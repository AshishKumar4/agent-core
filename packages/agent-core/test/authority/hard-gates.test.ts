import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    GuestVerificationScheme,
    Membership,
    MembershipId,
    PrincipalId,
    ProjectId,
    Role,
    RoleName,
    RoleRule,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { PrincipalRef } from "../identity/internal-fixture";
import { Binding, decodeDomain } from "../../src/authority/binding";
import {
    BindingValidationEvidence,
    BindingValidationRequest
} from "../../src/authority/binding-evidence";
import { AuthorityCheckEvidence, AuthorityCheckRequest } from "../../src/authority/evidence";
import { InvalidationWatermark, PathEpochEvidence, ScopeEpoch } from "../../src/authority/epoch";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { RoleGrantMaterializer } from "../../src/authority/materializer";
import { EpochPlanner } from "../../src/authority/planner";

const tenantId = new TenantId("authority-hard-tenant");
const otherTenant = new TenantId("authority-hard-other");
const principalId = new PrincipalId("authority-hard-principal");
const workspaceScope = ScopeRef.workspace(tenantId, new WorkspaceId("authority-hard-workspace"));
const tenantScope = ScopeRef.tenant(tenantId);
const projectScope = ScopeRef.project(tenantId, new ProjectId("authority-hard-project"));
const owner = new ActorRef("workspace", new ActorId("authority-hard-owner"));
const issuer = new ActorRef("tenant", new ActorId("authority-hard-issuer"));
const principal = new PrincipalRef(tenantId, principalId);
const domain = new ProtectionDomain("backend", "hard", "no-secrets");
const facet = new FacetRef("workspace:hard.facet");
const grantId = new GrantId("authority-hard-grant");
const binding = Binding.active(
    workspaceScope,
    SubjectRef.principal(principalId),
    domain,
    new BindingName("hard-binding"),
    grantId,
    facet
);
const path = new PathEpochEvidence([
    new ScopeEpoch(tenantScope, 1),
    new ScopeEpoch(workspaceScope, 2)
]);
const args = { value: "ok" } as const;
const argsDigest = Digest.sha256(encodeCanonicalJson(args));

describe("canonical capability hard gates", () => {
    test("[C13-AUTH-DENY-PATH] [authority.capability-spec] covers matching, narrowing, wildcards, and argument paths", () => {
        const parent = new CapabilitySpec({
            facetPattern: "workspace:mail.*",
            operations: ["send"],
            impacts: ["observe", "mutate"],
            argumentConstraints: { "message.channel": "internal" }
        });
        const child = new CapabilitySpec({
            facetPattern: "workspace:mail.instance",
            operations: ["send"],
            impacts: ["observe"],
            argumentConstraints: { "message.channel": "internal", folder: "inbox" }
        });
        expect(parent.covers(child)).toBe(true);
        expect(child.covers(parent)).toBe(false);
        expect(
            parent.matches({
                facet: "workspace:mail.instance",
                operation: "send",
                impact: "mutate",
                arguments: { message: { channel: "internal" } }
            })
        ).toBe(true);
        expect(
            parent.matches({
                facet: "other",
                operation: "read",
                impact: "observe",
                arguments: {}
            })
        ).toBe(false);
        expect(parent.grantsElevation()).toBe(false);
        expect(parent.equals(CapabilitySpec.decode(CapabilitySpec.encode(parent)))).toBe(true);
        expect(
            new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] }).covers(
                new CapabilitySpec({ facetPattern: "workspace:mail.sub.*", impacts: ["observe"] })
            )
        ).toBe(true);
        const constrained = new CapabilitySpec({
            facetPattern: "*",
            impacts: ["observe"],
            argumentConstraints: { "nested.value": true }
        });
        for (const nested of [null, [], "text", {}] as const) {
            expect(
                constrained.matches({
                    facet: "anything",
                    operation: "read",
                    impact: "observe",
                    arguments: { nested }
                })
            ).toBe(false);
        }
    });

    test("strictly rejects malformed capability shapes", () => {
        expect(() =>
            CapabilitySpec.fromData({
                facetPattern: "*",
                impacts: ["observe"]
            })
        ).toThrow(TypeError);
        expect(() =>
            CapabilitySpec.fromData({
                argumentConstraints: {},
                facetPattern: 3,
                impacts: ["observe"],
                operations: []
            })
        ).toThrow(TypeError);
        expect(() =>
            CapabilitySpec.fromData({
                argumentConstraints: {},
                facetPattern: "*",
                impacts: [],
                operations: []
            })
        ).toThrow(TypeError);
        expect(() => new CapabilitySpec({ facetPattern: "bad [", impacts: ["observe"] })).toThrow(
            TypeError
        );
        expect(
            () => new CapabilitySpec({ facetPattern: "*", operations: [""], impacts: ["observe"] })
        ).toThrow(TypeError);
        expect(() => new CapabilitySpec({ facetPattern: "*", impacts: [] as never })).toThrow(
            TypeError
        );
        expect(
            () => new CapabilitySpec({ facetPattern: "*", impacts: ["observe", "observe"] })
        ).toThrow(TypeError);
        expect(
            () =>
                new CapabilitySpec({
                    facetPattern: "*",
                    impacts: ["observe"],
                    argumentConstraints: { "bad.path!": true }
                })
        ).toThrow(TypeError);
        expect(() =>
            CapabilitySpec.fromData({
                argumentConstraints: {},
                facetPattern: "*",
                impacts: [],
                operations: []
            })
        ).toThrow(TypeError);
        expect(() =>
            CapabilitySpec.fromData({
                argumentConstraints: {},
                facetPattern: "*",
                impacts: [3],
                operations: []
            })
        ).toThrow(TypeError);
        expect(() =>
            CapabilitySpec.fromData({
                argumentConstraints: {},
                facetPattern: "*",
                impacts: ["unknown"],
                operations: [3]
            })
        ).toThrow(TypeError);
    });
});

