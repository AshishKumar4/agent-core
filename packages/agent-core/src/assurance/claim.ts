import { canonicalTupleKey } from "../core";
import { AgentCoreError } from "../errors";
import { AssuredClaimId } from "./id";
import { RuntimePremise } from "./premise";

/** Whether a claim underwrites safety or only progress. */
export abstract class ClaimModality {
    public static get safety(): ClaimModality {
        return safetyModality;
    }
    public static get liveness(): ClaimModality {
        return livenessModality;
    }

    public abstract readonly name: string;
    public abstract fold<Result>(cases: ClaimModalityCases<Result>): Result;
}

export interface ClaimModalityCases<Result> {
    readonly safety: () => Result;
    readonly liveness: () => Result;
}

class SafetyModality extends ClaimModality {
    public readonly name = "safety";
    public fold<Result>(cases: ClaimModalityCases<Result>): Result {
        return cases.safety();
    }
}

class LivenessModality extends ClaimModality {
    public readonly name = "liveness";
    public fold<Result>(cases: ClaimModalityCases<Result>): Result {
        return cases.liveness();
    }
}

const safetyModality = Object.freeze(new SafetyModality());
const livenessModality = Object.freeze(new LivenessModality());

/**
 * What one deployed claim is worth against a premise ledger.
 *
 * The three cases answer the three questions asked after an incident. `voided`: a premise it
 * rests on was refuted, and the ledger can name which ones. `conditional`: nothing refuted,
 * something not established, and the ledger can name that too. `residual`: every premise it
 * rests on is discharged by durable domain evidence — what remains proved.
 *
 * A claim with empty support is residual under every ledger there is, including one whose
 * every premise is refuted. That is the answer to "which properties remain proved", and it is
 * why support is reviewed input rather than something this plane computes.
 */
export abstract class ClaimStanding {
    public static get residual(): ClaimStanding {
        return residualStanding;
    }
    public static get conditional(): ClaimStanding {
        return conditionalClaimStanding;
    }
    public static get voided(): ClaimStanding {
        return voidedStanding;
    }

    public abstract readonly name: string;
}

class ResidualStanding extends ClaimStanding {
    public readonly name = "residual";
}

class ConditionalClaimStanding extends ClaimStanding {
    public readonly name = "conditional";
}

class VoidedStanding extends ClaimStanding {
    public readonly name = "voided";
}

const residualStanding = Object.freeze(new ResidualStanding());
const conditionalClaimStanding = Object.freeze(new ConditionalClaimStanding());
const voidedStanding = Object.freeze(new VoidedStanding());

/**
 * A deployed claim and the premises it rests on.
 *
 * `support` is reviewed input. Which claims rest on which assumptions is exactly the mapping
 * §14 states in prose and no artifact carries structurally; recording it here makes the blast
 * radius computable. Changing it is a claim-surface act governed by
 * `AGENT_OPERATING_DOCTRINE.md`, not a runtime decision.
 */
export class AssuredClaim {
    public readonly id: AssuredClaimId;
    public readonly modality: ClaimModality;
    public readonly support: readonly RuntimePremise[];

    public constructor(
        id: AssuredClaimId,
        modality: ClaimModality,
        support: readonly RuntimePremise[]
    ) {
        if (!(id instanceof AssuredClaimId)) {
            throw new TypeError("Assured claim id must be an AssuredClaimId");
        }
        if (!(modality instanceof ClaimModality)) {
            throw new TypeError("Assured claim modality must be a ClaimModality");
        }
        this.id = id;
        this.modality = modality;
        this.support = requireClaimSupport(support);
        if (!this.wellFormed()) {
            throw new AgentCoreError(
                "assurance.invalid-claim",
                `Assured claim ${id.value} does not carry the premises its modality requires`
            );
        }
        Object.freeze(this);
    }

    /**
     * A safety claim rests only on safety premises. A liveness claim rests on at least one
     * progress premise. The two rules make the safety/liveness boundary fail closed in the
     * declaration layer; the formal model still represents malformed claims as a predicate so
     * it can prove exactly why they fail.
     */
    public wellFormed(): boolean {
        return this.modality.fold<boolean>({
            safety: () =>
                this.support.every((premise) =>
                    premise.kind.fold<boolean>({
                        safety: () => true,
                        progress: () => false
                    })
                ),
            liveness: () =>
                this.support.some((premise) =>
                    premise.kind.fold<boolean>({
                        safety: () => false,
                        progress: () => true
                    })
                )
        });
    }

    public equals(other: AssuredClaim): boolean {
        return this.id.equals(other.id);
    }

    /** An injective identity over the claim's reviewed support. */
    public get key(): string {
        return canonicalTupleKey("assurance.claim", [
            this.id.value,
            this.modality.name,
            this.support.map((premise) => premise.id.value)
        ]);
    }
}

function requireClaimSupport(support: readonly RuntimePremise[]): readonly RuntimePremise[] {
    const seen = new Set<string>();
    const snapshot: RuntimePremise[] = [];
    for (const premise of support) {
        if (!(premise instanceof RuntimePremise)) {
            throw new TypeError("Assured claim support must hold RuntimePremise values");
        }
        if (seen.has(premise.id.value)) {
            throw new AgentCoreError(
                "assurance.invalid-claim",
                `Assured claim support repeats ${premise.id.value}`
            );
        }
        seen.add(premise.id.value);
        snapshot.push(premise);
    }
    return Object.freeze(snapshot);
}
