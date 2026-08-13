import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, encodeCanonicalJson } from "../../src/core";
import {
    AuthorityCheckRequest,
    Binding,
    Grant,
    GrantId,
    PathEpochEvidence,
    ScopeEpoch,
    TenantAuthorityRuntime,
    type AuthorityCheckEvidence,
    type TenantAuthorityReadStore
} from "../../src/authority";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    Principal,
    PrincipalId,
    PrincipalRef,
    ProjectId,
    ScopeRef,
    SubjectRef,
    Team,
    TeamId,
    TenantId,
    Workspace,
    WorkspaceId,
    type GuestTrust,
    type GuestTrustId,
    type Membership,
    type MembershipId
} from "../../src/identity";
import { LeanOracle } from "./oracle";

/*
 * Differential testing of deny precedence and Grant resolution (SPEC §3.3, §3.4) against the
 * verified Lean model.
 *
 * This is not a mirror check. `AgentCore.authority_decision_is_sound` proves that whenever
 * the model answers `allowed`, SPEC §3.3's own condition holds — a live matching allow-Grant
 * reaches the target and no live matching deny-Grant does — with "matching" meaning
 * `Capability.Matches` over the whole infinite intent domain and "reaches" meaning SPEC
 * §3.2's chain relation, both defined independently of the check. Agreement here is
 * therefore agreement with the precedence rule, not with a restatement of
 * `AuthorityRuntime.evaluate`.
 *
 * The sweeps are exhaustive over the shapes the decision distinguishes, not random. Deny
 * precedence is a filter over a conjunction, and random Grants miss on subject or Facet long
 * before effect and Scope are compared — the same masking that once let a capability
 * covering bug survive a passing property suite. So the extra Grant is enumerated over every
 * combination of Scope (three on the Tenant-to-target path plus one off it), effect, live
 * state, subject (the Principal, a Team it belongs to, a stranger), and capability (matching
 * or not), against every combination of the Binding's own backing Grant.
 *
 * The store is synthetic rather than built through `AuthorityMutationService`, because the
 * decision under test must be reachable with a revoked backing Grant, an off-path Scope, and
 * a lineage the mutation service would refuse to create. Everything the runtime reads before
 * precedence — Workspace topology, Principal liveness, Binding canonicality, path epochs —
 * is held valid so that those refusals never fire; the suite asserts that they do not.
 */

const TENANT = new TenantId("tenant-differential");
const PROJECT = new ProjectId("project-differential");
const WORKSPACE = new WorkspaceId("workspace-differential");
const OTHER_WORKSPACE = new WorkspaceId("workspace-differential-sibling");
const PRINCIPAL = new PrincipalId("principal-differential");
const STRANGER = new PrincipalId("principal-differential-stranger");
const TEAM = new TeamId("team-differential");

const TENANT_SCOPE = ScopeRef.tenant(TENANT);
const PROJECT_SCOPE = ScopeRef.project(TENANT, PROJECT);
const TARGET_SCOPE = ScopeRef.workspace(TENANT, PROJECT, WORKSPACE);
const SIBLING_SCOPE = ScopeRef.workspace(TENANT, PROJECT, OTHER_WORKSPACE);

const DOMAIN = new ProtectionDomain("backend", "differential", "no-secrets");
const FACET = new FacetRef("workspace:mail.instance");
const BINDING_NAME = new BindingName("mail");
const ARGUMENTS = { folder: "inbox" } as const;

/** The Scopes a Grant can be issued at: the exact path, plus one Workspace beside it. */
const SCOPES = [
    { name: "tenant", scope: TENANT_SCOPE },
    { name: "project", scope: PROJECT_SCOPE },
    { name: "workspace", scope: TARGET_SCOPE },
    { name: "sibling", scope: SIBLING_SCOPE }
] as const;

const SUBJECTS = [
    { name: "principal", subject: SubjectRef.principal(new PrincipalRef(TENANT, PRINCIPAL)) },
    { name: "team", subject: SubjectRef.team(TEAM) },
    { name: "stranger", subject: SubjectRef.principal(new PrincipalRef(TENANT, STRANGER)) }
] as const;

const CAPABILITIES = [
    {
        name: "matching",
        spec: new CapabilitySpec({ facetPattern: "workspace:*", impacts: ["observe"] })
    },
    { name: "other", spec: new CapabilitySpec({ facetPattern: "other:*", impacts: ["observe"] }) }
] as const;

/** A capability the matching one does not cover, for the widening lineage case. */
const WIDER = new CapabilitySpec({
    facetPattern: "workspace:*",
    impacts: ["observe", "administer"]
});

