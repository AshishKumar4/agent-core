import { compareCanonicalText, Revision } from "../core";
import { consumeAuthenticatedContribution, type AuthenticatedContribution } from "../definition";
import type { ContributionAttribution } from "../facets";
import { AgentCoreError } from "../errors";
import type { TenantId } from "../identity";
import {
    IngressEndpoint,
    IngressEndpointId,
    type IngressEndpointMaterializationInit
} from "./ingress-endpoint";

/** One durable revision of an Ingress endpoint, keyed by its endpoint id and revision. */
export interface StoredIngressEndpoint {
    readonly id: string;
    readonly bytes: Uint8Array;
}

/**
 * Slice-local storage seam for the ingress plane: one append-only record set plus one
 * current-revision pointer per endpoint. The owning context can back it with the shared
 * workspace substrate; tests use the memory implementation.
 */
export interface IngressEndpointStorage {
    findRecord(recordKey: string): StoredIngressEndpoint | undefined;
    listRecords(): readonly StoredIngressEndpoint[];
    insertRecord(record: StoredIngressEndpoint): void;
    findCurrent(endpointId: string): string | undefined;
    compareAndSetCurrent(
        endpointId: string,
        nextRecordKey: string,
        expectedRecordKey: string | undefined
    ): void;
}

export class MemoryIngressEndpointStorage implements IngressEndpointStorage {
    readonly #records = new Map<string, StoredIngressEndpoint>();
    readonly #current = new Map<string, string>();

    public findRecord(recordKey: string): StoredIngressEndpoint | undefined {
        return this.#records.get(recordKey);
    }

    public listRecords(): readonly StoredIngressEndpoint[] {
        return Object.freeze([...this.#records.values()]);
    }

    public insertRecord(record: StoredIngressEndpoint): void {
        if (this.#records.has(record.id)) {
            throw new AgentCoreError("protocol.duplicate", "Ingress records are append-only");
        }
        this.#records.set(record.id, record);
    }

    public findCurrent(endpointId: string): string | undefined {
        return this.#current.get(endpointId);
    }

    public compareAndSetCurrent(
        endpointId: string,
        nextRecordKey: string,
        expectedRecordKey: string | undefined
    ): void {
        const current = this.#current.get(endpointId);
        if (
            current !== expectedRecordKey ||
            (current === undefined && expectedRecordKey !== undefined)
        ) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Ingress pointer compare-and-set failed"
            );
        }
        this.#current.set(endpointId, nextRecordKey);
    }

    public snapshot(): MemoryIngressEndpointSnapshot {
        return {
            version: 1,
            records: [...this.#records.values()].map((record) => ({
                id: record.id,
                bytes: record.bytes.slice()
            })),
            currents: [...this.#current.entries()]
        };
    }

    public clone(): MemoryIngressEndpointStorage {
        return MemoryIngressEndpointStorage.restore(this.snapshot());
    }

    public static restore(snapshot: MemoryIngressEndpointSnapshot): MemoryIngressEndpointStorage {
        const storage = new MemoryIngressEndpointStorage();
        for (const record of snapshot.records) storage.#records.set(record.id, record);
        for (const [endpointId, recordKey] of snapshot.currents) {
            storage.#current.set(endpointId, recordKey);
        }
        return storage;
    }
}

export interface MemoryIngressEndpointSnapshot {
    readonly version: 1;
    readonly records: readonly StoredIngressEndpoint[];
    readonly currents: readonly (readonly [string, string])[];
}


function recordKeyOf(id: IngressEndpointId, revision: Revision): string {
    return `${id.value}@${revision.value}`;
}

/**
 * Owns the durable ingress endpoints of exactly one Tenant. Direct creation never carries
 * attribution; only materializeIngressEndpoint consumes the one-use capability that
 * authenticated package installation provenance minted, and withdrawal retires the stored
 * current revision itself so no caller-supplied clone can pass for a contributed record.
 */
export class WorkspaceIngressEndpointStore<Transaction> {
    public constructor(
        private readonly storage: (transaction: Transaction) => IngressEndpointStorage,
        private readonly tenant: TenantId
    ) {}

    public currentIngressEndpoint(
        transaction: Transaction,
        id: IngressEndpointId
    ): IngressEndpoint | undefined {
        const recordKey = this.storage(transaction).findCurrent(id.value);
        if (recordKey === undefined) return undefined;
        const endpoint = this.requireLoad(transaction, id, recordKey);
        if (!endpoint.id.equals(id)) {
            throw corrupt("Ingress pointer does not match its endpoint");
        }
        return endpoint;
    }

    /**
     * The live endpoints only: a retired endpoint (§4.1) exposes no path, verifies no
     * request, and mints no Event.
     */
    public listIngressEndpoints(transaction: Transaction): readonly IngressEndpoint[] {
        const seen = new Set<string>();
        const endpoints: IngressEndpoint[] = [];
        for (const stored of this.storage(transaction).listRecords()) {
            const decoded = this.decodeStored(stored);
            if (seen.has(decoded.id.value)) continue;
            seen.add(decoded.id.value);
            const current = this.currentIngressEndpoint(transaction, decoded.id);
            if (current !== undefined && current.retired !== true) endpoints.push(current);
        }
        return Object.freeze(
            endpoints.sort((left, right) => compareCanonicalText(left.id.value, right.id.value))
        );
    }

