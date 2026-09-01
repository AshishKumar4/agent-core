import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import {
    acceptedProofArtifact,
    PROOF_EVIDENCE_MODULES,
    ProofObligation,
    ProofRepairCandidate,
    ProofRepairLedger,
    ProofRepairLedgerCodec,
    ProofRepairObjective,
    proofRepairLedgerVersion,
    ProposedArtifact
} from "../../scripts/quality/proof-repair-record.js";
import {
    DeclaredProofArtifactOwners,
    proofAdmissionKinds,
    ProofArtifactSpan,
    proofFindingKinds,
    ProofRepairLocus,
    ProofRepairRefusal,
    type ProofFindingKind
} from "../../scripts/quality/proof-repair-refusal.js";
import {
    acceptedProofRepair,
    ProofRepairState,
    type RefusedProofRepair
} from "../../scripts/quality/proof-repair-outcome.js";
import {
    ProofRepairProtocol,
    RepositoryProofArtifactOwners
} from "../../scripts/quality/proof-repair.js";
import {
    FileProofRepairStore,
    MemoryProofRepairStore,
    proofRepairLedgerArtifact
} from "../../scripts/quality/proof-repair-store.js";
import { freshProofIsolation, proofTreesOverlap } from "../../scripts/quality/proof-repair-tree.js";
import {
    LeanProofCandidateVerification,
    forbiddenProofTokens,
    parseAxiomDesignations,
    parseProofDiagnostics,
    reachableProofModules,
    ProofCandidateVerification,
    ProofCommand,
    ProofCommandRunner,
    proofVerifierSandboxPremise,
    PROOF_FORBIDDEN_TOKENS,
    proofVerdictOf,
    ProofVerificationReport,
    redeemProofVerdict,
    SpawnProofCommandRunner,
    type ProofCandidateSubject,
    type ProofCommandOutcome
} from "../../scripts/quality/proof-repair-verification.js";
import {
    assertObject,
    parseCanonicalJson,
    type JsonObject,
    type JsonValue
} from "../../scripts/quality/project.mjs";

/**
 * Hostile tests for the untrusted-LLM proof repair protocol.
 *
 * Every passing verdict in this file is produced by the real verifier reading captured Lean
 * output, never by a fixture handing the protocol a report. That is deliberate: a report
 * carries the acceptance capability, the capability cannot be minted outside the verification
 * module, and a suite that could fabricate one would be testing a protocol nobody ships.
 * Fixtures therefore control the two things a host controls — the process results and the
 * ownership map — and the protocol decides everything else.
 */

const temporary: string[] = [];
let isolationOrdinal = 0;

/** The candidate-writable module of the reviewed corpus. Every evidence producer is refused
 * by `acceptedProofArtifact`, so the fixtures repair the one module a candidate may write. */
const REPAIRED = "SpecCnl/Repair.lean";

/** The frozen module the audited run elaborates, and the root of the import closure. */
const ENTRY = "SpecCnl/Report.lean";

/** The declarations the fixture corpus registers for the axiom report. A report that does not
 * designate exactly these is incomplete evidence, which is what the protocol refuses. */
const AUDITED = Object.freeze([
    "SpecCnl.Repair.proved_C13_RUN_ANCESTRY",
    "SpecCnl.Sentences.cnl_C13_RUN_ANCESTRY"
]);

interface ProofRepairFixture {
    readonly root: string;
    readonly base: string;
    readonly store: MemoryProofRepairStore;
    readonly owners: DeclaredProofArtifactOwners;
}

interface FailureCase {
    readonly kind: ProofFindingKind;
    readonly result: (subject: ProofCandidateSubject) => ProofRepairRefusal;
}

type VerificationAnswer = (
    subject: ProofCandidateSubject
) => ProofVerificationReport | ProofRepairRefusal;

/** A verifier seam that can only refuse. It cannot return a report: reports carry the
 * acceptance capability and no fixture can mint one, which is the property under test in
 * "a report cannot be assembled outside a completed run". */
class RefusingProofVerification extends ProofCandidateVerification {
    private readonly answer: VerificationAnswer;

    public constructor(answer: VerificationAnswer) {
        super();
        this.answer = answer;
        Object.freeze(this);
    }

    public verify(subject: ProofCandidateSubject): ProofVerificationReport | ProofRepairRefusal {
        return this.answer(subject);
    }

    public auditedNames(): readonly string[] {
        return AUDITED;
    }
}

/** Captured Lean process results. The protocol exercises its parser, its policy, and its
 * state machine without letting a test fixture execute a candidate. */
class ScriptedProofCommandRunner extends ProofCommandRunner {
    private readonly outcomes: readonly ProofCommandOutcome[];
    private position = 0;

    public constructor(outcomes: readonly ProofCommandOutcome[]) {
        super();
        this.outcomes = Object.freeze([...outcomes]);
    }

    public run(_command: ProofCommand, _cwd: string): ProofCommandOutcome {
        const outcome = this.outcomes[this.position];
        if (outcome === undefined) throw new TypeError("The fixture supplied no command result");
        this.position += 1;
        return outcome;
    }
}

/** The scratch directories this protocol mints, so a case can prove none is left behind. */
function scratchDirectories(): readonly string[] {
    return readdirSync(realpathSync(tmpdir()))
        .filter((entry) => entry.startsWith("agent-core-proof-repair-"))
        .sort();
}

/** A verifier that hands back the real report while keeping a reference to it, so a case can
 * present the same genuine report to the decision twice. */
class CapturingProofVerification extends ProofCandidateVerification {
    private readonly inner: ProofCandidateVerification;
    private captured: ProofVerificationReport | undefined;

    public constructor(inner: ProofCandidateVerification) {
        super();
        this.inner = inner;
    }

    public verify(subject: ProofCandidateSubject): ProofVerificationReport | ProofRepairRefusal {
        const answer = this.inner.verify(subject);
        if (!(answer instanceof ProofRepairRefusal)) this.captured = answer;
        return answer;
    }

    public auditedNames(): readonly string[] {
        return this.inner.auditedNames();
    }

    public report(): ProofVerificationReport {
        const captured = this.captured;
        if (captured === undefined) throw new TypeError("The fixture captured no report");
        return captured;
    }
}

/** A run that inspects the isolation it was given before answering, so a case can assert what
 * the verifier was actually handed. */
class InspectingProofCommandRunner extends ScriptedProofCommandRunner {
    private readonly inspect: (cwd: string) => void;

    public constructor(outcomes: readonly ProofCommandOutcome[], inspect: (cwd: string) => void) {
        super(outcomes);
        this.inspect = inspect;
    }

    public override run(command: ProofCommand, cwd: string): ProofCommandOutcome {
        this.inspect(cwd);
        return super.run(command, cwd);
    }
}

/** A run that rewrites the candidate inside its own isolation, which is what a candidate whose
 * elaboration writes files would do. The measured bytes must then stop matching the candidate
 * the report claims to be about. */
class TamperingProofCommandRunner extends ScriptedProofCommandRunner {
    public override run(command: ProofCommand, cwd: string): ProofCommandOutcome {
        writeFileSync(join(cwd, REPAIRED), "theorem rewritten : True := trivial\n");
        return super.run(command, cwd);
    }
}

afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

function fixture(): ProofRepairFixture {
    const root = mkdtempSync(join(tmpdir(), "agent-core-proof-repair-"));
    const base = join(root, "base");
    mkdirSync(join(base, "SpecCnl"), { recursive: true });
    writeFileSync(join(base, REPAIRED), repairText("trivial"));
    writeFileSync(join(base, "SpecCnl", "Sentences.lean"), "theorem stated : True := trivial\n");
    // The frozen entry module: the import-closure walk starts here, and only a frozen module's
    // imports are followed, so this is what makes the writable module reachable at all.
    writeFileSync(
        join(base, ENTRY),
        ["import SpecCnl.Repair", "import SpecCnl.Sentences", "#cnl_ledger"].join("\n")
    );
    temporary.push(root);
    return {
        root,
        base,
        store: new MemoryProofRepairStore(),
        // `packages/agent-core/formal/**` resolves to exactly one wave in the repository's own
        // ownership map, so every corpus module the report can designate has an owner here too.
        owners: new DeclaredProofArtifactOwners([
            { path: REPAIRED, owner: "W0" },
            { path: "SpecCnl/Sentences.lean", owner: "W0" },
            { path: "SpecCnl/Bridge.lean", owner: "W0" },
            { path: "SpecCnl/Report.lean", owner: "W0" },
            // `formal/**` resolves to one wave, so every corpus path has an owner even when the
            // audited build never imports it. Reachability is a separate question from ownership.
            { path: "SpecCnl/Unused.lean", owner: "W0" },
            { path: "SpecCnl/Smuggled.lean", owner: "W0" }
        ])
    };
}

function digest(label: string): string {
    return createHash("sha256").update(label).digest("hex");
}

function obligation(label: string): ProofObligation {
    return new ProofObligation(digest(label), ["C13-RUN-ANCESTRY"], "SPEC.md:1601");
}

/** Candidate text shaped like a real repair: it declares exactly the audited discharge, under
 * the namespace its module name implies, because a declaration outside the audited set is
 * refused before any command runs. */
function repairText(proof: string = "trivial"): string {
    return [
        "namespace SpecCnl.Repair",
        "",
        `theorem proved_C13_RUN_ANCESTRY : True := ${proof}`,
        "",
        "end SpecCnl.Repair",
        ""
    ].join("\n");
}

function candidate(
    selected: ProofRepairFixture,
    obligations: readonly ProofObligation[],
    text: string = repairText()
): ProofRepairCandidate {
    return new ProofRepairCandidate(selected.store.load().digest, obligations, [
        new ProposedArtifact(REPAIRED, text)
    ]);
}

function isolation(selected: ProofRepairFixture): string {
    const path = join(selected.root, `isolation-${isolationOrdinal}`);
    isolationOrdinal += 1;
    return path;
}

