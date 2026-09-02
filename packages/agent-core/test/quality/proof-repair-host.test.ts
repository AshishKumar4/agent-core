import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import {
    assertArray,
    assertObject,
    parseCanonicalJson,
    type JsonObject,
    type JsonValue
} from "../../scripts/quality/project.mjs";
import {
    AcceptedArtifact,
    ClosedObligation,
    ProofObligation,
    ProofRepairCandidate,
    ProofRepairLedger,
    ProofRepairLedgerCodec,
    ProofRepairObjective,
    ProposedArtifact
} from "../../scripts/quality/proof-repair-record.js";
import { acceptedProofRepair } from "../../scripts/quality/proof-repair-outcome.js";
import {
    DeclaredProofArtifactOwners,
    ProofArtifactSpan,
    ProofRepairLocus,
    ProofRepairRefusal
} from "../../scripts/quality/proof-repair-refusal.js";
import {
    FileProofRepairStore,
    MemoryProofRepairStore
} from "../../scripts/quality/proof-repair-store.js";
import { ProofRepairProtocol } from "../../scripts/quality/proof-repair.js";
import {
    LeanProofCandidateVerification,
    ProofCandidateVerification,
    ProofCommand,
    ProofCommandRunner,
    ProofVerificationReport,
    type ProofCandidateSubject,
    type ProofCommandOutcome
} from "../../scripts/quality/proof-repair-verification.js";
import {
    ProofRepairHost,
    RecordedProofCandidateGenerator,
    cnlCorpusLedgerArtifact,
    corpusObjective,
    type ProofCandidateGenerator,
    type ProofRepairTurn
} from "../../scripts/quality/proof-repair-host.js";
import {
    runQualitySubprocess,
    subprocessTestOptions,
    type QualitySubprocessResult
} from "./subprocess";

/**
 * Hostile tests for the untrusted-LLM proof synthesis loop host and its ledger gate.
 *
 * The landed protocol judges one candidate. This host owns the loop around that
 * judgement, so what has to be proven here is that the loop cannot be talked out of the
 * protocol's guarantees: a refused candidate's feedback reaches the next turn while the
 * accepted state stays byte-for-byte alone, a spent budget stops the loop rather than
 * relaxing anything, an acceptance persists through the store's compare-and-publish and
 * re-verifies from the committed record, and the gate that reads that record refuses a
 * formal tree that has drifted from it.
 *
 * Every acceptance below is produced the only way one can be — by a real verification run
 * over captured Lean output — because a report carries the acceptance capability and no
 * fixture can mint one. The gate cases run the real gate script in a scratch tree, the
 * same way the tslean-consumer suite runs its checker.
 */

const packageRoot = resolve(import.meta.dirname, "../..");
const gateScript = resolve(packageRoot, "scripts/quality/proof-repair-ledger.mjs");
const temporary: string[] = [];
let isolationOrdinal = 0;

/** The candidate-writable module of the fixture corpus. */
const REPAIRED = "SpecCnl/Repair.lean";

/** The frozen module the audited run elaborates, and the root of the import closure. */
const ENTRY = "SpecCnl/Report.lean";

/** The declarations the fixture corpus registers for the axiom report. */
const AUDITED = Object.freeze([
    "SpecCnl.Repair.proved_C13_RUN_ANCESTRY",
    "SpecCnl.Sentences.cnl_C13_RUN_ANCESTRY"
]);

interface HostFixture {
    readonly root: string;
    readonly base: string;
    readonly store: MemoryProofRepairStore;
    readonly owners: DeclaredProofArtifactOwners;
}

/** Captured Lean process results, so the protocol exercises its parser, its policy and
 * its state machine without a fixture executing a candidate. */
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

/** A verifier seam that answers with whatever the case scripted, in call order. It can
 * only refuse on its own: a report is unconstructable outside a completed run, so an
 * accepting answer has to come from the real verifier below. */
class ScriptedProofVerification extends ProofCandidateVerification {
    private readonly answers: readonly ((
        subject: ProofCandidateSubject
    ) => ProofVerificationReport | ProofRepairRefusal)[];
    private position = 0;

    public constructor(
        answers: readonly ((
            subject: ProofCandidateSubject
        ) => ProofVerificationReport | ProofRepairRefusal)[]
    ) {
        super();
        this.answers = Object.freeze([...answers]);
    }

    public verify(subject: ProofCandidateSubject): ProofVerificationReport | ProofRepairRefusal {
        const answer = this.answers[Math.min(this.position, this.answers.length - 1)];
        if (answer === undefined) throw new TypeError("The fixture scripted no verifier answer");
        this.position += 1;
        return answer(subject);
    }

    public auditedNames(): readonly string[] {
        return AUDITED;
    }

    /** How many candidates this verifier was actually handed. */
    public runs(): number {
        return this.position;
    }
}

/** A generator that records every turn it was handed, so a case asserts what the
 * generator was told rather than what the host believes it said. */