interface GrantShape {
    readonly label: string;
    readonly id: string;
    readonly scope: ScopeRef;
    readonly subject: SubjectRef;
    readonly effect: "allow" | "deny";
    readonly live: boolean;
    readonly capability: CapabilitySpec;
    readonly attenuationOf?: string;
}

let oracle: LeanOracle;
beforeAll(() => {
    oracle = LeanOracle.start();
}, 900_000);
afterAll(() => {
    oracle?.stop();
});

describe("deny precedence agrees with the verified model", () => {
    test(
        "precedence agreement over every backing and competing Grant shape",
        { tags: "p0", timeout: 900_000 },
        async () => {
            let allowed = 0;
            let denied = 0;
            for (const backing of backingShapes()) {
                for (const other of competingShapes()) {
                    const shapes = [backing, other];
                    const reason = runtimeReason(shapes, backing.id);
                    const model = await modelDecision(shapes, backing.id);
                    expect(reason, `${backing.label} against ${other.label}`).toBe(model);
                    if (reason === "allowed") allowed += 1;
                    if (reason === "matchingDeny") denied += 1;
                }
            }
            // Neither answer may be absent, or the sweep would agree on one verdict only.
            expect(allowed).toBeGreaterThan(0);
            expect(denied).toBeGreaterThan(0);
        }
    );

    test(
        "an ancestor deny defeats a descendant allow at every depth",
        { tags: "p0", timeout: 300_000 },
        async () => {
            // SPEC §3.3: "A descendant allow MUST NOT re-widen an ancestor deny." Enumerated
            // over every Scope on the exact path, for the subject directly and through its
            // Team.
            for (const deny of SCOPES) {
                for (const subject of SUBJECTS) {
                    const shapes: GrantShape[] = [
                        {
                            label: "backing",
                            id: "backing",
                            scope: TARGET_SCOPE,
                            subject: SUBJECTS[0].subject,
                            effect: "allow",
                            live: true,
                            capability: CAPABILITIES[0].spec
                        },
                        {
                            label: `deny at ${deny.name} for ${subject.name}`,
                            id: "deny",
                            scope: deny.scope,
                            subject: subject.subject,
                            effect: "deny",
                            live: true,
                            capability: CAPABILITIES[0].spec
                        }
                    ];
                    const reason = runtimeReason(shapes, "backing");
                    expect(reason, `deny at ${deny.name} for ${subject.name}`).toBe(
                        await modelDecision(shapes, "backing")
                    );
                    const onPath = deny.name !== "sibling";
                    const acting = subject.name !== "stranger";
                    expect(reason, `deny at ${deny.name} for ${subject.name}`).toBe(
                        onPath && acting ? "matchingDeny" : "allowed"
                    );
                }
            }
        }
    );

    test(
        "lineage agreement over every parent shape",
        { tags: "p0", timeout: 300_000 },
        async () => {
            for (const parent of SCOPES) {
                for (const live of [true, false]) {
                    for (const effect of ["allow", "deny"] as const) {
                        for (const capability of [CAPABILITIES[0].spec, WIDER]) {
                            const shapes: GrantShape[] = [
                                {
                                    label: "root",
                                    id: "root",
                                    scope: parent.scope,
                                    subject: SUBJECTS[0].subject,
                                    effect,
                                    live,
                                    capability
                                },
                                {
                                    label: "child",
                                    id: "backing",
                                    scope: TARGET_SCOPE,
                                    subject: SUBJECTS[0].subject,
                                    effect: "allow",
                                    live: true,
                                    capability: CAPABILITIES[0].spec,
                                    attenuationOf: "root"
                                }
                            ];
                            const label = `${parent.name}/${effect}/${live}/${capability.impacts.join("+")}`;
                            expect(runtimeReason(shapes, "backing"), label).toBe(
                                await modelDecision(shapes, "backing")
                            );
                        }
                    }
                }
            }
        }
    );

    test(
        "impact agreement over every impact a capability can carry",
        { tags: "p0", timeout: 300_000 },
        async () => {
            // Guest requests are deliberately absent. The implementation's guest path also
            // consults Grant origin provenance and Membership/GuestTrust verification
            // currency, which the model does not carry, so driving it here would compare
            // against a decision the model does not claim. The modeled half — the elevation
            // prohibition on `delegate` and `administer` — is witnessed in Lean by
            // `nonvacuous_authority_guest_elevation_refused`.
            for (const impact of ["observe", "mutate", "delegate", "administer"] as const) {
                for (const requested of ["observe", "delegate"] as const) {
                    const shapes: GrantShape[] = [
                        {
                            label: `backing ${impact}`,
                            id: "backing",
                            scope: TARGET_SCOPE,
                            subject: SUBJECTS[0].subject,
                            effect: "allow",
                            live: true,
                            capability: new CapabilitySpec({
                                facetPattern: "workspace:*",
                                impacts: [impact]
                            })
                        }
                    ];
                    const label = `${impact} capability against ${requested} intent`;
                    expect(runtimeReason(shapes, "backing", requested), label).toBe(
                        await modelDecision(shapes, "backing", requested)
                    );
                }
            }
        }
    );
});

