import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    Digest,
    Revision,
    SecretRef,
    encodeCanonicalJson,
    requireNonempty,
    type JsonObject
} from "../../src/core";
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
    GuestVerificationScheme,
    Membership,
    MembershipId,
    Principal,
    PrincipalId,
    PrincipalRef,
    ProjectId,
    RoleName,
    ScopeRef,
    SubjectRef,
    Team,
    TeamId,
    TenantId,
    Workspace,
    WorkspaceId
} from "../../src/identity";
import { GuestTrust, GuestTrustId, GuestVerification } from "../identity/internal-fixture";
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
 * The sweeps are exhaustive over the cases the decision distinguishes, not random. Deny
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
const GUEST_HOME = new TenantId("tenant-differential-guest-home");
const GUEST = new PrincipalId("principal-differential-guest");
const OTHER_GUEST = new PrincipalId("principal-differential-guest-other");

const TENANT_SCOPE = ScopeRef.tenant(TENANT);
const PROJECT_SCOPE = ScopeRef.project(TENANT, PROJECT);
const TARGET_SCOPE = ScopeRef.workspace(TENANT, PROJECT, WORKSPACE);
const SIBLING_SCOPE = ScopeRef.workspace(TENANT, PROJECT, OTHER_WORKSPACE);

const GUEST_TRUST_KEY = new SecretRef("tenant", "oidc", "differential-guest-key");
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

interface GrantCase {
    readonly label: string;
    readonly id: string;
    readonly scope: ScopeRef;
    readonly subject: SubjectRef;
    readonly effect: "allow" | "deny";
    readonly live: boolean;
    readonly capability: CapabilitySpec;
    readonly attenuationOf?: string;
}

/** Who is asking, and the subjects the resolver has established they act under. */
interface Requester {
    readonly principal: PrincipalRef;
    readonly subject: SubjectRef;
    readonly subjects: readonly SubjectRef[];
    readonly guest: boolean;
}

const HOST: Requester = {
    principal: new PrincipalRef(TENANT, PRINCIPAL),
    subject: SUBJECTS[0].subject,
    subjects: [SUBJECTS[0].subject, SUBJECTS[1].subject],
    guest: false
};

const GUEST_SCHEMES = [GuestVerificationScheme.token, GuestVerificationScheme.callback] as const;

function guestSubject(principal: PrincipalId, scheme: GuestVerificationScheme): SubjectRef {
    return SubjectRef.foreign(GUEST_HOME, principal, scheme);
}

function guestRequester(scheme: GuestVerificationScheme): Requester {
    const subject = guestSubject(GUEST, scheme);
    return {
        principal: new PrincipalRef(GUEST_HOME, GUEST),
        subject,
        subjects: [subject],
        guest: true
    };
}

/**
 * A guest Membership and the trust it was verified against, per foreign subject, so that
 * `guestGrantIsCurrent` admits a role Grant carrying that subject. Without them the guest
 * gates would decide the answer before the precedence the model claims.
 */
const GUEST_MEMBERSHIPS = new Map(
    guestDenySubjects().map((subject, index) => {
        if (subject.kind !== "foreign") throw new Error("Guest fixture subject must be foreign");
        const trust = new GuestTrust(
            new GuestTrustId(`trust-differential-${subject.verifiedVia.value}`),
            TENANT,
            GUEST_HOME,
            subject.verifiedVia.equals(GuestVerificationScheme.token)
                ? { kind: "token", issuer: "https://home.example", key: GUEST_TRUST_KEY }
                : { kind: "callback", endpoint: "https://home.example/verify" },
            "active",
            Revision.initial()
        );
        const membership = new Membership(
            new MembershipId(`membership-differential-${String(index)}`),
            TARGET_SCOPE,
            subject,
            new RoleName("guest"),
            "active",
            Revision.initial(),
            new GuestVerification(
                new PrincipalRef(GUEST_HOME, subject.principalId),
                trust.id,
                trust.revision,
                subject.verifiedVia,
                Digest.sha256(Uint8Array.of(13)),
                new Date(0),
                new Date(10_000)
            )
        );
        return [subjectLabel(subject), { trust, membership }];
    })
);

/** Every foreign subject a competing deny can name: the guest itself, and another guest. */
function guestDenySubjects(): readonly SubjectRef[] {
    return [
        ...GUEST_SCHEMES.map((scheme) => guestSubject(GUEST, scheme)),
        guestSubject(OTHER_GUEST, GuestVerificationScheme.token)
    ];
}