describe("Grant and authority identifier hard gates", () => {
    test("defensively freezes caller-provided subject references", () => {
        const mutable = {
            kind: "principal" as const,
            principalId: new PrincipalId("mutable-principal")
        };
        const member = new Membership(
            new MembershipId("mutable-member"),
            workspaceScope,
            mutable,
            new RoleName("reader"),
            "active",
            Revision.initial()
        );
        const grant = new Grant(
            new GrantId("mutable-grant"),
            workspaceScope,
            mutable,
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
            { kind: "direct" }
        );
        const bound = Binding.active(
            workspaceScope,
            mutable,
            domain,
            new BindingName("mutable"),
            grant.id,
            facet
        );
        mutable.principalId = new PrincipalId("changed-principal");
        expect(member.subject.kind === "principal" && member.subject.principalId.value).toBe(
            "mutable-principal"
        );
        expect(grant.subject.kind === "principal" && grant.subject.principalId.value).toBe(
            "mutable-principal"
        );
        expect(bound.subject.kind === "principal" && bound.subject.principalId.value).toBe(
            "mutable-principal"
        );
    });

    test("strictly validates Grant construction and replacement", () => {
        expect(
            () =>
                new Grant(
                    new GrantId("bad-effect"),
                    workspaceScope,
                    binding.subject,
                    "bad" as never,
                    new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                    { kind: "direct" }
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new Grant(
                    new GrantId("overlength-origin"),
                    workspaceScope,
                    binding.subject,
                    "allow",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                    {
                        kind: "role",
                        membershipId: "x".repeat(257) as never,
                        roleName: "reader",
                        ruleOrdinal: 0,
                        guest: false
                    }
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new Grant(
                    new GrantId("deny-child"),
                    workspaceScope,
                    binding.subject,
                    "deny",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                    { kind: "direct" },
                    grantId
                )
        ).toThrow(TypeError);
        const direct = Grant.create({
            id: grantId,
            scope: workspaceScope,
            subject: binding.subject,
            effect: "allow",
            capability: new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
            origin: { kind: "direct" }
        });
        expect(() =>
            direct.assertCanReplace(
                new Grant(
                    direct.id,
                    tenantScope,
                    direct.subject,
                    direct.effect,
                    direct.capability,
                    direct.origin
                )
            )
        ).toThrow(AgentCoreError);
        expect(() =>
            direct.assertCanReplace(
                new Grant(
                    direct.id,
                    direct.scope,
                    direct.subject,
                    direct.effect,
                    new CapabilitySpec({ facetPattern: "*", impacts: ["administer"] }),
                    direct.origin
                )
            )
        ).toThrow(AgentCoreError);
        expect(() => direct.revoke().assertCanReplace(direct)).toThrow(AgentCoreError);
    });

    test("strictly validates Grant codec origin, effect, state, and attenuation", () => {
        const grant = new Grant(
            grantId,
            workspaceScope,
            binding.subject,
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
            { kind: "direct" }
        );
        for (const mutate of [
            (payload: Record<string, JsonValue>) => ({ ...payload, attenuationOf: 3 }),
            (payload: Record<string, JsonValue>) => ({ ...payload, effect: "unknown" }),
            (payload: Record<string, JsonValue>) => ({ ...payload, state: "unknown" }),
            (payload: Record<string, JsonValue>) => ({
                ...payload,
                origin: {
                    kind: "role",
                    guest: false,
                    membershipId: "",
                    roleName: "x",
                    ruleOrdinal: -1
                }
            }),
            (payload: Record<string, JsonValue>) => ({ ...payload, origin: { kind: "unknown" } })
        ])
            expectRecordMutationFailure(Grant.codec, grant, mutate);
    });

    test("validates deterministic role Grant identifiers", () => {
        expect(GrantId.forRole("membership", 0).value).toMatch(/^role:/);
        expect(() => GrantId.forRole("membership", -1)).toThrow(TypeError);
        expect(() => GrantId.forRole("", 0)).toThrow(TypeError);
        expect(() => GrantId.forRole("x".repeat(257), 0)).toThrow(TypeError);
        expect(new FacetRef("workspace:facet").value).toBe("workspace:facet");
        for (const invalid of [
            "facet",
            ":facet",
            "workspace:",
            "workspace:facet:extra",
            "Workspace:facet",
            "workspace:facet_name",
            "workspace:-facet"
        ]) {
            expect(() => new FacetRef(invalid)).toThrow(/<scope>:<instance>/);
        }
    });
});

describe("Binding and epoch hard gates", () => {
    test("uses behavior-carrying Binding transitions", () => {
        const inactive = binding.deactivate();
        expect(inactive.deactivate()).toBe(inactive);
        expect(
            inactive.replace(new GrantId("next"), new FacetRef("workspace:next.facet")).state
        ).toBe("active");
        expect(
            () =>
                new Binding(
                    tenantScope,
                    binding.subject,
                    domain,
                    binding.name,
                    binding.grantId,
                    binding.facet,
                    0,
                    "active",
                    Revision.initial()
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new Binding(
                    workspaceScope,
                    binding.subject,
                    domain,
                    binding.name,
                    binding.grantId,
                    binding.facet,
                    -1,
                    "active",
                    Revision.initial()
                )
        ).toThrow(TypeError);
        const exhausted = new Binding(
            workspaceScope,
            binding.subject,
            domain,
            binding.name,
            binding.grantId,
            binding.facet,
            Number.MAX_SAFE_INTEGER,
            "active",
            new Revision(Number.MAX_SAFE_INTEGER)
        );
        expectAgentError(
            () => exhausted.replace(binding.grantId, binding.facet),
            "binding.invalid"
        );
        expectAgentError(
            () =>
                new Binding(
                    workspaceScope,
                    binding.subject,
                    domain,
                    binding.name,
                    binding.grantId,
                    binding.facet,
                    0,
                    "active",
                    new Revision(Number.MAX_SAFE_INTEGER)
                ).replace(binding.grantId, binding.facet),
            "binding.invalid"
        );
    });

    test("strictly decodes Binding domains and states", () => {
        expect(() =>
            decodeDomain({ kind: "unknown", label: "x", secretPolicy: "no-secrets" })
        ).toThrow(TypeError);
        expect(() =>
            decodeDomain({ kind: "backend", label: "x", secretPolicy: "unknown" })
        ).toThrow(TypeError);
        expectRecordMutationFailure(Binding.codec, binding, (payload) => ({
            ...payload,
            state: "unknown"
        }));
    });

    test("[C13-AUTH-DIRECT-WATERMARK] enforces exact path and watermark invariants", () => {
        expect(() => new ScopeEpoch(tenantScope, -1)).toThrow(TypeError);
        expectAgentError(
            () => new ScopeEpoch(tenantScope, Number.MAX_SAFE_INTEGER).next(),
            "protocol.invalid-state"
        );
        expect(() => new PathEpochEvidence([] as never)).toThrow(TypeError);
        expect(() => new PathEpochEvidence([new ScopeEpoch(projectScope, 1)])).toThrow(TypeError);
        expect(
            () =>
                new PathEpochEvidence([
                    new ScopeEpoch(tenantScope, 1),
                    new ScopeEpoch(projectScope, 1),
                    new ScopeEpoch(
                        ScopeRef.workspace(
                            tenantId,
                            new ProjectId("different-project"),
                            workspaceScope.workspaceId!
                        ),
                        1
                    )
                ])
        ).toThrow(TypeError);
        expect(
            () =>
                new PathEpochEvidence([
                    new ScopeEpoch(tenantScope, 1),
                    new ScopeEpoch(ScopeRef.workspace(otherTenant, new WorkspaceId("foreign")), 1)
                ])
        ).toThrow(TypeError);
        expect(
            () =>
                new PathEpochEvidence([
                    new ScopeEpoch(tenantScope, 1),
                    new ScopeEpoch(projectScope, 1),
                    new ScopeEpoch(workspaceScope, 1)
                ])
        ).toThrow(TypeError);
        expectRecordMutationFailure(PathEpochEvidence.codec, path, (payload) => ({
            ...payload,
            path: []
        }));
        expect(
            () =>
                new PathEpochEvidence([
                    new ScopeEpoch(tenantScope, 1),
                    new ScopeEpoch(tenantScope, 1)
                ])
        ).toThrow(TypeError);
        expect(
            path
                .staleScopes(new PathEpochEvidence([new ScopeEpoch(tenantScope, 1)]))
                .map((scope) => scope.kind)
        ).toEqual(["tenant"]);

        const watermark = InvalidationWatermark.empty(tenantId, owner, principal);
        expect(
            () =>
                new InvalidationWatermark(
                    tenantId,
                    owner,
                    principal,
                    [new ScopeEpoch(tenantScope, 1), new ScopeEpoch(tenantScope, 2)],
                    Revision.initial()
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new InvalidationWatermark(
                    tenantId,
                    owner,
                    principal,
                    [new ScopeEpoch(ScopeRef.tenant(otherTenant), 1)],
                    Revision.initial()
                )
        ).toThrow(TypeError);
        expectAgentError(
            () => watermark.join([new ScopeEpoch(ScopeRef.tenant(otherTenant), 1)]),
            "protocol.invalid-state"
        );
        expect(
            watermark.dominates(
                InvalidationWatermark.empty(
                    tenantId,
                    new ActorRef("workspace", new ActorId("other")),
                    principal
                )
            )
        ).toBe(false);
        expectRecordMutationFailure(InvalidationWatermark.codec, watermark, (payload) => ({
            ...payload,
            owner: { id: "owner", kind: "unknown" }
        }));
        expectAgentError(
            () =>
                new InvalidationWatermark(
                    tenantId,
                    owner,
                    principal,
                    [],
                    new Revision(Number.MAX_SAFE_INTEGER)
                ).join([new ScopeEpoch(tenantScope, 1)]),
            "protocol.invalid-state"
        );
    });
});

describe("typed authority evidence hard gates", () => {
    test("gives requests uniform static codecs", () => {
        const request = checkRequest();
        expect(
            AuthorityCheckRequest.decode(AuthorityCheckRequest.encode(request))
                .digest()
                .equals(request.digest())
        ).toBe(true);
        const validation = validationRequest();
        expect(
            BindingValidationRequest.decode(BindingValidationRequest.encode(validation))
                .digest()
                .equals(validation.digest())
        ).toBe(true);
        for (const kind of ["tenant", "run", "environment", "slate"] as const) {
            expectRecordMutationFailure(BindingValidationRequest.codec, validation, (payload) => ({
                ...payload,
                workspaceActor: { id: "alternate", kind }
            }));
        }
        expectRecordMutationFailure(BindingValidationRequest.codec, validation, (payload) => ({
            ...payload,
            workspaceActor: { id: "alternate", kind: "unknown" }
        }));
    });

    test("rejects malformed operational identity before evidence issuance", () => {
        const base = checkInit();
        expect(() => new AuthorityCheckRequest({ ...base, ownerFence: -1 })).toThrow(TypeError);
        expect(() => new AuthorityCheckRequest({ ...base, itemIndex: -1 })).toThrow(TypeError);
        expect(() => new AuthorityCheckRequest({ ...base, attemptOrdinal: -1 })).toThrow(TypeError);
        expect(() => new AuthorityCheckRequest({ ...base, nonce: "" })).toThrow(TypeError);
        expect(
            () =>
                new AuthorityCheckRequest({
                    ...base,
                    intent: { ...base.intent, operation: " " }
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new AuthorityCheckRequest({
                    ...base,
                    intent: { ...base.intent, argumentsDigest: Digest.sha256(Uint8Array.of(9)) }
                })
        ).toThrow(TypeError);

        const validation = validationInit();
        expect(
            () =>
                new BindingValidationRequest({
                    ...validation,
                    workspaceActor: new ActorRef("run", new ActorId("wrong-kind"))
                })
        ).toThrow(TypeError);
        expect(() => new BindingValidationRequest({ ...validation, scope: tenantScope })).toThrow(
            TypeError
        );
        expect(() => new BindingValidationRequest({ ...validation, workspaceFence: -1 })).toThrow(
            TypeError
        );
        expect(() => new BindingValidationRequest({ ...validation, nonce: "" })).toThrow(TypeError);
    });

    test("[C13-AUTH-PATH-EVIDENCE] enforces evidence issuer, time, path, and grant matrices", () => {
        const request = checkRequest();
        expect(() => evidence({ issuer: owner })).toThrow(TypeError);
        expect(() => evidence({ issuerTenant: otherTenant })).toThrow(TypeError);
        expect(() => evidence({ bindingKey: "" })).toThrow(TypeError);
        expect(() => evidence({ bindingGeneration: -1 })).toThrow(TypeError);
        expect(() => evidence({ checkedAt: new Date(Number.NaN) })).toThrow(TypeError);
        expect(() =>
            evidence({
                decision: "deny",
                reason: "matchingDeny",
                matchedAllow: [grantId],
                matchedDeny: [new GrantId("deny")]
            })
        ).toThrow(TypeError);
        expect(() => evidence({ decision: "deny", reason: "allowed" })).toThrow(TypeError);
        expect(() => evidence({ decision: "allow", reason: "allowed", matchedAllow: [] })).toThrow(
            TypeError
        );
        expect(() =>
            evidence({
                decision: "allow",
                reason: "allowed",
                matchedDeny: [new GrantId("deny")]
            })
        ).toThrow(TypeError);
        expect(() =>
            evidence({
                decision: "deny",
                reason: "noMatchingAllow",
                matchedAllow: [grantId]
            })
        ).toThrow(TypeError);
        expect(evidence().binds(request)).toBe(true);

        const validation = validationRequest();
        expect(() => validationEvidence({ checkedAt: new Date(Number.NaN) })).toThrow(TypeError);
        expect(() => validationEvidence({ scope: tenantScope })).toThrow(TypeError);
        expect(() => validationEvidence({ issuer: owner })).toThrow(TypeError);
        expect(() => validationEvidence({ issuerTenant: otherTenant })).toThrow(TypeError);
        expect(validationEvidence().binds(validation)).toBe(true);
    });

    test("strictly rejects evidence codec enums and duplicate Grant IDs", () => {
        expect(() => evidence({ matchedAllow: [grantId, grantId] })).toThrow(TypeError);
        expectRecordMutationFailure(AuthorityCheckEvidence.codec, evidence(), (payload) => ({
            ...payload,
            decision: "unknown"
        }));
        expectRecordMutationFailure(AuthorityCheckEvidence.codec, evidence(), (payload) => ({
            ...payload,
            matchedAllow: [3]
        }));
        for (const kind of ["workspace", "run", "environment", "slate"] as const) {
            expectRecordMutationFailure(AuthorityCheckEvidence.codec, evidence(), (payload) => ({
                ...payload,
                issuer: { id: "alternate", kind }
            }));
        }
        expectRecordMutationFailure(AuthorityCheckEvidence.codec, evidence(), (payload) => ({
            ...payload,
            issuer: { id: "alternate", kind: "unknown" }
        }));
        expectRecordMutationFailure(AuthorityCheckEvidence.codec, evidence(), (payload) => ({
            ...payload,
            reason: "unknown"
        }));
        expectRecordMutationFailure(AuthorityCheckRequest.codec, checkRequest(), (payload) => ({
            ...payload,
            intent: {
                ...(payload.intent as Record<string, JsonValue>),
                impact: "unknown"
            }
        }));
        for (const kind of ["run", "environment", "slate"] as const) {
            const request = checkRequest();
            expectRecordMutationSuccess(AuthorityCheckRequest.codec, request, (payload) => ({
                ...payload,
                owner: { id: "alternate", kind }
            }));
        }
        for (const impact of ["mutate", "externalSend", "execute", "administer"] as const) {
            const request = checkRequest();
            expectRecordMutationSuccess(AuthorityCheckRequest.codec, request, (payload) => ({
                ...payload,
                intent: {
                    ...(payload.intent as Record<string, JsonValue>),
                    impact
                }
            }));
        }
    });
});

describe("materialization and epoch planning operational errors", () => {
    const role = new Role(new RoleName("hard-role"), [
        new RoleRule(
            "allow",
            new CapabilitySpec({
                argumentConstraints: {},
                facetPattern: "*",
                impacts: ["observe"],
                operations: []
            })
        )
    ]);
    const member = new Membership(
        new MembershipId("hard-member"),
        workspaceScope,
        SubjectRef.principal(principalId),
        role.name,
        "active",
        Revision.initial()
    );

    test("uses AgentCoreError for invalid materialization inputs", () => {
        const materializer = new RoleGrantMaterializer();
        expectAgentError(
            () =>
                materializer.materialize({
                    membership: member,
                    role: new Role(new RoleName("other"), role.rules),
                    existing: []
                }),
            "protocol.invalid-state"
        );
        const guest = new Membership(
            new MembershipId("handshake-member"),
            workspaceScope,
            SubjectRef.foreign(otherTenant, principalId, GuestVerificationScheme.handshake),
            role.name,
            "active",
            Revision.initial()
        );
        expectAgentError(
            () => materializer.materialize({ membership: guest, role, existing: [] }),
            "authority.denied"
        );
        const grant = new Grant(
            GrantId.forRole(member.id, 0),
            member.scope,
            member.subject,
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
            {
                kind: "role",
                membershipId: member.id,
                roleName: role.name.value,
                ruleOrdinal: 0,
                guest: false
            }
        );
        expectAgentError(
            () => materializer.materialize({ membership: member, role, existing: [grant, grant] }),
            "protocol.invalid-state"
        );
    });

    test("uses AgentCoreError for invalid epoch plans", () => {
        const planner = new EpochPlanner();
        expectAgentError(
            () =>
                planner.plan([new ScopeEpoch(tenantScope, 1), new ScopeEpoch(tenantScope, 2)], []),
            "protocol.invalid-state"
        );
        expectAgentError(
            () =>
                planner.plan(
                    [new ScopeEpoch(tenantScope, Number.MAX_SAFE_INTEGER)],
                    [{ kind: "grant", scope: tenantScope }]
                ),
            "protocol.invalid-state"
        );
        expectAgentError(
            () => planner.plan([], [{ kind: "unknown" } as never]),
            "protocol.invalid-state"
        );
    });
});

function checkInit(): ConstructorParameters<typeof AuthorityCheckRequest>[0] {
    return {
        ownerTenant: tenantId,
        owner,
        ownerFence: 1,
        principal,
        binding,
        intent: {
            facet,
            operation: "read",
            impact: "observe",
            arguments: args,
            argumentsDigest: argsDigest
        },
        expectedPath: path,
        invocationDigest: Digest.sha256(Uint8Array.of(3)),
        itemIndex: 0,
        attemptOrdinal: 0,
        nonce: "hard-check"
    };
}

function checkRequest(): AuthorityCheckRequest {
    return new AuthorityCheckRequest(checkInit());
}

function validationInit(): ConstructorParameters<typeof BindingValidationRequest>[0] {
    return {
        ownerTenant: tenantId,
        workspaceActor: owner,
        workspaceFence: 1,
        scope: workspaceScope,
        domain,
        name: binding.name,
        grantId,
        facet,
        nonce: "hard-validation"
    };
}

function validationRequest(): BindingValidationRequest {
    return new BindingValidationRequest(validationInit());
}

function evidence(
    overrides: {
        issuerTenant?: TenantId;
        issuer?: ActorRef;
        requestDigest?: Digest;
        bindingKey?: string;
        bindingGeneration?: number;
        decision?: "allow" | "deny";
        reason?: AuthorityCheckEvidence["reason"];
        matchedAllow?: readonly GrantId[];
        matchedDeny?: readonly GrantId[];
        pathEpochs?: PathEpochEvidence;
        checkedAt?: Date;
    } = {}
): AuthorityCheckEvidence {
    return new AuthorityCheckEvidence(
        overrides.issuerTenant ?? tenantId,
        overrides.issuer ?? issuer,
        overrides.requestDigest ?? checkRequest().digest(),
        overrides.bindingKey ?? binding.key,
        overrides.bindingGeneration ?? binding.generation,
        overrides.decision ?? "allow",
        overrides.reason ?? "allowed",
        overrides.matchedAllow ?? [grantId],
        overrides.matchedDeny ?? [],
        overrides.pathEpochs ?? path,
        overrides.checkedAt ?? new Date(10)
    );
}

function validationEvidence(
    overrides: {
        issuerTenant?: TenantId;
        issuer?: ActorRef;
        scope?: ScopeRef;
        checkedAt?: Date;
    } = {}
): BindingValidationEvidence {
    return new BindingValidationEvidence(
        overrides.issuerTenant ?? tenantId,
        overrides.issuer ?? issuer,
        validationRequest().digest(),
        overrides.scope ?? workspaceScope,
        binding.subject,
        grantId,
        path,
        overrides.checkedAt ?? new Date(10)
    );
}

function expectAgentError(action: () => unknown, code: AgentCoreErrorCode): void {
    try {
        action();
        throw new Error("Expected AgentCoreError");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}

function expectRecordMutationFailure<Value>(
    codec: { encode(value: Value): Uint8Array; decode(bytes: Uint8Array): Value },
    value: Value,
    mutate: (payload: Record<string, JsonValue>) => Record<string, JsonValue>
): void {
    const envelope = decodeCanonicalJson(codec.encode(value));
    if (envelope === null || Array.isArray(envelope) || typeof envelope !== "object") {
        throw new TypeError("Expected record envelope");
    }
    const object = envelope as Record<string, JsonValue>;
    if (
        object["payload"] === null ||
        Array.isArray(object["payload"]) ||
        typeof object["payload"] !== "object"
    )
        throw new TypeError("Expected record envelope");
    expect(() =>
        codec.decode(
            encodeCanonicalJson({
                ...object,
                payload: mutate(object["payload"] as Record<string, JsonValue>)
            })
        )
    ).toThrow();
}

function expectRecordMutationSuccess<Value>(
    codec: { encode(value: Value): Uint8Array; decode(bytes: Uint8Array): Value },
    value: Value,
    mutate: (payload: Record<string, JsonValue>) => Record<string, JsonValue>
): void {
    const envelope = decodeCanonicalJson(codec.encode(value));
    if (envelope === null || Array.isArray(envelope) || typeof envelope !== "object") {
        throw new TypeError("Expected record envelope");
    }
    const object = envelope as Record<string, JsonValue>;
    const payload = object["payload"];
    if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
        throw new TypeError("Expected record payload");
    }
    expect(
        codec.decode(
            encodeCanonicalJson({
                ...object,
                payload: mutate(payload as Record<string, JsonValue>)
            })
        )
    ).toBeDefined();
}
