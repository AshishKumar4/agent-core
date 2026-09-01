import { allowedBuiltInAxioms } from "../formal-policy.mjs";
import { compareCanonicalText } from "./project.mjs";
import {
    assertArtifactPath,
    type ClosedObligation,
    type ProofObligation
} from "./proof-repair-record.js";

/**
 * Why a proof repair candidate was refused, and what the generator is told.
 *
 * The vocabulary is closed and has two halves. A **finding** is a fact the harness's own
 * verifier established about the candidate's text: it is ambiguous, it does not elaborate,
 * its proof leaves a goal, its statement is not the rule, it leans on an unreviewed axiom,
 * or the run itself reached no verdict. An **admission** refusal is a fact the protocol
 * established about the candidate: it was built against a baseline that has moved, its
 * artifact set escapes its isolation, it would drop something already proved, it leaves an
 * obligation open, it closes nothing new, or it is not a well-formed candidate at all.
 *
 * Two properties of this type are load-bearing.
 *
 * `attributed` separates a defect from an inconclusive run. `runtime` is the only
 * unattributed kind, and it covers every case where the harness cannot say anything about
 * this candidate — a verifier that failed to run, and evidence that describes some other
 * candidate. Feeding an unattributed refusal back as a defect would teach the generator to
 * "fix" text that was never judged, so the distinction is not cosmetic.
 *
 * Every kind carries the exact locus it can name, and each case requires its own part of it
 * in its constructor: a compile refusal without a span, a proof refusal without a theorem,
 * or an assumption refusal without an axiom is unconstructable rather than vague.
 */

export const proofFindingKinds = [
    "ambiguity",
    "assumption",
    "compile",
    "model",
    "proof",
    "runtime"
] as const;

export const proofAdmissionKinds = [
    "isolation",
    "malformed",
    "open",
    "progress",
    "regression",
    "stale"
] as const;

export type ProofFindingKind = (typeof proofFindingKinds)[number];
export type ProofAdmissionKind = (typeof proofAdmissionKinds)[number];
export type ProofRepairRefusalKind = ProofFindingKind | ProofAdmissionKind;

const OWNER = /^[A-Za-z][A-Za-z0-9-]*$/u;
const DECLARATION = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/u;

export function assertProofDeclaration(value: string, owner: string): string {
    if (!DECLARATION.test(value)) {
        throw new TypeError(`${owner} is not a declaration name: ${value}`);
    }
    return value;
}

/** A position inside an artifact, in Lean's convention: lines from one, columns from zero. */
export class ProofArtifactSpan {
    public readonly line: number;
    public readonly column: number;

    public constructor(line: number, column: number) {
        if (!Number.isSafeInteger(line) || line < 1) {
            throw new TypeError(`A span line is not a line number: ${line}`);
        }
        if (!Number.isSafeInteger(column) || column < 0) {
            throw new TypeError(`A span column is not a column number: ${column}`);
        }
        this.line = line;
        this.column = column;
        Object.freeze(this);
    }

    public render(): string {
        return `${this.line}:${this.column}`;
    }
}

/**
 * Exactly what a refusal points at: the wave that owns the artifact, the artifact, and
 * whichever of the position, the theorem, and the assumption the refusal knows. Each part is
 * added by its own transition, so a locus never carries a part nobody established.
 */
export class ProofRepairLocus {
    public readonly owner: string;
    public readonly artifact: string;
    public readonly span: ProofArtifactSpan | undefined;
    public readonly theorem: string | undefined;
    public readonly assumption: string | undefined;

    private constructor(
        owner: string,
        artifact: string,
        span: ProofArtifactSpan | undefined,
        theorem: string | undefined,
        assumption: string | undefined
    ) {
        if (!OWNER.test(owner)) throw new TypeError(`A locus owner is not an owner: ${owner}`);
        this.owner = owner;
        this.artifact = assertArtifactPath(artifact, "A locus artifact");
        this.span = span;
        this.theorem = theorem;
        this.assumption = assumption;
        Object.freeze(this);
    }

    public static at(owner: string, artifact: string): ProofRepairLocus {
        return new ProofRepairLocus(owner, artifact, undefined, undefined, undefined);
    }

    public withSpan(span: ProofArtifactSpan): ProofRepairLocus {
        return new ProofRepairLocus(this.owner, this.artifact, span, this.theorem, this.assumption);
    }

    public withTheorem(theorem: string): ProofRepairLocus {
        return new ProofRepairLocus(
            this.owner,
            this.artifact,
            this.span,
            assertProofDeclaration(theorem, "A locus theorem"),
            this.assumption
        );
    }