class RecordingGenerator implements ProofCandidateGenerator {
    public readonly turns: ProofRepairTurn[] = [];
    private readonly delegate: ProofCandidateGenerator;

    public constructor(delegate: ProofCandidateGenerator) {
        this.delegate = delegate;
    }

    public propose(turn: ProofRepairTurn): JsonValue | undefined {
        this.turns.push(turn);
        return this.delegate.propose(turn);
    }
}

afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

function fixture(): HostFixture {
    const root = mkdtempSync(join(tmpdir(), "agent-core-proof-repair-host-"));
    const base = join(root, "base");
    mkdirSync(join(base, "SpecCnl"), { recursive: true });
    writeFileSync(join(base, REPAIRED), repairText("trivial"));
    writeFileSync(join(base, "SpecCnl", "Sentences.lean"), "theorem stated : True := trivial\n");
    // The frozen entry module: the import-closure walk starts here, and only a frozen
    // module's imports are followed, so this is what makes the writable module reachable.
    writeFileSync(
        join(base, ENTRY),
        ["import SpecCnl.Repair", "import SpecCnl.Sentences", "#cnl_ledger"].join("\n")
    );
    temporary.push(root);
    return {
        root,
        base,
        store: new MemoryProofRepairStore(),
        owners: new DeclaredProofArtifactOwners([
            { path: REPAIRED, owner: "W0" },
            { path: "SpecCnl/Sentences.lean", owner: "W0" },
            { path: ENTRY, owner: "W0" }
        ])
    };
}

function obligation(label: string): ProofObligation {
    return new ProofObligation(
        createHash("sha256").update(label).digest("hex"),
        ["C13-RUN-ANCESTRY"],
        "SPEC.md:1601"
    );
}

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

function proposal(
    selected: HostFixture,
    obligations: readonly ProofObligation[],
    text: string = repairText()
): JsonObject {
    return new ProofRepairCandidate(selected.store.load().digest, obligations, [
        new ProposedArtifact(REPAIRED, text)
    ]).toData();
}

function isolation(selected: HostFixture): string {
    const path = join(selected.root, `isolation-${isolationOrdinal}`);
    isolationOrdinal += 1;
    return path;
}

/** The output one clean report run prints: a designation for every audited declaration,
 * then the ledger line naming the units the run proved. */
function cleanReport(proved: readonly ProofObligation[]): string {
    const designations = AUDITED.map((name) => `'${name}' does not depend on any axioms`);
    const units = proved.map((owed) => ({
        anchor: owed.anchor,
        atoms: [...owed.atoms],
        digest: owed.unit
    }));
    return [...designations, `cnl-ledger ${JSON.stringify({ units })}`].join("\n");
}

/** A verifier whose run accepts: a clean build, then a report designating every audited
 * declaration with reviewed axioms only. */
function acceptingVerifier(
    selected: HostFixture,
    proved: readonly ProofObligation[]
): LeanProofCandidateVerification {
    return new LeanProofCandidateVerification(
        new ScriptedProofCommandRunner([
            { status: 0, output: "" },
            { status: 0, output: cleanReport(proved) }
        ]),
        selected.owners,
        new ProofCommand("lake", ["build", "SpecCnl"]),
        new ProofCommand("lake", ["env", "lean", ENTRY]),
        AUDITED,
        ENTRY
    );
}

function host(selected: HostFixture, verifier: ProofCandidateVerification): ProofRepairHost {
    return new ProofRepairHost(selected.base, selected.store, verifier, selected.owners);
}

/** One accepted state in a store, produced the only way one can be. */
function acceptInto(
    store: MemoryProofRepairStore,
    selected: HostFixture,
    obligations: readonly ProofObligation[]
): void {
    const candidate = new ProofRepairCandidate(store.load().digest, obligations, [
        new ProposedArtifact(REPAIRED, repairText("by trivial"))
    ]);
    const state = new ProofRepairProtocol(
        selected.base,
        new ProofRepairObjective(obligations),
        store,
        acceptingVerifier(selected, obligations),
        selected.owners
    ).repair(candidate, isolation(selected));
    if (acceptedProofRepair(state) === undefined) {
        throw new TypeError("The fixture did not accept");
    }
}

/** A corpus ledger fixture in the shape the controlled-language gate commits. */
function corpusLedger(selected: HostFixture, units: readonly ProofObligation[]): string {
    const path = join(selected.root, `corpus-${units.length}-${isolationOrdinal}.json`);
    isolationOrdinal += 1;
    writeFileSync(
        path,
        `${JSON.stringify({
            units: units.map((unit) => ({
                anchor: unit.anchor,
                atoms: [...unit.atoms],
                digest: unit.unit,
                sentence: "a reviewed controlled sentence"
            }))
        })}\n`
    );
    return path;
}