/** Every shape the Binding's own backing Grant can take. */
function backingShapes(): readonly GrantShape[] {
    const shapes: GrantShape[] = [];
    for (const scope of SCOPES) {
        for (const live of [true, false]) {
            for (const capability of CAPABILITIES) {
                shapes.push({
                    label: `backing ${scope.name}/${live ? "live" : "revoked"}/${capability.name}`,
                    id: "backing",
                    scope: scope.scope,
                    subject: SUBJECTS[0].subject,
                    effect: "allow",
                    live,
                    capability: capability.spec
                });
            }
        }
    }
    return shapes;
}

/** Every shape a second Grant in the same plane can take. */
function competingShapes(): readonly GrantShape[] {
    const shapes: GrantShape[] = [];
    for (const scope of SCOPES) {
        for (const effect of ["allow", "deny"] as const) {
            for (const live of [true, false]) {
                for (const subject of SUBJECTS) {
                    for (const capability of CAPABILITIES) {
                        shapes.push({
                            label:
                                `other ${scope.name}/${effect}/${live ? "live" : "revoked"}/` +
                                `${subject.name}/${capability.name}`,
                            id: "other",
                            scope: scope.scope,
                            subject: subject.subject,
                            effect,
                            live,
                            capability: capability.spec
                        });
                    }
                }
            }
        }
    }
    return shapes;
}

function grantOf(shape: GrantShape): Grant {
    const grant = new Grant(
        new GrantId(shape.id),
        shape.scope,
        shape.subject,
        shape.effect,
        shape.capability,
        { kind: "direct" },
        shape.attenuationOf === undefined ? undefined : new GrantId(shape.attenuationOf)
    );
    return shape.live ? grant : grant.revoke();
}

/**
 * A read store carrying exactly the Grants under test. Everything the runtime consults
 * before precedence is valid, so the only refusals reachable are the ones the model decides.
 */
function storeOf(grants: readonly Grant[], binding: Binding): TenantAuthorityReadStore {
    const byId = new Map(grants.map((grant) => [grant.id.value, grant]));
    const team = new Team(TEAM, TENANT, "Differential", [PRINCIPAL], Revision.initial());
    const principals = new Map([
        [PRINCIPAL.value, new Principal(PRINCIPAL, "user", "active")],
        [STRANGER.value, new Principal(STRANGER, "user", "active")]
    ]);
    return {
        tenantId: TENANT,
        principal: (id: PrincipalId) => principals.get(id.value),
        teams: () => [team],
        workspace: (id: WorkspaceId) =>
            id.equals(WORKSPACE)
                ? new Workspace(WORKSPACE, TENANT, PROJECT, Revision.initial())
                : undefined,
        membership: (_id: MembershipId): Membership | undefined => undefined,
        guestTrust: (_id: GuestTrustId): GuestTrust | undefined => undefined,
        binding: (key: string) => (key === binding.key ? binding : undefined),
        grant: (id: GrantId) => byId.get(id.value),
        grants: () => grants,
        epoch: (scope: ScopeRef) => new ScopeEpoch(scope, 1)
    };
}

function bindingOf(backingId: string): Binding {
    return Binding.active(
        TARGET_SCOPE,
        SUBJECTS[0].subject,
        DOMAIN,
        BINDING_NAME,
        new GrantId(backingId),
        FACET
    );
}