    public withAssumption(assumption: string): ProofRepairLocus {
        return new ProofRepairLocus(
            this.owner,
            this.artifact,
            this.span,
            this.theorem,
            assertProofDeclaration(assumption, "A locus assumption")
        );
    }

    public describe(): string {
        const where =
            this.span === undefined ? this.artifact : `${this.artifact}:${this.span.render()}`;
        const parts = [this.owner, where];
        if (this.theorem !== undefined) parts.push(`theorem ${this.theorem}`);
        if (this.assumption !== undefined) parts.push(`assumption ${this.assumption}`);
        return parts.join(" ");
    }
}

/**
 * Who answers for an artifact. Feedback that cannot name an owner is feedback nobody is
 * accountable for, so an unresolvable artifact is refused rather than reported anonymously:
 * the seam returns nothing and the protocol turns that into a `malformed` refusal.
 */
export abstract class ProofArtifactOwners {
    public abstract owner(path: string): string | undefined;
}

export interface ProofArtifactOwner {
    readonly path: string;
    readonly owner: string;
}

/** The reference implementation: a reviewed path-to-owner list, used where the repository's
 * own ownership map is not the question under test. */
export class DeclaredProofArtifactOwners extends ProofArtifactOwners {
    private readonly declared: readonly ProofArtifactOwner[];

    public constructor(declared: readonly ProofArtifactOwner[]) {
        super();
        const paths = declared.map((entry) => assertArtifactPath(entry.path, "An owner path"));
        if (new Set(paths).size !== paths.length) {
            throw new TypeError("An owner declaration names one artifact twice");
        }
        this.declared = Object.freeze(
            declared.map((entry) => {
                if (!OWNER.test(entry.owner)) {
                    throw new TypeError(`An owner declaration names invalid owner ${entry.owner}`);
                }
                return Object.freeze({ path: entry.path, owner: entry.owner });
            })
        );
        Object.freeze(this);
    }

    public owner(path: string): string | undefined {
        return this.declared.find((entry) => entry.path === path)?.owner;
    }
}

/**
 * The one place an unresolvable artifact becomes a refusal. Both the admission path, which
 * runs before any candidate text is materialized, and the decision path, which judges the
 * verifier's designations, ask this question; a second copy of the rule would let one of
 * them keep adjudicating a file nobody answers for.
 */
export function unownedRefusals(
    paths: readonly string[],
    owners: ProofArtifactOwners
): readonly ProofRepairRefusal[] {
    return paths
        .filter((path) => owners.owner(path) === undefined)
        .map((path) => ProofRepairRefusal.malformed(`${path} has no reviewed owner`));
}

/** Every counterexample is nonempty, has no empty line, and is ordered, so the same refusal
 * always reads the same way and a diff of two runs is a difference in substance. */
function orderedLines(lines: readonly string[], owner: string): readonly string[] {
    if (lines.length === 0) throw new TypeError(`${owner} carries no counterexample`);
    for (const line of lines) {
        if (line.length === 0) throw new TypeError(`${owner} carries an empty counterexample`);
    }
    return Object.freeze([...lines].sort(compareCanonicalText));
}

function requireSpan(locus: ProofRepairLocus, owner: string): ProofRepairLocus {
    if (locus.span === undefined) throw new TypeError(`${owner} names no position`);
    return locus;
}

function requireTheorem(locus: ProofRepairLocus, owner: string): ProofRepairLocus {
    if (locus.theorem === undefined) throw new TypeError(`${owner} names no theorem`);
    return locus;
}

/** The axiom the refusal is about must be one the doctrine has not reviewed, and must be one
 * the declaration actually depends on. Both directions matter: refusing a reviewed axiom
 * would manufacture a defect, and refusing an axiom absent from the dependency would name a
 * counterexample that does not hold. */
function requireUnreviewedAssumption(
    locus: ProofRepairLocus,
    axioms: readonly string[]
): ProofRepairLocus {
    const assumption = requireTheorem(locus, "An assumption refusal").assumption;
    if (assumption === undefined) throw new TypeError("An assumption refusal names no axiom");
    if (allowedBuiltInAxioms.includes(assumption)) {
        throw new TypeError(`${assumption} is a reviewed axiom and refuses nothing`);
    }
    if (!axioms.includes(assumption)) {
        throw new TypeError(`${assumption} is absent from the dependency it is refused for`);
    }
    return locus;
}

