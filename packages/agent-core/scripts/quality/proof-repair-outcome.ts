import { allowedBuiltInAxioms } from "../formal-policy.mjs";
import {
    type AcceptedArtifact,
    type ProofObligation,
    type ProofRepairCandidate,
    type ProofRepairLedger,
    type ProofRepairObjective,
    type ProposedArtifact
} from "./proof-repair-record.js";
import {
    ProofRepairLocus,
    ProofRepairRefusal,
    unownedRefusals,
    type ProofArtifactOwners
} from "./proof-repair-refusal.js";
import {
    declarationArtifact,
    leanArtifact,
    redeemProofVerdict,
    type ProofVerdictView,
    type ProofVerificationReport
} from "./proof-repair-verification.js";

const SORRY = "sorryAx";

/**
 * The objective comes from the trusted repair host. A model may not shorten it by omitting
 * an obligation or expand it to obtain credit for unrelated work.
 */
export function objectiveRefusals(
    objective: ProofRepairObjective,
    candidate: ProofRepairCandidate
): readonly ProofRepairRefusal[] {
    const refusals: ProofRepairRefusal[] = [];
    const missing = objective.missing(candidate);
    if (missing.length > 0) refusals.push(ProofRepairRefusal.open(missing));
    for (const obligation of objective.unexpected(candidate)) {
        refusals.push(
            ProofRepairRefusal.malformed(
                `${obligation.describe()} is not in the trusted repair objective`
            )
        );
    }
    return refusals;
}

/** The path-and-digest pairs an evidence binding is taken over, in one stable rendering. */
function measured(artifacts: readonly { path: string; digest: string }[]): string {
    return artifacts.map((artifact) => `${artifact.path}@${artifact.digest}`).join(" ");
}

/**
 * The decision, and the two states a judged candidate can reach.
 *
 * Acceptance is exact. Every obligation the candidate claims must be proved by the run that
 * judged it, nothing the accepted state already closed may have stopped being proved, the run
 * must have found no defect, no declaration the candidate wrote may lean on an axiom the
 * doctrine has not reviewed, and the candidate must actually advance something. A candidate
 * that misses any of those is refused, and a refusal changes nothing: the accepted artifacts
 * and the accepted obligations are exactly what they were.
 *
 * The order of the checks is not cosmetic. A stale candidate was judged against a tree that
 * has moved, and a report that does not describe this candidate is not evidence about it, so
 * neither case reports the findings underneath — feedback drawn from the wrong run would
 * point a repair at text nobody judged. Once both hold, every remaining refusal is reported
 * together, because a generator repairing one defect at a time is a generator running the
 * whole verification once per defect.
 *
 * `AcceptedProofRepair` and `RefusedProofRepair` are exported as types only. The state that
 * authorizes a write is unconstructable outside this module, so "a rejected candidate must
 * not overwrite an accepted artifact" is a property of the type rather than a rule a caller
 * has to remember.
 */
export interface AcceptedProofRepair {
    readonly name: "accepted";
    readonly candidate: string;
    readonly baseline: string;
    readonly ledger: ProofRepairLedger;
    readonly promoted: readonly ProposedArtifact[];
    readonly progress: readonly ProofObligation[];
    readonly repaired: readonly AcceptedArtifact[];
    readonly preserved: readonly ProofObligation[];
    feedback(): string;
}

export interface RefusedProofRepair {
    readonly name: "refused";
    readonly refusals: readonly ProofRepairRefusal[];
    readonly preserved: readonly ProofObligation[];
    readonly attributed: boolean;
    kinds(): readonly string[];
    feedback(): string;
}

export interface ProofRepairStateCases<Result> {
    accepted(accepted: AcceptedProofRepair): Result;
    refused(refused: RefusedProofRepair): Result;
}

export abstract class ProofRepairState {
    public abstract readonly name: "accepted" | "refused";

    /** Total by construction: a caller that handles one state handles both, or does not
     * compile. */
    public abstract fold<Result>(cases: ProofRepairStateCases<Result>): Result;

    /** What the generator is told, whichever way the decision went. */
    public abstract feedback(): string;

    /** A refusal is safe to construct from value objects: it authorizes nothing. */
    public static refused(
        ledger: ProofRepairLedger,
        refusals: readonly ProofRepairRefusal[]
    ): ProofRepairState {
        return new Refused(ledger, refusals);
    }