function subjectLabel(subject: SubjectRef): string {
    return subject.kind === "foreign"
        ? `${subject.principalId.value}/${subject.verifiedVia.value}`
        : subject.kind;
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
            for (const backing of backingGrantCases()) {
                for (const other of competingGrantCases()) {
                    const grantCases = [backing, other];
                    const reason = runtimeReason(grantCases, backing.id);
                    const model = await modelDecision(grantCases, backing.id);
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
                    const grantCases: GrantCase[] = [
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
                    const reason = runtimeReason(grantCases, "backing");
                    expect(reason, `deny at ${deny.name} for ${subject.name}`).toBe(
                        await modelDecision(grantCases, "backing")
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
                            const grantCases: GrantCase[] = [
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
                            expect(runtimeReason(grantCases, "backing"), label).toBe(
                                await modelDecision(grantCases, "backing")
                            );
                        }
                    }
                }
            }
        }
    );

    test(
        "[C13-AUTH-DENY-PRECEDENCE] guest deny precedence agrees across verification schemes",
        { tags: "p0", timeout: 300_000 },
        async () => {
            // A guest's `verifiedVia` stamp is part of its subject and §3.3 lets it change,
            // so a deny recorded under one scheme and a request verified under another name
            // one Principal. The deny sweep reads that identity while the allow side keeps
            // the stamp, and this is both sides of that against the model. The competing
            // Grant is enumerated over each stamp of the same guest and over another foreign
            // Principal of the same home Tenant, which is what tells matching on identity
            // apart from matching on nothing.
            for (const scheme of GUEST_SCHEMES) {
                const requester = guestRequester(scheme);
                const backing: GrantCase = {
                    label: `guest backing ${scheme.value}`,
                    id: "backing",
                    scope: TARGET_SCOPE,
                    subject: requester.subject,
                    effect: "allow",
                    live: true,
                    capability: CAPABILITIES[0].spec
                };
                const admitted = runtimeReason([backing], "backing", "observe", requester);
                expect(admitted, scheme.value).toBe(
                    await modelDecision([backing], "backing", "observe", requester)
                );
                expect(admitted, scheme.value).toBe("allowed");

                for (const denySubject of guestDenySubjects()) {
                    const grantCases: GrantCase[] = [
                        backing,
                        {
                            label: `deny for ${subjectLabel(denySubject)}`,
                            id: "other",
                            scope: TENANT_SCOPE,
                            subject: denySubject,
                            effect: "deny",
                            live: true,
                            capability: CAPABILITIES[0].spec
                        }
                    ];
                    const label = `${subjectLabel(denySubject)} against ${scheme.value}`;
                    const reason = runtimeReason(grantCases, "backing", "observe", requester);
                    expect(reason, label).toBe(
                        await modelDecision(grantCases, "backing", "observe", requester)
                    );
                    const sameGuest =
                        denySubject.kind === "foreign" && denySubject.principalId.equals(GUEST);
                    expect(reason, label).toBe(sameGuest ? "matchingDeny" : "allowed");
                }
            }
        }
    );

    test(
        "impact agreement over every impact a capability can carry",
        { tags: "p0", timeout: 300_000 },
        async () => {
            // Host requests only. Guest elevation is not driven here: the implementation
            // refuses a `delegate` or `administer` guest intent through Grant origin
            // provenance as well, which the model does not carry, so an agreement on the
            // reason would not be an agreement about the same refusal. The modeled half is
            // witnessed in Lean by `nonvacuous_authority_guest_elevation_refused`.
            for (const impact of ["observe", "mutate", "delegate", "administer"] as const) {
                for (const requested of ["observe", "delegate"] as const) {
                    const grantCases: GrantCase[] = [
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
                    expect(runtimeReason(grantCases, "backing", requested), label).toBe(
                        await modelDecision(grantCases, "backing", requested)
                    );
                }
            }
        }
    );
});

