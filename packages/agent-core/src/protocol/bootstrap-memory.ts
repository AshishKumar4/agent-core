import { MemoryActorStore, type MemoryActorStoreSnapshot } from "../actors";
import { MemoryTenantControlStore, type MemoryTenantControlSnapshot } from "../authority";
import { Revision } from "../core";
import type { TransientContentAccess } from "../content";
import { AgentCoreError } from "../errors";
import type { TenantId } from "../identity";
import { AuditRecordId, CorrelationId, InvocationId, WriteRecordId } from "../invocations";
import type { CommandAuthenticator } from "./authentication";
import { CommandDispatcher, type CommandDispatchResult } from "./dispatcher";
import { CommandIngress, type CommandIngressResult } from "./ingress";
import { MemoryProtocolPersistence, MemoryProtocolRecords } from "./memory";
import {
    TenantBootstrapAnchorRecord,
    createTenantBootstrapCommand,
    type TenantBootstrapAnchor,
    type TenantBootstrapTarget
} from "./bootstrap";

interface MemoryTenantBootstrapState {
    control: MemoryTenantControlSnapshot;
    protocol: MemoryProtocolRecords;
    nextId: number;
}

interface TenantBootstrapRead {
    readonly eligible: boolean;
    readonly revision: Revision;
}

export interface MemoryTenantBootstrapSnapshot {
    readonly version: 1;
    readonly opaque: unknown;
}

export interface MemoryTenantBootstrapInit<Transport> {
    readonly actor: TenantBootstrapTarget["actor"];
    readonly anchor: TenantBootstrapAnchor;
    readonly authenticator: CommandAuthenticator<Transport>;
    readonly content: TransientContentAccess;
    readonly snapshot?: MemoryTenantBootstrapSnapshot;
}

export class MemoryTenantBootstrap<Transport> {
    readonly #store: MemoryActorStore<MemoryTenantBootstrapState>;
    readonly #ingress: CommandIngress<
        MemoryTenantBootstrapState,
        TenantBootstrapRead,
        MemoryTenantBootstrapState,
        Transport
    >;
    public readonly tenantId: TenantId;