function protocol(
    selected: ProofRepairFixture,
    objective: readonly ProofObligation[],
    verifier: ProofCandidateVerification
): ProofRepairProtocol {
    return new ProofRepairProtocol(
        selected.base,
        new ProofRepairObjective(objective),
        selected.store,
        verifier,
        selected.owners
    );
}

function artifact(subject: ProofCandidateSubject): ProposedArtifact {
    const first = subject.candidate.artifacts[0];
    if (first === undefined) throw new TypeError("The fixture candidate names no artifact");
    return first;
}

function locus(subject: ProofCandidateSubject): ProofRepairLocus {
    return ProofRepairLocus.at("W0", artifact(subject).path).withSpan(new ProofArtifactSpan(7, 3));
}

function refusal(state: ProofRepairState): RefusedProofRepair {
    return state.fold<RefusedProofRepair>({
        accepted: () => {
            throw new TypeError("The test expected a refusal");
        },
        refused: (result) => result
    });
}

/** The reviewed pair of commands, driven from captured process results. */
function leanVerifier(
    selected: ProofRepairFixture,
    outcomes: readonly ProofCommandOutcome[],
    runner: ScriptedProofCommandRunner = new ScriptedProofCommandRunner(outcomes)
): LeanProofCandidateVerification {
    return new LeanProofCandidateVerification(
        runner,
        selected.owners,
        new ProofCommand("lake", ["build", "SpecCnl"]),
        new ProofCommand("lake", ["env", "lean", ENTRY]),
        AUDITED,
        ENTRY
    );
}

/**
 * The output one clean report run prints: a designation for every audited declaration, then
 * the ledger line naming the units the run proved.
 *
 * `SpecCnl/Report.lean` emits both with `logInfo` and `#print axioms`, and Lean's own driver
 * prints an information message with no position prefix, which is why the reader takes them
 * from bare lines. The unit shape is the one `artifacts/cnl/ledger.json` records: a rule
 * digest, its atoms, and its SPEC anchor.
 */
function cleanReport(
    proved: readonly ProofObligation[],
    axioms: ReadonlyMap<string, readonly string[]> = new Map()
): string {
    const designations = AUDITED.map((name) => {
        const listed = axioms.get(name);
        return listed === undefined || listed.length === 0
            ? `'${name}' does not depend on any axioms`
            : `'${name}' depends on axioms: [${listed.join(", ")}]`;
    });
    return [...designations, provedLedgerLine(proved)].join("\n");
}

function provedLedgerLine(obligations: readonly ProofObligation[]): string {
    const units = obligations.map((owed) => ({
        anchor: owed.anchor,
        atoms: [...owed.atoms],
        digest: owed.unit
    }));
    return `cnl-ledger ${JSON.stringify({ units })}`;
}

/** A verifier whose run accepts: the build is clean and the report designates every audited
 * declaration with reviewed axioms only. */
function acceptingVerifier(
    selected: ProofRepairFixture,
    proved: readonly ProofObligation[],
    runner?: (outcomes: readonly ProofCommandOutcome[]) => ScriptedProofCommandRunner
): LeanProofCandidateVerification {
    const outcomes: readonly ProofCommandOutcome[] = [
        { status: 0, output: "" },
        { status: 0, output: cleanReport(proved) }
    ];
    return leanVerifier(selected, outcomes, runner?.(outcomes));
}

/** One accepted state, produced the only way one can be: by a completed verification run. */
function accept(
    selected: ProofRepairFixture,
    proposal: ProofRepairCandidate,
    proved: readonly ProofObligation[] = proposal.obligations
): ProofRepairState {
    return protocol(selected, proposal.obligations, acceptingVerifier(selected, proved)).repair(
        proposal,
        isolation(selected)
    );
}

/** One accepted ledger, for the codec cases. */
function acceptedLedger(text = repairText("by trivial")): ProofRepairLedger {
    const selected = fixture();
    accept(selected, candidate(selected, [obligation("codec")], text));
    return selected.store.load();
}

/** A ledger record with fields replaced, so a decode case states exactly what it doctored. */
function doctoredLedger(ledger: ProofRepairLedger, changes: JsonObject): JsonValue {
    return { ...ProofRepairLedgerCodec.encode(ledger), ...changes };
}

const failureCases: readonly FailureCase[] = [
    {
        kind: "ambiguity",
        result: (subject) =>
            ProofRepairRefusal.ambiguity(locus(subject), "every repair closes a proof", [
                "close(repair, proof)",
                "close(proof, repair)"
            ])
    },
    {
        kind: "model",
        result: (subject) =>
            ProofRepairRefusal.model(
                locus(subject).withTheorem("SpecCnl.Repair.proved_C13_RUN_ANCESTRY"),
                ["the bridge has type True ↔ True, not the reviewed proposition"]
            )
    },
    {
        kind: "proof",
        result: (subject) =>
            ProofRepairRefusal.proof(
                locus(subject).withTheorem("SpecCnl.Repair.proved_C13_RUN_ANCESTRY"),
                "⊢ ancestry depends only on commits"
            )
    },
    {
        kind: "compile",
        result: (subject) => ProofRepairRefusal.compile(locus(subject), "unexpected token")
    },
    {
        kind: "assumption",
        result: (subject) =>
            ProofRepairRefusal.assumption(
                locus(subject)
                    .withTheorem("SpecCnl.Repair.proved_C13_RUN_ANCESTRY")
                    .withAssumption("Unreviewed.Axiom"),
                ["Unreviewed.Axiom"]
            )
    },
    {
        kind: "runtime",
        result: () => ProofRepairRefusal.runtime("lake build SpecCnl", ["exit 137"])
    }
];