    /**
     * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the live endpoints one exact
     * contribution materialized, found by matching its complete immutable attribution.
     */
    public listContributedIngressEndpoints(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): readonly IngressEndpoint[] {
        return Object.freeze(
            this.listIngressEndpoints(transaction).filter(
                (endpoint) => endpoint.contribution?.equals(attribution) === true
            )
        );
    }

    /**
     * Writes a caller-declared endpoint. Attribution never enters through direct creation:
     * a caller carrying attribution here is laundering it past the trusted materializer.
     */
    public createIngressEndpoint(transaction: Transaction, endpoint: IngressEndpoint): void {
        if (endpoint.contribution !== undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Ingress endpoint attribution requires authenticated contribution materialization"
            );
        }
        this.requireOwnTenant(endpoint);
        const current = this.currentIngressEndpoint(transaction, endpoint.id);
        if (current !== undefined || endpoint.revision.value !== 0) {
            throw revisionConflict(
                "New Ingress endpoint requires revision zero and no current record"
            );
        }
        this.requireLivePathFree(transaction, endpoint);
        this.writeIngressEndpoint(transaction, endpoint, undefined);
    }

    /**
     * The sole attributed creation seam. It consumes the capability during the synchronous
     * authenticated provenance callback and constructs the revision-zero record itself.
     */
    public materializeIngressEndpoint(
        transaction: Transaction,
        contribution: AuthenticatedContribution,
        init: IngressEndpointMaterializationInit
    ): IngressEndpoint {
        if ("contribution" in init || "retired" in init || "revision" in init) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Ingress endpoint materialization input must not supply record state"
            );
        }
        const attribution = consumeAuthenticatedContribution(contribution);
        if (attribution === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Ingress endpoint materialization requires authenticated contribution provenance"
            );
        }
        const endpoint = new IngressEndpoint({
            id: init.id,
            revision: Revision.initial(),
            scope: init.scope,
            declared: init.declared,
            contribution: attribution
        });
        this.requireOwnTenant(endpoint);
        this.requireLivePathFree(transaction, endpoint);
        this.writeIngressEndpoint(transaction, endpoint, undefined);
        return endpoint;
    }

    /** Retires the stored current revision itself, so a caller cannot smuggle a clone past the store. */
    public retireIngressEndpoint(transaction: Transaction, id: IngressEndpointId): void {
        const current = this.currentIngressEndpoint(transaction, id);
        if (current === undefined || current.retired === true) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Ingress endpoint withdrawal requires a live contributed record"
            );
        }
        // The retirement is built from stored state, so its attribution is the exact pair
        // the trusted materializer wrote and no later writer can rewrite it.
        this.writeIngressEndpoint(transaction, current.retire(), current);
    }

    private writeIngressEndpoint(
        transaction: Transaction,
        endpoint: IngressEndpoint,
        current: IngressEndpoint | undefined
    ): void {
        const storage = this.storage(transaction);
        const recordKey = recordKeyOf(endpoint.id, endpoint.revision);
        storage.insertRecord({ id: recordKey, bytes: IngressEndpoint.encode(endpoint) });
        storage.compareAndSetCurrent(
            endpoint.id.value,
            recordKey,
            current === undefined ? undefined : recordKeyOf(current.id, current.revision)
        );
    }

    private requireOwnTenant(endpoint: IngressEndpoint): void {
        if (!endpoint.scope.tenantId.equals(this.tenant)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Ingress endpoint belongs to another Tenant"
            );
        }
    }

    private requireLivePathFree(transaction: Transaction, candidate: IngressEndpoint): void {
        const occupant = this.listIngressEndpoints(transaction).find(
            (endpoint) =>
                endpoint.declared.path === candidate.declared.path &&
                !endpoint.id.equals(candidate.id)
        );
        if (occupant !== undefined) {
            throw duplicate("A live Ingress endpoint already binds this path");
        }
    }

    private requireLoad(
        transaction: Transaction,
        id: IngressEndpointId,
        recordKey: string
    ): IngressEndpoint {
        const stored = this.storage(transaction).findRecord(recordKey);
        if (stored === undefined) throw corrupt("Ingress pointer targets a missing record");
        const endpoint = this.decodeStored(stored);
        if (!endpoint.id.equals(id)) {
            throw corrupt("Stored workspace key does not match its codec identity");
        }
        return endpoint;
    }

    private decodeStored(stored: StoredIngressEndpoint): IngressEndpoint {
        try {
            const endpoint = IngressEndpoint.decode(stored.bytes.slice());
            if (recordKeyOf(endpoint.id, endpoint.revision) !== stored.id) {
                throw corrupt("Stored ingress key does not match its codec identity");
            }
            return endpoint;
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw corrupt("Stored ingress record bytes are malformed");
        }
    }
}

function revisionConflict(message: string): AgentCoreError {
    return new AgentCoreError("protocol.revision-conflict", message);
}

function duplicate(message: string): AgentCoreError {
    return new AgentCoreError("protocol.duplicate", message);
}

function corrupt(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
