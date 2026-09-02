import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assertObject, parseCanonicalJson, type JsonValue } from "../../scripts/quality/project.mjs";
import {
    ProofObligation,
    ProofRepairCandidate,
    ProofRepairLedger,
    ProofRepairObjective
} from "../../scripts/quality/proof-repair-record.js";
import { DeclaredProofArtifactOwners } from "../../scripts/quality/proof-repair-refusal.js";
import { MemoryProofRepairStore } from "../../scripts/quality/proof-repair-store.js";
import {
    LeanProofCandidateVerification,
    ProofCommand,
    ProofCommandRunner,
    type ProofCommandOutcome
} from "../../scripts/quality/proof-repair-verification.js";
import {
    ProofRepairHost,
    corpusObjective,
    type ProofRepairLoopResult
} from "../../scripts/quality/proof-repair-host.js";
import {
    ProofModelExchange,
    ProofModelExchangeRecord,
    ProofModelUnavailable,
    ProofRepairModelGenerator,
    ProofRepairModelRecording,
    ProofRepairPrompt,
    RecordedProofModelExchange,
    proofModelProposal,
    type ProofModelRequest
} from "../../scripts/quality/proof-repair-model.js";

/**
 * Behavior tests for the live-model proof candidate generator.
 *
 * The landed host and protocol already decide candidates; what has to be proven here is
 * that the adapter between a model and that decision cannot launder anything through
 * itself. Four properties carry the suite.
 *
 * *The loop is driven, not mocked.* The headline case replays a committed recording whose
 * accepted reply is the reviewed `formal/SpecCnl/Proofs.lean` discharge for a real corpus
 * unit and whose refused reply is that same proof with a case deleted. The real protocol
 * refuses the first, the real host hands the protocol's own feedback to the next turn, and
 * the real store commits the second. Nothing in that path is a double except the captured
 * Lean output, which is the same seam the landed host suite fakes — a report carries the
 * acceptance capability and no fixture can mint one.
 *
 * *The recording describes this loop.* A replay compares every request against the one
 * rendered from the recorded turn, so a recording that no longer matches the questions the
 * loop asks fails loudly instead of reporting a green run against a stale transcript. The
 * derivation is asserted too: the recorded proof must still be the reviewed file's own text,
 * and the recorded objective must still be a row of the committed controlled-language
 * ledger.
 *
 * *Nothing repairs model output.* Prose, a fenced block, trailing commentary and a
 * duplicate key all arrive at the protocol as what the model said, and come back as its
 * attributed malformed refusal rather than as a silently corrected candidate.
 *
 * *The generator cannot write.* Every refused run leaves the accepted state byte-for-byte
 * alone, because the only thing the adapter produces is a proposal, and the only thing that
 * writes is the protocol's store.
 */

const packageRoot = resolve(import.meta.dirname, "../..");
const reviewedProofs = join(packageRoot, "formal", "SpecCnl", "Proofs.lean");
const committedCorpus = join(packageRoot, "artifacts", "cnl", "ledger.json");
const recordingFixture = join(
    import.meta.dirname,
    "fixtures",
    "proof-repair-model-recording.json"
);

/** The candidate-writable module of the corpus, and the frozen module the audited run
 * elaborates. Both are the real corpus's own names. */
const REPAIRED = "SpecCnl/Proofs.lean";
const ENTRY = "SpecCnl/Report.lean";

/** The four declarations the corpus registers per unit, as the axiom report designates
 * them. */
const AUDITED = Object.freeze([
    "SpecCnl.Bridge.bridge_C13_RUN_ANCESTRY",
    "SpecCnl.Bridge.hand_C13_RUN_ANCESTRY",
    "SpecCnl.Proofs.proved_C13_RUN_ANCESTRY",
    "SpecCnl.Sentences.cnl_C13_RUN_ANCESTRY"
]);

const temporary: string[] = [];

