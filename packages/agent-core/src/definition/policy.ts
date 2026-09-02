import {
    RecordCodec,
    TextId,
    hasExactJsonKeys,
    isJsonObject,
    isMember,
    type JsonValue
} from "../core";
import { enforcementFloor, type EnforcementTier, type Impact, type IsolationMode } from "../facets";
import {
    AuthoredCodeBackingId,
    AuthoredCodeBackingPolicy,
    PLACEMENT_PREFERENCE,
    PlacementPolicy
} from "./placement";
import {
    TreeMergePolicy,
    type TreeMergePolicyData
} from "./generated/tree-merge/AgentCore/Extract/TreeMerge";

export { enforcementFloor };
export type { EnforcementTier } from "../facets";
export type EnforcementTierOverrides = Readonly<Partial<Record<Impact, EnforcementTier>>>;

export const POLICY_IMPACTS: readonly Impact[] = Object.freeze([
    "observe",
    "mutate",
    "externalSend",
    "execute",
    "delegate",
    "administer"
]);

/**
 * SPEC §5.2.1: how a merge resolves the tree its two parents share. The three settings are
 * the whole vocabulary and the platform never picks silently, so this is a value object
 * whose cases carry the two facts a merge needs — which side a wholesale resolution
 * records, and whether a path changed on both sides is a conflict the operator resolves.
 * Absence is not a fourth setting: a Blueprint that omits it declares a platform whose
 * branches own disjoint Environments, and a merge that would need a side is rejected
 * rather than guessed (C13-RUN-TREE-CONFLICT-EXPLICIT).
 *
 * The vocabulary, both facts, and the singleton per case are lowered by the TSLean
 * compiler from `formal/AgentCore/Extract/TreeMerge.lean`; only the absence-tolerant
 * decode below is this context's, because absence is a Blueprint fact and not a merge one.
 */
export { TreeMergePolicy };
export type TreeMergeSetting = TreeMergePolicyData;

/** The declared policy, or nothing where the Blueprint declares none (SPEC §9.2). */
export function treeMergePolicyFromData(value: JsonValue | undefined): TreeMergePolicy | undefined {
    if (value === undefined || value === null) return undefined;
    return TreeMergePolicy.fromData(value);
}

// The lowering emits one singleton per case but does not freeze them, and a record this
// context hands out is frozen. Freezing here — where the lowered vocabulary enters the
// domain, not inside the generated tree a regeneration would overwrite — is what keeps
// `Object.isFrozen` true for every policy a caller can reach.
for (const policy of [TreeMergePolicy.ours, TreeMergePolicy.theirs, TreeMergePolicy.perPath]) {
    Object.freeze(policy);
}

export interface PolicySetInit {
    readonly tiers?: EnforcementTierOverrides;
    readonly approvals?: readonly Impact[];
    readonly placement?: PlacementPolicy;
    readonly maxDirectRevocationWindowMs?: number;
    readonly treeMerge?: TreeMergePolicy;
}

class PolicySetCodec extends RecordCodec<PolicySet> {
    public constructor() {
        super(
            [
                PolicySet,
                AuthoredCodeBackingPolicy,
                PlacementPolicy,
                AuthoredCodeBackingId,
                TextId,
                TreeMergePolicy
            ],
            "definition.policy-set",
            {
                major: 3,
                minor: 0
            }
        );
    }

    protected encodePayload(policy: PolicySet): JsonValue {
        return policy.toData();
    }

    protected decodePayload(payload: JsonValue): PolicySet {
        return PolicySet.fromData(payload);
    }
}

export class PolicySet {
    public static get codec(): RecordCodec<PolicySet> {
        return policySetCodecInstance;
    }
    public readonly tiers: EnforcementTierOverrides;
    public readonly approvals: readonly Impact[];
    public readonly placement: PlacementPolicy;
    public readonly maxDirectRevocationWindowMs: number | undefined;
    /**
     * Present only when the Blueprint declares it. Absence is the declaration that this
     * platform's branches own disjoint Environments, so a merge needing a side is refused.
     */
    public readonly treeMerge: TreeMergePolicy | undefined;

