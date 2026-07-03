import type { BindingName } from "../facets/id";
import type { Facet } from "../facets/facet";
import type { BindingId, GrantId } from "./id";
import { ResolvedBinding, type BindingRecord } from "./binding";
import type { GrantRecord } from "./grant";

export interface GrantStore {
    get(id: GrantId): Promise<GrantRecord | undefined>;
    put(record: GrantRecord): Promise<GrantRecord>;
    list(): Promise<readonly GrantRecord[]>;
}

export interface BindingStore {
    get(id: BindingId): Promise<BindingRecord | undefined>;
    put(record: BindingRecord): Promise<BindingRecord>;
    list(): Promise<readonly BindingRecord[]>;
}

export interface FacetRegistry {
    resolve(name: BindingName): Facet | undefined;
}

export interface BindingResolver {
    resolve(registry: FacetRegistry): Promise<readonly ResolvedBinding[]>;
}

export class MemoryGrantStore implements GrantStore {
    readonly #records = new Map<string, GrantRecord>();

    public constructor(records: readonly GrantRecord[] = []) {
        for (const record of records) {
            this.#records.set(record.id.value, record);
        }
    }

    public async get(id: GrantId): Promise<GrantRecord | undefined> {
        return this.#records.get(id.value);
    }

    public async put(record: GrantRecord): Promise<GrantRecord> {
        this.#records.set(record.id.value, record);
        return record;
    }

    public async list(): Promise<readonly GrantRecord[]> {
        return Object.freeze([...this.#records.values()]);
    }
}

export class MemoryBindingStore implements BindingStore {
    readonly #records = new Map<string, BindingRecord>();

    public constructor(records: readonly BindingRecord[] = []) {
        for (const record of records) {
            this.#records.set(record.id.value, record);
        }
    }

    public async get(id: BindingId): Promise<BindingRecord | undefined> {
        return this.#records.get(id.value);
    }

    public async put(record: BindingRecord): Promise<BindingRecord> {
        this.#records.set(record.id.value, record);
        return record;
    }

    public async list(): Promise<readonly BindingRecord[]> {
        return Object.freeze([...this.#records.values()]);
    }
}

export class MemoryFacetRegistry implements FacetRegistry {
    public constructor(private readonly facets: readonly Facet[] = []) {
    }

    public resolve(name: BindingName): Facet | undefined {
        return this.facets.find(facet => facet.name.equals(name));
    }
}

export class StoredBindingResolver implements BindingResolver {
    public constructor(
        private readonly bindings: BindingStore,
        private readonly grants: GrantStore
    ) {
    }

    public async resolve(registry: FacetRegistry): Promise<readonly ResolvedBinding[]> {
        const resolved: ResolvedBinding[] = [];

        for (const record of await this.bindings.list()) {
            const grant = await this.grants.get(record.grantId);
            if (grant === undefined) {
                throw new TypeError("Stored Binding references a missing Grant record");
            }

            const facet = registry.resolve(record.name);
            if (facet === undefined) {
                throw new TypeError("Stored Binding references an unregistered Facet");
            }

            resolved.push(new ResolvedBinding(record, grant, facet));
        }

        return Object.freeze(resolved);
    }
}
