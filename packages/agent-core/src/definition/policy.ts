import { RecordCodec, hasExactJsonKeys, isJsonObject, isMember, type JsonValue } from "../core";
import { enforcementFloor, type EnforcementTier, type Impact, type IsolationMode } from "../facets";
import { PLACEMENT_PREFERENCE, PlacementPolicy } from "./placement";

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

export interface PolicySetInit {
    readonly tiers?: EnforcementTierOverrides;
    readonly approvals?: readonly Impact[];
    readonly placement?: PlacementPolicy;
    readonly maxDirectRevocationWindowMs?: number;
}

class PolicySetCodec extends RecordCodec<PolicySet> {
    public constructor() {
        super("definition.policy-set", { major: 2, minor: 0 });
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
    public readonly maxDirectRevocationWindowMs: number | undefined;

    public constructor(init: PolicySetInit = {}) {
        this.tiers = canonicalTiers(init.tiers ?? {});
        this.approvals = canonicalApprovals(init.approvals ?? []);
        this.placement = init.placement ?? PlacementPolicy.all();
        this.maxDirectRevocationWindowMs = validateDirectRevocationWindow(
            init.maxDirectRevocationWindowMs
        );
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
                "tiers"
            ])
        ) {
            throw new TypeError("Policy set contains missing or unknown fields");
        }
        return new PolicySet({
            tiers: requireTiers(object["tiers"]),
            approvals: requireImpactArray(object["approvals"], "Policy approvals"),
            ...decodeOptionalDirectRevocationWindow(object["maxDirectRevocationWindowMs"]),
            placement: PlacementPolicy.fromData(object["placement"])
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
            tiers: this.tiers
        };
    }
}

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
    return new PolicySet({
        tiers,
        approvals: POLICY_IMPACTS.filter((impact) => approvals.has(impact)),
        ...(maxDirectRevocationWindowMs === undefined ? {} : { maxDirectRevocationWindowMs }),
        placement: new PlacementPolicy(placement)
    });
}

function validateDirectRevocationWindow(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
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
    if (typeof value !== "number") {
        throw new TypeError("Maximum direct revocation window is invalid");
    }
    return { maxDirectRevocationWindowMs: validateDirectRevocationWindow(value)! };
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
    if (isMember(POLICY_IMPACTS, value)) {
        return value;
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
    if (isMember(PLACEMENT_PREFERENCE, value)) {
        return value;
    }
    throw new TypeError("Policy placement is invalid");
}

function requireObject(
    value: JsonValue | undefined,
    subject: string
): { readonly [key: string]: JsonValue } {
    if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
    return value;
}

const emptyPolicySet = new PolicySet();