interface ModelFixture {
    readonly root: string;
    readonly base: string;
    readonly corpus: string;
    readonly store: MemoryProofRepairStore;
    readonly owners: DeclaredProofArtifactOwners;
    readonly objective: ProofRepairObjective;
}

/** Captured Lean process results, so the protocol exercises its real parser, policy and
 * state machine without a test elaborating a candidate. */
class ScriptedProofCommandRunner extends ProofCommandRunner {
    private readonly outcomes: readonly ProofCommandOutcome[];
    private position = 0;

    public constructor(outcomes: readonly ProofCommandOutcome[]) {
        super();
        this.outcomes = Object.freeze([...outcomes]);
    }

    public run(): ProofCommandOutcome {
        const outcome = this.outcomes[this.position];
        if (outcome === undefined) throw new TypeError("The fixture supplied no command result");
        this.position += 1;
        return outcome;
    }
}

/** A model seam that answers with the replies a case scripted, and remembers what it was
 * asked. Faking the seam is the point: everything above it — the prompt, the boundary
 * parsing, the budgets, the recording — is the code under test. */
class ScriptedProofModelExchange extends ProofModelExchange {
    public readonly requests: ProofModelRequest[] = [];
    private readonly replies: readonly string[];
    private position = 0;

    public constructor(replies: readonly string[]) {
        super();
        this.replies = Object.freeze([...replies]);
    }

    public exchange(request: ProofModelRequest): string {
        this.requests.push(request);
        const reply = this.replies[this.position];
        this.position += 1;
        if (reply === undefined) throw new ProofModelUnavailable("the script is out of replies");
        return reply;
    }
}

afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

const recording = ProofRepairModelRecording.read(
    readFileSync(recordingFixture, "utf8"),
    "the committed model recording"
);

/** One recorded exchange, by the attempt it answered. Every reader goes through here, so a
 * recording that has stopped carrying the turn a case is about fails by name rather than
 * through an index nobody checked. */
function exchangeAt(attempt: number): ProofModelExchangeRecord {
    const recorded = recording.exchanges[attempt - 1];
    if (recorded === undefined) throw new TypeError(`the recording has no attempt ${attempt}`);
    return recorded;
}

/** The obligation the recording was taken for. */
function obligation(): ProofObligation {
    const first = recording.objective[0];
    if (first === undefined) throw new TypeError("the recording names no obligation");
    return first;
}

const owed = obligation();

/** The reply text of one recorded exchange. */
function reply(attempt: number): string {
    return exchangeAt(attempt).reply;
}

/** The artifact text one recorded reply proposes. */
function proposedText(attempt: number): string {
    const candidate = ProofRepairCandidate.fromData(
        proofModelProposal(reply(attempt)),
        "the recorded reply"
    );
    const artifact = candidate.artifacts[0];
    if (artifact === undefined) throw new TypeError("the recorded reply proposes no artifact");
    return artifact.text;
}

/**
 * A corpus tree the protocol can isolate and a corpus ledger the host can build an
 * objective from: the real corpus's module names, with the frozen entry module importing the
 * writable one so the candidate is inside the audited import closure.
 */
function fixture(): ModelFixture {
    const root = mkdtempSync(join(tmpdir(), "agent-core-proof-repair-model-"));
    temporary.push(root);
    const base = join(root, "base");
    mkdirSync(join(base, "SpecCnl"), { recursive: true });
    writeFileSync(join(base, REPAIRED), proposedText(2));
    writeFileSync(join(base, "SpecCnl", "Bridge.lean"), "theorem bridged : True := trivial\n");
    writeFileSync(join(base, "SpecCnl", "Sentences.lean"), "theorem stated : True := trivial\n");
    writeFileSync(
        join(base, ENTRY),
        ["import SpecCnl.Proofs", "import SpecCnl.Sentences", "#cnl_ledger"].join("\n")
    );
    const corpus = join(root, "corpus.json");
    writeFileSync(
        corpus,
        `${JSON.stringify({
            units: [{ anchor: owed.anchor, atoms: [...owed.atoms], digest: owed.unit }]
        })}\n`
    );
    const store = new MemoryProofRepairStore();
    return {
        root,
        base,
        corpus,
        store,
        owners: new DeclaredProofArtifactOwners([
            { path: REPAIRED, owner: "W0" },
            { path: "SpecCnl/Bridge.lean", owner: "W0" },
            { path: "SpecCnl/Sentences.lean", owner: "W0" },
            { path: ENTRY, owner: "W0" }
        ]),
        objective: corpusObjective(corpus, store.load())
    };
}

