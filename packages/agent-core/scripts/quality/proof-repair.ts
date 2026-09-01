import { loadOwnership, ownersForPath } from "./ownership.mjs";
import { type JsonValue } from "./project.mjs";
import {
    ProofRepairCandidate,
    ProofRepairObjective,
    type ProofRepairLedger
} from "./proof-repair-record.js";
import {
    ProofArtifactOwners,
    ProofRepairLocus,
    ProofRepairRefusal,
    unownedRefusals
} from "./proof-repair-refusal.js";
import {
    acceptedProofRepair,
    objectiveRefusals,
    ProofRepairState
} from "./proof-repair-outcome.js";
import { type ProofRepairStore } from "./proof-repair-store.js";
import {
    callerProofIsolation,
    discardProofIsolation,
    freshProofIsolation,
    isolateProofCandidate,
    ProofTreeError,
    type IsolatedProofCandidate
} from "./proof-repair-tree.js";
import {
    ProofCandidateVerification,
    type ProofVerificationReport
} from "./proof-repair-verification.js";

const FORMAL_OWNERSHIP_ROOT = "packages/agent-core/formal";

/** Resolves candidate artifacts against the repository's one ownership map. Multiple matches
 * and missing matches are both refused: feedback has an exact owner or it has no authority to
 * tell anyone what to repair. */
export class RepositoryProofArtifactOwners extends ProofArtifactOwners {
    private readonly root: string;
    private readonly patterns: ReadonlyMap<string, string>;

    public constructor(root: string, patterns: ReadonlyMap<string, string>) {
        super();
        this.root = root.endsWith("/") ? root.slice(0, -1) : root;
        this.patterns = patterns;
        Object.freeze(this);
    }

    public owner(path: string): string | undefined {
        const matched = ownersForPath(`${this.root}/${path}`, this.patterns);
        return matched.length === 1 ? matched[0] : undefined;
    }

    public static async fromRepository(
        root: string = FORMAL_OWNERSHIP_ROOT
    ): Promise<RepositoryProofArtifactOwners> {
        const { patterns } = await loadOwnership();
        return new RepositoryProofArtifactOwners(root, patterns);
    }
}

/**
 * The untrusted-LLM proof repair protocol.
 *
 * `submit` is the only public path from raw model output to a decision. It parses the proposal
 * into immutable records, verifies freshness and ownership before any candidate text reaches a
 * process, overlays it only into a new disposable isolation, asks the trusted verifier for a
 * report, then applies the closed-state-machine decision. The store receives a state only if
 * it is `accepted`; all other paths return feedback with the previously closed obligations
 * preserved and leave the one accepted ledger byte-for-byte alone.
 *
 * A proof candidate is necessarily elaborated to be checked, but this protocol never executes
 * or imports it from the reviewed tree. The only command runner sees an isolated copy, and the
 * isolation is deleted once the verifier returns. Before acceptance, the model's text has no
 * durable home and no path into the accepted artifact set.
 */
export class ProofRepairProtocol {
    private readonly base: string;
    private readonly objective: ProofRepairObjective;
    private readonly store: ProofRepairStore;
    private readonly verifier: ProofCandidateVerification;
    private readonly owners: ProofArtifactOwners;

    public constructor(
        base: string,
        objective: ProofRepairObjective,
        store: ProofRepairStore,
        verifier: ProofCandidateVerification,
        owners: ProofArtifactOwners
    ) {
        this.base = base;
        this.objective = objective;
        this.store = store;
        this.verifier = verifier;
        this.owners = owners;
        Object.freeze(this);
    }

