import { describe, expect, it } from "vitest";
import {
    ByteRange,
    ContentStore,
    type ContentPutResult,
    type MediaHint
} from "../../../src/content";
import {
    ContentRef,
    Digest,
    JsonSchema,
    encodeBase64,
    encodeCanonicalJson
} from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { ActorCommitUnknownError, type SynchronousResultGuard } from "../../../src/actors";
import { RunCommitId } from "../../../src/execution-references";
import {
    MemoryRunStorage,
    PlacementPin,
    RunCommit,
    RunRepository,
    RunRuntime,
    TurnAdmittedEvent,
    TurnBoundOperation,
    TurnCommitOmission,
    TurnExecutor,
    TurnExecutorHost,
    TurnInboxEntry,
    TurnInboxEntryId,
    TurnModelInput,
    TurnModelInputReplay,
    TurnOmission,
    TurnPromptSection,
    TurnPromptSectionName,
    TurnShownContent,
    turnModelRequestBytes,
    type RunRecordKind,
    type StoredRunRecord,
    type TurnContext,
    type TurnModelCall,
    type TurnModelInputAssembly,
    type TurnModelExchange,
    type TurnModelInputInit,
    type TurnModelRequest,
    type TurnOutcome
} from "../../../src/agents/runs";
import {
    BindingName,
    FacetRef,
    OperationDescriptor,
    OperationName,
    OperationRef
} from "../../../src/facets";
import {
    TestEvidencePort,
    TestMergePort,
    TestSettlementPort,
    TestSourcePort,
    TestSpawnPort,
    content,
    ids,
    mutableData,
    fixtureMemoryRunSnapshot,
    seedRunningTurn,
    UncontributedCutPoints
} from "./fixture";

const encoder = new TextEncoder();

type MemoryTransaction = Parameters<MemoryRunStorage["get"]>[0];

/**
 * A ContentStore whose Tenant retention policy has released named content: it still
 * accepts writes and resolves everything else, which is the shape SPEC §8.2 legitimises
 * through export, legal deletion, and Tenant closure.
 */
class ReleasableContentStore extends ContentStore {
    readonly #released = new Set<string>();

    public constructor(private readonly inner: ContentStore) {
        super();
    }

    public release(ref: ContentRef): void {
        this.#released.add(ref.value);
    }

    public async put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult> {
        return hint === undefined ? this.inner.put(bytes) : this.inner.put(bytes, hint);
    }

    public async get(ref: ContentRef, range?: ByteRange): Promise<Uint8Array> {
        if (this.#released.has(ref.value)) {
            throw new AgentCoreError("content.not-found", "Tenant retention policy released this");
        }
        return range === undefined ? this.inner.get(ref) : this.inner.get(ref, range);
    }

    public async stat(ref: ContentRef) {
        return this.#released.has(ref.value) ? undefined : this.inner.stat(ref);
    }
}

/** How a substrate may answer a model-input commit. */
type CommitFault = "reject" | "unavailable" | "unknown" | "unknownAfterCommit";

type DispatchRefusal = readonly [label: string, fault: CommitFault];

const dispatchRefusals: readonly DispatchRefusal[] = [
    ["a store that rejects the record", "reject"],
    ["a store that is unavailable", "unavailable"],
    ["an outcome the substrate cannot report", "unknown"]
];

type RetentionLoss = readonly [label: string, lost: "section" | "event"];

const retentionLosses: readonly RetentionLoss[] = [
    ["a released prompt section reference", "section"],
    ["a no-longer-retained admitted Event", "event"]
];

/**
 * Storage that answers the next model-input commit with one named substrate outcome. The
 * `unknownAfterCommit` case is the decisive one: the write landed and the substrate cannot
 * say so, which is exactly when a host must not assume either branch.
 */
class FaultyRunStorage extends MemoryRunStorage {
    readonly #faults: CommitFault[] = [];
    #observed = false;

    public arm(...faults: readonly CommitFault[]): void {
        this.#faults.push(...faults);
    }

    /** Faults still waiting for a model-input commit, so no case passes vacuously. */
    public get unfired(): number {
        return this.#faults.length;
    }

    public override transaction<Result>(
        operation: (transaction: MemoryTransaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        if (!(#faults in this)) return super.transaction(operation, ...guard);
        this.#observed = false;
        const result = super.transaction(operation, ...guard);
        if (this.#observed && this.#faults[0] === "unknownAfterCommit") {
            this.#faults.shift();
            throw new ActorCommitUnknownError();
        }
        return result;
    }

    public override insert(transaction: MemoryTransaction, record: StoredRunRecord): void {
        if (#faults in this && record.kind === "commit" && record.key.startsWith("model-input:")) {
            const fault = this.#faults[0];
            if (fault === "reject" || fault === "unavailable" || fault === "unknown") {
                this.#faults.shift();
                if (fault === "unknown") throw new ActorCommitUnknownError();
                throw new AgentCoreError(
                    "run.invalid-state",
                    fault === "reject" ? "Store rejected the record" : "Store is unavailable"
                );
            }
            this.#observed = true;
        }
        super.insert(transaction, record);
    }
}

/**
 * Storage that keeps its records and its content custody whole and answers no inbox row, so
 * a replay which reached for a delivered Event through the inbox could not pass.
 */
class InboxlessRunStorage extends MemoryRunStorage {
    public override get(
        transaction: MemoryTransaction,
        kind: RunRecordKind,
        key: string
    ): StoredRunRecord | undefined {
        return kind === "inbox" ? undefined : super.get(transaction, kind, key);
    }

    public override list(
        transaction: MemoryTransaction,
        kind: RunRecordKind
    ): readonly StoredRunRecord[] {
        return kind === "inbox" ? [] : super.list(transaction, kind);
    }
}

class FunctionExecutor extends TurnExecutor {
    public constructor(private readonly run: (context: TurnContext) => Promise<TurnOutcome>) {
        super();
    }

    public async execute(context: TurnContext): Promise<TurnOutcome> {
        return this.run(context);
    }
}

/** A model port that records what it observed and reads the store on entry. */
class ObservingModelPort {
    public readonly calls: TurnModelCall[] = [];
    public readonly bytes: Uint8Array[] = [];
    public readonly durableOnEntry: boolean[] = [];

    public constructor(
        private readonly output: ContentRef,
        private readonly durable?: (input: RunCommitId) => boolean
    ) {}

    public readonly call = async (request: TurnModelCall) => {
        this.calls.push(request);
        this.bytes.push(turnModelRequestBytes(request));
        if (this.durable !== undefined) this.durableOnEntry.push(this.durable(request.input));
        return { output: this.output, usage: { inputTokens: 1, outputTokens: 1 } };
    };
}

function faultyHarness() {
    const faults = new FaultyRunStorage(
        ids.holder.tenantId,
        ids.actor,
        fixtureMemoryRunSnapshot(),
        () => new Date(0)
    );
    const repository = new RunRepository(faults);
    const sources = new TestSourcePort<MemoryTransaction>();
    const evidence = new TestEvidencePort<MemoryTransaction>();
    const settlement = new TestSettlementPort<MemoryTransaction>();
    const spawn = new TestSpawnPort<MemoryTransaction>();
    const merge = new TestMergePort<MemoryTransaction>();
    const runtime = new RunRuntime(
        repository,
        sources,
        evidence,
        settlement,
        spawn,
        merge,
        new UncontributedCutPoints()
    );
    return {
        storage: faults,
        faults,
        repository,
        sources,
        evidence,
        settlement,
        spawn,
        merge,
        runtime
    };
}

function tool(binding: string, operation: string): TurnBoundOperation {
    return new TurnBoundOperation(
        new BindingName(binding),
        new FacetRef("memory:primary"),
        new OperationRef(`memory:${operation}`),
        new OperationDescriptor(
            new OperationName(operation),
            "observe",
            new JsonSchema({ type: "object" }),
            new JsonSchema({ type: "object" }),
            `Run ${operation}.`
        )
    );
}

function section(
    name: string,
    shown: TurnShownContent,
    omission: TurnOmission = TurnOmission.none
): TurnPromptSection {
    return new TurnPromptSection(new TurnPromptSectionName(name), shown, omission);
}

function inboxEntry(
    id: string,
    sequence: number,
    event: string,
    payload: ContentRef
): TurnInboxEntry {
    return new TurnInboxEntry(
        new TurnInboxEntryId(id),
        ids.turn,
        sequence,
        event,
        payload,
        payload.digest,
        `key-${id}`,
        undefined,
        new Date(2_000)
    );
}

function cancellationEntry(id: string, payload: ContentRef): TurnInboxEntry {
    return new TurnInboxEntry(
        new TurnInboxEntryId(id),
        ids.turn,
        0,
        "turn.cancel",
        payload,
        payload.digest,
        `key-${id}`,
        { turn: ids.turn, holder: ids.holder, epoch: 1 },
        new Date(2_000)
    );
}

function resultCommit(
    context: TurnContext,
    id: string,
    parent: RunCommitId,
    result: ContentRef
): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: context.turn.run,
        branch: context.turn.branch,
        kind: "result",
        parents: [parent],
        pins: context.turn.pins,
        writer: { kind: "turn", token: context.token },
        subjectTurn: context.turn.id,
        content: result
    });
}