/** What lake prints when a candidate's proof leaves a goal open: the message continues under
 * its header until lake writes a line of its own. */
const failedBuild = [
    "⏵ [2/4] Building SpecCnl.Proofs",
    `error: ./${REPAIRED}:24:2: unsolved goals`,
    "case parent",
    "left right : GraphStore",
    "⊢ Ancestor right ancestor child",
    "Some builds logged failures:",
    "- SpecCnl.Proofs",
    "error: Lean exited with code 1"
].join("\n");

/** What one clean report run prints: a designation for every audited declaration, then the
 * ledger line naming the units the run proved. */
const cleanReport = [
    ...AUDITED.map((name) => `'${name}' does not depend on any axioms`),
    `cnl-ledger ${JSON.stringify({
        units: [{ anchor: owed.anchor, atoms: [...owed.atoms], digest: owed.unit }]
    })}`
].join("\n");

/** The real Lean verifier over captured output: a failed build first, then a clean build and
 * a clean report, which is exactly the refusal-then-acceptance the recording drives. */
function verifier(
    selected: ModelFixture,
    outcomes: readonly ProofCommandOutcome[]
): LeanProofCandidateVerification {
    return new LeanProofCandidateVerification(
        new ScriptedProofCommandRunner(outcomes),
        selected.owners,
        new ProofCommand("lake", ["build", "SpecCnl"]),
        new ProofCommand("lake", ["env", "lean", ENTRY]),
        AUDITED,
        ENTRY
    );
}

const refusedThenAccepted: readonly ProofCommandOutcome[] = Object.freeze([
    { status: 1, output: failedBuild },
    { status: 0, output: "" },
    { status: 0, output: cleanReport }
]);

function prompt(selected: ModelFixture): ProofRepairPrompt {
    return new ProofRepairPrompt(selected.store.load().digest, selected.objective, [
        { path: REPAIRED, text: proposedText(2) }
    ]);
}

function run(
    selected: ModelFixture,
    generator: ProofRepairModelGenerator,
    outcomes: readonly ProofCommandOutcome[],
    attempts: number
): ProofRepairLoopResult {
    return new ProofRepairHost(
        selected.base,
        selected.store,
        verifier(selected, outcomes),
        selected.owners
    ).repair(selected.objective, generator, attempts);
}