    public constructor(init: PolicySetInit = {}) {
        this.tiers = canonicalTiers(init.tiers ?? {});
        this.approvals = canonicalApprovals(init.approvals ?? []);
        this.placement = init.placement ?? PlacementPolicy.all();
        this.maxDirectRevocationWindowMs = validateDirectRevocationWindow(
            init.maxDirectRevocationWindowMs
        );
        this.treeMerge = init.treeMerge;
        Object.freeze(this);
    }

    public static empty(): PolicySet {
        return emptyPolicySet;
    }

    public static encode(policy: PolicySet): Uint8Array {
        return PolicySet.codec.encode(policy);
    }

    public static decode(bytes: Uint8Array): PolicySet {
        return PolicySet.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): PolicySet {
        const object = requireObject(payload, "Policy set");
        if (
            !hasExactJsonKeys(object, [
                "approvals",
                "maxDirectRevocationWindowMs",
                "placement",
                "tiers",
                "treeMerge"
            ])
        ) {
            throw new TypeError("Policy set contains missing or unknown fields");
        }
        const treeMerge = treeMergePolicyFromData(object["treeMerge"]);
        return new PolicySet({
            tiers: requireTiers(object["tiers"]),
            approvals: requireImpactArray(object["approvals"], "Policy approvals"),
            ...decodeOptionalDirectRevocationWindow(object["maxDirectRevocationWindowMs"]),
            placement: PlacementPolicy.fromData(object["placement"]),
            ...(treeMerge && { treeMerge })
        });
    }

    public tierFor(impact: Impact): EnforcementTier | undefined {
        return this.tiers[impact];
    }

    public requiresApproval(impact: Impact): boolean {
        return this.approvals.includes(impact);
    }

    public toData(): JsonValue {
        return {
            approvals: this.approvals,
            maxDirectRevocationWindowMs: this.maxDirectRevocationWindowMs ?? null,
            placement: this.placement.toData(),
            tiers: this.tiers,
            treeMerge: this.treeMerge?.toData() ?? null
        };
    }
}

const policySetCodecInstance = new PolicySetCodec();

export interface PolicyEvaluationInput {
    readonly impact: Impact;
    readonly turnOwnedSession: boolean;
    /**
     * True only when the operation's target is the Turn-owned Session's own
     * filesystem (SPEC §7.2). Required so a caller that cannot attest the fact
     * states false explicitly; a mutate outside that filesystem stays mediated.
     */
    readonly sessionFilesystemTarget: boolean;
    readonly placement: IsolationMode;
    readonly policies?: readonly PolicySet[];
}

export interface PolicyDecision {
    readonly tier: EnforcementTier;
    readonly approvalRequired: boolean;
}

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyDecision {
    requireMode(input.placement);
    const policy = mergePolicySets(input.policies ?? []);
    const approvalRequired = policy.requiresApproval(input.impact);
    const floor = enforcementFloor(
        input.impact,
        input.turnOwnedSession,
        input.sessionFilesystemTarget
    );
    const requested = policy.tierFor(input.impact) ?? "direct";
    const tier =
        floor === "mediated" ||
        requested === "mediated" ||
        input.placement !== "bundled" ||
        approvalRequired
            ? "mediated"
            : "direct";
    return Object.freeze({ approvalRequired, tier });
}

