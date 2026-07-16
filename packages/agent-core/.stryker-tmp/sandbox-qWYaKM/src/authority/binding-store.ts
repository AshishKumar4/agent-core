// @ts-nocheck
import { AgentCoreError } from "../errors";
import type { ScopeRef } from "../identity";
import { Binding } from "./binding";

export interface BindingStore {
    load(key: string): Binding | undefined;
    list(): readonly Binding[];
    save(binding: Binding): void;
}

export interface MemoryBindingSnapshot {
    readonly version: 1;
    readonly records: readonly { readonly key: string; readonly bytes: Uint8Array }[];
}

export class MemoryBindingStore implements BindingStore {
    readonly #records = new Map<string, Uint8Array>();

    public constructor(
        private readonly workspaceScope: ScopeRef,
        snapshot: MemoryBindingSnapshot = { version: 1, records: [] }
    ) {
        requireWorkspaceScope(workspaceScope);
        requireSnapshot(snapshot);
        for (const stored of snapshot.records) {
            if (this.#records.has(stored.key)) {
                throw corruptBindingSnapshot("Memory Binding snapshot contains duplicate keys");
            }
            const binding = Binding.decode(stored.bytes.slice());
            if (binding.key !== stored.key || !binding.scope.equals(workspaceScope)) {
                throw corruptBindingSnapshot("Memory Binding key does not match codec bytes");
            }
            this.#records.set(stored.key, stored.bytes.slice());
        }
    }

    public load(key: string): Binding | undefined {
        const bytes = this.#records.get(key);
        return bytes === undefined ? undefined : Binding.decode(bytes.slice());
    }

    public list(): readonly Binding[] {
        return Object.freeze([...this.#records.keys()].sort().map((key) => this.load(key)!));
    }

    public save(binding: Binding): void {
        if (!binding.scope.equals(this.workspaceScope)) {
            throw new AgentCoreError(
                "binding.invalid",
                "Binding belongs to another Workspace store"
            );
        }
        const previous = this.load(binding.key);
        if (previous === undefined) {
            if (binding.generation !== 0 || binding.revision.value !== 0) {
                throw new AgentCoreError(
                    "protocol.revision-conflict",
                    "New Bindings require generation and revision zero"
                );
            }
        } else {
            const previousBytes = Binding.encode(previous);
            const nextBytes = Binding.encode(binding);
            if (bytesEqual(previousBytes, nextBytes)) return;
            previous.assertCanReplace(binding);
        }
        this.#records.set(binding.key, Binding.encode(binding));
    }

    public snapshot(): MemoryBindingSnapshot {
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

function requireWorkspaceScope(scope: ScopeRef): void {
    if (scope.kind !== "workspace") throw new TypeError("Binding stores require a Workspace Scope");
}

function requireSnapshot(snapshot: MemoryBindingSnapshot): void {
    if (
        snapshot === null ||
        typeof snapshot !== "object" ||
        JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(["records", "version"]) ||
        snapshot.version !== 1 ||
        !Array.isArray(snapshot.records)
    ) {
        throw corruptBindingSnapshot("Memory Binding snapshot is malformed");
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
            throw corruptBindingSnapshot("Memory Binding snapshot record is malformed");
        }
    }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function corruptBindingSnapshot(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
