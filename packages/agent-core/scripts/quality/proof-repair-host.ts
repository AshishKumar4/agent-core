import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    assertArray,
    assertObject,
    assertString,
    isJsonObject,
    parseCanonicalJson,
    type JsonValue
} from "./project.mjs";
import {
    ProofObligation,
    ProofRepairCandidate,
    ProofRepairObjective,
    type ProofRepairLedger
} from "./proof-repair-record.js";
import {
    acceptedProofRepair,
    ProofRepairState,
    type RefusedProofRepair
} from "./proof-repair-outcome.js";
import { type ProofRepairStore } from "./proof-repair-store.js";
import { ProofRepairRefusal, type ProofArtifactOwners } from "./proof-repair-refusal.js";
import { ProofRepairProtocol } from "./proof-repair.js";
import { type ProofCandidateVerification } from "./proof-repair-verification.js";

const packageRoot = resolve(import.meta.dirname, "../..");

/** The corpus ledger the reviewed controlled-language gate committed: one row per bridged
 * rule unit, carrying the digest, atoms, and SPEC anchor that name an obligation. */
export const cnlCorpusLedgerArtifact = join(packageRoot, "artifacts", "cnl", "ledger.json");

/**
 * What the untrusted generator is told, and what it is allowed to answer with.
 *
 * The prompt is the trusted objective: the exact obligations this attempt owes, rendered
 * the way every obligation-bearing feedback renders them. The reply is raw proposal JSON —
 * the same shape `ProofRepairProtocol.submit` reads at its one boundary — because the
 * generator is the untrusted party and the host does not trust it to construct typed
 * records. A generator that cannot answer returns nothing and the loop counts the turn as
 * spent rather than fabricating a candidate for it.
 */
export interface ProofCandidateGenerator {
    /** One proposal for one attempt, or nothing when the generator declines to answer. */
    propose(turn: ProofRepairTurn): JsonValue | undefined;
}

/**
 * One exchange with the untrusted generator.
 *
 * `attempt` counts every proposal this objective has heard, refused or accepted, from one.
 * `prompt` is the trusted objective. On every turn after the first it also carries the
 * previous state's feedback verbatim: refusal feedback is the only thing the protocol
 * hands a caller that points at the defect to repair, and a host that dropped it would be
 * asking the same blind question again.
 */
export interface ProofRepairTurn {
    readonly attempt: number;
    readonly prompt: string;
    readonly feedback: string | undefined;
}

/** Where one objective's loop stopped, and what the accepted state is.
 *
 * `inconclusive` is the one terminal that is not the generator's: the harness reached no
 * verdict on a candidate (`attributed === false` on every refusal), so the loop stops
 * without blaming text nobody judged. The doctrine's instruction for an unattributed
 * refusal is to ask for the run again, and a caller cannot rerun what it was not handed
 * back, so the terminal carries the exact proposal that was never judged — the same
 * immutable shape `submit` reads — alongside the identity it decodes to. A proposal too
 * malformed to decode carries neither: there is no candidate to name, and the rerun
 * starts from the next generator turn.
 */
export interface ProofRepairLoopResult {
    readonly name: "accepted" | "declined" | "exhausted" | "inconclusive";
    readonly objective: ProofRepairObjective;
    readonly attempts: number;
    readonly refusals: readonly string[];
    readonly ledger: ProofRepairLedger;
    /** The proposal the harness failed to judge; present only on `inconclusive`. */
    readonly inconclusiveProposal: JsonValue | undefined;
    /** The identity that proposal decodes to, when it decodes to one. */
    readonly inconclusiveCandidate: string | undefined;
}

/**
 * The reference generator: it answers with the proposals it was constructed with, in
 * order, and declines once they run out.
 *
 * A live model adapter is a separate `ProofCandidateGenerator` implementation the host
 * takes by injection; this one exists so the loop's behavior is deterministic in tests
 * and in the gate. It never inspects the feedback: a recorded answer is the same
 * regardless of what the previous attempt heard, which is exactly what makes a suite that
 * uses it reproducible.
 */
export class RecordedProofCandidateGenerator implements ProofCandidateGenerator {
    private readonly proposals: readonly JsonValue[];
    private position = 0;

    public constructor(proposals: readonly JsonValue[]) {
        this.proposals = Object.freeze([...proposals]);
    }

    public propose(_turn: ProofRepairTurn): JsonValue | undefined {
        const next = this.proposals[this.position];
        this.position += 1;
        return next;
    }

    /** The proposals this generator has not yet answered with. */
    public remaining(): number {
        return this.proposals.length - this.position;
    }
}