    /** Parses untrusted model output at its one boundary. A malformed proposal is feedback,
     * not an exception that lets a model crash the repair loop. A path outside the
     * host-owned artifact policy is refused here, because `ProposedArtifact` refuses to exist
     * for one and the decode failure arrives as ordinary feedback. */
    public submit(proposal: JsonValue, isolation?: string): ProofRepairState {
        const ledger = this.store.load();
        let candidate: ProofRepairCandidate;
        try {
            candidate = ProofRepairCandidate.fromData(proposal, "proof candidate");
        } catch (error) {
            return ProofRepairState.refused(ledger, [
                ProofRepairRefusal.malformed(
                    error instanceof Error ? error.message : "the proposal could not be read"
                )
            ]);
        }
        return this.repair(candidate, isolation);
    }

    /**
     * A typed caller may submit an already-decoded candidate. It still crosses every
     * admission guard and cannot bypass isolation, verifier binding, or the store's commit
     * fence.
     *
     * The artifact policy is not rechecked here: `ProposedArtifact` and `AcceptedArtifact`
     * refuse to exist for a build product, a module outside the corpus, or an evidence
     * producer, so a candidate carrying one cannot be constructed and a ledger carrying one
     * cannot be decoded. One enforcement point, at the boundary where the bytes get names.
     *
     * Scratch space is minted only after the admission guards pass, and it is removed on every
     * path out. A refusal decided before any candidate text exists therefore leaves nothing
     * behind at all — the earlier shape, which minted a directory as a default argument, left
     * one temporary tree per refused proposal.
     */
    public repair(candidate: ProofRepairCandidate, isolation?: string): ProofRepairState {
        const ledger = this.store.load();
        if (candidate.baseline !== ledger.digest) {
            return ProofRepairState.refused(ledger, [
                ProofRepairRefusal.stale(ledger.digest, candidate.baseline)
            ]);
        }
        const objective = objectiveRefusals(this.objective, candidate);
        if (objective.length > 0) return ProofRepairState.refused(ledger, objective);
        // Owner lookup happens before isolation, so even a malicious path cannot reach a
        // process before the protocol knows who answers for it.
        const ownership = unownedRefusals(candidate.paths(), this.owners);
        if (ownership.length > 0) return ProofRepairState.refused(ledger, ownership);
        const workspace =
            isolation === undefined ? freshProofIsolation() : callerProofIsolation(isolation);
        try {
            return this.judge(ledger, candidate, workspace.candidate);
        } finally {
            workspace.discard();
        }
    }

    /** Materializes the candidate, asks the verifier, and applies the decision. */
    private judge(
        ledger: ProofRepairLedger,
        candidate: ProofRepairCandidate,
        target: string
    ): ProofRepairState {
        let isolated: IsolatedProofCandidate;
        try {
            isolated = isolateProofCandidate(this.base, target, ledger.artifacts, candidate);
        } catch (error) {
            if (error instanceof ProofTreeError && error.artifact !== undefined) {
                const owner = this.owners.owner(error.artifact);
                if (owner !== undefined && candidate.paths().includes(error.artifact)) {
                    return ProofRepairState.refused(ledger, [
                        ProofRepairRefusal.isolation(
                            ProofRepairLocus.at(owner, error.artifact),
                            error.message
                        )
                    ]);
                }
            }
            return ProofRepairState.refused(ledger, [
                ProofRepairRefusal.runtime("candidate isolation", [
                    error instanceof Error ? error.message : "the isolation could not be created"
                ])
            ]);
        }
        try {
            let report: ProofVerificationReport | ProofRepairRefusal;
            try {
                report = this.verifier.verify(isolated);
            } catch (error) {
                return ProofRepairState.refused(ledger, [
                    ProofRepairRefusal.runtime("proof verifier", [
                        error instanceof Error ? error.message : "the verifier reached no verdict"
                    ])
                ]);
            }
            const state =
                report instanceof ProofRepairRefusal
                    ? ProofRepairState.refused(ledger, [report])
                    : ProofRepairState.assess(
                          ledger,
                          this.objective,
                          candidate,
                          report,
                          this.owners,
                          this.verifier.auditedNames()
                      );
            if (acceptedProofRepair(state) !== undefined) this.store.commit(state);
            return state;
        } finally {
            discardProofIsolation(isolated);
        }
    }
}