    /**
     * The decision, and the only constructor of the state that authorizes a write.
     *
     * Acceptance requires a capability held only by verifiers that ran a candidate inside an
     * isolation, so a forged report — a value object assembled to match a candidate's
     * identity and digests without ever being elaborated by the kernel — cannot reach this
     * path no matter how well it is built. Everything else here is defense in depth over the
     * verifier that already proved itself by producing the capability.
     */
    public static assess(
        ledger: ProofRepairLedger,
        objective: ProofRepairObjective,
        candidate: ProofRepairCandidate,
        report: ProofVerificationReport,
        owners: ProofArtifactOwners,
        audited: readonly string[]
    ): ProofRepairState {
        // The report is a key, not evidence: the verdict it names is a frozen snapshot this
        // module took from the verifier's own arguments, so a proxy or subclass that reshapes
        // the report's fields decides nothing here. A report this module never produced names
        // no verdict at all.
        // One module function validates and spends: an unregistered report has no verdict, a
        // spent one cannot be replayed, and the verdict handed back is the frozen snapshot
        // rather than anything the caller's object says about itself.
        const verdict = redeemProofVerdict(report);
        const mismatches = objectiveRefusals(objective, candidate);
        if (mismatches.length > 0) return new Refused(ledger, mismatches);
        const unowned = unownedRefusals(candidate.paths(), owners);
        if (unowned.length > 0) return new Refused(ledger, unowned);
        if (candidate.baseline !== ledger.digest) {
            return new Refused(ledger, [
                ProofRepairRefusal.stale(ledger.digest, candidate.baseline)
            ]);
        }
        if (!verdict.describes(candidate)) {
            // Both halves are named because the bindings fail for two different reasons: a
            // report produced for another candidate, and a report produced for this one over
            // bytes that are no longer the candidate's. A single line naming only the
            // candidate identity would read as the first while hiding the second.
            return new Refused(ledger, [
                ProofRepairRefusal.runtime("the verifier", [
                    `the report reads ${verdict.candidate} over ${measured(verdict.artifacts)}`,
                    `the candidate is ${candidate.identity} over ${measured(candidate.artifacts)}`
                ])
            ]);
        }
        // A failed build did not produce a complete proof report. Its diagnostics are evidence;
        // any apparent open set beneath them is not, so do not make a generator repair noise.
        if (verdict.findings.length > 0) return new Refused(ledger, verdict.findings);
        const refusals = [
            ...axiomRefusals(candidate, verdict, owners),
            ...designationRefusals(candidate, verdict, audited),
            ...closureRefusals(ledger, objective, candidate, verdict)
        ];
        if (refusals.length > 0) return new Refused(ledger, refusals);
        return new Accepted(ledger, candidate, verdict);
    }
}

/**
 * Applies the reviewed axiom policy to every designation the verifier emitted. A candidate
 * can change shared machinery and affect an audited declaration in another module, so a clean
 * run requires the whole designation set to remain clean.
 *
 * A designation that depends on `sorryAx` also lists it among its axioms, so a sorry hole and
 * an unreviewed assumption are recorded together rather than one at a time: the state
 * machine's promise is that every remaining refusal arrives at once, and hiding a known
 * assumption behind a sorry repair would spend a whole verification run discovering it.
 */
function axiomRefusals(
    candidate: ProofRepairCandidate,
    verdict: ProofVerdictView,
    owners: ProofArtifactOwners
): readonly ProofRepairRefusal[] {
    const refusals: ProofRepairRefusal[] = [];
    const paths = candidate.paths();
    for (const designation of verdict.designations) {
        const artifact =
            leanArtifact(designation.declaration, paths) ??
            declarationArtifact(designation.declaration);
        if (artifact === undefined) {
            refusals.push(
                ProofRepairRefusal.runtime("axiom designation", [
                    `${designation.declaration} has no attributable source artifact`
                ])
            );
            continue;
        }
        const owner = owners.owner(artifact);
        if (owner === undefined) {
            // Every artifact the candidate proposes was owner-checked before it was written,
            // so an unowned module here belongs to the base tree. Reporting it as a defect
            // would point a repair at a file this candidate never wrote; the harness simply
            // cannot say who answers for it.
            refusals.push(
                ProofRepairRefusal.runtime("axiom designation", [
                    `${artifact} carries ${designation.declaration} and has no reviewed owner`
                ])
            );
            continue;
        }
        const locus = ProofRepairLocus.at(owner, artifact).withTheorem(designation.declaration);
        if (designation.axioms.includes(SORRY)) {
            refusals.push(
                ProofRepairRefusal.proof(
                    locus,
                    `the declaration depends on ${SORRY}, so it stands unproved`
                )
            );
        }
        for (const axiom of designation.axioms) {
            if (axiom === SORRY || allowedBuiltInAxioms.includes(axiom)) continue;
            refusals.push(
                ProofRepairRefusal.assumption(locus.withAssumption(axiom), designation.axioms)
            );
        }
    }
    return refusals;
}