/**
 * The untrusted-LLM proof synthesis loop host.
 *
 * The protocol decides one candidate. This host owns everything around that decision:
 * it constructs the trusted objective from the corpus's real rule units and the
 * committed ledger's already-closed set, asks the injected generator for a proposal,
 * submits it through the protocol's one boundary, and repeats while the answer is
 * attributed feedback and the attempt budget holds. Every acceptance the protocol
 * reaches is committed by the protocol through the store's compare-and-publish; this
 * host never writes the ledger itself, so a refused candidate leaves the accepted state
 * byte-for-byte alone not by convention but because nothing it runs has the authority
 * to write.
 *
 * The loop stops on the first acceptance: the objective that produced it is spent, and
 * the monotonicity of everything after it is the ledger's own invariant, not this loop's.
 * It also stops when a refusal is unattributed — the harness reporting it reached no
 * verdict — because feeding "we could not run the verifier" back as a defect would teach
 * the generator to fix text that was never judged.
 */
export class ProofRepairHost {
    private readonly base: string;
    private readonly store: ProofRepairStore;
    private readonly verifier: ProofCandidateVerification;
    private readonly owners: ProofArtifactOwners;

    public constructor(
        base: string,
        store: ProofRepairStore,
        verifier: ProofCandidateVerification,
        owners: ProofArtifactOwners
    ) {
        this.base = base;
        this.store = store;
        this.verifier = verifier;
        this.owners = owners;
        Object.freeze(this);
    }

    /**
     * Runs the loop for one trusted objective under one attempt budget.
     *
     * `budget` bounds the proposals this run submits for this objective. A loop that
     * exhausts it returns `exhausted` with the ledger's current state rather than
     * throwing, because a bounded repair loop running out of attempts is an outcome the
     * caller scheduled, not a failure the host failed to contain. A generator that stops
     * answering before the budget is spent returns `declined` for the same reason.
     */
    public repair(
        objective: ProofRepairObjective,
        generator: ProofCandidateGenerator,
        budget: number
    ): ProofRepairLoopResult {
        if (!Number.isSafeInteger(budget) || budget < 1) {
            throw new TypeError(`A repair budget bounds at least one attempt: ${budget}`);
        }
        const refusals: string[] = [];
        let feedback: string | undefined;
        for (let attempt = 1; attempt <= budget; attempt += 1) {
            const proposal = generator.propose({
                attempt,
                prompt: renderPrompt(objective),
                feedback
            });
            if (proposal === undefined) {
                return result("declined", objective, attempt - 1, refusals, this.store.load());
            }
            // The untrusted proposal is decoded exactly once, before anything else
            // looks at it: a plain-prototype object with enumerable accessors could
            // answer every read differently, so the loop judges, snapshots, and names
            // the same immutable candidate rather than three readings of one input.
            // A proposal too malformed to decode is the same attributed malformed
            // refusal the protocol's own boundary would produce, built here once from
            // the decode's own message.
            let decoded: ProofRepairCandidate | undefined;
            let decodeError: unknown;
            try {
                decoded = ProofRepairCandidate.fromData(proposal, "the proposed candidate");
            } catch (error) {
                decodeError = error;
            }
            const state: ProofRepairState =
                decoded === undefined
                    ? ProofRepairState.refused(this.store.load(), [
                          ProofRepairRefusal.malformed(
                              decodeError instanceof Error
                                  ? decodeError.message
                                  : "the proposal could not be read as a candidate"
                          )
                      ])
                    : new ProofRepairProtocol(
                          this.base,
                          objective,
                          this.store,
                          this.verifier,
                          this.owners
                      ).repair(decoded);
            if (acceptedProofRepair(state) !== undefined) {
                return result("accepted", objective, attempt, refusals, this.store.load());
            }
            const refused = state.fold<RefusedProofRepair>({
                accepted: () => {
                    throw new TypeError("An accepted state refused its own acceptance");
                },
                refused: (outcome) => outcome
            });
            feedback = state.feedback();
            refusals.push(feedback);
            if (!refused.attributed) {
                // An entirely unattributed refusal is the harness reporting it reached no
                // verdict, not a defect in the candidate. Feeding it back would teach the
                // generator to repair text nobody judged, so the loop stops and hands
                // back the one candidate it decoded: the doctrine's remedy is to run
                // that candidate again, which a caller can only do if the result
                // carries it.
                return inconclusive(
                    objective,
                    attempt,
                    refusals,
                    this.store.load(),
                    decoded === undefined ? undefined : deepFreeze(decoded.toData()),
                    decoded?.identity
                );
            }
        }
        return result("exhausted", objective, budget, refusals, this.store.load());
    }

