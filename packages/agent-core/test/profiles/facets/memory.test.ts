import {
    CompatRange,
    ContentRef,
    Digest,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../../src/core";
import { MemoryContentStore } from "../../../src/content";
import {
    FacetPackageId,
    InMemoryMemoryIndexBackend,
    InternalProfileFacetRuntime,
    MEMORY_CONTRIBUTIONS,
    MEMORY_OPERATION_CONTRACTS,
    MEMORY_OPERATIONS,
    MEMORY_PROMPT_CONTRIBUTION_DESCRIPTOR,
    MEMORY_PROMPT_CONTROL,
    MemoryBackend,
    MemoryEntry,
    MemoryFacet,
    OperationName,
    createMemoryManifest,
    type MemoryAccessBackend,
    type MemoryContentBackend,
    type MemoryIndexBackend,
    type OperationContext
} from "../../../src/facets";
import { InvocationId } from "../../../src/invocations";
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

    test("accepts boundary entry times and rejects non-canonical IDs", { tags: "p1" }, () => {
        const content = new TestContent();
        const reference = content.add({ text: "boundary" });

        expect(() => new MemoryEntry("", reference, "alice", 1)).toThrow(/canonical/);
        expect(() => new MemoryEntry(" padded", reference, "alice", 1)).toThrow(/canonical/);
        expect(new MemoryEntry("id", reference, "alice", 0).createdAt).toBe(0);
        expect(new MemoryEntry("id", reference, "alice", 5, 5).retainUntil).toBe(5);
    });

    test("names each malformed wire field and decodes forget output strictly", { tags: "p2" }, () => {
        const content = new TestContent();
        const reference = content.add({ text: "wire" });
        const remember = MEMORY_OPERATION_CONTRACTS.remember;
        const recall = MEMORY_OPERATION_CONTRACTS.recall;

        expect(() =>
            remember.decodeInput({ id: 1, content: reference.value, createdAt: 1 })
        ).toThrow(/Memory ID must be a string/);
        expect(() => remember.decodeInput({ id: "x", content: 1, createdAt: 1 })).toThrow(
            /Memory content must be a string/
        );
        expect(() => recall.decodeInput({ query: 1 })).toThrow(/Memory query must be a string/);
        expect(() =>
            recall.decodeOutput([{ id: 1, content: reference.value, authority: "a", createdAt: 1 }])
        ).toThrow(/Memory ID must be a string/);
        expect(() =>
            recall.decodeOutput([{ id: "x", content: 1, authority: "a", createdAt: 1 }])
        ).toThrow(/Memory content must be a string/);
        expect(() =>
            recall.decodeOutput([{ id: "x", content: reference.value, authority: 1, createdAt: 1 }])
        ).toThrow(/Memory authority must be a string/);
        expect(() => MEMORY_PROMPT_CONTROL.decodeOutput({})).toThrow(
            /Memory prompt contribution must be an array/
        );
        expect(MEMORY_OPERATION_CONTRACTS.forget.decodeOutput(true)).toBe(true);
        expect(MEMORY_OPERATION_CONTRACTS.forget.decodeOutput(false)).toBe(false);
        expect(MEMORY_OPERATION_CONTRACTS.forget.decodeOutput("yes")).toBe(false);
    });

    test("raises MemoryError with the shared invalid-input code and exact detail", { tags: "p1" }, () => {
        const content = new TestContent();
        const backend = new MemoryBackend(
            new InMemoryMemoryIndexBackend(),
            new TestAccess("alice"),
            content
        );
        const reference = content.add({ text: "dup" });
        backend.remember({ id: "one", content: reference, createdAt: 1 });

        expect(() => backend.remember({ id: "one", content: reference, createdAt: 1 })).toThrow(
            expect.objectContaining({
                name: "MemoryError",
                code: "operation.invalid-input",
                detailCode: "memory.exists",
                message: expect.stringMatching(/Memory ID already exists/)
            })
        );
        expect(() => backend.prune(-1)).toThrow(
            expect.objectContaining({
                message: expect.stringMatching(/Prune time is invalid/)
            })
        );
        expect(backend.prune(0)).toEqual([]);
    });

    test("AND-matches every query term with sorted, limited, readable results", { tags: "p1" }, () => {
        const content = new TestContent();
        const backend = new MemoryBackend(
            new InMemoryMemoryIndexBackend(),
            new TestAccess("alice"),
            content
        );
        backend.remember({ id: "b", content: content.add({ text: "alpha" }), createdAt: 1 });
        backend.remember({ id: "a", content: content.add({ text: "alpha beta" }), createdAt: 1 });
        backend.remember({ id: "c", content: content.add({ text: "alpha gamma" }), createdAt: 1 });

        expect(backend.recall({ query: "alpha" }).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
        expect(backend.recall({ query: " " }).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
        expect(backend.recall({ query: "alpha beta" }).map((entry) => entry.id)).toEqual(["a"]);
        expect(backend.recall({ query: "alpha zzz" })).toEqual([]);
        expect(backend.recall({ query: "zzz" })).toEqual([]);
        expect(backend.recall({ query: "pha" })).toEqual([]);
        expect(backend.recall({ query: "alpha", limit: 2 }).map((entry) => entry.id)).toEqual([
            "a",
            "b"
        ]);
    });

    test("skips index hits without a backing entry", { tags: "p1" }, () => {
        const content = new TestContent();
        const backend = new MemoryBackend(
            new InMemoryMemoryIndexBackend(
                new Map([["ghost", new Set(["ghost"])]]),
                new Set(["ghost"])
            ),
            new TestAccess("alice"),
            content
        );

        expect(backend.recall({ query: "ghost" })).toEqual([]);
        expect(backend.recall({ query: "" })).toEqual([]);
    });

    test("matches queries case-insensitively through lowercase folding", { tags: "p1" }, () => {
        const content = new TestContent();
        const backend = new MemoryBackend(
            new InMemoryMemoryIndexBackend(),
            new TestAccess("alice"),
            content
        );
        backend.remember({ id: "street", content: content.add({ text: "straße" }), createdAt: 1 });

        expect(backend.recall({ query: "Straße" }).map((entry) => entry.id)).toEqual(["street"]);
        expect(backend.recall({ query: "STRASSE" })).toEqual([]);
    });

    test("prunes elapsed retention in sorted order and keeps unbounded entries", { tags: "p1" }, () => {
        const content = new TestContent();
        const backend = new MemoryBackend(
            new InMemoryMemoryIndexBackend(),
            new TestAccess("alice"),
            content
        );
        const empty = content.add({});
        backend.remember({ id: "b-expired", content: empty, createdAt: 1, retainUntil: 5 });
        backend.remember({ id: "a-expired", content: empty, createdAt: 1, retainUntil: 5 });
        backend.remember({ id: "kept", content: empty, createdAt: 1 });

        expect(backend.prune(9)).toEqual(["a-expired", "b-expired"]);
        expect(backend.recall({ query: "" }).map((entry) => entry.id)).toEqual(["kept"]);
    });

    test("rebuilds the derived index only on entry changes or explicit rebuild", { tags: "p1" }, () => {
        const content = new TestContent();
        const counter = { replaces: 0 };
        const backend = new MemoryBackend(
            new CountingIndex(counter, new InMemoryMemoryIndexBackend()),
            new TestAccess("alice"),
            content
        );
        backend.remember({ id: "one", content: content.add({ text: "alpha" }), createdAt: 1 });
        expect(counter.replaces).toBe(1);

        expect(backend.prune(100)).toEqual([]);
        expect(counter.replaces).toBe(1);

        backend.rebuildIndex();
        expect(counter.replaces).toBe(2);
        expect(backend.recall({ query: "alpha" }).map((entry) => entry.id)).toEqual(["one"]);
    });

    test("clamps prompt recall to bounds and spends the exact character budget", { tags: "p1" }, async () => {
        const content = new TestContent();
        const backend = new MemoryBackend(
            new InMemoryMemoryIndexBackend(),
            new TestAccess("alice"),
            content
        );
        const bodies = ["aa", "bb", "cc"].map((text) => ({ note: "shared", text }));
        for (const [index, value] of bodies.entries()) {
            backend.remember({ id: `entry-${index}`, content: content.add(value), createdAt: 1 });
        }
        const bodyLength = JSON.stringify(bodies[0]).length;
        const runtime = recordingRuntime("memory-budget").runtime;

        const clamped = new MemoryFacet(runtime, backend, {
            maximumEntries: 1,
            maximumCharacters: bodyLength * 3,
            priority: 2
        });
        expect((await clamped.prompt({ query: "shared", limit: 5 })).sections).toHaveLength(1);

        const exact = new MemoryFacet(runtime, backend, {
            maximumEntries: 10,
            maximumCharacters: bodyLength,
            priority: 2
        });
        expect((await exact.prompt({ query: "shared" })).sections).toHaveLength(1);

        const budget = new MemoryFacet(runtime, backend, {
            maximumEntries: 10,
            maximumCharacters: bodyLength * 2 + 1,
            priority: 2
        });
        expect((await budget.prompt({ query: "shared" })).sections).toHaveLength(2);

        const zero = new MemoryFacet(runtime, backend, {
            maximumEntries: 10,
            maximumCharacters: 0,
            priority: 0
        });
        expect((await zero.prompt({ query: "shared" })).sections).toEqual([]);
    });

    test("exposes an executable internal runtime for remember, recall, and forget", { tags: "p1" }, async () => {
        const content = new TestContent();
        const backend = new MemoryBackend(
            new InMemoryMemoryIndexBackend(),
            new TestAccess("alice"),
            content
        );
        const { runtime } = recordingRuntime("memory-internal");
        const memory = new MemoryFacet(runtime, backend, {
            maximumEntries: 1,
            maximumCharacters: 10,
            priority: 0
        });
        const internal = memory.asInternalRuntime(
            createMemoryManifest({
                id: new FacetPackageId("profile.memory"),
                version: new SemVer("1.0.0"),
                compat: new CompatRange("^1.0.0", "^1.0.0"),
                bindings: []
            })
        );
        expect(internal).toBeInstanceOf(InternalProfileFacetRuntime);

        const reference = content.add({ text: "internal" });
        const context: OperationContext = {
            invocation: new InvocationId("memory-internal-invocation"),
            itemIndex: 0,
            idempotencyKey: "memory-internal-idempotency",
            signal: new AbortController().signal,
            content: new MemoryContentStore()
        };
        await expect(
            internal
                .operation(new OperationName("remember"))
                ?.execute(context, { id: "one", content: reference.value, createdAt: 1 })
        ).resolves.toMatchObject({ id: "one", authority: "alice" });
        await expect(
            internal.operation(new OperationName("recall"))?.execute(context, { query: "internal" })
        ).resolves.toMatchObject([{ id: "one" }]);
        await expect(
            internal.operation(new OperationName("forget"))?.execute(context, { id: "one" })
        ).resolves.toBe(true);
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

class CountingIndex implements MemoryIndexBackend {
    public constructor(
        private readonly counter: { replaces: number },
        private readonly inner: MemoryIndexBackend
    ) {}

    public search(query: string): readonly string[] {
        return this.inner.search(query);
    }

    public replace(
        entries: readonly MemoryEntry[],
        content: MemoryContentBackend
    ): MemoryIndexBackend {
        this.counter.replaces += 1;
        return new CountingIndex(this.counter, this.inner.replace(entries, content));
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