export function mergePolicySets(policies: readonly PolicySet[]): PolicySet {
    if (policies.length === 0) {
        return PolicySet.empty();
    }
    const tiers: Partial<Record<Impact, EnforcementTier>> = {};
    const approvals = new Set<Impact>();
    let placement = [...PLACEMENT_PREFERENCE];
    let maxDirectRevocationWindowMs: number | undefined;
    for (const policy of policies) {
        for (const impact of POLICY_IMPACTS) {
            const tier = policy.tierFor(impact);
            if (tier !== undefined && (tiers[impact] === undefined || tier === "mediated")) {
                tiers[impact] = tier;
            }
        }
        for (const impact of policy.approvals) {
            approvals.add(impact);
        }
        placement = placement.filter((mode) => policy.placement.admits(mode));
        if (policy.maxDirectRevocationWindowMs !== undefined) {
            maxDirectRevocationWindowMs =
                maxDirectRevocationWindowMs === undefined
                    ? policy.maxDirectRevocationWindowMs
                    : Math.min(maxDirectRevocationWindowMs, policy.maxDirectRevocationWindowMs);
        }
    }
    let merged: PolicySetInit = {
        tiers,
        approvals: POLICY_IMPACTS.filter((impact) => approvals.has(impact)),
        // The merge answers exactly one question: which modes every policy on the chain
        // still admits. The placement record's other declarations — the trust globs and
        // the §4.7 consumer → backing mapping — are single Blueprint statements with no
        // tightening semantics to merge, so callers that need them read the Blueprint's
        // own PlacementPolicy (definition/validator.ts, composition) rather than this.
        placement: new PlacementPolicy(placement)
    };
    if (maxDirectRevocationWindowMs !== undefined) {
        merged = { ...merged, maxDirectRevocationWindowMs };
    }
    return new PolicySet(merged);
}

function validateDirectRevocationWindow(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    return requireDirectRevocationWindow(value);
}

function requireDirectRevocationWindow(value: number): number {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
        throw new TypeError(
            "Maximum direct revocation window must be a finite non-negative safe integer"
        );
    }
    return value;
}

function decodeOptionalDirectRevocationWindow(
    value: JsonValue | undefined
): Pick<PolicySetInit, "maxDirectRevocationWindowMs"> {
    if (value === null) return {};
    if (!isNumberValue(value)) {
        throw new TypeError("Maximum direct revocation window is invalid");
    }
    return { maxDirectRevocationWindowMs: requireDirectRevocationWindow(value) };
}

function canonicalTiers(tiers: EnforcementTierOverrides): EnforcementTierOverrides {
    const keys = Object.keys(tiers);
    if (keys.some((key) => !isMember(POLICY_IMPACTS, key))) {
        throw new TypeError("Policy tiers contain an unknown impact");
    }
    const canonical: Partial<Record<Impact, EnforcementTier>> = {};
    for (const impact of POLICY_IMPACTS) {
        const tier = tiers[impact];
        if (tier !== undefined) {
            canonical[impact] = requireTier(tier);
        }
    }
    return Object.freeze(canonical);
}

function canonicalApprovals(approvals: readonly Impact[]): readonly Impact[] {
    for (const impact of approvals) {
        requireImpact(impact, "Policy approval impact");
    }
    if (new Set(approvals).size !== approvals.length) {
        throw new TypeError("Policy approval impacts must be unique");
    }
    return Object.freeze(POLICY_IMPACTS.filter((impact) => approvals.includes(impact)));
}

function requireTiers(value: JsonValue | undefined) {
    const object = requireObject(value, "Policy tiers");
    const tiers: Partial<Record<Impact, EnforcementTier>> = {};
    for (const [impact, tier] of Object.entries(object)) {
        tiers[requireImpact(impact, "Policy tier impact")] = requireTier(tier);
    }
    return tiers;
}

function requireImpactArray(value: JsonValue | undefined, subject: string): readonly Impact[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value.map((impact) => requireImpact(impact, subject));
}

function requireImpact(value: JsonValue, subject: string): Impact {
    if (isMember(POLICY_IMPACTS, value)) {
        return value;
    }
    throw new TypeError(`${subject} is invalid`);
}

function requireTier(value: JsonValue): EnforcementTier {
    if (value === "direct" || value === "mediated") {
        return value;
    }
    throw new TypeError("Policy enforcement tier is invalid");
}

function requireMode(value: JsonValue): IsolationMode {
    if (isMember(PLACEMENT_PREFERENCE, value)) {
        return value;
    }
    throw new TypeError("Policy placement is invalid");
}

function isNumberValue(value: JsonValue | undefined): value is number {
    return typeof value === "number";
}

function requireObject(
    value: JsonValue | undefined,
    subject: string
): { readonly [key: string]: JsonValue } {
    if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
    return value;
}

const emptyPolicySet = new PolicySet();