interface Fixture {
    readonly seeded: ReturnType<typeof seedRunningTurn>;
    readonly faults: FaultyRunStorage;
    readonly content: ReleasableContentStore;
    readonly output: ContentRef;
    readonly port: ObservingModelPort;
    readonly host: (
        executor: TurnExecutor,
        port?: ObservingModelPort,
        catalog?: readonly TurnBoundOperation[]
    ) => TurnExecutorHost<object>;
}

async function fixture(catalog: readonly TurnBoundOperation[] = []): Promise<Fixture> {
    const built = faultyHarness();
    // Custody admits only content the Run's own store holds, so the fixture writes through
    // that store and the release wrapper only withholds reads.
    const store = new ReleasableContentStore(built.storage.content);
    const prompt = (await store.put(encoder.encode("assembled"))).ref;
    const output = (await store.put(encoder.encode("response"))).ref;
    const seeded = seedRunningTurn(
        built,
        {},
        catalog.length === 0
            ? []
            : [
                  new PlacementPin({
                      facet: new FacetRef("memory:primary"),
                      manifest: ["dynamic"],
                      policy: ["dynamic"],
                      substrate: ["dynamic"],
                      trust: ["dynamic"],
                      selected: "dynamic"
                  })
              ]
    );
    const port = new ObservingModelPort(output);
    return {
        seeded,
        faults: built.faults,
        content: store,
        output,
        port,
        host: (executor, chosen = port, offered = catalog) =>
            new TurnExecutorHost({
                runtime: seeded.runtime,
                cutPoints: new UncontributedCutPoints(),
                executor,
                content: store,
                operations: { resolve: async () => offered },
                prompt: { assemble: async () => prompt },
                invocations: {
                    invoke: async () => ({ tier: "direct" as const, output: {} })
                },
                model: { call: chosen.call },
                stream: { publish: async () => undefined },
                now: () => new Date(2_000)
            })
    };
}