    public constructor(init: MemoryTenantBootstrapInit<Transport>) {
        const restored = snapshotValue(init.snapshot);
        const initial: MemoryTenantBootstrapState = restored?.state ?? {
            control: MemoryTenantControlStore.create(init.anchor).snapshot(),
            protocol: new MemoryProtocolRecords(),
            nextId: 0
        };
        const storedAnchor = MemoryTenantControlStore.restore(initial.control).bootstrapAnchor();
        if (!anchorsEqual(storedAnchor, init.anchor)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Memory Tenant bootstrap anchor changed across restart"
            );
        }
        const target = { actor: init.actor, tenantId: storedAnchor.tenantId };
        this.tenantId = target.tenantId;
        try {
            this.#store =
                restored === undefined
                    ? new MemoryActorStore(initial, cloneState)
                    : MemoryActorStore.restore(restored, cloneState);
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError(
                "codec.invalid",
                "Memory Tenant bootstrap snapshot is malformed"
            );
        }
        const persistence = new MemoryProtocolPersistence<MemoryTenantBootstrapState>(
            (state) => state.protocol
        );
        const backend = {
            anchor: (_read: TenantBootstrapRead) => storedAnchor,
            anchorInTransaction: (transaction: MemoryTenantBootstrapState) =>
                MemoryTenantControlStore.restore(transaction.control).bootstrapAnchor(),
            eligible: (read: TenantBootstrapRead) => read.eligible,
            currentRevision: (read: TenantBootstrapRead) => read.revision,
            bootstrapTenant: (
                transaction: MemoryTenantBootstrapState,
                anchor: TenantBootstrapAnchorRecord,
                expectedRevision: Revision
            ) => {
                const control = MemoryTenantControlStore.restore(transaction.control);
                control.bootstrapTenant(anchor, expectedRevision);
                transaction.control = control.snapshot();
            }
        };
        try {
            const dispatcher = new CommandDispatcher({
                store: this.#store,
                persistence,
                ids: {
                    writeRecordId: (transaction) => new WriteRecordId(nextId(transaction, "write")),
                    auditRecordId: (transaction) => new AuditRecordId(nextId(transaction, "audit")),
                    correlationId: (transaction) =>
                        new CorrelationId(nextId(transaction, "correlation")),
                    invocationId: (transaction) =>
                        new InvocationId(nextId(transaction, "invocation"))
                },
                actor: init.actor,
                tenant: storedAnchor.tenantId,
                readOnly: (state) => {
                    const control = MemoryTenantControlStore.restore(state.control);
                    return Object.freeze({
                        eligible: control.isBootstrapEligible(),
                        revision: Revision.initial()
                    });
                },
                commands: [createTenantBootstrapCommand(backend, target)],
                limits: { envelopeBytes: 16_384, payloadBytes: 16_384 }
            });
            this.#ingress = new CommandIngress({
                dispatcher,
                content: init.content,
                authenticator: init.authenticator,
                leaseForMilliseconds: 60_000
            });
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant bootstrap Actor state is invalid"
            );
        }
    }

    public accept(
        envelope: Uint8Array,
        transport: Transport,
        submittedBytes?: Uint8Array
    ): Promise<CommandIngressResult> {
        return this.#ingress.accept(envelope, transport, submittedBytes);
    }

    public async dispatch(
        envelope: Uint8Array,
        transport: Transport,
        submittedBytes?: Uint8Array
    ): Promise<CommandDispatchResult> {
        const result = await this.accept(envelope, transport, submittedBytes);
        if (result.kind === "preDispatchFailure") throw result.cause;
        return result;
    }

    public snapshot(): MemoryTenantBootstrapSnapshot {
        return Object.freeze({ version: 1, opaque: this.#store.snapshot() });
    }
}

function snapshotValue(
    snapshot: MemoryTenantBootstrapSnapshot | undefined
): MemoryActorStoreSnapshot<MemoryTenantBootstrapState> | undefined {
    if (snapshot === undefined) return undefined;
    if (
        snapshot === null ||
        typeof snapshot !== "object" ||
        Object.keys(snapshot).sort().join(",") !== "opaque,version" ||
        snapshot.version !== 1 ||
        snapshot.opaque === null ||
        typeof snapshot.opaque !== "object"
    ) {
        throw new AgentCoreError("codec.invalid", "Memory Tenant bootstrap snapshot is malformed");
    }
    const value = snapshot.opaque as MemoryActorStoreSnapshot<MemoryTenantBootstrapState>;
    try {
        cloneState(value.state);
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError("codec.invalid", "Memory Tenant bootstrap snapshot is malformed");
    }
    return value;
}

export function createMemoryTenantBootstrap<Transport>(
    init: MemoryTenantBootstrapInit<Transport>
): MemoryTenantBootstrap<Transport> {
    return new MemoryTenantBootstrap(init);
}

function cloneState(state: MemoryTenantBootstrapState): MemoryTenantBootstrapState {
    if (!Number.isSafeInteger(state.nextId) || state.nextId < 0) {
        throw new AgentCoreError("codec.invalid", "Memory Tenant bootstrap snapshot is malformed");
    }
    return {
        control: MemoryTenantControlStore.restore(state.control).snapshot(),
        protocol: state.protocol.clone(),
        nextId: state.nextId
    };
}

function nextId(state: MemoryTenantBootstrapState, prefix: string): string {
    if (
        !Number.isSafeInteger(state.nextId) ||
        state.nextId < 0 ||
        state.nextId === Number.MAX_SAFE_INTEGER
    ) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Memory bootstrap protocol ID is exhausted"
        );
    }
    state.nextId += 1;
    return `${prefix}-${state.nextId}`;
}

function anchorsEqual(left: TenantBootstrapAnchor, right: TenantBootstrapAnchor): boolean {
    return (
        left.actorId.equals(right.actorId) &&
        left.tenantId.equals(right.tenantId) &&
        left.principalId.equals(right.principalId) &&
        (left.tenantKind ?? "personal") === (right.tenantKind ?? "personal") &&
        left.trustAnchor.byteLength === right.trustAnchor.byteLength &&
        left.trustAnchor.every((value, index) => value === right.trustAnchor[index])
    );
}
