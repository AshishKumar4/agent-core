// @ts-nocheck
import { RecordCodec, hasExactJsonKeys, type JsonValue } from "../core";
import type { Impact, IsolationMode } from "../facets";
import { PLACEMENT_PREFERENCE, PlacementPolicy } from "./placement";

export type EnforcementTier = "direct" | "mediated";
export type EnforcementTierOverrides = Readonly<Partial<Record<Impact, EnforcementTier>>>;

export const POLICY_IMPACTS: readonly Impact[] = Object.freeze([
    "observe",
    "mutate",
    "externalSend",
    "execute",
    "delegate",
    "administer"
]);

export interface PolicySetInit {
    readonly tiers?: EnforcementTierOverrides;
    readonly approvals?: readonly Impact[];
    readonly placement?: PlacementPolicy;
}

class PolicySetCodec extends RecordCodec<PolicySet> {
    public constructor() {
        super("definition.policy-set", { major: 1, minor: 0 });
    }

    protected encodePayload(policy: PolicySet): JsonValue {
        return policy.toData();
    }

    protected decodePayload(payload: JsonValue): PolicySet {
        return PolicySet.fromData(payload);
    }
}

export class PolicySet {
    public static readonly codec: RecordCodec<PolicySet> = new PolicySetCodec();
    public readonly tiers: EnforcementTierOverrides;
    public readonly approvals: readonly Impact[];
    public readonly placement: PlacementPolicy;

    public constructor(init: PolicySetInit = {}) {
        this.tiers = canonicalTiers(init.tiers ?? {});
        this.approvals = canonicalApprovals(init.approvals ?? []);
        this.placement = init.placement ?? PlacementPolicy.all();
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
        if (!hasExactJsonKeys(object, ["approvals", "placement", "tiers"])) {
            throw new TypeError("Policy set contains missing or unknown fields");
        }
        return new PolicySet({
            tiers: requireTiers(object["tiers"]),
            approvals: requireImpactArray(object["approvals"], "Policy approvals"),
            placement: PlacementPolicy.fromData(object["placement"]!)
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
            placement: this.placement.toData(),
            tiers: this.tiers
        };
    }
}

export interface PolicyEvaluationInput {
    readonly impact: Impact;
    readonly turnOwnedSession: boolean;
    readonly placement: IsolationMode;
    readonly policies?: readonly PolicySet[];
}

export interface PolicyDecision {
    readonly tier: EnforcementTier;
    readonly approvalRequired: boolean;
}

export function enforcementFloor(impact: Impact, turnOwnedSession: boolean): EnforcementTier {
    requireImpact(impact, "Policy impact");
    if (impact === "observe" || (impact === "execute" && turnOwnedSession)) {
        return "direct";
    }
    return "mediated";
}

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyDecision {
    requireMode(input.placement);
    const policy = mergePolicySets(input.policies ?? []);
    const approvalRequired = policy.requiresApproval(input.impact);
    const floor = enforcementFloor(input.impact, input.turnOwnedSession);
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
    }
    return new PolicySet({
        tiers,
        approvals: POLICY_IMPACTS.filter((impact) => approvals.has(impact)),
        placement: new PlacementPolicy(placement)
    });
}

function canonicalTiers(tiers: EnforcementTierOverrides): EnforcementTierOverrides {
    const keys = Object.keys(tiers);
    if (keys.some((key) => !POLICY_IMPACTS.includes(key as Impact))) {
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

function requireTiers(value: JsonValue | undefined): EnforcementTierOverrides {
    const object = requireObject(value, "Policy tiers");
    const tiers: Partial<Record<Impact, EnforcementTier>> = {};
    for (const [impact, tier] of Object.entries(object)) {
        requireImpact(impact, "Policy tier impact");
        tiers[impact as Impact] = requireTier(tier);
    }
    return tiers;
}

function requireImpactArray(value: JsonValue | undefined, subject: string): readonly Impact[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value.map((impact) => requireImpact(impact, subject));
}

function requireImpact(value: unknown, subject: string): Impact {
    if (typeof value === "string" && POLICY_IMPACTS.includes(value as Impact)) {
        return value as Impact;
    }
    throw new TypeError(`${subject} is invalid`);
}

function requireTier(value: unknown): EnforcementTier {
    if (value === "direct" || value === "mediated") {
        return value;
    }
    throw new TypeError("Policy enforcement tier is invalid");
}

function requireMode(value: unknown): IsolationMode {
    if (typeof value === "string" && PLACEMENT_PREFERENCE.includes(value as IsolationMode)) {
        return value as IsolationMode;
    }
    throw new TypeError("Policy placement is invalid");
}

function requireObject(
    value: JsonValue | undefined,
    subject: string
): { readonly [key: string]: JsonValue } {
    if (
        value === undefined ||
        value === null ||
        Array.isArray(value) ||
        typeof value !== "object"
    ) {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

const emptyPolicySet = new PolicySet();