describe("Turn model input", () => {
    it(
        "[C13-TURN-MODEL-INPUT-RECONSTRUCTABLE] replays the exact request bytes from committed records inline, by reference, and across a restart",
        { tags: "p0" },
        async () => {
            const read = tool("memory.read", "read");
            const base = await fixture([read]);
            const inline = encoder.encode("inline section");
            const referenced = (await base.content.put(encoder.encode("referenced section"))).ref;
            let exchange: TurnModelExchange | undefined;
            const executor = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                exchange = await context.model.call({
                    covers,
                    sections: [
                        section("inline", TurnShownContent.inline(inline)),
                        section("referenced", TurnShownContent.reference(referenced))
                    ],
                    catalog: [context.operations[0]!],
                    admitted: []
                });
                return context.outcome.succeed(
                    resultCommit(context, "replay-result", exchange.input, base.output)
                );
            });

            await expect(base.host(executor).execute(base.seeded.token)).resolves.toMatchObject({
                kind: "succeeded"
            });
            const input = exchange!.input;
            const sent = base.port.bytes[0]!;

            // Inline and by-reference sections both rebuild, in the recorded order.
            const live = new TurnModelInputReplay({
                repository: base.seeded.repository,
                content: base.content
            });
            const replayed = await live.reconstruct(input);
            expect(turnModelRequestBytes(replayed)).toEqual(sent);
            expect(replayed.sections.map((entry) => new TextDecoder().decode(entry.bytes))).toEqual(
                ["inline section", "referenced section"]
            );
            expect(replayed.catalog).toEqual([read]);
            expect(replayed.baseCommit).toEqual(ids.root);

            // The restart discards every executor process and keeps only the records, whose
            // one aggregate snapshot carries the Run's content custody with them.
            const reopened = new MemoryRunStorage(
                ids.holder.tenantId,
                ids.actor,
                base.seeded.storage.snapshot()
            );
            const restarted = new TurnModelInputReplay({
                repository: new RunRepository(reopened),
                content: reopened.content
            });
            expect(turnModelRequestBytes(await restarted.reconstruct(input))).toEqual(sent);
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-RECONSTRUCTABLE] refuses model-visible content that no committed record carries",
        { tags: "p0" },
        async () => {
            const read = tool("memory.read", "read");
            const write = tool("memory.write", "write");
            const base = await fixture([read]);
            const stray = inboxEntry("stray", 0, "turn.message", content("b"));
            const failures: string[] = [];
            const executor = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                for (const draft of [
                    { covers, sections: [], catalog: [], admitted: [] },
                    {
                        covers,
                        sections: [section("s", TurnShownContent.inline(encoder.encode("s")))],
                        catalog: [write],
                        admitted: []
                    },
                    {
                        covers,
                        sections: [section("s", TurnShownContent.inline(encoder.encode("s")))],
                        catalog: [],
                        admitted: [stray]
                    }
                ] satisfies readonly TurnModelInputAssembly[]) {
                    try {
                        await context.model.call(draft);
                        failures.push("accepted");
                    } catch (error) {
                        failures.push(error instanceof AgentCoreError ? error.code : "TypeError");
                    }
                }
                const exchange = await context.model.call({
                    covers,
                    sections: [section("s", TurnShownContent.inline(encoder.encode("s")))],
                    catalog: [context.operations[0]!],
                    admitted: []
                });
                return context.outcome.succeed(
                    resultCommit(context, "stray-result", exchange.input, base.output)
                );
            });

            await expect(base.host(executor).execute(base.seeded.token)).resolves.toMatchObject({
                kind: "succeeded"
            });
            expect(failures).toEqual(["TypeError", "operation.missing", "turn.invalid-state"]);
            expect(base.port.calls).toHaveLength(1);
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-RECONSTRUCTABLE] holds only the observed bytes, never a digest of them and never a bare record that an interceptor ran",
        { tags: "p1" },
        () => {
            const shown = TurnShownContent.inline(encoder.encode("rewritten"));
            expect(shown.inlineBytes()).toEqual(encoder.encode("rewritten"));
            expect(shown.ref).toBeUndefined();
            expect(TurnShownContent.reference(content("a")).inlineBytes()).toBeUndefined();
            const digest = Digest.sha256(encoder.encode("rewritten"));
            for (const malformed of [
                {},
                { digest: digest.value },
                { interceptor: "prompt.assemble" },
                { inline: "cmV3cml0dGVu", ref: content("a").value }
            ]) {
                expect(() => TurnShownContent.fromData(malformed)).toThrow(TypeError);
            }
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-RECONSTRUCTABLE] names every admitted Event's content in the request and leaves an unadmitted Event out of it",
        { tags: "p0" },
        async () => {
            const base = await fixture();
            const first = (await base.content.put(encoder.encode("delivered one"))).ref;
            const second = (await base.content.put(encoder.encode("delivered two"))).ref;
            const admitted = inboxEntry("admitted", 0, "turn.message", first);
            const ignored = inboxEntry("ignored", 1, "turn.message", second);
            let revision = base.seeded.running.revision;
            for (const entry of [admitted, ignored]) {
                base.seeded.runtime.deliverEvent(
                    ids.turn,
                    revision,
                    base.seeded.token,
                    entry,
                    new Date(2_000)
                );
                revision = base.seeded.repository.transaction(
                    (tx) => base.seeded.repository.loadTurn(tx, ids.turn)!.revision
                );
            }
            let exchange: TurnModelExchange | undefined;
            const executor = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                exchange = await context.model.call({
                    covers,
                    sections: [section("s", TurnShownContent.inline(encoder.encode("s")))],
                    catalog: [],
                    admitted: [admitted]
                });
                return context.outcome.succeed(
                    resultCommit(context, "custody-result", exchange.input, base.output)
                );
            });
            await expect(base.host(executor).execute(base.seeded.token)).resolves.toMatchObject({
                kind: "succeeded"
            });

            const record = base.seeded.repository.transaction((tx) =>
                base.seeded.repository.loadCommit(tx, exchange!.input)
            );
            const document = TurnModelInput.decode(await base.content.get(record!.content!));
            expect(document.admitted.map((entry) => entry.content.value)).toEqual([first.value]);
            expect(document.admissionCut).toBe(2);

            // The committed model input names the admitted Event's content itself, so a
            // replay rebuilds the request whole from a store that answers no inbox row.
            const inboxFree = new RunRepository(
                new InboxlessRunStorage(
                    ids.holder.tenantId,
                    ids.actor,
                    base.seeded.storage.snapshot()
                )
            );
            const replayed = await new TurnModelInputReplay({
                repository: inboxFree,
                content: base.content
            }).reconstruct(exchange!.input);
            expect(replayed.admitted.map((entry) => new TextDecoder().decode(entry.bytes))).toEqual(
                ["delivered one"]
            );
            expect(turnModelRequestBytes(replayed)).toEqual(base.port.bytes[0]);
        }
    );

    it.each(dispatchRefusals)(
        "[C13-TURN-MODEL-INPUT-DURABLE-BEFORE-DISPATCH] refuses to dispatch on %s",
        { tags: "p0" },
        async (_, fault) => {
            const base = await fixture();
            base.faults.arm(fault);
            let refusal: AgentCoreError | undefined;
            const executor = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                try {
                    await context.model.call({
                        covers,
                        sections: [section("s", TurnShownContent.inline(encoder.encode("s")))],
                        catalog: [],
                        admitted: []
                    });
                } catch (error) {
                    refusal = error instanceof AgentCoreError ? error : undefined;
                }
                // A refused dispatch ends the Turn through the §5.3 lifecycle without a
                // model call rather than surfacing as a model-call failure.
                return context.outcome.fail(
                    resultCommit(context, `refused-${fault}`, ids.root, base.output)
                );
            });

            await expect(base.host(executor).execute(base.seeded.token)).resolves.toMatchObject({
                kind: "failed"
            });
            expect(base.faults.unfired).toBe(0);
            expect(refusal?.code).toBe("turn.model-input-undurable");
            expect(base.port.calls).toHaveLength(0);
            expect(
                base.seeded.repository
                    .transaction((tx) => base.seeded.repository.listCommits(tx))
                    .filter((commit) => commit.kind === "modelInput")
            ).toEqual([]);
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-DURABLE-BEFORE-DISPATCH] a fenced Turn's rejected commit prevents dispatch and leaves the branch head where it was",
        { tags: "p0" },
        async () => {
            const base = await fixture();
            const executor = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                base.seeded.runtime.reclaimTurn(
                    ids.turn,
                    base.seeded.running.revision,
                    ids.holder,
                    new Date(6_000),
                    new Date(10_000),
                    cancellationEntry("fence", base.output)
                );
                await expect(
                    context.model.call({
                        covers,
                        sections: [section("s", TurnShownContent.inline(encoder.encode("s")))],
                        catalog: [],
                        admitted: []
                    })
                ).rejects.toMatchObject({ code: "lease.invalid" });
                return context.outcome.cancelled();
            });

            await expect(base.host(executor).execute(base.seeded.token)).resolves.toMatchObject({
                kind: "cancelled"
            });
            expect(base.port.calls).toHaveLength(0);
            expect(
                base.seeded.repository.transaction(
                    (tx) => base.seeded.repository.loadBranch(tx, ids.branch)!.head
                )
            ).toEqual(ids.root);
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-DURABLE-BEFORE-DISPATCH] the port observes its request already durable on entry, which no after-the-fact record inspection could establish",
        { tags: "p0" },
        async () => {
            const base = await fixture();
            const ordering = new ObservingModelPort(base.output, (input) =>
                base.seeded.repository.transaction(
                    (tx) => base.seeded.repository.loadCommit(tx, input) !== undefined
                )
            );
            const executor = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                const exchange = await context.model.call({
                    covers,
                    sections: [section("s", TurnShownContent.inline(encoder.encode("s")))],
                    catalog: [],
                    admitted: []
                });
                return context.outcome.succeed(
                    resultCommit(context, "ordered-result", exchange.input, base.output)
                );
            });

            await expect(
                base.host(executor, ordering).execute(base.seeded.token)
            ).resolves.toMatchObject({ kind: "succeeded" });
            expect(ordering.durableOnEntry).toEqual([true]);
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-DURABLE-BEFORE-DISPATCH] settles an unknown outcome by re-reading that exact commit rather than assuming either branch",
        { tags: "p0" },
        async () => {
            const base = await fixture();
            base.faults.arm("unknownAfterCommit");
            const ordering = new ObservingModelPort(base.output, (input) =>
                base.seeded.repository.transaction(
                    (tx) => base.seeded.repository.loadCommit(tx, input) !== undefined
                )
            );
            const executor = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                const exchange = await context.model.call({
                    covers,
                    sections: [section("s", TurnShownContent.inline(encoder.encode("s")))],
                    catalog: [],
                    admitted: []
                });
                return context.outcome.succeed(
                    resultCommit(context, "unknown-result", exchange.input, base.output)
                );
            });

            await expect(
                base.host(executor, ordering).execute(base.seeded.token)
            ).resolves.toMatchObject({ kind: "succeeded" });
            expect(base.faults.unfired).toBe(0);
            expect(ordering.durableOnEntry).toEqual([true]);
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-DURABLE-BEFORE-DISPATCH] reaches durability on a further attempt at that same commit, and fails without a model call when its attempts are exhausted",
        { tags: "p0" },
        async () => {
            const retried = await fixture();
            retried.faults.arm("unavailable");
            const draft: Omit<TurnModelInputAssembly, "covers"> = {
                sections: [section("s", TurnShownContent.inline(encoder.encode("s")))],
                catalog: [],
                admitted: []
            };
            const attempts: RunCommitId[] = [];
            const executor = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    try {
                        const exchange = await context.model.call({ ...draft, covers });
                        attempts.push(exchange.input);
                        return context.outcome.succeed(
                            resultCommit(context, "retried-result", exchange.input, retried.output)
                        );
                    } catch (error) {
                        if (
                            !(error instanceof AgentCoreError) ||
                            error.code !== "turn.model-input-undurable"
                        ) {
                            throw error;
                        }
                    }
                }
                throw new TypeError("The retry never reached durability");
            });

            await expect(
                retried.host(executor).execute(retried.seeded.token)
            ).resolves.toMatchObject({ kind: "succeeded" });
            expect(retried.faults.unfired).toBe(0);
            expect(retried.port.calls).toHaveLength(1);
            expect(attempts[0]!.value.startsWith("model-input:")).toBe(true);

            const exhausted = await fixture();
            exhausted.faults.arm("unavailable", "unavailable");
            const giveUp = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    try {
                        await context.model.call({ ...draft, covers });
                    } catch {
                        continue;
                    }
                }
                return context.outcome.fail(
                    resultCommit(context, "exhausted-result", ids.root, exhausted.output)
                );
            });
            await expect(
                exhausted.host(giveUp).execute(exhausted.seeded.token)
            ).resolves.toMatchObject({ kind: "failed" });
            expect(exhausted.faults.unfired).toBe(0);
            expect(exhausted.port.calls).toHaveLength(0);
        }
    );

    it.each(retentionLosses)(
        "[C13-TURN-MODEL-INPUT-RETENTION-LOSS] fails typed on %s and names what is missing",
        { tags: "p0" },
        async (_, lost) => {
            const base = await fixture();
            const sectionRef = (await base.content.put(encoder.encode("retained section"))).ref;
            const eventRef = (await base.content.put(encoder.encode("retained event"))).ref;
            const admitted = inboxEntry("retained", 0, "turn.message", eventRef);
            base.seeded.runtime.deliverEvent(
                ids.turn,
                base.seeded.running.revision,
                base.seeded.token,
                admitted,
                new Date(2_000)
            );
            let exchange: TurnModelExchange | undefined;
            const executor = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                exchange = await context.model.call({
                    covers,
                    sections: [section("retained", TurnShownContent.reference(sectionRef))],
                    catalog: [],
                    admitted: [admitted]
                });
                return context.outcome.succeed(
                    resultCommit(context, `retention-${lost}`, exchange.input, base.output)
                );
            });
            await expect(base.host(executor).execute(base.seeded.token)).resolves.toMatchObject({
                kind: "succeeded"
            });
            const sent = base.port.bytes[0]!;
            const replay = new TurnModelInputReplay({
                repository: base.seeded.repository,
                content: base.content
            });
            expect(turnModelRequestBytes(await replay.reconstruct(exchange!.input))).toEqual(sent);

            base.content.release(lost === "section" ? sectionRef : eventRef);
            let failure: AgentCoreError | undefined;
            try {
                await replay.reconstruct(exchange!.input);
            } catch (error) {
                if (error instanceof AgentCoreError) failure = error;
            }
            expect(failure?.code).toBe("run.model-input-unrebuildable");
            expect(failure?.message).toContain(
                lost === "section" ? sectionRef.value : eventRef.value
            );
            expect(failure?.message).toContain(
                lost === "section" ? "prompt section retained" : "admitted Event retained"
            );
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-RETENTION-LOSS] never yields a shorter prefix, a partial request, or an approximation",
        { tags: "p0" },
        async () => {
            const base = await fixture();
            const kept = (await base.content.put(encoder.encode("kept"))).ref;
            const lost = (await base.content.put(encoder.encode("lost"))).ref;
            let exchange: TurnModelExchange | undefined;
            let observed: readonly RunCommitId[] = [];
            const executor = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                observed = covers;
                exchange = await context.model.call({
                    covers,
                    sections: [
                        section("kept", TurnShownContent.reference(kept)),
                        section("lost", TurnShownContent.reference(lost))
                    ],
                    catalog: [],
                    admitted: []
                });
                return context.outcome.succeed(
                    resultCommit(context, "prefix-result", exchange.input, base.output)
                );
            });
            await expect(base.host(executor).execute(base.seeded.token)).resolves.toMatchObject({
                kind: "succeeded"
            });
            const sent = base.port.bytes[0]!;
            base.content.release(lost);
            const replay = new TurnModelInputReplay({
                repository: base.seeded.repository,
                content: base.content
            });

            // A prefix over the surviving section would compare equal to a re-assembly of
            // the same degraded records, so the compare is against the request as sent.
            await expect(replay.reconstruct(exchange!.input)).rejects.toMatchObject({
                code: "run.model-input-unrebuildable"
            });
            expect(sent).not.toEqual(
                turnModelRequestBytes({
                    input: exchange!.input,
                    baseCommit: ids.root,
                    covers: observed,
                    sections: [
                        {
                            name: new TurnPromptSectionName("kept"),
                            bytes: encoder.encode("kept"),
                            omission: TurnOmission.none
                        }
                    ],
                    catalog: [],
                    admitted: [],
                    admissionCut: 0
                })
            );
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-ABRIDGED] reconstructs exactly the abridged bytes the model observed and states the withheld amount",
        { tags: "p0" },
        async () => {
            const base = await fixture();
            const whole = encoder.encode("0123456789");
            const abridged = whole.slice(0, 4);
            const wholeRef = (await base.content.put(whole)).ref;
            let exchange: TurnModelExchange | undefined;
            const executor = new FunctionExecutor(async (context) => {
                const covers = await context.modelInput.accountable();
                exchange = await context.model.call({
                    covers,
                    sections: [
                        section(
                            "result",
                            TurnShownContent.inline(abridged),
                            TurnOmission.exact(whole.length - abridged.length)
                        ),
                        section(
                            "stream",
                            TurnShownContent.inline(encoder.encode("head")),
                            TurnOmission.unknown
                        ),
                        section("whole", TurnShownContent.reference(wholeRef))
                    ],
                    catalog: [],
                    admitted: []
                });
                return context.outcome.succeed(
                    resultCommit(context, "abridged-result", exchange.input, base.output)
                );
            });
            await expect(base.host(executor).execute(base.seeded.token)).resolves.toMatchObject({
                kind: "succeeded"
            });

            const observed = base.port.calls[0]!;
            expect(observed.sections[0]!.bytes).toEqual(abridged);
            expect(observed.sections[0]!.bytes).not.toEqual(whole);
            expect(observed.sections.map((entry) => entry.omission)).toEqual([
                TurnOmission.exact(6),
                TurnOmission.unknown,
                TurnOmission.none
            ]);
            expect(observed.sections[1]!.omission.withheldBytes).toBeUndefined();
            const replayed = await new TurnModelInputReplay({
                repository: base.seeded.repository,
                content: base.content
            }).reconstruct(exchange!.input);
            expect(turnModelRequestBytes(replayed)).toEqual(base.port.bytes[0]);
            expect(replayed.sections[0]!.bytes).toEqual(abridged);
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-ABRIDGED] distinguishes withholding nothing from withholding an unknown amount and refuses to express a guess as exact",
        { tags: "p0" },
        () => {
            expect(TurnOmission.none.kind).toBe("none");
            expect(TurnOmission.none.withheldBytes).toBeUndefined();
            expect(TurnOmission.unknown.kind).toBe("unknown");
            expect(TurnOmission.none.equals(TurnOmission.unknown)).toBe(false);
            expect(TurnOmission.none.equals(TurnOmission.exact(1))).toBe(false);
            for (const invalid of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
                expect(() => TurnOmission.exact(invalid)).toThrow(TypeError);
            }
            expect(TurnOmission.none.toData()).toEqual({ kind: "none" });
            expect(TurnOmission.exact(3).toData()).toEqual({ kind: "exact", withheldBytes: 3 });
            expect(TurnOmission.unknown.toData()).toEqual({ kind: "unknown" });
            for (const malformed of [
                { kind: "unknown", withheldBytes: 3 },
                { kind: "none", withheldBytes: 0 },
                { kind: "truncated" },
                { kind: "partiallySucceeded" },
                { kind: "exact" }
            ]) {
                expect(() => TurnOmission.fromData(malformed)).toThrow(TypeError);
            }
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-ABRIDGED] records a budget omission and an incompletely covered source as different requests, neither reachable from the other's inputs",
        { tags: "p1" },
        () => {
            const whole = encoder.encode("0123456789");
            const abridgedComplete = new TurnModelInput({
                covers: [],
                sections: [
                    section(
                        "result",
                        TurnShownContent.inline(whole.slice(0, 4)),
                        TurnOmission.exact(6)
                    )
                ],
                catalog: [],
                admitted: [],
                admissionCut: 0
            });
            const incompleteShownWhole = new TurnModelInput({
                covers: [],
                sections: [section("result", TurnShownContent.inline(whole.slice(0, 4)))],
                catalog: [],
                admitted: [],
                admissionCut: 0
            });
            expect(TurnModelInput.encode(abridgedComplete)).not.toEqual(
                TurnModelInput.encode(incompleteShownWhole)
            );
            expect(abridgedComplete.sections[0]!.omission).toEqual(TurnOmission.exact(6));
            expect(incompleteShownWhole.sections[0]!.omission).toEqual(TurnOmission.none);

            // The request carries the omission and nothing about the source's own coverage;
            // a §7.4 completeness field is not a member of this record's exact shape.
            const withCoverage = mutableData(abridgedComplete.toData());
            withCoverage["partiallySucceeded"] = true;
            expect(() => TurnModelInput.fromData(withCoverage)).toThrow(TypeError);
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-RECONSTRUCTABLE] [turn.model-input] provides static codec, encode, decode, and frozen records with an exact shape",
        { tags: "p1" },
        () => {
            const record = new TurnModelInput({
                covers: [],
                sections: [
                    section("system", TurnShownContent.inline(encoder.encode("rules"))),
                    section(
                        "result",
                        TurnShownContent.reference(content("b")),
                        TurnOmission.exact(12)
                    )
                ],
                catalog: [tool("memory.read", "read")],
                admitted: [
                    new TurnAdmittedEvent(
                        new TurnInboxEntryId("admitted"),
                        1,
                        "turn.message",
                        content("c")
                    )
                ],
                admissionCut: 4
            });

            expect(TurnModelInput.codec.kind).toBe("turn.model-input");
            expect(TurnModelInput.codec.version).toEqual({ major: 1, minor: 0 });
            expect(Object.isFrozen(record)).toBe(true);
            const decoded = TurnModelInput.decode(TurnModelInput.encode(record));
            expect(Object.isFrozen(decoded)).toBe(true);
            expect(TurnModelInput.encode(decoded)).toEqual(TurnModelInput.encode(record));
            expect(decoded.catalog).toEqual(record.catalog);
            expect(decoded.admitted[0]!.content).toEqual(content("c"));
            expect(decoded.sections[1]!.omission).toEqual(TurnOmission.exact(12));

            const foreign = mutableData(record.toData());
            foreign["extra"] = 1;
            const sectionless = mutableData(record.toData());
            sectionless["sections"] = [];
            const shortCut = mutableData(record.toData());
            shortCut["admissionCut"] = 1;
            for (const malformed of [foreign, sectionless, shortCut]) {
                expect(() => TurnModelInput.fromData(malformed)).toThrow(TypeError);
            }
        }
    );

    it(
        "[C13-RUN-DISTINCTION-REPRESENTABLE] tells a commit carried in fully abridged form from one carried whole, and leaves a surface that attributes nothing byte-identical",
        { tags: "p0" },
        () => {
            const first = new RunCommitId("carried-first");
            const second = new RunCommitId("carried-second");
            const shown = encoder.encode("first only");
            // One section renders two commits and drops every byte of the second one.
            const base = {
                sections: [
                    section("transcript", TurnShownContent.inline(shown), TurnOmission.exact(6))
                ],
                catalog: [],
                admitted: [],
                admissionCut: 0,
                covers: [first, second]
            } satisfies TurnModelInputInit;
            const attributed = new TurnModelInput({
                ...base,
                withheld: [new TurnCommitOmission(second, TurnOmission.exact(6))]
            });
            // The same two commits carried whole: the sections withhold nothing, so there is
            // nothing to attribute and the record attributes nothing.
            const whole = new TurnModelInput({
                ...base,
                sections: [section("transcript", TurnShownContent.inline(shown))]
            });

            // Same coverage, and the attribution is the only thing that tells the abridged
            // commit from the whole one.
            expect(attributed.covers.map((commit) => commit.value)).toEqual(
                whole.covers.map((commit) => commit.value)
            );
            expect(attributed.withheld.map((entry) => entry.commit.value)).toEqual([second.value]);
            expect(attributed.withheld[0]!.omission).toEqual(TurnOmission.exact(6));
            expect(whole.withheld).toEqual([]);
            expect(TurnModelInput.encode(attributed)).not.toEqual(TurnModelInput.encode(whole));

            // The record that states neither is the one the rule forbids: it carries both
            // commits, withholds six bytes of one of them, and attributes that withholding to
            // nothing. It is refused rather than recorded, so no reader has to guess.
            expect(() => new TurnModelInput(base)).toThrow(AgentCoreError);

            const decoded = TurnModelInput.decode(TurnModelInput.encode(attributed));
            expect(decoded.withheld[0]!.commit.value).toBe(second.value);
            expect(decoded.withheld[0]!.omission).toEqual(TurnOmission.exact(6));
            expect(TurnModelInput.encode(decoded)).toEqual(TurnModelInput.encode(attributed));

            // The encoding a surface that attributes nothing had before the field existed,
            // written out here rather than derived: the key is absent and the codec version is
            // where it was, so every `modelInput` identity derived from these bytes stands.
            expect(TurnModelInput.encode(whole)).toEqual(
                encodeCanonicalJson({
                    kind: "turn.model-input",
                    version: { major: 1, minor: 0 },
                    payload: {
                        admissionCut: 0,
                        admitted: [],
                        catalog: [],
                        covers: [first.value, second.value],
                        sections: [
                            {
                                name: "transcript",
                                omission: { kind: "none" },
                                shown: { inline: encodeBase64(shown) }
                            }
                        ]
                    }
                })
            );
            // A surface that carries one commit attributes its whole withholding to that
            // commit already, so an abridged one writes those same pre-field bytes too.
            expect(TurnModelInput.encode(new TurnModelInput({ ...base, covers: [first] }))).toEqual(
                encodeCanonicalJson({
                    kind: "turn.model-input",
                    version: { major: 1, minor: 0 },
                    payload: {
                        admissionCut: 0,
                        admitted: [],
                        catalog: [],
                        covers: [first.value],
                        sections: [
                            {
                                name: "transcript",
                                omission: { kind: "exact", withheldBytes: 6 },
                                shown: { inline: encodeBase64(shown) }
                            }
                        ]
                    }
                })
            );
        }
    );

    it(
        "[C13-RUN-DISTINCTION-REPRESENTABLE] refuses an attribution outside the coverage, a repeated commit, a commit carried whole, and a total its sections contradict",
        { tags: "p0" },
        () => {
            const carried = new RunCommitId("carried-first");
            const stranger = new RunCommitId("uncarried");
            const shown = TurnShownContent.inline(encoder.encode("shown"));
            const surface =
                (sections: readonly TurnPromptSection[], withheld: readonly TurnCommitOmission[]) =>
                () =>
                    new TurnModelInput({
                        sections,
                        catalog: [],
                        admitted: [],
                        admissionCut: 0,
                        covers: [carried],
                        withheld
                    });
            const abridged = [section("transcript", shown, TurnOmission.exact(10))];
            const whole = [section("transcript", shown)];

            // Withholding nothing is the absence of an entry rather than an entry.
            expect(() => new TurnCommitOmission(carried, TurnOmission.none)).toThrow(TypeError);
            // An omission attributed to content this record never carried.
            expect(
                surface(abridged, [new TurnCommitOmission(stranger, TurnOmission.exact(10))])
            ).toThrow(TypeError);
            // One commit's withholding, stated twice.
            expect(
                surface(abridged, [
                    new TurnCommitOmission(carried, TurnOmission.exact(4)),
                    new TurnCommitOmission(carried, TurnOmission.exact(6))
                ])
            ).toThrow(TypeError);
            // A second, contradictory total: sections that withheld nothing at all, and a
            // section total smaller than the attribution claims.
            expect(
                surface(whole, [new TurnCommitOmission(carried, TurnOmission.exact(10))])
            ).toThrow(TypeError);
            expect(surface(whole, [new TurnCommitOmission(carried, TurnOmission.unknown)])).toThrow(
                TypeError
            );
            expect(
                surface(abridged, [new TurnCommitOmission(carried, TurnOmission.exact(11))])
            ).toThrow(TypeError);
            // A section that withheld an unknown amount states no total to contradict.
            expect(
                surface(
                    [section("transcript", shown, TurnOmission.unknown)],
                    [new TurnCommitOmission(carried, TurnOmission.exact(4_000))]
                )
            ).not.toThrow();
            // A structural stand-in is not the canonical value.
            const impostor: TurnCommitOmission = Object.freeze({
                commit: carried,
                omission: TurnOmission.unknown,
                toData: () => ({ commit: carried.value, omission: TurnOmission.unknown.toData() })
            });
            expect(surface(abridged, [impostor])).toThrow(TypeError);

            // Absence has exactly one encoding — no key, never an empty list — and every
            // encoded entry decodes through the constructor that refuses a whole commit.
            const record = surface(abridged, [
                new TurnCommitOmission(carried, TurnOmission.exact(10))
            ])();
            const emptied = mutableData(record.toData());
            emptied["withheld"] = [];
            const nameless = mutableData(record.toData());
            nameless["withheld"] = [{ commit: carried.value }];
            const nothingWithheld = mutableData(record.toData());
            nothingWithheld["withheld"] = [{ commit: carried.value, omission: { kind: "none" } }];
            for (const malformed of [emptied, nameless, nothingWithheld]) {
                expect(() => TurnModelInput.fromData(malformed)).toThrow(TypeError);
            }
        }
    );

    it(
        "[C13-RUN-DISTINCTION-REPRESENTABLE] refuses a multi-commit surface that attributes nothing, one commit short, or nothing an unknown amount reaches",
        { tags: "p0" },
        () => {
            const first = new RunCommitId("carried-first");
            const second = new RunCommitId("carried-second");
            const shown = TurnShownContent.inline(encoder.encode("neither in full"));
            const surface =
                (omission: TurnOmission, withheld: readonly TurnCommitOmission[]) => () =>
                    new TurnModelInput({
                        sections: [section("transcript", shown, omission)],
                        catalog: [],
                        admitted: [],
                        admissionCut: 0,
                        covers: [first, second],
                        withheld
                    });
            const refusalOf = (build: () => TurnModelInput): AgentCoreError => {
                try {
                    build();
                } catch (error) {
                    if (error instanceof AgentCoreError) return error;
                    throw error;
                }
                throw new TypeError("Expected the surface to be refused");
            };

            // Nothing attributed at all: the section drops thirty bytes of two carried
            // commits and says which of them held none of them.
            const silent = refusalOf(surface(TurnOmission.exact(30), []));
            expect(silent.code).toBe("turn.model-input-unaccounted");
            expect(silent.message).toContain("carries 2 commits");
            // One commit short: twenty of the thirty withheld bytes belong to a commit the
            // attribution does not name, which is exactly the commit a reader would read as
            // carried whole.
            const short = refusalOf(
                surface(TurnOmission.exact(30), [
                    new TurnCommitOmission(first, TurnOmission.exact(10))
                ])
            );
            expect(short.code).toBe("turn.model-input-unaccounted");
            expect(short.message).toContain("attributes 10 of the 30 bytes");
            // An unknown withholding that every attributed amount claims to measure closes no
            // account, so the unknown travels into the attribution or the record is refused.
            const measured = refusalOf(
                surface(TurnOmission.unknown, [
                    new TurnCommitOmission(first, TurnOmission.exact(10))
                ])
            );
            expect(measured.code).toBe("turn.model-input-unaccounted");
            expect(measured.message).toContain("closes no account");

            // A total the sections contradict stays the malformed-entry refusal it was: the
            // entry claims more than the surface withheld at all.
            expect(
                surface(TurnOmission.exact(30), [
                    new TurnCommitOmission(first, TurnOmission.exact(31))
                ])
            ).toThrow(TypeError);

            // Both accounts a surface may state: the exact amounts that close, and the open
            // one an unknown amount leaves.
            expect(
                surface(TurnOmission.exact(30), [
                    new TurnCommitOmission(first, TurnOmission.exact(10)),
                    new TurnCommitOmission(second, TurnOmission.exact(20))
                ])
            ).not.toThrow();
            expect(
                surface(TurnOmission.unknown, [new TurnCommitOmission(first, TurnOmission.unknown)])
            ).not.toThrow();

            // A stored surface is held to the same rule on the way out, so a restart cannot
            // read back a record the seam would have refused. The attribution one commit short
            // and the attribution absent altogether both fail at decode.
            const complete = surface(TurnOmission.exact(30), [
                new TurnCommitOmission(first, TurnOmission.exact(10)),
                new TurnCommitOmission(second, TurnOmission.exact(20))
            ])();
            const storedShort = mutableData(complete.toData());
            storedShort["withheld"] = [
                { commit: first.value, omission: { kind: "exact", withheldBytes: 10 } }
            ];
            const storedSilent = mutableData(
                new TurnModelInput({
                    sections: [section("transcript", shown, TurnOmission.exact(30))],
                    catalog: [],
                    admitted: [],
                    admissionCut: 0,
                    covers: [first]
                }).toData()
            );
            storedSilent["covers"] = [first.value, second.value];
            for (const stored of [storedShort, storedSilent]) {
                expect(() => TurnModelInput.fromData(stored)).toThrow(AgentCoreError);
            }
        }
    );

    it(
        "[C13-RUN-DISTINCTION-REPRESENTABLE] writes one record for an attribution stated in any order, and still refuses a commit named twice",
        { tags: "p0" },
        () => {
            const first = new RunCommitId("carried-first");
            const second = new RunCommitId("carried-second");
            const shown = TurnShownContent.inline(encoder.encode("neither in full"));
            const surface = (withheld: readonly TurnCommitOmission[]) => () =>
                new TurnModelInput({
                    sections: [section("transcript", shown, TurnOmission.exact(30))],
                    catalog: [],
                    admitted: [],
                    admissionCut: 0,
                    covers: [first, second],
                    withheld
                });
            const held = new TurnCommitOmission(first, TurnOmission.exact(10));
            const dropped = new TurnCommitOmission(second, TurnOmission.exact(20));

            // Which commit an omission belonged to is a fact about one commit, and a set of
            // those facts has no order, so the caller's order reaches neither the record nor
            // the identity a `modelInput` commit derives from its bytes.
            const ascending = surface([held, dropped])();
            const descending = surface([dropped, held])();
            expect(descending.withheld.map((entry) => entry.commit.value)).toEqual([
                first.value,
                second.value
            ]);
            expect(TurnModelInput.encode(descending)).toEqual(TurnModelInput.encode(ascending));

            // A stored record whose entries were written in the other order reads back as the
            // one canonical record too.
            const stored = mutableData(ascending.toData());
            stored["withheld"] = [dropped.toData(), held.toData()];
            expect(TurnModelInput.encode(TurnModelInput.fromData(stored))).toEqual(
                TurnModelInput.encode(ascending)
            );

            // Order is not licence to state one commit's withholding twice, however it adds up.
            expect(surface([held, new TurnCommitOmission(first, TurnOmission.exact(20))])).toThrow(
                TypeError
            );
        }
    );

    it(
        "[C13-TURN-CANCEL-INBOX] hides a mid-step delivery from the running step and names it in the next step's committed record",
        { tags: "p0" },
        async () => {
            const base = await fixture();
            const payload = (await base.content.put(encoder.encode("delivered mid-step"))).ref;
            const arrival = inboxEntry("mid-step", 0, "turn.message", payload);
            const opened: string[] = [];
            const inputs: RunCommitId[] = [];
            const executor = new FunctionExecutor(async (context) => {
                const running = await context.step.open();
                const before = await context.model.call({
                    covers: await context.modelInput.accountable(),
                    sections: [section("s", TurnShownContent.inline(encoder.encode("before")))],
                    catalog: [],
                    admitted: []
                });
                inputs.push(before.input);
                // The delivery lands while that step is running, after it opened its cut.
                base.seeded.runtime.deliverEvent(
                    ids.turn,
                    base.seeded.running.revision,
                    base.seeded.token,
                    arrival,
                    new Date(2_000)
                );
                opened.push(`step ${running.step.ordinal} cut ${running.step.inboxCut}`);
                const next = await context.step.open();
                opened.push(`step ${next.step.ordinal} cut ${next.step.inboxCut}`);
                const after = await context.model.call({
                    covers: await context.modelInput.accountable(),
                    sections: [section("s", TurnShownContent.inline(encoder.encode("after")))],
                    catalog: [],
                    admitted: [arrival]
                });
                inputs.push(after.input);
                return context.outcome.succeed(
                    resultCommit(context, "mid-step-result", after.input, base.output)
                );
            });
            await expect(base.host(executor).execute(base.seeded.token)).resolves.toMatchObject({
                kind: "succeeded"
            });

            // The step that was running opened on an empty inbox and stays there; the next
            // step opens on the arrival.
            expect(opened).toEqual(["step 0 cut 0", "step 1 cut 1"]);

            // The causal evidence is in the records rather than in the executor: a store
            // reopened from the snapshot alone answers which call admitted the Event.
            const reopened = new MemoryRunStorage(
                ids.holder.tenantId,
                ids.actor,
                base.seeded.storage.snapshot()
            );
            const replay = new TurnModelInputReplay({
                repository: new RunRepository(reopened),
                content: reopened.content
            });
            const first = await replay.reconstruct(inputs[0]!);
            const second = await replay.reconstruct(inputs[1]!);
            expect(first.admitted).toEqual([]);
            expect(first.admissionCut).toBe(0);
            expect(second.admitted.map((entry) => entry.entry.value)).toEqual([arrival.id.value]);
            expect(second.admissionCut).toBe(1);
            expect(new TextDecoder().decode(second.admitted[0]!.bytes)).toBe("delivered mid-step");
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-RECONSTRUCTABLE] re-enters the Turn under the same lease after a crash between steps and loses no accepted work",
        { tags: "p0" },
        async () => {
            const base = await fixture();
            const payload = (await base.content.put(encoder.encode("delivered before the crash")))
                .ref;
            const arrival = inboxEntry("survivor", 0, "turn.message", payload);
            base.seeded.runtime.deliverEvent(
                ids.turn,
                base.seeded.running.revision,
                base.seeded.token,
                arrival,
                new Date(2_000)
            );
            const landed: RunCommitId[] = [];
            const crashing = new FunctionExecutor(async (context) => {
                for (const body of ["first", "second"]) {
                    await context.step.open();
                    const exchange = await context.model.call({
                        covers: await context.modelInput.accountable(),
                        sections: [section(body, TurnShownContent.inline(encoder.encode(body)))],
                        catalog: [],
                        admitted: [arrival]
                    });
                    landed.push(exchange.input);
                }
                throw new TypeError("the host died between steps");
            });
            await expect(base.host(crashing).execute(base.seeded.token)).rejects.toThrow(TypeError);
            expect(landed).toHaveLength(2);

            // A rebuilt host: a new executor and a new model port over the same records, under
            // the same lease. Nothing the Turn accepted lived in the process that died.
            const port = new ObservingModelPort(base.output);
            const rebuilt: TurnModelRequest[] = [];
            let inbox: readonly TurnInboxEntry[] = [];
            let head: RunCommitId | undefined;
            const reentering = new FunctionExecutor(async (context) => {
                inbox = await context.inbox.read(0);
                head = base.seeded.repository.transaction(
                    (tx) => base.seeded.repository.loadBranch(tx, ids.branch)!.head
                );
                for (const input of landed) {
                    rebuilt.push(await context.modelInput.reconstruct(input));
                }
                return context.outcome.succeed(
                    resultCommit(context, "reentry-result", head, base.output)
                );
            });
            await expect(
                base.host(reentering, port).execute(base.seeded.token)
            ).resolves.toMatchObject({ kind: "succeeded" });

            // The inbox, the admitted Event, and both model input commits crossed the
            // boundary, and each request rebuilds byte for byte as the first host sent it.
            expect(inbox).toEqual([arrival]);
            expect(head?.value).toBe(landed[1]?.value);
            expect(rebuilt.map((request) => request.input.value)).toEqual(
                landed.map((commit) => commit.value)
            );
            expect(rebuilt.map((request) => turnModelRequestBytes(request))).toEqual(
                base.port.bytes
            );
            expect(rebuilt[1]!.admitted.map((entry) => entry.entry.value)).toEqual([
                arrival.id.value
            ]);
            // The retried step landed on the commits already there: no second request was
            // recorded, and no second model call was made.
            expect(port.calls).toHaveLength(0);
            expect(
                base.seeded.repository
                    .transaction((tx) => base.seeded.repository.listCommits(tx))
                    .filter((commit) => commit.kind === "modelInput")
                    .map((commit) => commit.id.value)
            ).toEqual(landed.map((commit) => commit.value));
        }
    );

    it(
        "[C13-TURN-MODEL-INPUT-DURABLE-BEFORE-DISPATCH] a rebuilt host retrying the step a crash left unrecorded lands that same derived commit",
        { tags: "p0" },
        async () => {
            const draft = (covers: readonly RunCommitId[]): TurnModelInputAssembly => ({
                covers,
                sections: [section("s", TurnShownContent.inline(encoder.encode("one request")))],
                catalog: [],
                admitted: []
            });

            // The control: the same request, at the same parent, in a Run that never faulted.
            const control = await fixture();
            let expected: RunCommitId | undefined;
            const controlled = new FunctionExecutor(async (context) => {
                const exchange = await context.model.call(
                    draft(await context.modelInput.accountable())
                );
                expected = exchange.input;
                return context.outcome.succeed(
                    resultCommit(context, "control-result", exchange.input, control.output)
                );
            });
            await expect(
                control.host(controlled).execute(control.seeded.token)
            ).resolves.toMatchObject({ kind: "succeeded" });

            // The crash: the append is refused, so nothing lands, and the host dies holding
            // the lease.
            const crashed = await fixture();
            crashed.faults.arm("unavailable");
            const crashing = new FunctionExecutor(async (context) => {
                await expect(
                    context.model.call(draft(await context.modelInput.accountable()))
                ).rejects.toMatchObject({ code: "turn.model-input-undurable" });
                throw new TypeError("the host died at the refused append");
            });
            await expect(crashed.host(crashing).execute(crashed.seeded.token)).rejects.toThrow(
                TypeError
            );
            expect(crashed.faults.unfired).toBe(0);
            expect(crashed.port.calls).toHaveLength(0);

            // The rebuilt host retries that step. The identity is derived from the record and
            // the parent, so what it lands is the commit the crash was attempting.
            const port = new ObservingModelPort(crashed.output);
            let retried: RunCommitId | undefined;
            const retrying = new FunctionExecutor(async (context) => {
                const exchange = await context.model.call(
                    draft(await context.modelInput.accountable())
                );
                retried = exchange.input;
                return context.outcome.succeed(
                    resultCommit(context, "retry-result", exchange.input, crashed.output)
                );
            });
            await expect(
                crashed.host(retrying, port).execute(crashed.seeded.token)
            ).resolves.toMatchObject({ kind: "succeeded" });
            expect(retried?.value).toBe(expected?.value);
            expect(port.calls).toHaveLength(1);
            expect(
                crashed.seeded.repository
                    .transaction((tx) => crashed.seeded.repository.listCommits(tx))
                    .filter((commit) => commit.kind === "modelInput")
                    .map((commit) => commit.id.value)
            ).toEqual([expected?.value]);
        }
    );

    it(
        "[C13-TURN-CANCEL-INBOX] stops committing at the step boundary after a mid-step cancellation and keeps what it committed before",
        { tags: "p0" },
        async () => {
            const base = await fixture();
            const cancellation = cancellationEntry("mid-step-cancel", base.output);
            let committed: RunCommitId | undefined;
            let observed: readonly TurnInboxEntry[] = [];
            let abortedInStep = true;
            let abortedAtBoundary = false;
            const executor = new FunctionExecutor(async (context) => {
                await context.step.open();
                const exchange = await context.model.call({
                    covers: await context.modelInput.accountable(),
                    sections: [section("s", TurnShownContent.inline(encoder.encode("accepted")))],
                    catalog: [],
                    admitted: []
                });
                committed = exchange.input;
                // The fence arrives against the live lease, so the holder is the one that has
                // to settle it (SPEC §5.6).
                base.seeded.runtime.deliverEvent(
                    ids.turn,
                    base.seeded.running.revision,
                    base.seeded.token,
                    cancellation,
                    new Date(2_000)
                );
                abortedInStep = context.cancellation.aborted;
                await context.step.open();
                abortedAtBoundary = context.cancellation.aborted;
                observed = await context.inbox.read(0);
                return context.outcome.cancel(
                    resultCommit(context, "cancelled-result", exchange.input, base.output),
                    cancellation
                );
            });
            await expect(base.host(executor).execute(base.seeded.token)).resolves.toMatchObject({
                kind: "cancelled"
            });

            // Nothing inside the step reads the inbox, so the signal is raised where a
            // conforming executor observes it: at the next step boundary.
            expect(abortedInStep).toBe(false);
            expect(abortedAtBoundary).toBe(true);
            expect(observed).toEqual([cancellation]);

            // One model call and one recorded request: the Turn stopped committing at that
            // boundary instead of opening another call.
            expect(base.port.calls).toHaveLength(1);
            expect(
                base.seeded.repository
                    .transaction((tx) => base.seeded.repository.listCommits(tx))
                    .filter((commit) => commit.kind === "modelInput")
                    .map((commit) => commit.id.value)
            ).toEqual([committed?.value]);

            // The work accepted before the cancellation survives it, request and all.
            const replay = new TurnModelInputReplay({
                repository: base.seeded.repository,
                content: base.content
            });
            expect(turnModelRequestBytes(await replay.reconstruct(committed!))).toEqual(
                base.port.bytes[0]
            );
            expect(
                base.seeded.repository.transaction((tx) =>
                    base.seeded.repository.loadTurn(tx, ids.turn)
                )?.status.kind
            ).toBe("cancelled");
        }
    );
});