/**
 * A scratch package the gate can read: its own scripts, its own formal tree, and its own
 * committed ledger. The gate resolves every path from its module location, so a copy of
 * those three directories is a package as far as it is concerned — and nothing here can
 * touch the worktree's own artifact.
 */
function gateTree(ledger: ProofRepairLedger, formal: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "agent-core-proof-repair-gate-"));
    temporary.push(root);
    cpSync(resolve(packageRoot, "scripts"), join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "artifacts", "quality"), { recursive: true });
    mkdirSync(join(root, "formal", "SpecCnl"), { recursive: true });
    writeFileSync(
        join(root, "artifacts", "quality", "proof-repair.json"),
        `${JSON.stringify(ProofRepairLedgerCodec.encode(ledger), null, 2)}\n`
    );
    for (const [path, text] of Object.entries(formal)) {
        const target = join(root, "formal", path);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, text);
    }
    return root;
}

/** One accepted ledger over one artifact, for the gate cases. */
function acceptedLedger(path: string, text: string): ProofRepairLedger {
    const owed = obligation(`gate-${path}`);
    const candidate = createHash("sha256").update(`candidate-${path}-${text}`).digest("hex");
    return new ProofRepairLedger(
        candidate,
        [new ClosedObligation(owed, candidate, [path])],
        [new AcceptedArtifact(path, text)]
    );
}

function runGate(root: string): QualitySubprocessResult {
    return runQualitySubprocess(
        process.execPath,
        [join(root, "scripts/quality/proof-repair-ledger.mjs"), "--stage", "building"],
        root
    );
}