function ambiguitySummary(sentence: string, readings: readonly string[]): string {
    if (sentence.length === 0) throw new TypeError("An ambiguity refusal names no sentence");
    if (new Set(readings).size !== 2) {
        throw new TypeError("An ambiguity refusal needs exactly two distinct readings");
    }
    return `the sentence "${sentence}" has two readings, so its intent is undecided`;
}

/** The program a runtime refusal names, checked where it is used rather than after the
 * summary has already been built out of it. */
function requireCommand(command: string): string {
    if (command.length === 0) throw new TypeError("A runtime refusal names no program");
    return command;
}

function distinctBaselines(expected: string, given: string): readonly string[] {
    if (expected === given) throw new TypeError("A stale refusal names one baseline twice");
    return [`accepted baseline ${expected}`, `candidate baseline ${given}`];
}

export abstract class ProofRepairRefusal {
    public readonly locus: ProofRepairLocus | undefined;
    public readonly summary: string;
    public readonly counterexample: readonly string[];

    protected constructor(
        locus: ProofRepairLocus | undefined,
        summary: string,
        counterexample: readonly string[]
    ) {
        if (summary.length === 0) throw new TypeError("A refusal states no reason");
        this.locus = locus;
        this.summary = summary;
        this.counterexample = Object.freeze([...counterexample]);
    }

    public abstract readonly kind: ProofRepairRefusalKind;

    /** Whether the candidate is answerable for this refusal. An unattributed refusal is the
     * harness reporting that it reached no verdict, and is never a defect to repair. */
    public abstract readonly attributed: boolean;

    /** One line, exact enough to act on without reading anything else. */
    public feedback(): string {
        const where = this.locus === undefined ? "candidate" : this.locus.describe();
        const detail =
            this.counterexample.length === 0 ? "" : ` [${this.counterexample.join(" | ")}]`;
        return `${this.kind} ${where}: ${this.summary}${detail}`;
    }

    /** The sentence admits more than one reading, so the intent it carries is undecided. Two
     * readings are the whole counterexample: a third adds nothing a repair could use. */
    public static ambiguity(
        locus: ProofRepairLocus,
        sentence: string,
        readings: readonly string[]
    ): ProofFinding {
        return new AmbiguityRefusal(locus, sentence, readings);
    }

    public static compile(locus: ProofRepairLocus, message: string): ProofFinding {
        return new CompileRefusal(locus, message);
    }

    public static proof(locus: ProofRepairLocus, goal: string): ProofFinding {
        return new ProofRefusal(locus, goal);
    }

    public static model(locus: ProofRepairLocus, divergence: readonly string[]): ProofFinding {
        return new ModelRefusal(locus, divergence);
    }

    public static assumption(locus: ProofRepairLocus, axioms: readonly string[]): ProofFinding {
        return new AssumptionRefusal(locus, axioms);
    }

    public static runtime(command: string, detail: readonly string[]): ProofFinding {
        return new RuntimeRefusal(command, detail);
    }

    public static stale(expected: string, given: string): ProofRepairRefusal {
        return new StaleRefusal(expected, given);
    }

    public static isolation(locus: ProofRepairLocus, detail: string): ProofRepairRefusal {
        return new IsolationRefusal(locus, detail);
    }

    public static regression(entries: readonly ClosedObligation[]): ProofRepairRefusal {
        return new RegressionRefusal(entries);
    }

    public static open(remaining: readonly ProofObligation[]): ProofRepairRefusal {
        return new OpenRefusal(remaining);
    }

    public static progress(claimed: readonly ProofObligation[]): ProofRepairRefusal {
        return new ProgressRefusal(claimed);
    }

    public static malformed(detail: string): ProofRepairRefusal {
        return new MalformedRefusal(detail);
    }
}

/**
 * A refusal a verifier run established about the candidate's text. The distinction is in the
 * type rather than in a comment: a verification report holds findings, so a report cannot
 * carry a stale baseline or an open obligation — those are the protocol's conclusions, not
 * the verifier's, and a verifier that could state them could decide its own acceptance.
 */
export abstract class ProofFinding extends ProofRepairRefusal {
    public abstract override readonly kind: ProofFindingKind;
}

class AmbiguityRefusal extends ProofFinding {
    public readonly kind: ProofFindingKind = "ambiguity";
    public readonly attributed = true;

    public constructor(locus: ProofRepairLocus, sentence: string, readings: readonly string[]) {
        super(
            requireSpan(locus, "An ambiguity refusal"),
            ambiguitySummary(sentence, readings),
            orderedLines(readings, "An ambiguity refusal")
        );
        Object.freeze(this);
    }
}