function runtimeReason(
    shapes: readonly GrantShape[],
    backingId: string,
    impact: "observe" | "mutate" | "delegate" | "administer" = "observe"
): string {
    const binding = bindingOf(backingId);
    const grants = shapes.map(grantOf);
    const store = storeOf(grants, binding);
    const runtime = new TenantAuthorityRuntime(
        store,
        new ActorRef("tenant", new ActorId("tenant-actor"))
    );
    const evidence: AuthorityCheckEvidence = runtime.check(
        new AuthorityCheckRequest({
            ownerTenant: TENANT,
            owner: new ActorRef("workspace", new ActorId("workspace-actor")),
            ownerFence: 1,
            principal: new PrincipalRef(TENANT, PRINCIPAL),
            binding,
            intent: {
                facet: FACET,
                operation: "read",
                impact,
                arguments: ARGUMENTS,
                argumentsDigest: Digest.sha256(encodeCanonicalJson(ARGUMENTS))
            },
            expectedPath: new PathEpochEvidence(
                TARGET_SCOPE.path.map((scope) => new ScopeEpoch(scope, 1)) as [
                    ScopeEpoch,
                    ...ScopeEpoch[]
                ]
            ),
            invocationDigest: Digest.sha256(Uint8Array.of(3)),
            itemIndex: 0,
            attemptOrdinal: 0,
            nonce: "authority-differential"
        }),
        new Date(1_000)
    );
    // Nothing outside the modeled decision may decide the answer.
    expect(["missingPrincipal", "inactivePrincipal", "invalidBinding", "stalePath"]).not.toContain(
        evidence.reason
    );
    return evidence.reason;
}

async function modelDecision(
    shapes: readonly GrantShape[],
    backingId: string,
    impact: "observe" | "mutate" | "delegate" | "administer" = "observe"
): Promise<string> {
    const response = await oracle.ask({
        op: "authority.evaluate",
        grants: shapes.map(modelGrant),
        request: {
            subjects: [modelSubject(SUBJECTS[0].subject), modelSubject(SUBJECTS[1].subject)],
            target: modelScope(TARGET_SCOPE),
            intent: {
                facet: FACET.value,
                operation: "read",
                impact,
                arguments: []
            }
        },
        guest: false,
        backing: grantNumber(backingId)
    });
    return String(response["decision"]);
}

/** The model's identifiers are numbers; this is the only place the mapping is fixed. */
function grantNumber(id: string): number {
    return id === "backing" ? 1 : id === "other" ? 2 : 3;
}

function modelGrant(shape: GrantShape): Record<string, unknown> {
    return {
        id: grantNumber(shape.id),
        subject: modelSubject(shape.subject),
        scope: modelScope(shape.scope),
        effect: shape.effect,
        capability: {
            facetPattern: shape.capability.facetPattern,
            operations: shape.capability.operations,
            impacts: shape.capability.impacts,
            constraints: []
        },
        attenuationOf: shape.attenuationOf === undefined ? null : grantNumber(shape.attenuationOf),
        live: shape.live
    };
}

function modelSubject(subject: SubjectRef): Record<string, unknown> {
    if (subject.kind === "principal") {
        return {
            kind: "principal",
            tenant: identityNumber(subject.principal.tenantId.value),
            principal: identityNumber(subject.principal.principalId.value)
        };
    }
    if (subject.kind === "team") {
        return { kind: "team", team: identityNumber(subject.teamId.value) };
    }
    return {
        kind: "foreign",
        homeTenant: identityNumber(subject.homeTenant.value),
        principal: identityNumber(subject.principalId.value)
    };
}

function modelScope(scope: ScopeRef): Record<string, unknown> {
    if (scope.kind === "tenant") {
        return { kind: "tenant", tenant: identityNumber(scope.tenantId.value) };
    }
    if (scope.kind === "project") {
        return {
            kind: "project",
            tenant: identityNumber(scope.tenantId.value),
            project: identityNumber(scope.projectId!.value)
        };
    }
    return {
        kind: "workspace",
        tenant: identityNumber(scope.tenantId.value),
        project: scope.projectId === undefined ? null : identityNumber(scope.projectId.value),
        workspace: identityNumber(scope.workspaceId!.value)
    };
}

/**
 * The model's identities are natural numbers and the implementation's are text, so the
 * harness fixes one injective mapping. Distinct text must map to distinct numbers or the
 * comparison would be against a coarser model than the implementation runs; the table is
 * closed over exactly the identifiers this suite uses and throws on anything else.
 */
const IDENTITY_NUMBERS = new Map<string, number>([
    [TENANT.value, 1],
    [PROJECT.value, 2],
    [WORKSPACE.value, 3],
    [OTHER_WORKSPACE.value, 4],
    [PRINCIPAL.value, 5],
    [TEAM.value, 6],
    [STRANGER.value, 7]
]);

function identityNumber(value: string): number {
    const mapped = IDENTITY_NUMBERS.get(value);
    if (mapped === undefined) throw new Error(`Unmapped differential identifier ${value}`);
    return mapped;
}
