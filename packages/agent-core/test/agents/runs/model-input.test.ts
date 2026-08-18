import { describe, expect, it } from "vitest";
import {
    ByteRange,
    ContentStore,
    type ContentPutResult,
    type MediaHint
} from "../../../src/content";
import { ContentRef, Digest, JsonSchema } from "../../../src/core";
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
    seedRunningTurn
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
    const faults = new FaultyRunStorage(ids.holder.tenantId, ids.actor, fixtureMemoryRunSnapshot(), () => new Date(0));
    const repository = new RunRepository(faults);
    const sources = new TestSourcePort<MemoryTransaction>();
    const evidence = new TestEvidencePort<MemoryTransaction>();
    const settlement = new TestSettlementPort<MemoryTransaction>();
    const spawn = new TestSpawnPort<MemoryTransaction>();
    const merge = new TestMergePort<MemoryTransaction>();
    const runtime = new RunRuntime(repository, sources, evidence, settlement, spawn, merge);
    return { storage: faults, faults, repository, sources, evidence, settlement, spawn, merge, runtime };
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
            expect(replayed.sections.map((entry) => new TextDecoder().decode(entry.bytes))).toEqual([
                "inline section",
                "referenced section"
            ]);
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
                return context.outcome.succeed(resultCommit(context, "stray-result", exchange.input, base.output));
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
            expect(
                TurnShownContent.reference(content("a")).inlineBytes()
            ).toBeUndefined();
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
                return context.outcome.fail(resultCommit(context, `refused-${fault}`, ids.root, base.output));
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
                return context.outcome.fail(resultCommit(context, "exhausted-result", ids.root, exhausted.output));
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
                        section("stream", TurnShownContent.inline(encoder.encode("head")), TurnOmission.unknown),
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
        "[turn.model-input] provides static codec, encode, decode, and frozen records with an exact shape",
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
});
