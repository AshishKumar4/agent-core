// @ts-nocheck
import {
    ContentRef,
    Digest,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../../src/core";
import {
    InMemoryMemoryIndexBackend,
    MEMORY_CONTRIBUTIONS,
    MEMORY_OPERATION_CONTRACTS,
    MEMORY_OPERATIONS,
    MEMORY_PROMPT_CONTRIBUTION_DESCRIPTOR,
    MemoryBackend,
    MemoryEntry,
    MemoryFacet,
    type MemoryAccessBackend,
    type MemoryContentBackend
} from "../../../src/facets";
import { describe, expect, test } from "vitest";
import { denyingRuntime, operationDeclarationEvidence, recordingRuntime } from "./harness";

operationDeclarationEvidence("Memory", MEMORY_OPERATIONS, {
    remember: "mutate",
    recall: "observe",
    forget: "mutate"
});

describe("Memory protected facade", () => {
    test("[P11-MEMORY-PROMPT] materializes the relevant authorized recall result into the prompt", async () => {
        const content = new TestContent();
        const backend = new MemoryBackend(
            new InMemoryMemoryIndexBackend(),
            new TestAccess("alice"),
            content
        );
        backend.remember({
            id: "relevant",
            content: content.add({ text: "release rollback procedure" }),
            createdAt: 1
        });
        backend.remember({
            id: "irrelevant",
            content: content.add({ text: "lunch menu" }),
            createdAt: 1
        });
        const memory = new MemoryFacet(recordingRuntime("memory-prompt").runtime, backend, {
            maximumEntries: 1,
            maximumCharacters: 100,
            priority: 5
        });

        const contribution = await memory.prompt({ query: "rollback" });
        expect(contribution.sections).toMatchObject([
            {
                title: "Memory relevant",
                body: JSON.stringify({ text: "release rollback procedure" }),
                priority: 5
            }
        ]);
    });

    test("[P11-MEMORY-DISCOVERY] routes all Operations, filters through host-bound access, and bounds prompt contribution", async () => {
        const content = new TestContent();
        const access = new TestAccess("alice");
        const backend = new MemoryBackend(new InMemoryMemoryIndexBackend(), access, content);
        const { runtime, admission } = recordingRuntime("memory");
        const memory = new MemoryFacet(runtime, backend, {
            maximumEntries: 1,
            maximumCharacters: 40,
            priority: 10
        });
        await memory.remember({
            id: "one",
            content: content.add({ text: "shared term" }),
            createdAt: 1
        });
        access.current = "bob";
        await memory.remember({
            id: "two",
            content: content.add({ text: "shared term for bob" }),
            createdAt: 1
        });

        expect((await memory.recall({ query: "shared" })).map((entry) => entry.id)).toEqual([
            "two"
        ]);
        const prompt = await memory.prompt({ query: "shared", limit: 10 });
        expect(prompt.sections).toHaveLength(1);
        expect(prompt.sections[0]?.body.length).toBeLessThanOrEqual(40);
        await expect(memory.forget({ id: "two" })).resolves.toBe(true);
        expect(admission.calls.map((call) => call.name)).toEqual([
            "remember",
            "remember",
            "recall",
            "memory.prompt",
            "forget"
        ]);
        expect(typeof (admission.calls[0]!.input as { content: unknown }).content).toBe("string");
        expect(admission.calls[3]?.kind).toBe("control");
    });

    test("[P11-MEMORY-CANONICAL] denial leaves canonical memory unchanged", async () => {
        const content = new TestContent();
        const backend = new MemoryBackend(
            new InMemoryMemoryIndexBackend(),
            new TestAccess("alice"),
            content
        );
        const memory = new MemoryFacet(denyingRuntime("memory").runtime, backend, {
            maximumEntries: 1,
            maximumCharacters: 10,
            priority: 0
        });
        await expect(
            memory.remember({ id: "denied", content: content.add({}), createdAt: 1 })
        ).rejects.toMatchObject({ code: "authority.denied" });
        await expect(memory.prompt({ query: "denied" })).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(backend.recall({ query: "" })).toEqual([]);
    });
});

describe("Memory backends", () => {
    test("declares the bounded protected recall prompt materializer", () => {
        expect(MEMORY_CONTRIBUTIONS.entries.map((entry) => entry.slot.value)).toEqual([
            "operations",
            "prompt"
        ]);
        expect(MEMORY_PROMPT_CONTRIBUTION_DESCRIPTOR.sections[0]?.body).toContain(
            "protected recall Operation"
        );
    });

    test("[P11-MEMORY-REBUILD] prunes only elapsed retention and keeps derived index rebuild invisible", () => {
        const content = new TestContent();
        const backend = new MemoryBackend(
            new InMemoryMemoryIndexBackend(),
            new TestAccess("alice"),
            content
        );
        const empty = content.add({});
        backend.remember({ id: "expired", content: empty, createdAt: 1, retainUntil: 5 });
        backend.remember({ id: "retained", content: empty, createdAt: 1, retainUntil: 10 });
        expect(backend.prune(5)).toEqual(["expired"]);
        backend.rebuildIndex();
        expect(backend.recall({ query: "" }).map((entry) => entry.id)).toEqual(["retained"]);
    });

    test("[P11-MEMORY-FORGET] validates entries, duplicate IDs, limits, time, and forget authority", () => {
        const content = new TestContent();
        const access = new TestAccess("alice");
        const backend = new MemoryBackend(new InMemoryMemoryIndexBackend(), access, content);
        const reference = content.add({ text: "alpha beta" });

        for (const construct of [
            () => new MemoryEntry(" ", reference, "alice", 0),
            () => new MemoryEntry("id", reference, " ", 0),
            () => new MemoryEntry("id", reference, "alice", -1),
            () => new MemoryEntry("id", reference, "alice", 2, 1)
        ])
            expect(construct).toThrow(TypeError);

        backend.remember({ id: "one", content: reference, createdAt: 1 });
        expect(backend.recall({ query: "alpha", limit: 0 })).toEqual([]);
        expect(() => backend.remember({ id: "one", content: reference, createdAt: 1 })).toThrow(
            expect.objectContaining({ detailCode: "memory.exists" })
        );
        expect(() => backend.recall({ query: "alpha", limit: -1 })).toThrow(
            expect.objectContaining({ detailCode: "memory.limit" })
        );
        expect(() => backend.prune(-1)).toThrow(
            expect.objectContaining({ detailCode: "memory.time" })
        );
        expect(backend.prune(1)).toEqual([]);
        expect(backend.forget({ id: "missing" })).toBe(false);
        access.current = "bob";
        expect(backend.forget({ id: "one" })).toBe(false);
        expect(backend.recall({ query: "alpha beta" })).toEqual([]);
        expect(backend.recall({ query: "absent" })).toEqual([]);

        const retained = MEMORY_OPERATION_CONTRACTS.remember.decodeInput(
            MEMORY_OPERATION_CONTRACTS.remember.encodeInput({
                id: "retained-wire",
                content: reference,
                createdAt: 1,
                retainUntil: 2
            })
        );
        expect(retained.retainUntil).toBe(2);
        expect(
            MEMORY_OPERATION_CONTRACTS.remember.decodeOutput(
                MEMORY_OPERATION_CONTRACTS.remember.encodeOutput(
                    new MemoryEntry("retained-wire", reference, "alice", 1, 2)
                )
            ).retainUntil
        ).toBe(2);
        expect(
            MEMORY_OPERATION_CONTRACTS.recall.decodeInput(
                MEMORY_OPERATION_CONTRACTS.recall.encodeInput({ query: "alpha", limit: 1 })
            )
        ).toEqual({ query: "alpha", limit: 1 });
    });

    test("bounds prompt construction and validates every configured integer", async () => {
        const content = new TestContent();
        const backend = new MemoryBackend(
            new InMemoryMemoryIndexBackend(),
            new TestAccess("alice"),
            content
        );
        backend.remember({ id: "large", content: content.add({ text: "too long" }), createdAt: 1 });
        const runtime = recordingRuntime("memory-bounds").runtime;
        const memory = new MemoryFacet(runtime, backend, {
            maximumEntries: 1,
            maximumCharacters: 1,
            priority: 0
        });
        expect((await memory.prompt({ query: "long" })).sections).toEqual([]);
        const noEntries = new MemoryFacet(runtime, backend, {
            maximumEntries: 0,
            maximumCharacters: 100,
            priority: 0
        });
        expect((await noEntries.prompt({ query: "long" })).sections).toEqual([]);

        for (const bounds of [
            { maximumEntries: -1, maximumCharacters: 1, priority: 0 },
            { maximumEntries: 1, maximumCharacters: -1, priority: 0 },
            { maximumEntries: 1, maximumCharacters: 1, priority: 0.5 }
        ])
            expect(() => new MemoryFacet(runtime, backend, bounds)).toThrow(TypeError);
    });
});

class TestAccess implements MemoryAccessBackend {
    public constructor(public current: string) {}

    public authorityForRemember(): string {
        return this.current;
    }

    public canRead(authority: string): boolean {
        return authority === this.current;
    }

    public canForget(authority: string): boolean {
        return authority === this.current;
    }
}

class TestContent implements MemoryContentBackend {
    readonly #values = new Map<string, JsonValue>();

    public add(value: JsonValue): ContentRef {
        const bytes = encodeCanonicalJson(value);
        const reference = ContentRef.fromDigest(Digest.sha256(bytes));
        this.#values.set(reference.value, decodeCanonicalJson(bytes));
        return reference;
    }

    public resolve(content: ContentRef): JsonValue {
        const value = this.#values.get(content.value);
        if (value === undefined) throw new TypeError("Content is unavailable");
        return value;
    }
}