describe("untrusted proof repair", () => {
    for (const failure of failureCases) {
        test(`returns exact ${failure.kind} feedback without advancing accepted state`, () => {
            const selected = fixture();
            const proposal = candidate(selected, [obligation(failure.kind)]);
            const before = selected.store.load().digest;
            const state = protocol(
                selected,
                proposal.obligations,
                new RefusingProofVerification((subject) => failure.result(subject))
            ).repair(proposal, isolation(selected));

            const result = refusal(state);
            expect(result.kinds()).toEqual([failure.kind]);
            if (failure.kind === "ambiguity") {
                expect(result.refusals[0]?.counterexample).toHaveLength(2);
            }
            expect(result.feedback()).toContain(failure.kind);
            expect(result.feedback()).toContain("preserved: nothing is closed yet");
            expect(selected.store.load().digest).toBe(before);
            expect(selected.store.load().artifacts).toEqual([]);
        });
    }

    test("classifies Lean ambiguity output at the candidate artifact and span", () => {
        const selected = fixture();
        const proposal = candidate(selected, [obligation("lean-ambiguity")]);
        const verifier = leanVerifier(selected, [
            {
                status: 1,
                output:
                    `${REPAIRED}:7:3: error: refused: 'every proof closes' has ` +
                    "2 readings: close(proof) | close(every)"
            }
        ]);

        const state = protocol(selected, proposal.obligations, verifier).repair(
            proposal,
            isolation(selected)
        );

        const result = refusal(state);
        expect(result.kinds()).toEqual(["ambiguity"]);
        expect(result.feedback()).toContain(`W0 ${REPAIRED}:7:3`);
        expect(result.refusals[0]?.counterexample).toEqual(["close(every)", "close(proof)"]);
    });

    test("isolates raw candidate text until a verifier accepts it", () => {
        const selected = fixture();
        const text = repairText("by trivial");
        const owed = obligation("isolation");
        const proposal = candidate(selected, [owed], text);
        const directory = isolation(selected);
        let observed = false;

        const state = protocol(
            selected,
            proposal.obligations,
            acceptingVerifier(
                selected,
                [owed],
                (outcomes) =>
                    new InspectingProofCommandRunner(outcomes, (cwd) => {
                        observed = true;
                        expect(readFileSync(join(cwd, REPAIRED), "utf8")).toBe(text);
                        expect(readFileSync(join(selected.base, REPAIRED), "utf8")).toBe(
                            repairText("trivial")
                        );
                        expect(selected.store.load().artifacts).toEqual([]);
                    })
            )
        ).repair(proposal, directory);

        expect(acceptedProofRepair(state)).toBeDefined();
        expect(observed).toBe(true);
        expect(existsSync(directory)).toBe(false);
        expect(selected.store.load().artifacts[0]?.text).toBe(text);
    });

    test("names the owner, artifact, span, theorem, and assumption in actionable feedback", () => {
        const selected = fixture();
        const proposal = candidate(selected, [obligation("locus")]);
        const state = protocol(
            selected,
            proposal.obligations,
            new RefusingProofVerification((subject) =>
                ProofRepairRefusal.assumption(
                    locus(subject)
                        .withTheorem("SpecCnl.Repair.proved_C13_RUN_ANCESTRY")
                        .withAssumption("Unreviewed.Axiom"),
                    ["Unreviewed.Axiom"]
                )
            )
        ).repair(proposal, isolation(selected));

        expect(refusal(state).feedback()).toContain(
            `W0 ${REPAIRED}:7:3 theorem SpecCnl.Repair.proved_C13_RUN_ANCESTRY ` +
                "assumption Unreviewed.Axiom"
        );
    });

    test("refuses a symlink escape before a verifier sees the candidate", () => {
        const selected = fixture();
        const outside = join(selected.root, "outside");
        mkdirSync(outside);
        rmSync(join(selected.base, "SpecCnl"), { recursive: true });
        symlinkSync(outside, join(selected.base, "SpecCnl"));
        let invoked = false;

        const state = protocol(
            selected,
            [obligation("escape")],
            new RefusingProofVerification(() => {
                invoked = true;
                throw new TypeError("The verifier must not run after an isolation escape");
            })
        ).repair(candidate(selected, [obligation("escape")]), isolation(selected));

        expect(refusal(state).kinds()).toEqual(["isolation"]);
        expect(invoked).toBe(false);
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("returns stale feedback without executing a candidate made against an old ledger", () => {
        const selected = fixture();
        const first = candidate(selected, [obligation("first")]);
        const oldBaseline = first.baseline;
        accept(selected, first);
        let invoked = false;
        const stale = new ProofRepairCandidate(
            oldBaseline,
            [obligation("stale")],
            [new ProposedArtifact(REPAIRED, repairText("by exact trivial"))]
        );

        const state = protocol(
            selected,
            stale.obligations,
            new RefusingProofVerification(() => {
                invoked = true;
                throw new TypeError("Stale candidates must not reach a verifier");
            })
        ).repair(stale, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["stale"]);
        expect(result.feedback()).toContain(`candidate baseline ${oldBaseline}`);
        expect(invoked).toBe(false);
        expect(selected.store.load().candidate).toBe(first.identity);
    });

    test("refuses a model-selected subset of the trusted objective before verification", () => {
        const selected = fixture();
        const required = obligation("required");
        const omitted = candidate(selected, [obligation("different")]);
        let invoked = false;
        const state = protocol(
            selected,
            [required],
            new RefusingProofVerification(() => {
                invoked = true;
                throw new TypeError("An incomplete objective must not reach a verifier");
            })
        ).repair(omitted, isolation(selected));

        expect(refusal(state).kinds()).toEqual(["open", "malformed"]);
        expect(invoked).toBe(false);
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("refuses a candidate that regresses a prior closed obligation", () => {
        const selected = fixture();
        const firstObligation = obligation("first");
        accept(selected, candidate(selected, [firstObligation]));
        const secondObligation = obligation("second");
        const second = candidate(selected, [secondObligation], repairText("by simp"));
        const before = selected.store.load().digest;

        const state = protocol(
            selected,
            second.obligations,
            acceptingVerifier(selected, [secondObligation])
        ).repair(second, isolation(selected));

        expect(refusal(state).kinds()).toEqual(["regression"]);
        expect(selected.store.load().digest).toBe(before);
        expect(selected.store.load().closed[0]?.obligation.equals(firstObligation)).toBe(true);
    });

    test("refuses a report whose obligation evidence names a different atom or anchor", () => {
        const selected = fixture();
        const claimed = obligation("shape");
        const proposal = candidate(selected, [claimed]);
        const substituted = new ProofObligation(
            claimed.unit,
            ["C13-TURN-LIFECYCLE"],
            "SPEC.md:1602"
        );

        const state = protocol(
            selected,
            proposal.obligations,
            acceptingVerifier(selected, [substituted])
        ).repair(proposal, isolation(selected));

        expect(refusal(state).kinds()).toEqual(["open"]);
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("does not let a rejected candidate overwrite accepted artifact text", () => {
        const selected = fixture();
        accept(selected, candidate(selected, [obligation("accepted")], repairText("by trivial")));
        const before = selected.store.load();
        const rejected = candidate(
            selected,
            [obligation("rejected")],
            repairText("by exact trivial")
        );

        const state = protocol(
            selected,
            rejected.obligations,
            new RefusingProofVerification((subject) =>
                ProofRepairRefusal.compile(locus(subject), "forged candidate does not elaborate")
            )
        ).repair(rejected, isolation(selected));

        expect(refusal(state).kinds()).toEqual(["compile"]);
        expect(() => selected.store.commit(state)).toThrow(
            "A refused proof repair has no authority to overwrite artifacts"
        );
        expect(selected.store.load().digest).toBe(before.digest);
        expect(selected.store.load().artifacts[0]?.text).toBe(repairText("by trivial"));
    });

    test("accepts only a report that closes every exact claimed obligation", () => {
        const selected = fixture();
        const first = obligation("one");
        const second = obligation("two");
        const proposal = candidate(selected, [first, second], repairText("by trivial"));

        const state = protocol(
            selected,
            proposal.obligations,
            acceptingVerifier(selected, [first])
        ).repair(proposal, isolation(selected));

        expect(refusal(state).kinds()).toEqual(["open"]);
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("accepts a complete exact report and stores its one versioned artifact set", () => {
        const selected = fixture();
        const owed = obligation("exact");
        const text = repairText("by trivial");
        const proposal = candidate(selected, [owed], text);

        const state = protocol(
            selected,
            proposal.obligations,
            acceptingVerifier(selected, [owed])
        ).submit(proposal.toData(), isolation(selected));

        const accepted = acceptedProofRepair(state);
        expect(accepted).toBeDefined();
        expect(accepted?.progress).toEqual([owed]);
        expect(selected.store.load().candidate).toBe(proposal.identity);
        expect(selected.store.load().closed[0]?.obligation.equals(owed)).toBe(true);
        expect(selected.store.load().artifacts[0]?.text).toBe(text);
        expect(selected.store.load().artifacts[0]?.digest).toBe(digest(text));
        expect(accepted?.feedback()).toContain("closed:");
    });

    test("reads the committed genesis artifact through the versioned codec", () => {
        const ledger = new FileProofRepairStore(proofRepairLedgerArtifact).load();
        expect(ledger.digest).toBe(ProofRepairLedger.genesis.digest);
        expect(ledger.artifacts).toEqual([]);
        expect(ledger.closed).toEqual([]);
    });

    test("restarts from one committed ledger record with its accepted artifact text", () => {
        const selected = fixture();
        const path = join(selected.root, "proof-repair.json");
        const store = new FileProofRepairStore(path);
        const owed = obligation("restart");
        const proposal = new ProofRepairCandidate(
            store.load().digest,
            [owed],
            [new ProposedArtifact(REPAIRED, repairText("by trivial"))]
        );

        const state = new ProofRepairProtocol(
            selected.base,
            new ProofRepairObjective([owed]),
            store,
            acceptingVerifier(selected, [owed]),
            selected.owners
        ).repair(proposal, isolation(selected));

        expect(acceptedProofRepair(state)).toBeDefined();
        const restarted = new FileProofRepairStore(path).load();
        expect(restarted.closed[0]?.obligation.equals(owed)).toBe(true);
        expect(restarted.artifacts[0]?.text).toBe(repairText("by trivial"));
    });

    test("refuses a candidate that closes nothing new and repairs nothing", () => {
        const selected = fixture();
        const owed = obligation("progress");
        const text = repairText("by trivial");
        accept(selected, candidate(selected, [owed], text));
        const before = selected.store.load().digest;
        const repeated = new ProofRepairCandidate(
            before,
            [owed],
            [new ProposedArtifact(REPAIRED, text)]
        );

        const state = protocol(
            selected,
            repeated.obligations,
            acceptingVerifier(selected, [owed])
        ).repair(repeated, isolation(selected));

        expect(refusal(state).kinds()).toEqual(["progress"]);
        expect(selected.store.load().digest).toBe(before);
    });

    test("accepts a repair of accepted text that closes nothing new", () => {
        const selected = fixture();
        const owed = obligation("repair");
        accept(selected, candidate(selected, [owed], repairText("trivial")));
        const rewrite = candidate(selected, [owed], repairText("by trivial"));

        const state = protocol(
            selected,
            rewrite.obligations,
            acceptingVerifier(selected, [owed])
        ).repair(rewrite, isolation(selected));

        const accepted = acceptedProofRepair(state);
        expect(accepted?.progress).toEqual([]);
        expect(accepted?.repaired.map((item) => item.path)).toEqual([REPAIRED]);
        expect(accepted?.feedback()).toContain("closed: nothing new");
        expect(accepted?.feedback()).toContain(`repaired: ${REPAIRED}`);
        expect(selected.store.load().artifacts[0]?.text).toBe(repairText("by trivial"));
    });

    test("keeps every earlier closure while accepting a second obligation", () => {
        const selected = fixture();
        const first = obligation("monotone-first");
        const second = obligation("monotone-second");
        accept(selected, candidate(selected, [first], repairText("by trivial")));
        const advance = candidate(selected, [second], repairText("by simp"));

        const state = protocol(
            selected,
            advance.obligations,
            acceptingVerifier(selected, [first, second])
        ).repair(advance, isolation(selected));

        const accepted = acceptedProofRepair(state);
        expect(accepted?.progress).toEqual([second]);
        expect(accepted?.preserved).toEqual([first]);
        const closed = selected.store.load().closedUnits();
        expect([...closed].sort()).toEqual([first.unit, second.unit].sort());
    });

    test("rebinds a closure to the candidate whose bytes now carry it", () => {
        const selected = fixture();
        const first = obligation("rebind-first");
        const second = obligation("rebind-second");
        const opening = candidate(selected, [first], repairText("by trivial"));
        accept(selected, opening);
        const rewrite = candidate(selected, [second], repairText("by simp"));

        const state = protocol(
            selected,
            rewrite.obligations,
            acceptingVerifier(selected, [first, second])
        ).repair(rewrite, isolation(selected));

        expect(acceptedProofRepair(state)).toBeDefined();
        const closed = selected.store.load().closed;
        const rebound = closed.find((entry) => entry.obligation.equals(first));
        expect(rebound?.candidate).toBe(rewrite.identity);
        expect(rebound?.candidate).not.toBe(opening.identity);
        expect(selected.store.load().artifacts[0]?.text).toBe(repairText("by simp"));
    });

    test("repeats the closed obligations a later refusal must not silence", () => {
        const selected = fixture();
        const owed = obligation("preserved");
        accept(selected, candidate(selected, [owed], repairText("by trivial")));
        const next = obligation("preserved-next");
        const rejected = candidate(selected, [next], repairText("by exact trivial"));

        const state = protocol(
            selected,
            rejected.obligations,
            new RefusingProofVerification((subject) =>
                ProofRepairRefusal.compile(locus(subject), "unexpected token")
            )
        ).repair(rejected, isolation(selected));

        expect(refusal(state).feedback()).toContain(`preserved: ${owed.describe()}`);
        expect(owed.describe()).toContain(owed.unit);
    });

    test("round-trips an accepted ledger through its own canonical encoding", () => {
        const ledger = acceptedLedger();
        const decoded = ProofRepairLedgerCodec.decode(
            ProofRepairLedgerCodec.encode(ledger),
            "the ledger"
        );

        const original = ledger.closed[0];
        const restored = decoded.closed[0];
        if (original === undefined || restored === undefined) {
            throw new TypeError("The fixture ledger closed nothing");
        }
        expect(decoded.digest).toBe(ledger.digest);
        expect(decoded.candidate).toBe(ledger.candidate);
        expect(decoded.artifacts[0]?.text).toBe(ledger.artifacts[0]?.text);
        expect(restored.obligation.equals(original.obligation)).toBe(true);
        expect(restored.artifacts).toEqual(original.artifacts);
    });

    test("refuses a ledger record from an unknown major or a newer minor", () => {
        const ledger = acceptedLedger();

        expect(() =>
            ProofRepairLedgerCodec.decode(doctoredLedger(ledger, { version: "2.0" }), "x")
        ).toThrow("declares unknown major 2");
        expect(() =>
            ProofRepairLedgerCodec.decode(doctoredLedger(ledger, { version: "1.1" }), "x")
        ).toThrow("declares newer minor 1");
        expect(() =>
            ProofRepairLedgerCodec.decode(doctoredLedger(ledger, { version: "one" }), "x")
        ).toThrow("is not a record version");
        expect(() =>
            ProofRepairLedgerCodec.decode(doctoredLedger(ledger, { kind: "proof.repair" }), "x")
        ).toThrow("is not proof.repair.ledger");
    });

    test("refuses a ledger record carrying a field the codec does not name", () => {
        expect(() =>
            ProofRepairLedgerCodec.decode(
                doctoredLedger(acceptedLedger(), { accepted: true }),
                "the ledger"
            )
        ).toThrow("carries unexpected fields");
    });

    test("refuses accepted artifact text whose digest does not describe it", () => {
        const ledger = acceptedLedger(repairText("by simp"));
        const encoded = ProofRepairLedgerCodec.encode(ledger);
        const accepted = ledger.artifacts[0];
        if (accepted === undefined) throw new TypeError("The fixture ledger accepted no artifact");

        expect(() =>
            ProofRepairLedgerCodec.decode(
                {
                    ...encoded,
                    artifacts: [
                        {
                            digest: accepted.digest,
                            path: accepted.path,
                            text: repairText("by trivial")
                        }
                    ]
                },
                "the ledger"
            )
        ).toThrow("does not describe its own text");
    });

    test("refuses a decoded genesis record that carries accepted state", () => {
        const encoded = ProofRepairLedgerCodec.encode(acceptedLedger());

        expect(() =>
            ProofRepairLedgerCodec.decode(
                {
                    artifacts: encoded["artifacts"] ?? [],
                    closed: encoded["closed"] ?? [],
                    kind: "proof.repair.ledger",
                    version: "1.0"
                },
                "the ledger"
            )
        ).toThrow("A genesis ledger cannot carry accepted state");
    });

    test("refuses a decoded ledger that closes one rule unit twice", () => {
        const encoded = ProofRepairLedgerCodec.encode(acceptedLedger());
        const closed = encoded["closed"];
        if (!Array.isArray(closed) || closed[0] === undefined) {
            throw new TypeError("The fixture ledger closed nothing");
        }

        expect(() =>
            ProofRepairLedgerCodec.decode(
                { ...encoded, closed: [closed[0], closed[0]] },
                "the ledger"
            )
        ).toThrow("closes one rule unit twice");
    });

    test("refuses a durable ledger that smuggles a verifier-control artifact", () => {
        const encoded = ProofRepairLedgerCodec.encode(acceptedLedger());
        const smuggled = "unsafe def candidate := 1\n";

        expect(() =>
            ProofRepairLedgerCodec.decode(
                {
                    ...encoded,
                    artifacts: [
                        {
                            digest: digest(smuggled),
                            path: "lakefile.lean",
                            text: smuggled
                        }
                    ]
                },
                "the ledger"
            )
        ).toThrow("is not controlled-language corpus source");
    });

    test("refuses a durable ledger whose closure names an artifact it does not carry", () => {
        const encoded = ProofRepairLedgerCodec.encode(acceptedLedger());
        const closed = encoded["closed"];
        if (!Array.isArray(closed)) throw new TypeError("The fixture ledger closed nothing");
        const entry = assertObject(closed[0], "the closure");

        expect(() =>
            ProofRepairLedgerCodec.decode(
                {
                    ...encoded,
                    closed: [{ ...entry, artifacts: ["SpecCnl/Elsewhere.lean"] }]
                },
                "the ledger"
            )
        ).toThrow("which it does not accept");
    });

    for (const evidence of ["SpecCnl/Report.lean", "SpecCnl/Corpus.lean", "SpecCnl/Grammar.lean"]) {
        test(`refuses a candidate that would rewrite ${evidence}`, () => {
            const selected = fixture();
            const owed = obligation(`evidence-${evidence}`);
            const proposal = {
                artifacts: [{ path: evidence, text: repairText("by trivial") }],
                baseline: selected.store.load().digest,
                obligations: [owed.toData()]
            };
            let invoked = false;

            const state = protocol(
                selected,
                [owed],
                new RefusingProofVerification(() => {
                    invoked = true;
                    throw new TypeError("An evidence module must not reach a verifier");
                })
            ).submit(proposal, isolation(selected));

            const result = refusal(state);
            expect(result.kinds()).toEqual(["malformed"]);
            expect(result.feedback()).toContain("produces the evidence that judges it");
            expect(invoked).toBe(false);
            expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
        });
    }

    test("refuses a candidate module the audited build never imports", () => {
        const selected = fixture();
        const owed = obligation("unreachable");
        const unreachable = "SpecCnl/Unused.lean";
        const proposal = new ProofRepairCandidate(
            selected.store.load().digest,
            [owed],
            [new ProposedArtifact(unreachable, repairText())]
        );
        let ran = false;

        const state = protocol(
            selected,
            [owed],
            acceptingVerifier(
                selected,
                [owed],
                (outcomes) =>
                    new InspectingProofCommandRunner(outcomes, () => {
                        ran = true;
                    })
            )
        ).repair(proposal, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["malformed"]);
        expect(result.feedback()).toContain(`${unreachable} is outside the import closure`);
        expect(ran).toBe(false);
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("walks the import closure through frozen modules only", () => {
        const selected = fixture();
        // A writable module claiming to import another writable module cannot make it reachable:
        // its own import list is candidate-controlled, so the walk does not follow it.
        writeFileSync(join(selected.base, REPAIRED), "import SpecCnl.Smuggled\n");
        writeFileSync(join(selected.base, "SpecCnl", "Smuggled.lean"), repairText());

        const reachable = reachableProofModules(selected.base, ENTRY);

        expect([...reachable].sort()).toEqual([ENTRY, REPAIRED, "SpecCnl/Sentences.lean"].sort());
        expect(reachable.has("SpecCnl/Smuggled.lean")).toBe(false);
    });

    const forbiddenCases: readonly { readonly label: string; readonly body: readonly string[] }[] =
        [
            {
                label: "an asserted axiom",
                body: ["axiom hidden : False", "theorem proved_C13_RUN_ANCESTRY : True := trivial"]
            },
            {
                label: "a hole a line break hides",
                body: ["theorem proved_C13_RUN_ANCESTRY :", "    True :=", "  by", "    sorry"]
            },
            {
                label: "elaboration-time code",
                body: [
                    'run_cmd IO.println "cnl-ledger {}"',
                    "theorem proved_C13_RUN_ANCESTRY : True := trivial"
                ]
            },
            {
                label: "a compiled decision procedure",
                body: ["theorem proved_C13_RUN_ANCESTRY : True := by native_decide"]
            }
        ];

    for (const { label, body } of forbiddenCases) {
        test(`refuses candidate text carrying ${label}`, () => {
            const selected = fixture();
            const owed = obligation(`forbidden-${label}`);
            const text = [
                "namespace SpecCnl.Repair",
                "",
                ...body,
                "",
                "end SpecCnl.Repair",
                ""
            ].join("\n");
            let ran = false;

            const state = protocol(
                selected,
                [owed],
                acceptingVerifier(
                    selected,
                    [owed],
                    (outcomes) =>
                        new InspectingProofCommandRunner(outcomes, () => {
                            ran = true;
                        })
                )
            ).repair(candidate(selected, [owed], text), isolation(selected));

            const result = refusal(state);
            expect(result.kinds()).toEqual(["malformed"]);
            expect(result.feedback()).toContain("reaches past the kernel that judges it");
            expect(ran).toBe(false);
            expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
        });
    }

    const lexerCases: readonly {
        readonly label: string;
        readonly body: readonly string[];
        readonly refused: boolean;
    }[] = [
        {
            label: "a comment marker inside a string does not hide what follows it",
            body: ['def marker : String := "/-"', "axiom hidden : False"],
            refused: true
        },
        {
            label: "a dash pair inside a string does not comment out what follows it",
            body: ['def dash : String := "--"', "axiom hidden : False"],
            refused: true
        },
        {
            label: "a raw string carrying a comment marker does not hide a later hole",
            body: ['def raw : String := r#"/- "sorry" -/"#', "theorem t : True := by sorry"],
            refused: true
        },
        {
            // The discriminating case for raw strings: the inner quotes are content, so a
            // reader that treated this as ordinary strings would leave `sorry` outside them.
            label: "a raw string carrying quoted forbidden words is prose",
            body: ['def raw : String := r#"say "sorry" and "axiom" now"#'],
            refused: false
        },
        {
            label: "a forbidden word inside a genuine string is prose",
            body: ['def note : String := "sorry, this is documentation"'],
            refused: false
        },
        {
            label: "a forbidden word inside a genuine comment is prose",
            body: ["-- this proof used to be a sorry", "/- and an axiom lived here -/"],
            refused: false
        },
        {
            label: "an escaped quote does not end the string it sits in",
            body: ['def escaped : String := "a \\" axiom b"'],
            refused: false
        },
        {
            label: "a primed name is a name rather than a char literal",
            body: ["theorem t' : True := trivial", "theorem u : True := t'"],
            refused: false
        }
    ];

    for (const lexed of lexerCases) {
        test(`lexes candidate text so that ${lexed.label}`, () => {
            const source = [
                "namespace SpecCnl.Repair",
                "",
                ...lexed.body,
                "",
                "theorem proved_C13_RUN_ANCESTRY : True := trivial",
                "",
                "end SpecCnl.Repair",
                ""
            ].join("\n");

            const found = forbiddenProofTokens(source);

            expect(found.length > 0).toBe(lexed.refused);
        });
    }

    test("admits a private helper that carries no forbidden token", () => {
        const selected = fixture();
        const owed = obligation("private-helper");
        const text = [
            "namespace SpecCnl.Repair",
            "",
            "/- A helper the corpus does not audit: legitimate, and its soundness is the",
            "   designation audit's question rather than the token scan's. -/",
            "private theorem tableSet_preserves (table : Nat) : table = table := rfl",
            "",
            "theorem proved_C13_RUN_ANCESTRY : True :=",
            "  by",
            "    have _ := tableSet_preserves 0",
            "    trivial",
            "",
            "end SpecCnl.Repair",
            ""
        ].join("\n");

        const state = protocol(selected, [owed], acceptingVerifier(selected, [owed])).repair(
            candidate(selected, [owed], text),
            isolation(selected)
        );

        expect(acceptedProofRepair(state)?.progress).toEqual([owed]);
        expect(selected.store.load().artifacts[0]?.text).toBe(text);
    });

    test("scans candidate text for forbidden tokens without reading its comments", () => {
        expect(forbiddenProofTokens(repairText())).toEqual([]);
        expect(
            forbiddenProofTokens("-- a comment about sorry\ntheorem t : True := trivial\n")
        ).toEqual([]);
        expect(
            forbiddenProofTokens(
                "/- outer /- inner sorry -/ still comment -/\ntheorem t : True := trivial\n"
            )
        ).toEqual([]);
        expect(forbiddenProofTokens("theorem t : True := by\n  sorry\n")).toEqual(["sorry"]);
        // A line comment marker inside a block comment is comment text, not the start of a
        // line comment: reading it as one would swallow the code after the block ends.
        expect(
            forbiddenProofTokens("/- note -- about it -/ theorem t : True := by sorry\n")
        ).toEqual(["sorry"]);
        expect(forbiddenProofTokens("@[implemented_by fast] def slow : Nat := 0\n")).toEqual([
            "@[implemented_by]"
        ]);
        // A name that merely contains a forbidden word is not that word.
        expect(forbiddenProofTokens("theorem sorry_free_lemma : True := trivial\n")).toEqual([]);
        expect(PROOF_FORBIDDEN_TOKENS).toContain("native_decide");
        expect(Object.isFrozen(PROOF_FORBIDDEN_TOKENS)).toBe(true);
    });

    test("persists only the closures this acceptance is entitled to move", () => {
        const selected = fixture();
        const owed = obligation("entitled");
        const unrelated = obligation("never-in-any-objective");
        const proposal = candidate(selected, [owed]);

        const state = protocol(
            selected,
            proposal.obligations,
            acceptingVerifier(selected, [owed, unrelated])
        ).repair(proposal, isolation(selected));

        expect(acceptedProofRepair(state)).toBeDefined();
        const closed = selected.store.load().closedUnits();
        expect([...closed]).toEqual([owed.unit]);
        expect(closed.has(unrelated.unit)).toBe(false);
    });

    test("refuses a candidate build product or non-corpus artifact before verification", () => {
        const selected = fixture();
        const owed = obligation("outside");
        for (const path of ["lakefile.lean", "SpecCnl/.lake/Repair.lean", "Repair.lean"]) {
            const state = protocol(
                selected,
                [owed],
                new RefusingProofVerification(() => {
                    throw new TypeError("A refused artifact must not reach a verifier");
                })
            ).submit(
                {
                    artifacts: [{ path, text: repairText("by trivial") }],
                    baseline: selected.store.load().digest,
                    obligations: [owed.toData()]
                },
                isolation(selected)
            );

            expect(refusal(state).kinds()).toEqual(["malformed"]);
        }
        expect(PROOF_EVIDENCE_MODULES.has("SpecCnl/Report.lean")).toBe(true);
        expect(() => acceptedProofArtifact(REPAIRED, "the fixture artifact")).not.toThrow();
        // The discharge module stays writable on purpose: a protocol that cannot write a proof
        // closes nothing, and the evidence about that module lives in modules a candidate
        // cannot touch.
        expect(PROOF_EVIDENCE_MODULES.has("SpecCnl/Proofs.lean")).toBe(false);
        expect(() => acceptedProofArtifact("SpecCnl/Proofs.lean", "a discharge")).not.toThrow();
    });

    for (const escape of [
        "../escape.lean",
        "/absolute.lean",
        "SpecCnl//Repair.lean",
        "SpecCnl/./Repair.lean",
        "SpecCnl\\Repair.lean",
        "SpecCnl/Repaire\u0301.lean"
    ]) {
        test(`refuses ${JSON.stringify(escape)} as an artifact path`, () => {
            expect(() => new ProposedArtifact(escape, repairText("by trivial"))).toThrow(
                /canonical relative path|Unicode normal form/
            );
            expect(() => ProofRepairLocus.at("W0", escape)).toThrow(
                /canonical relative path|Unicode normal form/
            );
        });
    }

    test("treats a nested directory as overlapping and a sibling as separate", () => {
        expect(proofTreesOverlap("/proof/base", "/proof/base/isolation")).toBe(true);
        expect(proofTreesOverlap("/proof/base/isolation", "/proof/base")).toBe(true);
        expect(proofTreesOverlap("/proof/base", "/proof/base")).toBe(true);
        expect(proofTreesOverlap("/proof/base", "/proof/isolation")).toBe(false);
    });

    test("mints each isolation outside the repository as a path that does not exist yet", () => {
        const first = freshProofIsolation();
        const second = freshProofIsolation();

        try {
            expect(first.candidate).not.toBe(second.candidate);
            expect(first.candidate.startsWith(realpathSync(tmpdir()))).toBe(true);
            expect(proofTreesOverlap(first.candidate, process.cwd())).toBe(false);
            // The scratch directory exists; the candidate path inside it must not, because
            // materialization refuses a target that already exists.
            expect(existsSync(dirname(first.candidate))).toBe(true);
            expect(existsSync(first.candidate)).toBe(false);
        } finally {
            first.discard();
            second.discard();
        }
        expect(existsSync(dirname(first.candidate))).toBe(false);
    });

    test("accepts with no isolation argument and leaves no scratch directory behind", () => {
        const selected = fixture();
        const owed = obligation("default-isolation");
        const before = scratchDirectories();

        const state = protocol(selected, [owed], acceptingVerifier(selected, [owed])).repair(
            candidate(selected, [owed])
        );

        expect(acceptedProofRepair(state)).toBeDefined();
        expect(selected.store.load().artifacts[0]?.path).toBe(REPAIRED);
        expect(scratchDirectories()).toEqual(before);
    });

    test("leaves no scratch directory behind when admission refuses before isolation", () => {
        const selected = fixture();
        const owed = obligation("refused-before-isolation");
        const before = scratchDirectories();
        const stale = new ProofRepairCandidate(
            digest("moved"),
            [owed],
            [new ProposedArtifact(REPAIRED, repairText())]
        );

        const state = protocol(
            selected,
            [owed],
            new RefusingProofVerification(() => {
                throw new TypeError("A stale candidate must not reach a verifier");
            })
        ).repair(stale);

        expect(refusal(state).kinds()).toEqual(["stale"]);
        expect(scratchDirectories()).toEqual(before);
    });

    test("refuses an isolation that overlaps or already occupies its directory", () => {
        const selected = fixture();
        const owed = obligation("overlap");
        const nested = protocol(
            selected,
            [owed],
            new RefusingProofVerification(() => {
                throw new TypeError("An overlapping isolation must not reach a verifier");
            })
        ).repair(candidate(selected, [owed]), join(selected.base, "isolation"));
        expect(refusal(nested).kinds()).toEqual(["runtime"]);
        expect(refusal(nested).feedback()).toContain("overlaps the reviewed proof base");

        const occupied = isolation(selected);
        mkdirSync(occupied);
        const reused = protocol(
            selected,
            [owed],
            new RefusingProofVerification(() => {
                throw new TypeError("A reused isolation must not reach a verifier");
            })
        ).repair(candidate(selected, [owed]), occupied);
        expect(refusal(reused).kinds()).toEqual(["runtime"]);
        expect(refusal(reused).feedback()).toContain("already exists");
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("refuses an isolation inside the repository working copy", () => {
        const selected = fixture();
        const owed = obligation("inside-repo");
        const inside = join(process.cwd(), "reports", `proof-isolation-${isolationOrdinal}`);
        isolationOrdinal += 1;

        const state = protocol(
            selected,
            [owed],
            new RefusingProofVerification(() => {
                throw new TypeError("An in-repository isolation must not reach a verifier");
            })
        ).repair(candidate(selected, [owed]), inside);

        expect(refusal(state).kinds()).toEqual(["runtime"]);
        expect(refusal(state).feedback()).toContain("inside the repository");
        expect(existsSync(inside)).toBe(false);
    });

    test("refuses a candidate path the base holds as a symbolic link", () => {
        const selected = fixture();
        const owed = obligation("linked-file");
        const outside = join(selected.root, "outside.lean");
        writeFileSync(outside, "theorem outside : True := trivial\n");
        rmSync(join(selected.base, REPAIRED));
        symlinkSync(outside, join(selected.base, REPAIRED));

        const state = protocol(
            selected,
            [owed],
            new RefusingProofVerification(() => {
                throw new TypeError("A linked artifact must not reach a verifier");
            })
        ).repair(candidate(selected, [owed]), isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["isolation"]);
        expect(result.feedback()).toContain(`W0 ${REPAIRED}`);
        expect(readFileSync(outside, "utf8")).toBe("theorem outside : True := trivial\n");
    });

    test("rebuilds rather than copies build products into the isolation", () => {
        const selected = fixture();
        const owed = obligation("build-products");
        mkdirSync(join(selected.base, ".lake", "build"), { recursive: true });
        writeFileSync(join(selected.base, ".lake", "build", "Repair.olean"), "stale");
        let observed = false;

        protocol(
            selected,
            [owed],
            acceptingVerifier(
                selected,
                [owed],
                (outcomes) =>
                    new InspectingProofCommandRunner(outcomes, (cwd) => {
                        observed = true;
                        expect(existsSync(join(cwd, ".lake"))).toBe(false);
                        expect(existsSync(join(cwd, REPAIRED))).toBe(true);
                    })
            )
        ).repair(candidate(selected, [owed]), isolation(selected));

        expect(observed).toBe(true);
    });

    test("refuses an acceptance decided against a ledger that has since moved", () => {
        const selected = fixture();
        const proposal = candidate(selected, [obligation("fence")], repairText("by trivial"));
        const state = accept(selected, proposal);
        expect(acceptedProofRepair(state)).toBeDefined();

        const moved = new MemoryProofRepairStore(selected.store.load());
        expect(() => moved.commit(state)).toThrow(
            "An accepted proof repair was decided against a stale ledger"
        );
    });

    test("refuses a second commit of the same acceptance", () => {
        const selected = fixture();
        const path = join(selected.root, "double", "proof-repair.json");
        const store = new FileProofRepairStore(path);
        const owed = obligation("double-commit");
        const proposal = new ProofRepairCandidate(
            store.load().digest,
            [owed],
            [new ProposedArtifact(REPAIRED, repairText("by trivial"))]
        );

        const state = new ProofRepairProtocol(
            selected.base,
            new ProofRepairObjective([owed]),
            store,
            acceptingVerifier(selected, [owed]),
            selected.owners
        ).repair(proposal, isolation(selected));
        const first = acceptedProofRepair(state);
        if (first === undefined) throw new TypeError("The fixture did not accept");

        expect(() => store.commit(state)).toThrow(
            "An accepted proof repair was decided against a stale ledger"
        );
        expect(new FileProofRepairStore(path).load().digest).toBe(first.ledger.digest);
        expect(existsSync(join(selected.root, "double", ".proof-repair.json.lock"))).toBe(false);
    });

    test("refuses to publish while another commit holds the ledger lock", () => {
        const selected = fixture();
        const directory = join(selected.root, "locked");
        const path = join(directory, "proof-repair.json");
        const store = new FileProofRepairStore(path);
        const owed = obligation("locked");
        const proposal = new ProofRepairCandidate(
            store.load().digest,
            [owed],
            [new ProposedArtifact(REPAIRED, repairText("by trivial"))]
        );
        const state = protocol(selected, [owed], acceptingVerifier(selected, [owed])).repair(
            candidate(selected, [owed]),
            isolation(selected)
        );
        expect(acceptedProofRepair(state)).toBeDefined();
        writeFileSync(join(directory, ".proof-repair.json.lock"), "99999\n");

        const held = new ProofRepairCandidate(
            store.load().digest,
            [owed],
            [new ProposedArtifact(REPAIRED, proposal.artifacts[0]?.text ?? "")]
        );
        const blocked = new ProofRepairProtocol(
            selected.base,
            new ProofRepairObjective([owed]),
            store,
            acceptingVerifier(selected, [owed]),
            selected.owners
        );

        expect(() => blocked.repair(held, isolation(selected))).toThrow(
            "The proof repair ledger is locked by another commit"
        );
        expect(existsSync(path)).toBe(false);
    });

    test("refuses a ledger location that is not one ordinary absolute file", () => {
        const selected = fixture();
        expect(() => new FileProofRepairStore("artifacts/quality/proof-repair.json")).toThrow(
            "A ledger path is not absolute"
        );
        const linked = join(selected.root, "linked-ledger.json");
        symlinkSync(join(selected.root, "absent.json"), linked);
        expect(() => new FileProofRepairStore(linked).load()).toThrow(
            "The proof repair ledger is not an ordinary file"
        );
    });

    test("reads a compile defect out of lake's build log with the goal it left open", () => {
        const selected = fixture();
        const proposal = candidate(selected, [obligation("lake-compile")]);
        const state = protocol(
            selected,
            proposal.obligations,
            leanVerifier(selected, [
                {
                    status: 1,
                    output: [
                        "\u2716 [2/4] Building SpecCnl.Repair (98ms)",
                        "trace: .> LEAN_PATH=.lake/build/lib/lean lean SpecCnl/Repair.lean",
                        `error: ${REPAIRED}:3:18: unsolved goals`,
                        "\u22a2 True",
                        "error: Lean exited with code 1",
                        "Some required targets logged failures:",
                        "- SpecCnl.Repair"
                    ].join("\n")
                }
            ])
        ).repair(proposal, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["compile"]);
        expect(result.feedback()).toContain(`W0 ${REPAIRED}:3:18`);
        expect(result.refusals[0]?.counterexample).toEqual(["unsolved goals\n\u22a2 True"]);
    });

    test("reads a compile defect Lean labelled with an error kind", () => {
        const selected = fixture();
        const proposal = candidate(selected, [obligation("named-error")]);
        const state = protocol(
            selected,
            proposal.obligations,
            leanVerifier(selected, [
                {
                    status: 1,
                    output:
                        `${REPAIRED}:11:18: error(lean.unknownIdentifier): ` +
                        "Unknown identifier `nonexistentThing`"
                }
            ])
        ).repair(proposal, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["compile"]);
        expect(result.feedback()).toContain(`W0 ${REPAIRED}:11:18`);
        expect(result.refusals[0]?.counterexample).toEqual([
            "Unknown identifier `nonexistentThing`"
        ]);
    });

    test("attributes a base-file diagnostic to the candidate edit that broke it", () => {
        const selected = fixture();
        const owed = obligation("cross-file");
        const proposal = candidate(selected, [owed]);
        const state = protocol(
            selected,
            proposal.obligations,
            leanVerifier(selected, [
                {
                    status: 1,
                    output:
                        "error: SpecCnl/Bridge.lean:5:1: unknown constant " +
                        "'SpecCnl.Repair.proved_C13_RUN_ANCESTRY'"
                }
            ])
        ).repair(proposal, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["compile"]);
        expect(result.feedback()).toContain("W0 SpecCnl/Bridge.lean:5:1");
        expect(result.refusals[0]?.counterexample[0]).toContain(
            `broken by the candidate edit to ${REPAIRED}`
        );
        expect(result.attributed).toBe(true);
    });

    test("leaves a refusal with more than two readings as a compile defect", () => {
        const selected = fixture();
        const proposal = candidate(selected, [obligation("three-readings")]);
        const state = protocol(
            selected,
            proposal.obligations,
            leanVerifier(selected, [
                {
                    status: 1,
                    output:
                        `${REPAIRED}:7:3: error: refused: 'every proof closes every ` +
                        "goal' has 3 readings: close(proof) | close(goal) | close(every)"
                }
            ])
        ).repair(proposal, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["compile"]);
        expect(result.feedback()).toContain("does not elaborate");
        expect(result.refusals[0]?.counterexample[0]).toContain("3 readings");
    });

    test("names the candidate's own declaration when the shapes assertion refuses", () => {
        const selected = fixture();
        const proposal = candidate(selected, [obligation("shapes")]);
        const state = protocol(
            selected,
            proposal.obligations,
            leanVerifier(selected, [
                {
                    status: 1,
                    output:
                        "SpecCnl/Report.lean:210:0: error: controlled-language declaration " +
                        "shapes refused: C13_RUN_ANCESTRY: SpecCnl.Bridge.bridge_C13_RUN_ANCESTRY" +
                        " has type other, not Iff(const:a,const:b); C13_RUN_ANCESTRY: " +
                        "SpecCnl.Repair.proved_C13_RUN_ANCESTRY has type Prop, not const:b"
                }
            ])
        ).repair(proposal, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["model"]);
        expect(result.feedback()).toContain(
            `W0 ${REPAIRED} theorem SpecCnl.Repair.proved_C13_RUN_ANCESTRY`
        );
        expect(result.refusals[0]?.counterexample).toHaveLength(3);
        expect(result.refusals[0]?.counterexample.join(" ")).toContain(
            "SpecCnl.Bridge.bridge_C13_RUN_ANCESTRY has type other"
        );
        expect(result.refusals[0]?.counterexample.join(" ")).toContain(
            "reported at SpecCnl/Report.lean:210:0"
        );
    });

    test("refuses a declaration the report says stands on sorryAx, with its other axioms", () => {
        const selected = fixture();
        const owed = obligation("sorry");
        const proposal = candidate(selected, [owed]);
        const state = protocol(
            selected,
            proposal.obligations,
            leanVerifier(selected, [
                { status: 0, output: "" },
                {
                    status: 0,
                    output: cleanReport(
                        [owed],
                        new Map([
                            [
                                "SpecCnl.Repair.proved_C13_RUN_ANCESTRY",
                                ["sorryAx", "Unreviewed.Axiom"]
                            ]
                        ])
                    )
                }
            ])
        ).repair(proposal, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["proof", "assumption"]);
        expect(result.feedback()).toContain("sorryAx");
        expect(result.feedback()).toContain("assumption Unreviewed.Axiom");
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("refuses a designation that leans on an axiom the doctrine has not reviewed", () => {
        const selected = fixture();
        const owed = obligation("unreviewed-axiom");
        const proposal = candidate(selected, [owed]);
        const state = protocol(
            selected,
            proposal.obligations,
            leanVerifier(selected, [
                { status: 0, output: "" },
                {
                    status: 0,
                    output: cleanReport(
                        [owed],
                        new Map([
                            [
                                "SpecCnl.Repair.proved_C13_RUN_ANCESTRY",
                                ["Classical.choice", "Unreviewed.Axiom"]
                            ]
                        ])
                    )
                }
            ])
        ).repair(proposal, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["assumption"]);
        expect(result.feedback()).toContain("assumption Unreviewed.Axiom");
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("accepts a run whose designations use only reviewed axioms", () => {
        const selected = fixture();
        const owed = obligation("reviewed-axioms");
        const text = repairText("by trivial");
        const proposal = candidate(selected, [owed], text);
        const state = protocol(
            selected,
            proposal.obligations,
            leanVerifier(selected, [
                { status: 0, output: "" },
                {
                    status: 0,
                    output: cleanReport(
                        [owed],
                        new Map([
                            [
                                "SpecCnl.Repair.proved_C13_RUN_ANCESTRY",
                                ["Classical.choice", "propext"]
                            ]
                        ])
                    )
                }
            ])
        ).repair(proposal, isolation(selected));

        expect(acceptedProofRepair(state)?.progress).toEqual([owed]);
        expect(selected.store.load().artifacts[0]?.text).toBe(text);
    });

    test("refuses a report that omits an audited axiom designation", () => {
        const selected = fixture();
        const owed = obligation("incomplete-designations");
        const proposal = candidate(selected, [owed]);
        const state = protocol(
            selected,
            proposal.obligations,
            leanVerifier(selected, [
                { status: 0, output: "" },
                {
                    status: 0,
                    output: [
                        "'SpecCnl.Repair.proved_C13_RUN_ANCESTRY' does not depend on any axioms",
                        provedLedgerLine([owed])
                    ].join("\n")
                }
            ])
        ).repair(proposal, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["runtime"]);
        expect(result.attributed).toBe(false);
        expect(result.feedback()).toContain(
            "no axiom designation was printed for SpecCnl.Sentences.cnl_C13_RUN_ANCESTRY"
        );
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("refuses a report that designates a declaration the corpus never audited", () => {
        const selected = fixture();
        const owed = obligation("unaudited-designation");
        const proposal = candidate(selected, [owed]);
        const state = protocol(
            selected,
            proposal.obligations,
            leanVerifier(selected, [
                { status: 0, output: "" },
                {
                    status: 0,
                    output: [
                        cleanReport([owed]),
                        "'SpecCnl.Repair.hidden_helper' does not depend on any axioms"
                    ].join("\n")
                }
            ])
        ).repair(proposal, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["malformed"]);
        expect(result.feedback()).toContain(
            `SpecCnl.Repair.hidden_helper is introduced by ${REPAIRED}`
        );
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("reaches no verdict when a clean report prints no ledger line", () => {
        const selected = fixture();
        const owed = obligation("no-ledger");
        const state = protocol(
            selected,
            [owed],
            leanVerifier(selected, [
                { status: 0, output: "" },
                { status: 0, output: "'SpecCnl.Repair.proved_X' does not depend on any axioms" }
            ])
        ).repair(candidate(selected, [owed]), isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["runtime"]);
        expect(result.attributed).toBe(false);
        expect(result.feedback()).toContain("no ledger line was printed");
    });

    test("reaches no verdict when a run prints a second ledger line", () => {
        const selected = fixture();
        const owed = obligation("two-ledgers");
        const forged = provedLedgerLine([owed, obligation("smuggled")]);
        const state = protocol(
            selected,
            [owed],
            leanVerifier(selected, [
                { status: 0, output: "" },
                { status: 0, output: [forged, cleanReport([owed])].join("\n") }
            ])
        ).repair(candidate(selected, [owed]), isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["runtime"]);
        expect(result.attributed).toBe(false);
        expect(result.feedback()).toContain("2 ledger lines");
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("reaches no verdict on a ledger line that is not the shape the reader expects", () => {
        const selected = fixture();
        const owed = obligation("bad-ledger");
        const state = protocol(
            selected,
            [owed],
            leanVerifier(selected, [
                { status: 0, output: "" },
                { status: 0, output: 'cnl-ledger {"units":[{"digest":"short"}]}' }
            ])
        ).repair(candidate(selected, [owed]), isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["runtime"]);
        expect(result.attributed).toBe(false);
    });

    test("reaches no verdict on a failed build it cannot attribute", () => {
        const selected = fixture();
        const owed = obligation("inconclusive");
        const state = protocol(
            selected,
            [owed],
            leanVerifier(selected, [{ status: 137, output: "error: build failed" }])
        ).repair(candidate(selected, [owed]), isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["runtime"]);
        expect(result.attributed).toBe(false);
        expect(result.feedback()).toContain("exit 137");
    });

    test("refuses a report whose obligation the run did not prove", () => {
        const selected = fixture();
        const owed = obligation("unproved");
        const state = protocol(
            selected,
            [owed],
            acceptingVerifier(selected, [obligation("other-unit")])
        ).repair(candidate(selected, [owed]), isolation(selected));

        expect(refusal(state).kinds()).toEqual(["open"]);
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("refuses evidence measured over bytes a command rewrote in the isolation", () => {
        const selected = fixture();
        const owed = obligation("tamper");
        const proposal = candidate(selected, [owed], repairText("by trivial"));
        const state = protocol(
            selected,
            proposal.obligations,
            acceptingVerifier(
                selected,
                [owed],
                (outcomes) => new TamperingProofCommandRunner(outcomes)
            )
        ).repair(proposal, isolation(selected));

        const result = refusal(state);
        expect(result.kinds()).toEqual(["runtime"]);
        expect(result.attributed).toBe(false);
        expect(result.feedback()).toContain("the candidate is");
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("cannot construct a verification report at all", () => {
        // There is no authority object to mint any more: authority is a row this module keeps
        // for reports it built, and a report is unconstructable from outside it.
        expect(
            () => new ProofVerificationReport(Symbol("forged"), digest("c"), [], [], [], [])
        ).toThrow("A verification report cannot be constructed by a caller");
        expect(
            () => new ProofVerificationReport(Symbol.iterator, digest("c"), [], [], [], [])
        ).toThrow("A verification report cannot be constructed by a caller");
    });

    test("spends one run's acceptance authority exactly once", () => {
        const selected = fixture();
        const owed = obligation("single-use");
        const proposal = candidate(selected, [owed]);
        const capture = new CapturingProofVerification(acceptingVerifier(selected, [owed]));

        const state = protocol(selected, proposal.obligations, capture).repair(
            proposal,
            isolation(selected)
        );
        expect(acceptedProofRepair(state)).toBeDefined();
        const report = capture.report();

        // The report is genuine, so a caller holding it reaches the decision — once. The row
        // this module keeps for that run was spent by the acceptance above.
        expect(() => redeemProofVerdict(report)).toThrow("was already redeemed");
        expect(() =>
            ProofRepairState.assess(
                ProofRepairLedger.genesis,
                new ProofRepairObjective([owed]),
                proposal,
                report,
                selected.owners,
                AUDITED
            )
        ).toThrow("was already redeemed");
    });

    test("refuses a proxied report that answers the decision's questions itself", () => {
        const selected = fixture();
        const owed = obligation("proxied-report");
        const proposal = candidate(selected, [owed]);
        const capture = new CapturingProofVerification(
            leanVerifier(selected, [
                { status: 1, output: `${REPAIRED}:3:0: error: unexpected token` }
            ])
        );

        const refused = protocol(selected, proposal.obligations, capture).repair(
            proposal,
            isolation(selected)
        );
        expect(refusal(refused).kinds()).toEqual(["compile"]);
        const report = capture.report();

        // Frozen own properties cannot be re-answered by a proxy — JavaScript enforces that
        // invariant itself — but methods reached through the prototype can, and the decision's
        // questions used to be exactly that. This proxy answers them the way an attacker wants:
        // yes, this describes your candidate; yes, it proved your obligation; nothing was wrong.
        const proxied = new Proxy(report, {
            get: (target, key) => {
                if (key === "describes") return () => true;
                if (key === "proves") return () => true;
                if (key === "redeemAcceptance") return () => undefined;
                if (key === "candidate") return target.candidate;
                if (key === "artifacts") return target.artifacts;
                if (key === "closed") return target.closed;
                if (key === "designations") return target.designations;
                if (key === "findings") return target.findings;
                return undefined;
            }
        });

        expect(proxied instanceof ProofVerificationReport).toBe(true);
        expect(proofVerdictOf(report)?.findings.length).toBe(1);
        expect(proofVerdictOf(proxied)).toBeUndefined();
        expect(() =>
            ProofRepairState.assess(
                selected.store.load(),
                new ProofRepairObjective([owed]),
                proposal,
                proxied,
                selected.owners,
                AUDITED
            )
        ).toThrow("needs a verdict this verifier reached");
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("refuses a proxy wrapped around a genuine acceptance at the commit seam", () => {
        const selected = fixture();
        const owed = obligation("proxied");
        const genuine = accept(selected, candidate(selected, [owed]));
        const accepted = acceptedProofRepair(genuine);
        if (accepted === undefined) throw new TypeError("The fixture did not accept");
        const proxied = new Proxy(genuine, {});

        // A proxy satisfies `instanceof` and forwards every read, which is why the store's gate
        // is identity in a module-private map rather than a prototype check.
        expect(proxied instanceof ProofRepairState).toBe(true);
        expect(acceptedProofRepair(proxied)).toBeUndefined();
        expect(() => new MemoryProofRepairStore().commit(proxied)).toThrow(
            "A refused proof repair has no authority to overwrite artifacts"
        );
    });

    test("refuses a state that only looks accepted at the commit seam", () => {
        const selected = fixture();
        const owed = obligation("forged-state");
        const genuine = accept(selected, candidate(selected, [owed]));
        const accepted = acceptedProofRepair(genuine);
        if (accepted === undefined) throw new TypeError("The fixture did not accept");
        const lookalike = ProofRepairState.refused(ProofRepairLedger.genesis, [
            ProofRepairRefusal.malformed("a refusal wearing an acceptance's shape")
        ]);

        expect(acceptedProofRepair(lookalike)).toBeUndefined();
        expect(() => new MemoryProofRepairStore().commit(lookalike)).toThrow(
            "A refused proof repair has no authority to overwrite artifacts"
        );
    });

    test("reads both diagnostic renderings and keeps lake's own lines out of them", () => {
        const diagnostics = parseProofDiagnostics(
            [
                "\u2716 [2/4] Building SpecCnl.Repair (98ms)",
                `error: ${REPAIRED}:3:18: unsolved goals`,
                "\u22a2 True",
                "error: Lean exited with code 1",
                `${REPAIRED}:7:3-7:9: warning: declaration uses \`sorry\``,
                `${REPAIRED}:11:18: error(lean.unknownIdentifier): Unknown identifier \`x\``,
                "'SpecCnl.Repair.proved_X' does not depend on any axioms"
            ].join("\n")
        );

        expect(
            diagnostics.map((diagnostic) => [
                diagnostic.severity,
                `${diagnostic.artifact}:${diagnostic.span.render()}`,
                diagnostic.message
            ])
        ).toEqual([
            ["error", `${REPAIRED}:3:18`, "unsolved goals\n\u22a2 True"],
            ["warning", `${REPAIRED}:7:3`, "declaration uses `sorry`"],
            ["error", `${REPAIRED}:11:18`, "Unknown identifier `x`"]
        ]);
    });

    test("reads axiom designations in both forms the report prints", () => {
        const designations = parseAxiomDesignations(
            [
                "'SpecCnl.Repair.proved_X' depends on axioms: [Classical.choice, propext]",
                "'SpecCnl.Sentences.cnl_X' does not depend on any axioms",
                'cnl-ledger {"units":[]}'
            ].join("\n")
        );

        expect(
            designations.map((designation) => [designation.declaration, [...designation.axioms]])
        ).toEqual([
            ["SpecCnl.Repair.proved_X", ["Classical.choice", "propext"]],
            ["SpecCnl.Sentences.cnl_X", []]
        ]);
    });

    test("captures the exit status and both streams of one real process", () => {
        const selected = fixture();
        const runner = new SpawnProofCommandRunner();

        const outcome = runner.run(
            ProofCommand.parse([
                process.execPath,
                "-e",
                "process.stdout.write('out');process.stderr.write('err');process.exit(3)"
            ]),
            selected.root
        );
        expect(outcome.status).toBe(3);
        expect(outcome.output).toContain("out");
        expect(outcome.output).toContain("err");

        // The supervisor ran and reported that the command could not be executed, which is a
        // status the protocol turns into an unattributed refusal rather than a defect.
        const absent = runner.run(new ProofCommand("agent-core-absent-program", []), selected.root);
        expect(absent.status).toBe(127);
        expect(absent.output.length).toBeGreaterThan(0);
    });

    test("scrubs the environment a real command inherits", () => {
        const selected = fixture();
        process.env["AGENT_CORE_PROOF_SECRET"] = "must-not-leak";

        const outcome = new SpawnProofCommandRunner().run(
            ProofCommand.parse([
                process.execPath,
                "-e",
                "process.stdout.write(Object.keys(process.env).sort().join(','))"
            ]),
            selected.root
        );
        delete process.env["AGENT_CORE_PROOF_SECRET"];

        expect(outcome.status).toBe(0);
        expect(outcome.output).not.toContain("AGENT_CORE_PROOF_SECRET");
        expect(outcome.output.split(",")).toEqual([
            "ELAN_HOME",
            "HOME",
            "LANG",
            "LC_ALL",
            "PATH",
            "TMPDIR"
        ]);
    });

    test("resolves a real Lean toolchain under the scrubbed environment", () => {
        const selected = fixture();
        const project = join(selected.root, "project");
        mkdirSync(project);
        // The toolchain the reviewed corpus pins. `HOME` is repointed at the isolation, so this
        // proves the run finds a toolchain through ELAN_HOME rather than through the host home.
        writeFileSync(
            join(project, "lean-toolchain"),
            readFileSync(join(process.cwd(), "formal", "lean-toolchain"), "utf8")
        );
        writeFileSync(join(project, "lakefile.toml"), 'name = "probe"\ndefaultTargets = []\n');

        const outcome = new SpawnProofCommandRunner(120_000).run(
            new ProofCommand("lake", ["--version"]),
            project
        );

        expect(outcome.status).toBe(0);
        expect(outcome.output).toContain("Lake version");
        expect(outcome.output).toContain("Lean version");
    });

    // A real child, a real budget, and a real kill: the behaviour under test is the platform's
    // process supervision, which fake timers cannot exercise. The budget is 250ms.
    test("kills a command that outruns its wall-clock budget and reaches no verdict", () => {
        const selected = fixture();
        const owed = obligation("timeout");
        const verifier = new LeanProofCandidateVerification(
            new SpawnProofCommandRunner(250),
            selected.owners,
            ProofCommand.parse([process.execPath, "-e", "setTimeout(() => {}, 30000)"]),
            new ProofCommand("lake", ["env", "lean", ENTRY]),
            AUDITED,
            ENTRY
        );

        const state = protocol(selected, [owed], verifier).repair(
            candidate(selected, [owed]),
            isolation(selected)
        );

        const result = refusal(state);
        expect(result.kinds()).toEqual(["runtime"]);
        expect(result.attributed).toBe(false);
        expect(result.feedback()).toContain("was killed after 250ms");
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("names the sandbox premise the host still owes", () => {
        expect(Object.isFrozen(proofVerifierSandboxPremise)).toBe(true);
        expect(proofVerifierSandboxPremise.name).toBe("same-user-process-isolation");
        expect(proofVerifierSandboxPremise.enforced.length).toBeGreaterThan(0);
        expect(proofVerifierSandboxPremise.hostOwes).toContain("isolation");
        expect(() => new SpawnProofCommandRunner(0)).toThrow("is not a duration");
    });

    test("resolves a formal artifact against the repository's own ownership map", async () => {
        const owners = await RepositoryProofArtifactOwners.fromRepository();
        expect(owners.owner("SpecCnl/Proofs.lean")).toBe("W0");
        expect(owners.owner("SpecCnl/Report.lean")).toBe("W0");

        const unmapped = await RepositoryProofArtifactOwners.fromRepository(
            "packages/agent-core/reports"
        );
        expect(unmapped.owner("quality.json")).toBeUndefined();
    });

    test("refuses to name an owner when two patterns claim one artifact", () => {
        const ambiguous = new RepositoryProofArtifactOwners(
            "packages/agent-core/formal/",
            new Map([
                ["packages/agent-core/formal/**", "W0"],
                [`packages/agent-core/formal/${REPAIRED}`, "W5"]
            ])
        );

        expect(ambiguous.owner(REPAIRED)).toBeUndefined();
        expect(ambiguous.owner("SpecCnl/Report.lean")).toBe("W0");
    });

    test("reaches no verdict on a designated module the owners seam cannot name", () => {
        const selected = fixture();
        const owed = obligation("unowned-module");
        const proposal = candidate(selected, [owed]);
        const verifier = new LeanProofCandidateVerification(
            new ScriptedProofCommandRunner([
                { status: 0, output: "" },
                {
                    status: 0,
                    output: [
                        ...AUDITED.map((name) => `'${name}' does not depend on any axioms`),
                        "'SpecCnl.Hostile.refused_X' does not depend on any axioms",
                        provedLedgerLine([owed])
                    ].join("\n")
                }
            ]),
            selected.owners,
            new ProofCommand("lake", ["build", "SpecCnl"]),
            new ProofCommand("lake", ["env", "lean", ENTRY]),
            [...AUDITED, "SpecCnl.Hostile.refused_X"],
            ENTRY
        );

        const state = protocol(selected, proposal.obligations, verifier).repair(
            proposal,
            isolation(selected)
        );

        const result = refusal(state);
        expect(result.kinds()).toEqual(["runtime"]);
        expect(result.attributed).toBe(false);
        expect(result.feedback()).toContain(
            "SpecCnl/Hostile.lean carries SpecCnl.Hostile.refused_X"
        );
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("keeps the feedback vocabulary closed and every kind constructable", () => {
        const selected = fixture();
        const spot = ProofRepairLocus.at("W0", REPAIRED);
        const positioned = spot.withSpan(new ProofArtifactSpan(7, 3));
        const owed = obligation("vocabulary");
        const accepted = acceptedProofRepair(accept(selected, candidate(selected, [owed])));
        if (accepted === undefined) throw new TypeError("The fixture did not accept");

        const findings = [
            ProofRepairRefusal.ambiguity(positioned, "every proof closes", [
                "close(a)",
                "close(b)"
            ]),
            ProofRepairRefusal.assumption(
                positioned
                    .withTheorem("SpecCnl.Repair.proved_X")
                    .withAssumption("Unreviewed.Axiom"),
                ["Unreviewed.Axiom"]
            ),
            ProofRepairRefusal.compile(positioned, "unexpected token"),
            ProofRepairRefusal.model(positioned.withTheorem("SpecCnl.Repair.proved_X"), ["other"]),
            ProofRepairRefusal.proof(positioned.withTheorem("SpecCnl.Repair.proved_X"), "⊢ True"),
            ProofRepairRefusal.runtime("lake build SpecCnl", ["exit 137"])
        ];
        const admissions = [
            ProofRepairRefusal.isolation(spot, "escapes"),
            ProofRepairRefusal.malformed("unreadable"),
            ProofRepairRefusal.open([owed]),
            ProofRepairRefusal.progress([owed]),
            ProofRepairRefusal.regression(accepted.ledger.closed),
            ProofRepairRefusal.stale(ProofRepairLedger.genesis.digest, digest("moved"))
        ];

        expect(findings.map((finding) => finding.kind)).toEqual([...proofFindingKinds]);
        expect(admissions.map((admission) => admission.kind)).toEqual([...proofAdmissionKinds]);
        expect(findings.filter((finding) => finding.attributed)).toHaveLength(5);
        expect(admissions.every((admission) => admission.attributed)).toBe(true);
        const admitted = new Set<string>(proofAdmissionKinds);
        expect([...proofFindingKinds].filter((kind) => admitted.has(kind))).toEqual([]);
    });

    test("declares the codec version the committed ledger artifact carries", () => {
        const committed = parseCanonicalJson(
            readFileSync(proofRepairLedgerArtifact, "utf8"),
            proofRepairLedgerArtifact
        );
        const record = assertObject(committed, proofRepairLedgerArtifact);

        expect(record["version"]).toBe(proofRepairLedgerVersion);
        expect(record["kind"]).toBe("proof.repair.ledger");
        expect(Object.keys(record).sort()).toEqual(["artifacts", "closed", "kind", "version"]);
    });
});