    /**
     * The corpus's obligations for one repair objective.
     *
     * Reads the reviewed controlled-language ledger the CNL gate committed — real corpus
     * data, with each unit's rule-unit digest, its conformance atoms, and its SPEC anchor —
     * and returns the obligations the committed proof-repair ledger has not closed yet.
     * The closed set is what the host already owes nothing for; the remainder is what a
     * repair attempt is for. A unit whose obligation is already closed is not re-proposed,
     * because the protocol would refuse it for making no progress.
     */
    public objectiveForUnits(
        corpusLedger: string = cnlCorpusLedgerArtifact,
        ledger: ProofRepairLedger = this.store.load()
    ): ProofRepairObjective {
        return corpusObjective(corpusLedger, ledger);
    }

    /** The reviewed formal base this host materializes candidates against. */
    public get proofBase(): string {
        return this.base;
    }
}

/**
 * The trusted objective for the corpus units a ledger has not closed in their current form.
 *
 * The corpus ledger is the reviewed artifact the controlled-language gate produced; this
 * reader trusts exactly its three obligation-bearing fields per unit and refuses
 * everything else about the record rather than guessing an obligation shape. A unit row
 * that names no atom, or whose anchor or digest is not the shape the obligation record
 * requires, is a corpus defect and fails here rather than becoming a weaker obligation.
 *
 * The complete corpus form travels as the objective's frame, and a unit is subtracted only
 * when a stored closure equals its current corpus form completely — digest, atoms, and
 * anchor. A closure whose corpus form moved stays owed: its acceptance proves the frame's
 * form and supersedes the stored record with provenance, so the host never reports nothing
 * to repair while the ledger holds a conflicting claim. The one conflict no repair can fix
 * is a closed unit the corpus dropped entirely — nothing remains to supersede it — so that
 * is refused here as the migration it is.
 */
export function corpusObjective(
    corpusLedger: string,
    ledger: ProofRepairLedger
): ProofRepairObjective {
    const record = assertObject(
        parseCanonicalJson(readFileSync(corpusLedger, "utf8"), corpusLedger),
        corpusLedger
    );
    const units = assertArray(record["units"], `${corpusLedger} units`);
    const frame: ProofObligation[] = [];
    for (const [index, unit] of units.entries()) {
        const owner = `${corpusLedger} units[${index}]`;
        const row = assertObject(unit, owner);
        frame.push(
            new ProofObligation(
                assertString(row["digest"], `${owner}.digest`),
                assertArray(row["atoms"], `${owner}.atoms`).map((atom, position) =>
                    assertString(atom, `${owner}.atoms[${position}]`)
                ),
                assertString(row["anchor"], `${owner}.anchor`)
            )
        );
    }
    const settledForms = ledger.obligations();
    for (const settled of settledForms) {
        if (frame.some((row) => row.unit === settled.unit)) continue;
        throw new TypeError(
            `The accepted ledger closes ${settled.describe()}, which the corpus no ` +
                "longer carries; this needs a ledger migration, not a repair"
        );
    }
    const obligations = frame.filter(
        (obligation) => !settledForms.some((settled) => settled.equals(obligation))
    );
    if (obligations.length === 0) {
        throw new TypeError("The corpus owes no open obligation; there is nothing to repair");
    }
    return new ProofRepairObjective(obligations, frame);
}

/** The prompt every turn hands the generator: the owed obligations, one per line. */
function renderPrompt(objective: ProofRepairObjective): string {
    const owed = objective.obligations.map((obligation) => obligation.describe());
    return [
        "Close every obligation in the trusted repair objective:",
        ...owed.map((line) => `  ${line}`)
    ].join("\n");
}

function result(
    name: Exclude<ProofRepairLoopResult["name"], "inconclusive">,
    objective: ProofRepairObjective,
    attempts: number,
    refusals: readonly string[],
    ledger: ProofRepairLedger
): ProofRepairLoopResult {
    return Object.freeze({
        name,
        objective,
        attempts,
        refusals: Object.freeze([...refusals]),
        ledger,
        inconclusiveProposal: undefined,
        inconclusiveCandidate: undefined
    });
}

function inconclusive(
    objective: ProofRepairObjective,
    attempts: number,
    refusals: readonly string[],
    ledger: ProofRepairLedger,
    proposal: JsonValue | undefined,
    candidate: string | undefined
): ProofRepairLoopResult {
    return Object.freeze({
        name: "inconclusive",
        objective,
        attempts,
        refusals: Object.freeze([...refusals]),
        ledger,
        inconclusiveProposal: proposal,
        inconclusiveCandidate: candidate
    });
}

function deepFreeze(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        return Object.freeze(value.map(deepFreeze));
    }
    if (isJsonObject(value)) {
        return Object.freeze(
            Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [key, deepFreeze(entry)])
            )
        );
    }
    return value;
}
