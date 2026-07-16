// @ts-nocheck
import { AgentCoreError } from "../errors";
import type { ActorRef } from "../actors";
import type { TenantId } from "../identity";
import { authorityKey } from "./key";
import { InvalidationWatermark, type ScopeEpoch } from "./epoch";

export interface InvalidationWatermarkStore {
    load(key: string): InvalidationWatermark | undefined;
    save(watermark: InvalidationWatermark): void;
    join(key: string, entries: readonly ScopeEpoch[]): InvalidationWatermark;
}

export interface MemoryInvalidationWatermarkSnapshot {
    readonly version: 1;
    readonly records: readonly { readonly key: string; readonly bytes: Uint8Array }[];
}

export class MemoryInvalidationWatermarkStore implements InvalidationWatermarkStore {
    readonly #records = new Map<string, Uint8Array>();

    public constructor(
        private readonly ownerTenant: TenantId,
        private readonly owner: ActorRef,
        snapshot: MemoryInvalidationWatermarkSnapshot = { version: 1, records: [] }
    ) {
        requireSnapshot(snapshot);
        for (const stored of snapshot.records) {
            if (this.#records.has(stored.key)) {
                throw corruptWatermarkSnapshot("Memory watermark snapshot contains duplicate keys");
            }
            const watermark = InvalidationWatermark.decode(stored.bytes.slice());
            if (
                watermarkKey(watermark) !== stored.key ||
                !watermark.ownerTenant.equals(ownerTenant) ||
                !watermark.owner.equals(owner)
            ) {
                throw corruptWatermarkSnapshot("Memory watermark key does not match codec bytes");
            }
            this.#records.set(stored.key, stored.bytes.slice());
        }
    }

    public load(key: string): InvalidationWatermark | undefined {
        const bytes = this.#records.get(key);
        return bytes === undefined ? undefined : InvalidationWatermark.decode(bytes.slice());
    }

    public save(watermark: InvalidationWatermark): void {
        if (
            !watermark.ownerTenant.equals(this.ownerTenant) ||
            !watermark.owner.equals(this.owner)
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Watermark belongs to another Actor store"
            );
        }
        const key = watermarkKey(watermark);
        const previous = this.load(key);
        if (previous === undefined) {
            if (watermark.revision.value !== 0) {
                throw new AgentCoreError(
                    "protocol.revision-conflict",
                    "New watermarks require revision zero"
                );
            }
        } else {
            const previousBytes = InvalidationWatermark.encode(previous);
            const nextBytes = InvalidationWatermark.encode(watermark);
            if (bytesEqual(previousBytes, nextBytes)) return;
            if (
                watermark.revision.value !== previous.revision.value + 1 ||
                !watermark.dominates(previous)
            ) {
                throw new AgentCoreError(
                    "protocol.revision-conflict",
                    "Watermark updates require monotonic entries and the next revision"
                );
            }
        }
        this.#records.set(key, InvalidationWatermark.encode(watermark));
    }

    public join(key: string, entries: readonly ScopeEpoch[]): InvalidationWatermark {
        const current = this.load(key);
        if (current === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Watermark must be initialized before join"
            );
        }
        const joined = current.join(entries);
        this.save(joined);
        return joined;
    }

    public snapshot(): MemoryInvalidationWatermarkSnapshot {
        return Object.freeze({
            version: 1,
            records: Object.freeze(
                [...this.#records.entries()]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, bytes]) =>
                        Object.freeze({
                            key,
                            bytes: bytes.slice()
                        })
                    )
            )
        });
    }
}

export function watermarkKey(watermark: InvalidationWatermark): string {
    return authorityKey("principal", [
        watermark.ownerTenant.value,
        watermark.owner.kind,
        watermark.owner.id.value,
        watermark.holder.tenantId.value,
        watermark.holder.principalId.value
    ]);
}

function requireSnapshot(snapshot: MemoryInvalidationWatermarkSnapshot): void {
    if (
        snapshot === null ||
        typeof snapshot !== "object" ||
        JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(["records", "version"]) ||
        snapshot.version !== 1 ||
        !Array.isArray(snapshot.records)
    ) {
        throw corruptWatermarkSnapshot("Memory watermark snapshot is malformed");
    }
    for (const record of snapshot.records) {
        if (
            record === null ||
            typeof record !== "object" ||
            JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["bytes", "key"]) ||
            typeof record.key !== "string" ||
            record.key.length === 0 ||
            !(record.bytes instanceof Uint8Array)
        ) {
            throw corruptWatermarkSnapshot("Memory watermark snapshot record is malformed");
        }
    }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function corruptWatermarkSnapshot(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