/** Every case the Binding's own backing Grant can take. */
function backingGrantCases(): readonly GrantCase[] {
    const grantCases: GrantCase[] = [];
    for (const scope of SCOPES) {
        for (const live of [true, false]) {
            for (const capability of CAPABILITIES) {
                grantCases.push({
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
    return grantCases;
}

/** Every case a second Grant in the same plane can take. */
function competingGrantCases(): readonly GrantCase[] {
    const grantCases: GrantCase[] = [];
    for (const scope of SCOPES) {
        for (const effect of ["allow", "deny"] as const) {
            for (const live of [true, false]) {
                for (const subject of SUBJECTS) {
                    for (const capability of CAPABILITIES) {
                        grantCases.push({
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
    return grantCases;
}

function grantOf(grantCase: GrantCase): Grant {
    const guest = GUEST_MEMBERSHIPS.get(subjectLabel(grantCase.subject));
    const grant = new Grant(
        new GrantId(grantCase.id),
        grantCase.scope,
        grantCase.subject,
        grantCase.effect,
        grantCase.capability,
        guest === undefined
            ? { kind: "direct" }
            : {
                  kind: "role",
                  membershipId: guest.membership.id,
                  roleName: guest.membership.role.value,
                  ruleOrdinal: 0,
                  guest: true
              },
        grantCase.attenuationOf === undefined ? undefined : new GrantId(grantCase.attenuationOf)
    );
    return grantCase.live ? grant : grant.revoke();
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
    const guests = [...GUEST_MEMBERSHIPS.values()];
    const memberships = new Map(guests.map(({ membership }) => [membership.id.value, membership]));
    const trusts = new Map(guests.map(({ trust }) => [trust.id.value, trust]));
    return {
        tenantId: TENANT,
        principal: (id: PrincipalId) => principals.get(id.value),
        teams: () => [team],
        workspace: (id: WorkspaceId) =>
            id.equals(WORKSPACE)
                ? new Workspace(WORKSPACE, TENANT, PROJECT, Revision.initial())
                : undefined,
        membership: (id: MembershipId) => memberships.get(id.value),
        guestTrust: (id: GuestTrustId) => trusts.get(id.value),
        binding: (key: string) => (key === binding.key ? binding : undefined),
        grant: (id: GrantId) => byId.get(id.value),
        grants: () => grants,
        epoch: (scope: ScopeRef) => new ScopeEpoch(scope, 1)
    };
}

function bindingOf(backingId: string, requester: Requester): Binding {
    return Binding.active(
        TARGET_SCOPE,
        requester.subject,
        DOMAIN,
        BINDING_NAME,
        new GrantId(backingId),
        FACET
    );
}

function runtimeReason(
    grantCases: readonly GrantCase[],
    backingId: string,
    impact: "observe" | "mutate" | "delegate" | "administer" = "observe",
    requester: Requester = HOST
): string {
    const binding = bindingOf(backingId, requester);
    const grants = grantCases.map(grantOf);
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
            principal: requester.principal,
            binding,
            intent: {
                facet: FACET,
                operation: "read",
                impact,
                arguments: ARGUMENTS,
                argumentsDigest: Digest.sha256(encodeCanonicalJson(ARGUMENTS))
            },
            expectedPath: new PathEpochEvidence(
                requireNonempty(
                    TARGET_SCOPE.path.map((scope) => new ScopeEpoch(scope, 1)),
                    "Target Scope path"
                )
            ),
            invocationDigest: Digest.sha256(Uint8Array.of(3)),
            itemIndex: 0,
            attemptOrdinal: 0,
            nonce: "authority-differential"
        }),
        new Date(1_000)
    );
    // Nothing outside the modeled decision may decide the answer. The guest gates are here
    // because a guest sweep drives them: the store carries the Membership and trust that
    // keep a guest role Grant current, so precedence is what is left to decide.
    expect([
        "missingPrincipal",
        "inactivePrincipal",
        "invalidBinding",
        "stalePath",
        "guestVerificationExpired"
    ]).not.toContain(evidence.reason);
    return evidence.reason;
}

async function modelDecision(
    grantCases: readonly GrantCase[],
    backingId: string,
    impact: "observe" | "mutate" | "delegate" | "administer" = "observe",
    requester: Requester = HOST
): Promise<string> {
    const response = await oracle.ask({
        op: "authority.evaluate",
        grants: grantCases.map(modelGrant),
        request: {
            subjects: requester.subjects.map(modelSubject),
            target: modelScope(TARGET_SCOPE),
            intent: {
                facet: FACET.value,
                operation: "read",
                impact,
                arguments: []
            }
        },
        guest: requester.guest,
        backing: grantNumber(backingId)
    });
    return String(response["decision"]);
}

/** The model's identifiers are numbers; this is the only place the mapping is fixed. */
function grantNumber(id: string): number {
    return id === "backing" ? 1 : id === "other" ? 2 : 3;
}

function modelGrant(grantCase: GrantCase): JsonObject {
    return {
        id: grantNumber(grantCase.id),
        subject: modelSubject(grantCase.subject),
        scope: modelScope(grantCase.scope),
        effect: grantCase.effect,
        capability: {
            facetPattern: grantCase.capability.facetPattern,
            operations: grantCase.capability.operations,
            impacts: grantCase.capability.impacts,
            constraints: []
        },
        attenuationOf: grantCase.attenuationOf === undefined ? null : grantNumber(grantCase.attenuationOf),
        live: grantCase.live
    };
}

function modelSubject(subject: SubjectRef): JsonObject {
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
        principal: identityNumber(subject.principalId.value),
        verifiedVia: subject.verifiedVia.value
    };
}

function modelScope(scope: ScopeRef): JsonObject {
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
    [STRANGER.value, 7],
    [GUEST_HOME.value, 8],
    [GUEST.value, 9],
    [OTHER_GUEST.value, 10]
]);

function identityNumber(value: string): number {
    const mapped = IDENTITY_NUMBERS.get(value);
    if (mapped === undefined) throw new Error(`Unmapped differential identifier ${value}`);
    return mapped;
}