describe("the live-model proof candidate generator", () => {
    test("replays a recorded refusal, feeds the feedback back, and accepts the real proof", () => {
        const selected = fixture();
        const asked = prompt(selected);
        const exchange = new RecordedProofModelExchange(recording, asked);
        const generator = new ProofRepairModelGenerator(asked, exchange, 4);

        const result = run(selected, generator, refusedThenAccepted, 4);

        expect(result.name).toBe("accepted");
        expect(result.attempts).toBe(2);
        // The first candidate was refused for the defect the recording's first reply
        // carries, and the refusal is the candidate's to answer for.
        expect(result.refusals).toHaveLength(1);
        expect(result.refusals[0]).toContain("compile W0 SpecCnl/Proofs.lean:24:2");
        expect(result.refusals[0]).toContain("unsolved goals");
        // Both recorded exchanges were spent, in order.
        expect(exchange.remaining()).toBe(0);
        expect(result.ledger.closed).toHaveLength(1);
        expect(result.ledger.closed[0]?.obligation.equals(owed)).toBe(true);
        expect(result.ledger.artifacts[0]?.text).toBe(proposedText(2));
        expect(selected.store.load().digest).not.toBe(ProofRepairLedger.genesis.digest);
        expect(generator.declined()).toBeUndefined();
    });

    test("carries the protocol's own feedback into the recorded second turn", () => {
        const selected = fixture();
        const asked = prompt(selected);
        const seam = new ScriptedProofModelExchange([reply(1), reply(2)]);
        const generator = new ProofRepairModelGenerator(asked, seam, 4);

        const result = run(selected, generator, refusedThenAccepted, 4);

        expect(result.name).toBe("accepted");
        // The recorded feedback is not a fixture's invention: it is the exact refusal this
        // protocol produced for the first recorded reply, and the second request carries it.
        const feedback = exchangeAt(2).feedback;
        expect(feedback).toBe(result.refusals[0]);
        const second = seam.requests[1];
        expect(second?.text).toContain("The previous attempt was refused:");
        expect(second?.text).toContain(feedback ?? "no feedback was recorded");
        // The first request has no refusal block at all, and both show the model the
        // candidate it is rewriting.
        expect(seam.requests[0]?.text).not.toContain("The previous attempt was refused:");
        expect(seam.requests[0]?.text).toContain("The candidate to repair:");
        expect(seam.requests[0]?.text).toContain(owed.describe());
    });

    test("is derived from the reviewed corpus rather than from a fixture's imagination", () => {
        const reviewed = readFileSync(reviewedProofs, "utf8");
        const accepted = proposedText(2);
        const closing = "\nend SpecCnl.Proofs\n";

        // The accepted reply is the reviewed file's own text through its discharge for this
        // unit, closed as a module. A repository whose proof moved fails here, which is the
        // signal to record the run again rather than to keep replaying a stale proof.
        expect(accepted.endsWith(closing)).toBe(true);
        expect(reviewed.startsWith(accepted.slice(0, -closing.length))).toBe(true);
        expect(accepted).toContain("theorem proved_C13_RUN_ANCESTRY");
        // The refused reply is that same proof with its `parent` case deleted: a defect,
        // not a different file.
        expect(proposedText(1)).not.toContain("| parent lookup member _ step");
        expect(proposedText(1).length).toBeLessThan(accepted.length);

        // The obligation the recording was taken for is still a row of the committed
        // controlled-language ledger, byte for byte.
        const corpus = assertObject(
            parseCanonicalJson(readFileSync(committedCorpus, "utf8"), "the corpus ledger"),
            "the corpus ledger"
        );
        const units = corpus["units"];
        if (!Array.isArray(units)) throw new TypeError("the corpus ledger carries no units");
        const row = units
            .map((entry) => assertObject(entry, "a corpus unit"))
            .find((entry) => entry["digest"] === owed.unit);
        expect(row).toBeDefined();
        expect(row?.["anchor"]).toBe(owed.anchor);
        expect(row?.["atoms"]).toEqual([...owed.atoms]);
    });

    test("refuses a recording taken against another baseline or objective", () => {
        const selected = fixture();
        const moved = new ProofRepairPrompt("0".repeat(64), selected.objective, [
            { path: REPAIRED, text: proposedText(2) }
        ]);
        const relabelled = new ProofRepairPrompt(
            selected.store.load().digest,
            new ProofRepairObjective([
                new ProofObligation(owed.unit, ["C13-RUN-UNDO-FENCE"], owed.anchor)
            ]),
            [{ path: REPAIRED, text: proposedText(2) }]
        );

        expect(() => new RecordedProofModelExchange(recording, moved)).toThrow(
            "was taken against baseline"
        );
        expect(() => new RecordedProofModelExchange(recording, relabelled)).toThrow(
            "was taken against another objective"
        );
    });

    test("refuses to answer a turn the recording does not describe", () => {
        const selected = fixture();
        const asked = prompt(selected);
        const drifted = new ProofRepairModelRecording(
            recording.model,
            recording.provenance,
            recording.baseline,
            recording.objective,
            [
                new ProofModelExchangeRecord(
                    1,
                    "Close every obligation nobody asked for:",
                    undefined,
                    reply(1)
                )
            ]
        );

        // A recording that answers a question the loop no longer asks would report a green
        // run over a transcript that has stopped describing anything.
        expect(() =>
            run(
                selected,
                new ProofRepairModelGenerator(
                    asked,
                    new RecordedProofModelExchange(drifted, asked),
                    4
                ),
                refusedThenAccepted,
                4
            )
        ).toThrow("no longer describes the question this loop asks");
    });

    test("declines when the recording runs out and when its own budget is spent", () => {
        const exhausted = fixture();
        const askedFirst = prompt(exhausted);
        const single = new ProofRepairModelRecording(
            recording.model,
            recording.provenance,
            recording.baseline,
            recording.objective,
            [exchangeAt(1)]
        );
        const outOfRecord = new ProofRepairModelGenerator(
            askedFirst,
            new RecordedProofModelExchange(single, askedFirst),
            4
        );

        const ranOut = run(exhausted, outOfRecord, refusedThenAccepted, 4);

        // One recorded reply, refused; the second turn has nothing to answer with, so the
        // loop declines rather than inventing a candidate.
        expect(ranOut.name).toBe("declined");
        expect(ranOut.attempts).toBe(1);
        expect(outOfRecord.declined()).toContain("the recording holds 1 exchange(s)");

        const bounded = fixture();
        const askedAgain = prompt(bounded);
        const capped = new ProofRepairModelGenerator(
            askedAgain,
            new RecordedProofModelExchange(recording, askedAgain),
            1
        );

        const spent = run(bounded, capped, refusedThenAccepted, 4);

        // The host would have allowed four attempts; the generator's own ceiling is what
        // stopped the paid exchanges at one.
        expect(spent.name).toBe("declined");
        expect(spent.attempts).toBe(1);
        expect(capped.declined()).toBe("the exchange budget of 1 is spent");
        expect(bounded.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("forwards untrusted model output verbatim instead of repairing it", () => {
        const object = proofModelProposal('{"artifacts":[],"baseline":"x","obligations":[]}');
        expect(object).toEqual({ artifacts: [], baseline: "x", obligations: [] });

        // A fenced block, trailing prose, a duplicate key and plain text are all the model's
        // own answer, handed on as the string it sent. Nothing here strips, splits, or
        // deduplicates, because the protocol's boundary is what judges a proposal.
        for (const answer of [
            '```json\n{"artifacts":[]}\n```',
            '{"artifacts":[]} and let me know if you want more',
            '{"artifacts":[],"artifacts":[{"path":"SpecCnl/Proofs.lean","text":"x"}]}',
            "I could not find the proof."
        ]) {
            expect(proofModelProposal(answer)).toBe(answer);
        }
        // Whitespace around one JSON object is not content, and a reply that is a bare
        // string stays a string rather than becoming an object.
        expect(proofModelProposal('  {"artifacts":[]}\n')).toEqual({ artifacts: [] });
        expect(proofModelProposal('"just a string"')).toBe("just a string");
    });

    test("turns a malformed reply into the protocol's own attributed refusal", () => {
        const selected = fixture();
        const asked = prompt(selected);
        const seam = new ScriptedProofModelExchange([
            "Certainly! Here is the repaired proof.",
            reply(2)
        ]);
        const generator = new ProofRepairModelGenerator(asked, seam, 4);

        // Only the accepting run is scripted: the prose reply never reaches a Lean command,
        // because the protocol refuses it at its decode boundary.
        const result = run(
            selected,
            generator,
            [
                { status: 0, output: "" },
                { status: 0, output: cleanReport }
            ],
            4
        );

        expect(result.name).toBe("accepted");
        expect(result.attempts).toBe(2);
        expect(result.refusals[0]).toContain("malformed candidate");
        expect(result.refusals[0]).toContain("must be an object");
        // The model was told what was wrong with its own answer, in the protocol's words.
        expect(seam.requests[1]?.text).toContain("malformed candidate");
    });

    test("declines an empty reply without proposing anything", () => {
        const selected = fixture();
        const asked = prompt(selected);
        const generator = new ProofRepairModelGenerator(
            asked,
            new ScriptedProofModelExchange(["   \n  "]),
            4
        );

        const result = run(selected, generator, refusedThenAccepted, 4);

        expect(result.name).toBe("declined");
        expect(result.attempts).toBe(0);
        expect(generator.declined()).toBe("the model answered with no text");
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("records what it asked and what it heard, and nothing else", () => {
        const selected = fixture();
        const asked = prompt(selected);
        const generator = new ProofRepairModelGenerator(
            asked,
            new RecordedProofModelExchange(recording, asked),
            4
        );

        run(selected, generator, refusedThenAccepted, 4);
        const rerecorded = generator.recording(recording.model, recording.provenance);

        // A replayed run re-records the recording it replayed, which is what makes
        // `--record` on the operator entry and a committed replay fixture the same thing.
        expect(rerecorded.toData()).toEqual(recording.toData());
        // A recording carries the turns and the replies, and no credential, endpoint or
        // header could hide in it: the codec refuses a key it does not name.
        const encoded = assertObject(rerecorded.toData(), "the recording");
        expect(Object.keys(encoded).sort()).toEqual([
            "baseline",
            "exchanges",
            "kind",
            "model",
            "objective",
            "provenance",
            "version"
        ]);
    });

    test("refuses a recording that is not the shape this reader records", () => {
        const encoded = assertObject(recording.toData(), "the recording");
        const rewritten = (changes: Record<string, JsonValue | undefined>): string =>
            JSON.stringify(
                Object.fromEntries(
                    Object.entries({ ...encoded, ...changes }).filter(
                        ([, value]) => value !== undefined
                    )
                )
            );

        expect(() =>
            ProofRepairModelRecording.read(rewritten({ version: "2.0" }), "a recording")
        ).toThrow("record the run again");
        expect(() =>
            ProofRepairModelRecording.read(rewritten({ kind: "proof.repair.ledger" }), "a recording")
        ).toThrow("is not a proof repair model recording");
        expect(() =>
            ProofRepairModelRecording.read(rewritten({ endpoint: "https://example" }), "a recording")
        ).toThrow("missing or unknown fields");
        expect(() =>
            ProofRepairModelRecording.read(rewritten({ provenance: undefined }), "a recording")
        ).toThrow("missing or unknown fields");
        // Attempts number the turns they answered, so a transcript that starts at the second
        // turn is out of order rather than a shorter run.
        expect(
            () =>
                new ProofRepairModelRecording(
                    recording.model,
                    recording.provenance,
                    recording.baseline,
                    recording.objective,
                    [exchangeAt(2)]
                )
        ).toThrow("is out of order");
    });

    test("refuses to prompt for an artifact the policy does not admit", () => {
        const selected = fixture();

        // The prompt is built as a real candidate, so the frozen evidence modules and the
        // paths outside the corpus are refused while the question is being written rather
        // than after a model has spent an attempt on them.
        expect(
            () =>
                new ProofRepairPrompt(selected.store.load().digest, selected.objective, [
                    { path: ENTRY, text: "import SpecCnl.Proofs\n" }
                ])
        ).toThrow("produces the evidence that judges it");
        expect(
            () =>
                new ProofRepairPrompt(selected.store.load().digest, selected.objective, [])
        ).toThrow("shows the model no writable artifact");
    });
});