class CompileRefusal extends ProofFinding {
    public readonly kind: ProofFindingKind = "compile";
    public readonly attributed = true;

    public constructor(locus: ProofRepairLocus, message: string) {
        super(
            requireSpan(locus, "A compile refusal"),
            "the artifact does not elaborate",
            orderedLines([message], "A compile refusal")
        );
        Object.freeze(this);
    }
}

class ProofRefusal extends ProofFinding {
    public readonly kind: ProofFindingKind = "proof";
    public readonly attributed = true;

    public constructor(locus: ProofRepairLocus, goal: string) {
        super(
            requireTheorem(locus, "A proof refusal"),
            "the proof leaves its goal open",
            orderedLines([goal], "A proof refusal")
        );
        Object.freeze(this);
    }
}

class ModelRefusal extends ProofFinding {
    public readonly kind: ProofFindingKind = "model";
    public readonly attributed = true;

    public constructor(locus: ProofRepairLocus, divergence: readonly string[]) {
        super(
            requireTheorem(locus, "A model refusal"),
            "the statement is not the rule it claims to carry",
            orderedLines(divergence, "A model refusal")
        );
        Object.freeze(this);
    }
}

class AssumptionRefusal extends ProofFinding {
    public readonly kind: ProofFindingKind = "assumption";
    public readonly attributed = true;

    public constructor(locus: ProofRepairLocus, axioms: readonly string[]) {
        super(
            requireUnreviewedAssumption(locus, axioms),
            "the declaration depends on an axiom the doctrine has not reviewed",
            orderedLines(axioms, "An assumption refusal")
        );
        Object.freeze(this);
    }
}

class RuntimeRefusal extends ProofFinding {
    public readonly kind: ProofFindingKind = "runtime";
    public readonly attributed = false;

    public constructor(command: string, detail: readonly string[]) {
        super(
            undefined,
            `the harness reached no verdict running ${requireCommand(command)}`,
            orderedLines(detail, "A runtime refusal")
        );
        Object.freeze(this);
    }
}

class StaleRefusal extends ProofRepairRefusal {
    public readonly kind: ProofAdmissionKind = "stale";
    public readonly attributed = true;

    public constructor(expected: string, given: string) {
        super(
            undefined,
            "the candidate was built against a baseline that has moved",
            distinctBaselines(expected, given)
        );
        Object.freeze(this);
    }
}

class IsolationRefusal extends ProofRepairRefusal {
    public readonly kind: ProofAdmissionKind = "isolation";
    public readonly attributed = true;

    public constructor(locus: ProofRepairLocus, detail: string) {
        super(
            locus,
            "the artifact set does not stay inside its isolation",
            orderedLines([detail], "An isolation refusal")
        );
        Object.freeze(this);
    }
}

class RegressionRefusal extends ProofRepairRefusal {
    public readonly kind: ProofAdmissionKind = "regression";
    public readonly attributed = true;

    public constructor(entries: readonly ClosedObligation[]) {
        super(
            undefined,
            "the candidate no longer proves obligations the accepted state already closed",
            orderedLines(
                entries.map(
                    (entry) =>
                        `${entry.obligation.describe()} closed by ${entry.artifacts.join(" ")}`
                ),
                "A regression refusal"
            )
        );
        Object.freeze(this);
    }
}

class OpenRefusal extends ProofRepairRefusal {
    public readonly kind: ProofAdmissionKind = "open";
    public readonly attributed = true;

    public constructor(remaining: readonly ProofObligation[]) {
        super(
            undefined,
            "the candidate leaves obligations it claims open",
            orderedLines(
                remaining.map((obligation) => obligation.describe()),
                "An open refusal"
            )
        );
        Object.freeze(this);
    }
}

class ProgressRefusal extends ProofRepairRefusal {
    public readonly kind: ProofAdmissionKind = "progress";
    public readonly attributed = true;

    public constructor(claimed: readonly ProofObligation[]) {
        super(
            undefined,
            "the candidate closes nothing that was not closed already",
            orderedLines(
                claimed.map((obligation) => obligation.describe()),
                "A progress refusal"
            )
        );
        Object.freeze(this);
    }
}

class MalformedRefusal extends ProofRepairRefusal {
    public readonly kind: ProofAdmissionKind = "malformed";
    public readonly attributed = true;

    public constructor(detail: string) {
        super(
            undefined,
            "the proposal is not a well-formed candidate",
            orderedLines([detail], "A malformed refusal")
        );
        Object.freeze(this);
    }
}