describe("the proof repair synthesis host", () => {
    test("builds the objective from the corpus units the ledger has not closed", () => {
        const selected = fixture();
        const owed = obligation("corpus-open");
        const settled = obligation("corpus-closed");
        const corpus = corpusLedger(selected, [owed, settled]);
        const store = new MemoryProofRepairStore();
        acceptInto(store, selected, [settled]);

        const remaining = corpusObjective(corpus, store.load());

        expect(remaining.obligations).toHaveLength(1);
        expect(remaining.obligations[0]?.equals(owed)).toBe(true);
    });

    test("owes a unit again when only its anchor moved", () => {
        const selected = fixture();
        // Same digest and atoms, a new location. Under the frame rule the stored closure
        // no longer equals the corpus form, so it is owed again rather than subtracted;
        // the acceptance below is what reconciles the ledger to the corpus.
        const settled = obligation("moved");
        const moved = new ProofObligation(settled.unit, [...settled.atoms], "SPEC.md:1602");
        const corpus = corpusLedger(selected, [moved]);
        const store = new MemoryProofRepairStore();
        acceptInto(store, selected, [settled]);

        const objective = corpusObjective(corpus, store.load());

        expect(objective.obligations).toHaveLength(1);
        expect(objective.obligations[0]?.equals(moved)).toBe(true);
        // A corpus-built objective always carries the frame; only a directly built one
        // omits it, and then the ledger defends every record exactly.
        const frame = objective.frame;
        if (frame === undefined) throw new TypeError("A corpus objective carries no frame");
        expect(frame.some((entry) => entry.equals(moved))).toBe(true);
    });

    test("repairs an open unit and reconciles a moved closed unit in one acceptance", () => {
        const selected = fixture();
        // The realistic next repair under the frame rule: U moved, V still open, so the
        // objective owes both and the candidate claims both. The acceptance proves the
        // frame's forms, closes V, and supersedes U's stored record with provenance.
        const settled = obligation("moved-beneath");
        const moved = new ProofObligation(settled.unit, [...settled.atoms], "SPEC.md:1602");
        const owed = new ProofObligation(
            createHash("sha256").update("still-open").digest("hex"),
            ["C13-TURN-LEASE-EXPIRY"],
            "SPEC.md:1700"
        );
        acceptInto(selected.store, selected, [settled]);
        const corpus = corpusLedger(selected, [moved, owed]);

        const objective = corpusObjective(corpus, selected.store.load());
        expect(objective.obligations.map((entry) => entry.unit).sort()).toEqual(
            [moved.unit, owed.unit].sort()
        );

        const advanced = selected.store.load().digest;
        const result = host(selected, acceptingVerifier(selected, [moved, owed])).repair(
            objective,
            new RecordedProofCandidateGenerator([
                new ProofRepairCandidate(
                    advanced,
                    [moved, owed],
                    [new ProposedArtifact(REPAIRED, repairText("by simp"))]
                ).toData()
            ]),
            1
        );

        expect(result.name).toBe("accepted");
        const committed = selected.store.load();
        expect([...committed.closedUnits()].sort()).toEqual([settled.unit, owed.unit].sort());
        const carried = committed.closed.find((entry) => entry.obligation.unit === settled.unit);
        expect(carried?.obligation.anchor).toBe("SPEC.md:1602");
        expect(carried?.superseded?.equals(settled)).toBe(true);
    });

    test("still refuses a report that substitutes a closed unit's conformance atoms", () => {
        const selected = fixture();
        // Supersession tolerates the anchor moving and nothing else: the same prose
        // claimed for different atoms is a different claim, and losing the recorded one
        // is the regression the ledger exists to catch.
        const settled = obligation("atoms-substituted");
        const substituted = new ProofObligation(
            settled.unit,
            ["C13-TURN-LEASE-EXPIRY"],
            settled.anchor
        );
        acceptInto(selected.store, selected, [settled]);
        const advanced = selected.store.load().digest;

        const result = host(selected, acceptingVerifier(selected, [substituted])).repair(
            new ProofRepairObjective([substituted]),
            new RecordedProofCandidateGenerator([
                new ProofRepairCandidate(
                    advanced,
                    [substituted],
                    [new ProposedArtifact(REPAIRED, repairText("by simp"))]
                ).toData()
            ]),
            1
        );

        expect(result.name).toBe("exhausted");
        expect(result.refusals[0]).toContain("regression");
        expect(selected.store.load().digest).toBe(advanced);
    });

    test("owes a relabelled unit again and supersedes the stored form on acceptance", () => {
        const selected = fixture();
        // Relabelling `This maps to **C13-X**` changes the atoms while the rule body
        // digest stays put, because the corpus strips that suffix before digesting. The
        // stored closure no longer equals the corpus form, so the unit is owed again;
        // its acceptance proves the frame's form and supersedes the stored record,
        // keeping the old atoms as provenance rather than losing them.
        const settled = obligation("relabelled");
        const relabelled = new ProofObligation(
            settled.unit,
            ["C13-TURN-LEASE-EXPIRY"],
            settled.anchor
        );
        const corpus = corpusLedger(selected, [relabelled]);
        acceptInto(selected.store, selected, [settled]);

        const objective = corpusObjective(corpus, selected.store.load());
        expect(objective.obligations).toHaveLength(1);
        expect(objective.obligations[0]?.equals(relabelled)).toBe(true);

        const advanced = selected.store.load().digest;
        const result = host(selected, acceptingVerifier(selected, [relabelled])).repair(
            objective,
            new RecordedProofCandidateGenerator([
                new ProofRepairCandidate(
                    advanced,
                    [relabelled],
                    [new ProposedArtifact(REPAIRED, repairText("by simp"))]
                ).toData()
            ]),
            1
        );

        expect(result.name).toBe("accepted");
        const carried = selected.store
            .load()
            .closed.find((entry) => entry.obligation.unit === settled.unit);
        expect(carried?.obligation.equals(relabelled)).toBe(true);
        expect(carried?.superseded?.equals(settled)).toBe(true);
        expect(carried?.superseded?.atoms).toEqual([...settled.atoms]);
    });

    test("names a corpus-dropped closed unit as a migration rather than no work", () => {
        const selected = fixture();
        // The other direction: the ledger holds a closure the corpus no longer carries at
        // all, so nothing can supersede it and every later run regresses it.
        const settled = obligation("dropped");
        const survivor = new ProofObligation(
            createHash("sha256").update("survivor").digest("hex"),
            ["C13-TURN-LEASE-EXPIRY"],
            "SPEC.md:1700"
        );
        const corpus = corpusLedger(selected, [survivor]);
        const store = new MemoryProofRepairStore();
        acceptInto(store, selected, [settled]);

        expect(() => corpusObjective(corpus, store.load())).toThrow(
            "which the corpus no longer carries"
        );
    });

    test("reads the reviewed controlled-language corpus into real obligations", () => {
        const committed = assertArray(
            assertObject(
                parseCanonicalJson(
                    readFileSync(cnlCorpusLedgerArtifact, "utf8"),
                    cnlCorpusLedgerArtifact
                ),
                cnlCorpusLedgerArtifact
            )["units"],
            "the reviewed corpus units"
        );

        const owed = corpusObjective(cnlCorpusLedgerArtifact, ProofRepairLedger.genesis);

        // Every reviewed unit is owed against the genesis ledger, and each one is a
        // well-formed obligation because the record refused to construct otherwise.
        expect(owed.obligations).toHaveLength(committed.length);
        expect(new Set(owed.obligations.map((entry) => entry.unit)).size).toBe(committed.length);
        expect(owed.obligations.some((entry) => entry.atoms.includes("C13-RUN-ANCESTRY"))).toBe(
            true
        );
    });

    test("refuses a corpus unit that is not obligation-shaped", () => {
        const selected = fixture();
        const owed = obligation("shape");
        const unshaped = join(selected.root, "unshaped-corpus.json");
        const undigested = join(selected.root, "undigested-corpus.json");
        const atomless = join(selected.root, "atomless-corpus.json");
        writeFileSync(unshaped, `${JSON.stringify({ units: [{ digest: owed.unit }] })}\n`);
        writeFileSync(
            undigested,
            `${JSON.stringify({
                units: [{ anchor: owed.anchor, atoms: [...owed.atoms], digest: "not-a-digest" }]
            })}\n`
        );
        writeFileSync(
            atomless,
            `${JSON.stringify({
                units: [{ anchor: owed.anchor, atoms: [], digest: owed.unit }]
            })}\n`
        );

        // A row that omits a field, one whose rule-unit digest is not a digest, and one
        // that anchors no conformance atom are all corpus defects: the obligation record
        // refuses to exist for them rather than becoming a weaker objective.
        expect(() => corpusObjective(unshaped, ProofRepairLedger.genesis)).toThrow(
            "units[0].atoms must be an array"
        );
        expect(() => corpusObjective(undigested, ProofRepairLedger.genesis)).toThrow(
            "is not a sha256 digest"
        );
        expect(() => corpusObjective(atomless, ProofRepairLedger.genesis)).toThrow(
            "An obligation names no conformance atom"
        );
    });

    test("refuses to build an objective when the corpus owes nothing", () => {
        const selected = fixture();
        const settled = obligation("nothing-owed");
        const corpus = corpusLedger(selected, [settled]);
        const store = new MemoryProofRepairStore();
        acceptInto(store, selected, [settled]);

        expect(() => corpusObjective(corpus, store.load())).toThrow(
            "The corpus owes no open obligation"
        );
    });

    test("refuses a budget that bounds no attempt", () => {
        const selected = fixture();
        const owed = obligation("budget");

        expect(() =>
            host(selected, acceptingVerifier(selected, [owed])).repair(
                new ProofRepairObjective([owed]),
                new RecordedProofCandidateGenerator([]),
                0
            )
        ).toThrow("A repair budget bounds at least one attempt");
    });

    test("feeds a refused candidate's feedback into the next turn and then accepts", () => {
        const selected = fixture();
        const owed = obligation("feedback");
        const accepted = acceptingVerifier(selected, [owed]);
        const verifier = new ScriptedProofVerification([
            () =>
                ProofRepairRefusal.proof(
                    ProofRepairLocus.at("W0", REPAIRED)
                        .withSpan(new ProofArtifactSpan(7, 3))
                        .withTheorem("SpecCnl.Repair.proved_C13_RUN_ANCESTRY"),
                    "⊢ ancestry depends only on commits"
                ),
            (subject) => accepted.verify(subject)
        ]);
        const text = repairText("by simp");
        const generator = new RecordingGenerator(
            new RecordedProofCandidateGenerator([
                proposal(selected, [owed], repairText("by exact trivial")),
                proposal(selected, [owed], text)
            ])
        );

        const result = host(selected, verifier).repair(
            new ProofRepairObjective([owed]),
            generator,
            3
        );

        expect(result.name).toBe("accepted");
        expect(result.attempts).toBe(2);
        expect(result.refusals).toHaveLength(1);
        expect(generator.turns[0]?.feedback).toBeUndefined();
        expect(generator.turns[1]?.attempt).toBe(2);
        expect(generator.turns[1]?.feedback).toContain("proof");
        expect(generator.turns[1]?.feedback).toContain("the proof leaves its goal open");
        expect(result.ledger.closed[0]?.obligation.equals(owed)).toBe(true);
        expect(result.ledger.artifacts[0]?.text).toBe(text);
    });

    test("exhausts a spent budget with the accepted state byte-for-byte alone", () => {
        const selected = fixture();
        const owed = obligation("exhaustion");
        const before = selected.store.load();
        const verifier = new ScriptedProofVerification([
            () =>
                ProofRepairRefusal.compile(
                    ProofRepairLocus.at("W0", REPAIRED).withSpan(new ProofArtifactSpan(7, 3)),
                    "unexpected token"
                )
        ]);
        const generator = new RecordingGenerator(
            new RecordedProofCandidateGenerator([
                proposal(selected, [owed], repairText("by exact trivial")),
                proposal(selected, [owed], repairText("by simp_all")),
                proposal(selected, [owed], repairText("by aesop"))
            ])
        );

        const result = host(selected, verifier).repair(
            new ProofRepairObjective([owed]),
            generator,
            2
        );

        expect(result.name).toBe("exhausted");
        expect(result.attempts).toBe(2);
        expect(result.refusals).toHaveLength(2);
        // The third proposal was never asked for, every candidate was judged in its own
        // isolation, and nothing the loop ran could write the ledger.
        expect(generator.turns).toHaveLength(2);
        expect(verifier.runs()).toBe(2);
        expect(selected.store.load().digest).toBe(before.digest);
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("returns a rerunnable immutable proposal on an unattributed refusal", () => {
        const selected = fixture();
        const owed = obligation("runtime");
        const answered = proposal(selected, [owed]);
        const verifier = new ScriptedProofVerification([
            () => ProofRepairRefusal.runtime("lake build SpecCnl", ["exit 137"])
        ]);
        // A generator that hands out the object it still owns: whatever the caller is
        // given must survive the generator mutating it afterwards.
        const owned = assertObject(
            JSON.parse(JSON.stringify(answered)),
            "the generator-owned proposal"
        );
        const generator = new RecordingGenerator(new RecordedProofCandidateGenerator([owned]));

        const result = host(selected, verifier).repair(
            new ProofRepairObjective([owed]),
            generator,
            2
        );

        expect(result.name).toBe("inconclusive");
        expect(result.attempts).toBe(1);
        expect(result.refusals[0]).toContain("reached no verdict");
        expect(result.inconclusiveCandidate).toBe(
            ProofRepairCandidate.fromData(answered, "the fixture proposal").identity
        );
        // The snapshot is the decoded candidate's own canonical form, not the
        // generator's live object...
        expect(result.inconclusiveProposal).toEqual(
            ProofRepairCandidate.fromData(answered, "the fixture proposal").toData()
        );
        // ...so mutating the generator's original after the fact changes nothing the
        // caller holds, and the snapshot itself refuses to be written.
        writeAt(owned, "artifacts", []); // the generator may still write its own
        const snapshot = assertObject(
            result.inconclusiveProposal,
            "the inconclusive proposal snapshot"
        );
        expect(() => writeAt(snapshot, "baseline", "0".repeat(64))).toThrow();

        expect(result.inconclusiveProposal).toEqual(
            ProofRepairCandidate.fromData(answered, "the fixture proposal").toData()
        );
    });

    test("reads the untrusted proposal exactly once", () => {
        const selected = fixture();
        const owed = obligation("one-read");
        const answered = proposal(selected, [owed]);
        // A proposal whose fields are accessors can answer each read differently, so a
        // host that decoded it more than once could judge one candidate, snapshot a
        // second and name a third. The counter proves there is exactly one reading.
        let reads = 0;
        const watched: JsonObject = {};
        for (const [key, value] of Object.entries(assertObject(answered, "the proposal"))) {
            Object.defineProperty(watched, key, {
                enumerable: true,
                get: () => {
                    reads += 1;
                    return value;
                }
            });
        }
        const verifier = new ScriptedProofVerification([
            () => ProofRepairRefusal.runtime("lake build SpecCnl", ["exit 137"])
        ]);

        const result = host(selected, verifier).repair(
            new ProofRepairObjective([owed]),
            new RecordedProofCandidateGenerator([watched]),
            1
        );

        expect(result.name).toBe("inconclusive");
        // Three fields, read once each: one decode, and everything the terminal carries
        // is derived from that one immutable candidate.
        expect(reads).toBe(3);
        expect(result.inconclusiveCandidate).toBe(
            ProofRepairCandidate.fromData(answered, "the fixture proposal").identity
        );
    });

    test("re-submits an inconclusive proposal through a fresh host to a real verdict", () => {
        const selected = fixture();
        const owed = obligation("rerun");
        const answered = proposal(selected, [owed], repairText("by simp"));
        const first = new ScriptedProofVerification([
            () => ProofRepairRefusal.runtime("lake build SpecCnl", ["exit 137"])
        ]);

        const inconclusive = host(selected, first).repair(
            new ProofRepairObjective([owed]),
            new RecordedProofCandidateGenerator([answered]),
            1
        );

        expect(inconclusive.name).toBe("inconclusive");
        // The doctrine's remedy for an unattributed refusal is the same run again, so
        // the terminal's proposal is exactly what a fresh loop submits next.
        const second = host(selected, acceptingVerifier(selected, [owed])).repair(
            new ProofRepairObjective([owed]),
            new RecordedProofCandidateGenerator([
                assertObject(
                    inconclusive.inconclusiveProposal,
                    "the inconclusive proposal snapshot"
                )
            ]),
            1
        );

        expect(second.name).toBe("accepted");
        expect(second.attempts).toBe(1);
        expect(selected.store.load().artifacts[0]?.text).toBe(repairText("by simp"));
        expect(selected.store.load().closed[0]?.obligation.equals(owed)).toBe(true);
    });

    test("returns an exhausted result only when the attempt budget is spent", () => {
        const selected = fixture();
        const owed = obligation("purely-exhausted");
        const verifier = new ScriptedProofVerification([
            () =>
                ProofRepairRefusal.compile(
                    ProofRepairLocus.at("W0", REPAIRED).withSpan(new ProofArtifactSpan(7, 3)),
                    "unexpected token"
                )
        ]);

        const result = host(selected, verifier).repair(
            new ProofRepairObjective([owed]),
            new RecordedProofCandidateGenerator([
                proposal(selected, [owed]),
                proposal(selected, [owed], repairText("by simp"))
            ]),
            2
        );

        expect(result.name).toBe("exhausted");
        expect(result.attempts).toBe(2);
        expect(result.inconclusiveCandidate).toBeUndefined();
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("reports a declining generator without spending an attempt", () => {
        const selected = fixture();
        const owed = obligation("declined");

        const result = host(selected, acceptingVerifier(selected, [owed])).repair(
            new ProofRepairObjective([owed]),
            new RecordedProofCandidateGenerator([]),
            3
        );

        expect(result.name).toBe("declined");
        expect(result.attempts).toBe(0);
        expect(result.refusals).toEqual([]);
        expect(selected.store.load()).toEqual(ProofRepairLedger.genesis);
    });

    test("hands the generator the trusted objective, not the candidate's own claim", () => {
        const selected = fixture();
        const first = obligation("prompt-first");
        const second = obligation("prompt-second");
        const generator = new RecordingGenerator(new RecordedProofCandidateGenerator([]));

        host(selected, acceptingVerifier(selected, [])).repair(
            new ProofRepairObjective([first, second]),
            generator,
            1
        );

        const prompt = generator.turns[0]?.prompt;
        expect(prompt).toContain("Close every obligation in the trusted repair objective");
        expect(prompt).toContain(first.describe());
        expect(prompt).toContain(second.describe());
    });

    test("persists one acceptance through the store and re-verifies the committed record", () => {
        const selected = fixture();
        const path = join(selected.root, "proof-repair.json");
        const store = new FileProofRepairStore(path);
        const owed = obligation("persist");
        const text = repairText("by trivial");
        const candidate = new ProofRepairCandidate(
            store.load().digest,
            [owed],
            [new ProposedArtifact(REPAIRED, text)]
        );

        const result = new ProofRepairHost(
            selected.base,
            store,
            acceptingVerifier(selected, [owed]),
            selected.owners
        ).repair(
            new ProofRepairObjective([owed]),
            new RecordedProofCandidateGenerator([candidate.toData()]),
            1
        );

        expect(result.name).toBe("accepted");
        expect(result.attempts).toBe(1);
        const restarted = new FileProofRepairStore(path).load();
        expect(restarted.digest).toBe(result.ledger.digest);
        expect(restarted.candidate).toBe(candidate.identity);
        expect(restarted.closed[0]?.obligation.equals(owed)).toBe(true);
        expect(restarted.artifacts[0]?.text).toBe(text);
        // The committed record re-verifies: it decodes through its own codec to the same
        // accepted identity a later baseline would be taken over.
        const decoded = ProofRepairLedgerCodec.decode(
            ProofRepairLedgerCodec.encode(restarted),
            "the committed ledger"
        );
        expect(decoded.digest).toBe(restarted.digest);
        expect(decoded.artifacts[0]?.text).toBe(text);
    });
});

describe("the proof repair ledger gate", subprocessTestOptions, () => {
    test("accepts the committed genesis ledger", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [gateScript, "--stage", "building"],
            packageRoot
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("proof repair ledger verified");
        expect(result.stdout).toContain("genesis ledger");
    });

    test("accepts an accepted ledger whose text the formal tree still carries", () => {
        const text = "namespace SpecCnl.Proofs\n\ntheorem accepted : True := trivial\n";
        const root = gateTree(acceptedLedger("SpecCnl/Proofs.lean", text), {
            "SpecCnl/Proofs.lean": text
        });

        const result = runGate(root);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("1 accepted artifact(s) byte-identical");
    });

    test("refuses a ledger whose accepted text the formal tree does not carry", () => {
        const text = "namespace SpecCnl.Proofs\n\ntheorem accepted : True := trivial\n";
        const root = gateTree(acceptedLedger("SpecCnl/Proofs.lean", text), {
            "SpecCnl/Proofs.lean": `${text}-- drifted\n`
        });

        const result = runGate(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("the committed proof repair ledger is not intact");
        expect(result.stderr).toContain(
            "SpecCnl/Proofs.lean is not byte-identical to the reviewed formal tree"
        );
    });

    test("refuses a ledger whose accepted artifact the formal tree omits", () => {
        const text = "namespace SpecCnl.Proofs\n\ntheorem accepted : True := trivial\n";
        const root = gateTree(acceptedLedger("SpecCnl/Proofs.lean", text), {});

        const result = runGate(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("not an ordinary file inside the reviewed formal tree");
        expect(result.stderr).toContain("no reviewed formal tree file");
    });

    test("refuses a committed record the versioned codec does not admit", () => {
        const root = gateTree(ProofRepairLedger.genesis, {});
        const artifact = join(root, "artifacts", "quality", "proof-repair.json");
        const doctored = {
            ...ProofRepairLedgerCodec.encode(ProofRepairLedger.genesis),
            version: "2.0"
        };
        writeFileSync(artifact, `${JSON.stringify(doctored, null, 2)}\n`);

        const result = runGate(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("declares unknown major 2");
    });

    test("refuses an accepted artifact reached through a symlink", () => {
        const text = "namespace SpecCnl.Proofs\n\ntheorem accepted : True := trivial\n";
        const root = gateTree(acceptedLedger("SpecCnl/Proofs.lean", text), {});
        // The linked-to bytes match the ledger exactly, so only the path the gate took
        // can refuse: reading through a link compares against bytes the reviewed tree
        // does not contain at that path.
        const outside = join(root, "outside");
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "Proofs.lean"), text);
        symlinkSync(join(outside, "Proofs.lean"), join(root, "formal/SpecCnl/Proofs.lean"));

        const result = runGate(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("not an ordinary file inside the reviewed formal tree");
    });

    test("refuses a symlinked parent directory even when the target matches", () => {
        const text = "namespace SpecCnl.Proofs\n\ntheorem accepted : True := trivial\n";
        const root = gateTree(acceptedLedger("SpecCnl/Proofs.lean", text), {});
        const outside = join(root, "outside");
        mkdirSync(join(outside, "SpecCnl"), { recursive: true });
        writeFileSync(join(outside, "SpecCnl", "Proofs.lean"), text);
        rmSync(join(root, "formal/SpecCnl"), { recursive: true });
        symlinkSync(join(outside, "SpecCnl"), join(root, "formal/SpecCnl"));

        const result = runGate(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("not an ordinary file inside the reviewed formal tree");
    });

    test("refuses a formal root that is itself a symlink", () => {
        const text = "namespace SpecCnl.Proofs\n\ntheorem accepted : True := trivial\n";
        const root = gateTree(acceptedLedger("SpecCnl/Proofs.lean", text), {});
        // A symlinked `formal/` makes every child's lstat ordinary and turns realpath
        // containment into a statement about the link's target, so the walk has to start
        // at the root itself.
        const outside = join(root, "outside-formal", "SpecCnl");
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "Proofs.lean"), text);
        rmSync(join(root, "formal"), { recursive: true });
        symlinkSync(join(root, "outside-formal"), join(root, "formal"));

        const result = runGate(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("the reviewed formal tree root passes through the symlink");
    });

    test("refuses a committed ledger reached through a symlinked artifact directory", () => {
        const root = gateTree(ProofRepairLedger.genesis, {});
        // The store realpaths the record's directory, so a symlinked `artifacts/quality`
        // would load a record from outside the package as an ordinary file.
        const outside = join(root, "outside-quality");
        mkdirSync(outside, { recursive: true });
        writeFileSync(
            join(outside, "proof-repair.json"),
            `${JSON.stringify(ProofRepairLedgerCodec.encode(ProofRepairLedger.genesis), null, 2)}\n`
        );
        rmSync(join(root, "artifacts", "quality"), { recursive: true });
        symlinkSync(outside, join(root, "artifacts", "quality"));

        const result = runGate(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            "the committed proof repair ledger passes through the symlink"
        );
    });

    test("refuses an accepted artifact reached through an in-tree parent symlink", () => {
        const text = "namespace SpecCnl.Proofs\n\ntheorem accepted : True := trivial\n";
        const root = gateTree(acceptedLedger("SpecCnl/Proofs.lean", text), {});
        // The link's target is an ordinary in-tree directory carrying matching bytes, so
        // realpath containment alone would admit it: the same reviewed path can be
        // retargeted without the ledger changing a byte, which is what the walk refuses.
        mkdirSync(join(root, "formal", "ActualSpecCnl"), { recursive: true });
        writeFileSync(join(root, "formal", "ActualSpecCnl", "Proofs.lean"), text);
        rmSync(join(root, "formal", "SpecCnl"), { recursive: true });
        symlinkSync(join(root, "formal", "ActualSpecCnl"), join(root, "formal", "SpecCnl"));

        const result = runGate(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("it passes through the symlink SpecCnl");
    });

    test("refuses bytes a lossy UTF-8 decode would equate", () => {
        // A ledger text carrying U+FFFD and a formal file carrying an invalid byte at
        // that position decode to the same JavaScript string, so only a byte
        // comparison refuses them.
        const aliased = "theorem accepted : True := trivial\nX\uFFFdZ";
        const root = gateTree(acceptedLedger("SpecCnl/Proofs.lean", aliased), {});
        writeFileSync(
            join(root, "formal/SpecCnl/Proofs.lean"),
            Buffer.concat([
                Buffer.from("theorem accepted : True := trivial\n", "utf8"),
                Buffer.from([0x58, 0xff, 0x5a])
            ])
        );

        const result = runGate(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            "SpecCnl/Proofs.lean is not byte-identical to the reviewed formal tree"
        );
    });
});

/** One write into a decoded record, refused loudly. The record types are readonly by
 * contract, so the write goes through the one reflection API whose purpose is exactly
 * this; `Reflect.set` returns false rather than throwing on a frozen target, so the
 * refusal is converted into one here. */
function writeAt(record: JsonObject, key: string, value: JsonValue): void {
    if (!Reflect.set(record, key, value)) {
        throw new TypeError(`the record refused the write of ${key}`);
    }
}
