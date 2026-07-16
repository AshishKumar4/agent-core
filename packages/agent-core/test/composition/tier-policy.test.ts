import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { TurnId, TurnLease } from "../../src/agents";
import {
    Binding,
    GrantId,
    InvalidationWatermark,
    PathEpochEvidence,
    ScopeEpoch
} from "../../src/authority";
import {
    TenantOperationAuthority,
    type OperationAuthorityStatePort,
    type OperationResolutionState
} from "../../src/composition";
import { Digest, JsonSchema, SemVer } from "../../src/core";
import {
    PackageId,
    PackagePin,
    PolicySet,
    evaluatePolicy,
    type EnforcementTier
} from "../../src/definition";
import {
    BindingName,
    FacetRef,
    OperationDescriptor,
    OperationName,
    ProtectionDomain,
    type Impact,
    type IsolationMode
} from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { InvocationPlacementPin } from "../../src/invocations";
import { RouteReservationId } from "../../src/interaction-references";

const tenant = new TenantId("tier-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("tier-principal"));
const owner = new ActorRef("workspace", new ActorId("tier-owner"));
const tenantScope = ScopeRef.tenant(tenant);
const scope = ScopeRef.workspace(tenant, new WorkspaceId("tier-workspace"));
const facet = new FacetRef("workspace:tier-target");
const bindingName = new BindingName("tier-target");
const domain = new ProtectionDomain("backend", "tier-domain", "may-hold-secrets");
const binding = Binding.active(
    scope,
    SubjectRef.principal(principal.principalId),
    domain,
    bindingName,
    new GrantId("tier-grant"),
    facet
);
const path = new PathEpochEvidence([ScopeEpoch.initial(tenantScope), ScopeEpoch.initial(scope)]);
const digest = new Digest("b".repeat(64));
const pin = new PackagePin(new PackageId("tier-package"), new SemVer("1.0.0"), digest, digest);
const lease = TurnLease.restore(new TurnId("tier-turn"), principal.principalId, 1, new Date(100));
const leaseToken = { turn: lease.turn, holder: principal.principalId, epoch: lease.epoch };

const IMPACTS: readonly Impact[] = [
    "observe",
    "mutate",
    "externalSend",
    "execute",
    "delegate",
    "administer"
];
const PLACEMENTS: readonly IsolationMode[] = ["bundled", "provider", "dynamic"];
const schema = new JsonSchema({});

function placementPin(selected: IsolationMode): InvocationPlacementPin {
    return new InvocationPlacementPin({
        manifest: [selected],
        policy: [selected],
        substrate: [selected],
        trust: [selected],
        selected
    });
}

function resolution(init: {
    readonly turnOwned: boolean;
    readonly sessionOwned?: boolean;
    readonly placement: IsolationMode;
    readonly policies: readonly PolicySet[];
}): OperationResolutionState {
    return {
        principal,
        binding,
        pathEpochs: path,
        watermark: InvalidationWatermark.empty(tenant, owner, principal),
        lease: init.turnOwned ? leaseToken : undefined,
        originalLease: init.turnOwned ? lease : undefined,
        ...(init.turnOwned ? {} : { route: new RouteReservationId("tier-route") }),
        package: pin,
        placement: placementPin(init.placement),
        resolvedAt: new Date(0),
        deadline: new Date(50),
        owner,
        policies: init.policies,
        turnOwnedSession: init.sessionOwned ?? init.turnOwned
    };
}

function descriptorFor(impact: Impact): OperationDescriptor {
    return new OperationDescriptor(new OperationName("op"), impact, schema, schema);
}

// tier() never consults the state port, so the port is unused here.
const unusedState: OperationAuthorityStatePort<PrincipalRef> = new Proxy(
    {} as OperationAuthorityStatePort<PrincipalRef>,
    {
        get() {
            throw new Error("tier() must not touch the authority state port");
        }
    }
);
const authority = new TenantOperationAuthority(unusedState, () => new Date(10));

describe("runtime enforcement tier is the single evaluatePolicy call site", () => {
    test("workspace policy raising observe to mediated is honored on a bundled leased facet", () => {
        const policies = [new PolicySet({ tiers: { observe: "mediated" } })];
        const resolved = resolution({ turnOwned: true, placement: "bundled", policies });
        expect(authority.tier(resolved, descriptorFor("observe"), false)).toBe("mediated");
    });

    test("approvals covering observe and execute force mediated on a bundled leased facet", () => {
        for (const impact of ["observe", "execute"] as const) {
            const policies = [new PolicySet({ approvals: [impact] })];
            const resolved = resolution({ turnOwned: true, placement: "bundled", policies });
            const decision = evaluatePolicy({
                impact,
                turnOwnedSession: true,
                placement: "bundled",
                policies
            });
            expect(decision.approvalRequired).toBe(true);
            expect(authority.tier(resolved, descriptorFor(impact), false)).toBe("mediated");
        }
    });

    test("execute without a turn-owned session is mediated, not direct", () => {
        const resolved = resolution({ turnOwned: false, placement: "bundled", policies: [] });
        expect(authority.tier(resolved, descriptorFor("execute"), false)).toBe("mediated");
    });

    test("execute with a turn-owned bundled session is direct absent tightening", () => {
        const resolved = resolution({ turnOwned: true, placement: "bundled", policies: [] });
        expect(authority.tier(resolved, descriptorFor("execute"), false)).toBe("direct");
    });

    test("a live lease alone does not make execute session-scoped", () => {
        const resolved = resolution({
            turnOwned: true,
            sessionOwned: false,
            placement: "bundled",
            policies: []
        });
        expect(authority.tier(resolved, descriptorFor("execute"), false)).toBe("mediated");
    });

    test("interceptors force mediated regardless of policy", () => {
        const resolved = resolution({ turnOwned: true, placement: "bundled", policies: [] });
        expect(authority.tier(resolved, descriptorFor("observe"), true)).toBe("mediated");
    });

    test("tier decision equals evaluatePolicy over the full policy matrix", () => {
        const policySets: readonly (readonly PolicySet[])[] = [
            [],
            [new PolicySet({ tiers: { observe: "mediated", execute: "mediated" } })],
            [new PolicySet({ tiers: { mutate: "direct" } })],
            [new PolicySet({ approvals: ["observe", "execute", "mutate"] })],
            [
                new PolicySet({ tiers: { execute: "mediated" } }),
                new PolicySet({ approvals: ["observe"] })
            ]
        ];
        for (const impact of IMPACTS) {
            for (const placement of PLACEMENTS) {
                for (const turnOwned of [true, false]) {
                    for (const sessionOwned of [true, false]) {
                    for (const policies of policySets) {
                        const resolved = resolution({
                            turnOwned,
                            sessionOwned,
                            placement,
                            policies
                        });
                        const decision = evaluatePolicy({
                            impact,
                            turnOwnedSession: sessionOwned,
                            placement,
                            policies
                        });
                        const gatewayTier: EnforcementTier = authority.tier(
                            resolved,
                            descriptorFor(impact),
                            false
                        );
                        expect(gatewayTier).toBe(decision.tier);
                        if (decision.approvalRequired) {
                            expect(gatewayTier).toBe("mediated");
                        }
                    }
                    }
                }
            }
        }
    });
});