/**
 * The designation set must be complete and closed over the audited corpus.
 *
 * `#print axioms` designates exactly the registered audited names, so a report from the
 * reviewed command names every corpus declaration and nothing else. A designation list that
 * is smaller says the command that produced it was not the reviewed one — an omitted line is
 * how a candidate that never ran the real report grades itself. A designation list that
 * names something else says a declaration the corpus never audited was introduced into the
 * tree, and its axioms were never inspected at all. Both are refusals before closure is
 * assessed, because a missing designation is not an unknown; it is the absence of the
 * evidence the acceptance depends on.
 *
 * The audited set is host-owned and passed by the verifier, never read from the report.
 */
export function designationRefusals(
    candidate: ProofRepairCandidate,
    verdict: ProofVerdictView,
    audited: readonly string[]
): readonly ProofRepairRefusal[] {
    const designated = new Set(verdict.designations.map((entry) => entry.declaration));
    const missing = audited.filter((name) => !designated.has(name));
    if (missing.length > 0) {
        return [
            ProofRepairRefusal.runtime("axiom designation", [
                `the report designated ${designated.size} of ${audited.length} audited declarations`,
                ...missing.map((name) => `no axiom designation was printed for ${name}`)
            ])
        ];
    }
    const introduced = verdict.designations
        .map((entry) => entry.declaration)
        .filter((name) => !audited.includes(name));
    if (introduced.length > 0) {
        return introduced.map((name) => {
            const artifact = leanArtifact(name, candidate.paths());
            return artifact === undefined
                ? ProofRepairRefusal.runtime("axiom designation", [
                      `${name} is not an audited declaration and has no candidate artifact`
                  ])
                : ProofRepairRefusal.malformed(
                      `${name} is introduced by ${artifact} but is not an audited declaration`
                  );
        });
    }
    return [];
}

/** Zero open obligations, no lost closure under the trusted frame, and real advancement. */
function closureRefusals(
    ledger: ProofRepairLedger,
    objective: ProofRepairObjective,
    candidate: ProofRepairCandidate,
    verdict: ProofVerdictView
): readonly ProofRepairRefusal[] {
    const refusals: ProofRepairRefusal[] = [];
    const open = candidate.obligations.filter((obligation) => !verdict.proves(obligation));
    if (open.length > 0) refusals.push(ProofRepairRefusal.open(open));
    const regressed = ledger.regressed(verdict.closed, objective.frame);
    if (regressed.length > 0) refusals.push(ProofRepairRefusal.regression(regressed));
    if (
        newlyClosed(ledger, candidate).length === 0 &&
        ledger.rewritten(candidate.artifacts).length === 0
    ) {
        refusals.push(ProofRepairRefusal.progress(candidate.obligations));
    }
    return refusals;
}

function newlyClosed(
    ledger: ProofRepairLedger,
    candidate: ProofRepairCandidate
): readonly ProofObligation[] {
    return candidate.obligations.filter(
        (obligation) => !ledger.obligations().some((closed) => closed.equals(obligation))
    );
}

/**
 * The closures an acceptance may persist.
 *
 * A run reports every unit it proved, which is more than this candidate was asked about: the
 * report is the state of the whole corpus, not a reply to the objective. Persisting it whole
 * would write closures for rule units nobody put in an objective and nothing previously
 * closed, so the durable ledger would grow claims that no repair attempt was ever judged
 * against. The persisted set is therefore the intersection with what this acceptance is
 * entitled to move: the units already closed, which must keep their closure, and the units
 * this candidate's own objective named.
 */
function persistableClosures(
    ledger: ProofRepairLedger,
    candidate: ProofRepairCandidate,
    verdict: ProofVerdictView
): readonly ProofObligation[] {
    const closed = ledger.closedUnits();
    return verdict.closed.filter(
        (obligation) =>
            closed.has(obligation.unit) ||
            candidate.obligations.some((claimed) => claimed.equals(obligation))
    );
}

/**
 * The states this module accepted, held by identity.
 *
 * `instanceof` is not the check here, and the difference is load-bearing: a `Proxy` wrapping a
 * genuine acceptance satisfies `instanceof` while intercepting every read the store then makes,
 * and a subclass satisfies it while carrying whatever fields it likes. Membership is recorded
 * by the constructor for the exact instance it built, so a proxy, a subclass and an
 * `Object.create` of the prototype all fail, and the store's commit gate sees only states this
 * module produced.
 */
const acceptedStates = new WeakMap<ProofRepairState, Accepted>();

class Accepted extends ProofRepairState implements AcceptedProofRepair {
    public readonly name = "accepted";
    public readonly candidate: string;

    /** The baseline this acceptance was computed against. A store refuses to write it once the
     * accepted state has moved, so an acceptance cannot be replayed onto a tree it never saw. */
    public readonly baseline: string;
    public readonly ledger: ProofRepairLedger;
    public readonly promoted: readonly ProposedArtifact[];
    public readonly progress: readonly ProofObligation[];
    public readonly repaired: readonly AcceptedArtifact[];
    public readonly preserved: readonly ProofObligation[];

    public constructor(
        ledger: ProofRepairLedger,
        candidate: ProofRepairCandidate,
        verdict: ProofVerdictView
    ) {
        super();
        this.candidate = candidate.identity;
        this.baseline = ledger.digest;
        this.ledger = ledger.accept(candidate, persistableClosures(ledger, candidate, verdict));
        this.promoted = candidate.artifacts;
        this.progress = newlyClosed(ledger, candidate);
        this.repaired = ledger.rewritten(candidate.artifacts);
        this.preserved = ledger.obligations();
        Object.freeze(this);
        acceptedStates.set(this, this);
    }

    public fold<Result>(cases: ProofRepairStateCases<Result>): Result {
        return cases.accepted(this);
    }

    public feedback(): string {
        const closed = this.progress.map((obligation) => obligation.describe());
        const repaired = this.repaired.map((artifact) => artifact.path);
        return [
            `accepted ${this.candidate}: baseline ${this.baseline} advances ` +
                `to ${this.ledger.digest}`,
            `closed: ${closed.length === 0 ? "nothing new" : closed.join(" ; ")}`,
            `repaired: ${repaired.length === 0 ? "nothing" : repaired.join(" ")}`,
            preservedLine(this.preserved)
        ].join("\n");
    }
}

class Refused extends ProofRepairState implements RefusedProofRepair {
    public readonly name = "refused";
    public readonly refusals: readonly ProofRepairRefusal[];
    public readonly preserved: readonly ProofObligation[];

    /** True when at least one refusal is the candidate's to answer for. A refusal set that is
     * entirely unattributed asks for the run again, not for a different candidate. */
    public readonly attributed: boolean;

    public constructor(ledger: ProofRepairLedger, refusals: readonly ProofRepairRefusal[]) {
        super();
        if (refusals.length === 0) throw new TypeError("A refusal states no reason");
        this.refusals = Object.freeze([...refusals]);
        this.preserved = ledger.obligations();
        this.attributed = this.refusals.some((refusal) => refusal.attributed);
        Object.freeze(this);
    }

    public fold<Result>(cases: ProofRepairStateCases<Result>): Result {
        return cases.refused(this);
    }

    public kinds(): readonly string[] {
        return this.refusals.map((refusal) => refusal.kind);
    }

    public feedback(): string {
        return [
            ...this.refusals.map((refusal) => refusal.feedback()),
            preservedLine(this.preserved)
        ].join("\n");
    }
}

/** Every refusal and every acceptance repeats what is already closed. A repair that silences
 * one defect by dropping a proved obligation is the failure this line exists to prevent. */
function preservedLine(preserved: readonly ProofObligation[]): string {
    if (preserved.length === 0) return "preserved: nothing is closed yet";
    const units = preserved.map((obligation) => obligation.describe());
    return `preserved: ${units.join(" ; ")}`;
}

/** Returns the authority-bearing state only for an instance this module constructed. The
 * lookup is by object identity, so a subclass, a prototype clone and a `Proxy` around a real
 * acceptance all answer nothing — a wrapper is not the instance the constructor registered. */
export function acceptedProofRepair(state: ProofRepairState): AcceptedProofRepair | undefined {
    return acceptedStates.get(state);
}
