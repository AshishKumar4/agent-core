// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
    Digest,
    Revision,
    SecretRef,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { CapabilitySpec } from "../../src/facets";
import { GuestTrust } from "../../src/identity/guest-trust";
import { GuestVerification } from "./internal-fixture";
import {
    GuestTrustId,
    MembershipId,
    PrincipalId,
    ProjectId,
    RoleName,
    TeamId,
    TenantId,
    WorkspaceId
} from "../../src/identity/id";
import { Membership } from "../../src/identity/member";
import { Principal } from "../../src/identity/principal";
import { PrincipalRef } from "../../src/identity/principal-ref";
import { Project } from "../../src/identity/project";
import { MemoryIdentityRepository } from "../../src/identity/repository";
import { Role, RoleRule } from "../../src/identity/role";
import { ScopeRef } from "../../src/identity/scope";
import { GuestVerificationScheme, SubjectRef } from "../../src/identity/subject";
import { Team } from "../../src/identity/team";
import { Tenant } from "../../src/identity/tenant";
import { Workspace } from "../../src/identity/workspace";
import * as identityPublic from "../../src/identity";

const tenantId = new TenantId("hard-tenant");
const principalId = new PrincipalId("hard-principal");
const homeTenant = new TenantId("hard-home");
const guestId = new PrincipalId("hard-guest");
const guestSubject = SubjectRef.foreign(homeTenant, guestId, GuestVerificationScheme.callback);
const verification = new GuestVerification(
    new PrincipalRef(homeTenant, guestId),
    new GuestTrustId("hard-trust"),
    Revision.initial(),
    "callback",
    Digest.sha256(Uint8Array.of(1)),
    new Date(100),
    new Date(200)
);

describe("behavior-carrying identity states", () => {
    test("keeps Principal disable terminal and immutable", () => {
        const active = new Principal(principalId, "user", "active");
        const disabled = active.disable();
        expect(active.canAct).toBe(true);
        expect(disabled.canAct).toBe(false);
        expect(disabled.disable()).toBe(disabled);
        expect(Principal.decode(Principal.encode(disabled)).status).toBe("disabled");
        expect(() => new Principal(principalId, "bad" as never, "active")).toThrow(TypeError);
        expect(() => new Principal(principalId, "user", "bad" as never)).toThrow(TypeError);
    });

    test("enforces Membership transitions with AgentCoreError", () => {
        const member = new Membership(
            new MembershipId("hard-member"),
            ScopeRef.tenant(tenantId),
            SubjectRef.principal(principalId),
            new RoleName("reader"),
            "active",
            Revision.initial()
        );
        const suspended = member.suspend();
        expectAgentError(() => suspended.activate(), "protocol.invalid-state");
        const revoked = suspended.revoke();
        expect(suspended.state).toBe("suspended");
        expect(revoked.revoke().state).toBe("revoked");
        expectAgentError(() => revoked.activate(), "protocol.invalid-state");
        expectAgentError(
            () => member.revise(member.role, "bad" as never),
            "protocol.invalid-state"
        );
        expectAgentError(() => member.withGuestVerification(verification), "authority.denied");
        expectCodecFailure(Membership.codec, member, (payload) => ({
            ...payload,
            state: "unknown"
        }));
        expectAgentError(
            () =>
                new Membership(
                    new MembershipId("exhausted-member"),
                    member.scope,
                    member.subject,
                    member.role,
                    "active",
                    new Revision(Number.MAX_SAFE_INTEGER)
                ).revoke(),
            "protocol.invalid-state"
        );
    });

    test("admits only fresh host-minted guest proof and prevents restored proof reuse", () => {
        expect(
            () =>
                new Membership(
                    new MembershipId("local-proof"),
                    ScopeRef.tenant(tenantId),
                    SubjectRef.principal(principalId),
                    new RoleName("reader"),
                    "active",
                    Revision.initial(),
                    verification
                )
        ).toThrow(TypeError);
        const verified = new Membership(
            new MembershipId("guest-proof"),
            ScopeRef.tenant(tenantId),
            guestSubject,
            new RoleName("reader"),
            "active",
            Revision.initial()
        ).withGuestVerification(verification);
        const restored = Membership.decode(Membership.encode(verified));
        expect(restored.guestVerification).toBeDefined();
        expect(restored.guestVerification?.isHostMinted).toBe(false);
        expectAgentError(
            () =>
                new Membership(
                    new MembershipId("reused-proof"),
                    ScopeRef.tenant(tenantId),
                    guestSubject,
                    new RoleName("reader"),
                    "active",
                    Revision.initial()
                ).withGuestVerification(restored.guestVerification!),
            "authority.denied"
        );
        expect("GuestVerification" in identityPublic).toBe(false);
        expect(
            () =>
                new Membership(
                    new MembershipId("wrong-proof"),
                    ScopeRef.tenant(tenantId),
                    SubjectRef.foreign(
                        homeTenant,
                        new PrincipalId("other"),
                        GuestVerificationScheme.callback
                    ),
                    new RoleName("reader"),
                    "active",
                    Revision.initial(),
                    verification
                )
        ).toThrow(TypeError);
    });

    test("makes deleted Tenant state terminal", () => {
        const tenant = new Tenant(tenantId, "organization", "active", Revision.initial());
        const suspended = tenant.revise("suspended");
        const active = suspended.revise("active");
        const deleted = active.revise("deleted");
        expect(suspended.acceptsMutation).toBe(false);
        expect(deleted.revise("deleted")).toBe(deleted);
        expectAgentError(() => deleted.revise("active"), "protocol.invalid-state");
        expectAgentError(() => tenant.revise("bad" as never), "protocol.invalid-state");
        expect(() => new Tenant(tenantId, "bad" as never, "active", Revision.initial())).toThrow(
            TypeError
        );
        expect(() => new Tenant(tenantId, "personal", "bad" as never, Revision.initial())).toThrow(
            TypeError
        );
    });

    test("uses AgentCoreError for invalid Team and Project operations", () => {
        const team = new Team(
            new TeamId("hard-team"),
            tenantId,
            "Hard team",
            [principalId],
            Revision.initial()
        );
        expect(team.revise("Renamed", []).revision.value).toBe(1);
        expectAgentError(() => team.revise("", []), "protocol.invalid-state");
        expectAgentError(
            () => team.revise("Duplicate", [principalId, principalId]),
            "protocol.invalid-state"
        );
        expect(
            () =>
                new Team(
                    new TeamId("duplicate-team"),
                    tenantId,
                    "Duplicate",
                    [principalId, principalId],
                    Revision.initial()
                )
        ).toThrow(TypeError);
        expectCodecFailure(Team.codec, team, (payload) => ({
            ...payload,
            principals: false
        }));
        expect(
            () => new Team(new TeamId("blank-team"), tenantId, "", [], Revision.initial())
        ).toThrow(TypeError);
        const project = new Project(
            new ProjectId("hard-project"),
            tenantId,
            "Hard project",
            Revision.initial()
        );
        expect(project.rename("Renamed project").revision.value).toBe(1);
        expectAgentError(() => project.rename(""), "protocol.invalid-state");
        expect(
            () => new Project(new ProjectId("blank-project"), tenantId, "", Revision.initial())
        ).toThrow(TypeError);
    });
});

describe("guest trust and verification hard gates", () => {
    const trust = new GuestTrust(
        verification.trustId,
        tenantId,
        homeTenant,
        { kind: "callback", endpoint: "https://home.example/verify" },
        "active",
        Revision.initial(),
        Digest.sha256(Uint8Array.of(2))
    );

    test("carries state behavior and closed operational errors", () => {
        expectAgentError(
            () => trust.rotate({ kind: "callback", endpoint: "http://insecure.example/" }),
            "protocol.invalid-state"
        );
        const rotated = trust.rotate({
            kind: "token",
            issuer: "issuer",
            key: new SecretRef("tenant", "oidc", "key")
        });
        const revoked = rotated.revoke();
        expect(revoked.revoke()).toBe(revoked);
        expectAgentError(() => revoked.rotate(trust.verifier), "protocol.invalid-state");
        expectAgentError(
            () =>
                trust.assertCanReplace(
                    new GuestTrust(
                        new GuestTrustId("other"),
                        tenantId,
                        homeTenant,
                        trust.verifier,
                        "active",
                        trust.revision.next(),
                        trust.handshakeDigest
                    )
                ),
            "protocol.revision-conflict"
        );
        expectAgentError(
            () =>
                trust.assertCanReplace(
                    new GuestTrust(
                        trust.id,
                        tenantId,
                        homeTenant,
                        { kind: "callback", endpoint: "https://other.example/verify" },
                        "revoked",
                        trust.revision.next(),
                        trust.handshakeDigest
                    )
                ),
            "protocol.invalid-state"
        );
        expect(
            () =>
                new GuestTrust(
                    new GuestTrustId("blank-issuer"),
                    tenantId,
                    homeTenant,
                    {
                        kind: "token",
                        issuer: "",
                        key: new SecretRef("tenant", "oidc", "key")
                    },
                    "active",
                    Revision.initial()
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new GuestTrust(
                    new GuestTrustId("uncanonical-callback"),
                    tenantId,
                    homeTenant,
                    { kind: "callback", endpoint: "https://home.example" },
                    "active",
                    Revision.initial()
                )
        ).toThrow(TypeError);
        const exceptional = {
            kind: "token" as const,
            get issuer(): string {
                throw new AgentCoreError("protocol.invalid-state", "issuer failed");
            },
            key: new SecretRef("tenant", "oidc", "key")
        };
        expectAgentError(() => trust.rotate(exceptional), "protocol.invalid-state");
    });

    test("separates verification shape errors from operational time errors", () => {
        expect(
            () =>
                new GuestVerification(
                    verification.principal,
                    verification.trustId,
                    verification.trustRevision,
                    verification.method,
                    verification.evidenceDigest,
                    new Date(200),
                    new Date(100)
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new GuestVerification(
                    verification.principal,
                    verification.trustId,
                    verification.trustRevision,
                    verification.method,
                    verification.evidenceDigest,
                    new Date(Number.NaN),
                    new Date(200)
                )
        ).toThrow(TypeError);
        expectAgentError(
            () => verification.admits(guestSubject, new Date(Number.NaN)),
            "protocol.invalid-state"
        );
        expect(
            verification.admits(
                SubjectRef.foreign(
                    homeTenant,
                    new PrincipalId("wrong"),
                    GuestVerificationScheme.callback
                ),
                new Date(150)
            )
        ).toBe(false);
    });

    test("strictly rejects malformed guest codec variants", () => {
        expectCodecFailure(GuestTrust.codec, trust, (payload) => ({
            ...payload,
            handshakeDigest: 3
        }));
        expectCodecFailure(GuestTrust.codec, trust, (payload) => ({
            ...payload,
            verifier: { kind: "unknown" }
        }));
        expectCodecFailure(GuestVerification.codec, verification, (payload) => ({
            ...payload,
            method: "handshake"
        }));
        expectCodecFailure(GuestTrust.codec, trust, (payload) => ({
            ...payload,
            state: "unknown"
        }));
        expectCodecFailure(GuestVerification.codec, verification, (payload) => ({
            ...payload,
            verifiedAt: "invalid"
        }));
    });
});

describe("identity shape and codec hard gates", () => {
    test("strictly validates Role capability declarations", () => {
        expect(() => new RoleRule("bad" as never, capability())).toThrow(TypeError);
        expect(() => new RoleRule("allow", {} as never)).toThrow(TypeError);
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
        expect(
            () =>
                new CapabilitySpec({
                    facetPattern: "*",
                    impacts: ["observe"],
                    argumentConstraints: { "": true }
                })
        ).toThrow(TypeError);
        expect(() =>
            CapabilitySpec.fromData({
                argumentConstraints: {},
                facetPattern: "*",
                impacts: ["observe"],
                operations: false
            })
        ).toThrow(TypeError);
        expect(() =>
            CapabilitySpec.fromData({
                argumentConstraints: {},
                facetPattern: "*",
                impacts: ["observe"],
                operations: [3]
            })
        ).toThrow(TypeError);
        expect(
            () =>
                new CapabilitySpec({
                    facetPattern: "*",
                    impacts: ["observe"],
                    operations: [" padded "]
                })
        ).toThrow(TypeError);
        const role = new Role(new RoleName("hard-role"), [new RoleRule("allow", capability())]);
        expect(Role.decode(Role.encode(role)).rules).toHaveLength(1);
        expectCodecFailure(Role.codec, role, (payload) => ({ ...payload, rules: false }));
        expectCodecFailure(Role.codec, role, (payload) => ({
            ...payload,
            rules: [{ effect: "unknown", capability: capability().toData() }]
        }));
    });

    test("validates immutable Workspace topology shape", () => {
        expect(
            () =>
                new Workspace(
                    new WorkspaceId("hard-workspace"),
                    tenantId,
                    undefined,
                    new Revision(1)
                )
        ).toThrow(TypeError);
        expectCodecFailure(
            Workspace.codec,
            new Workspace(
                new WorkspaceId("codec-workspace"),
                tenantId,
                undefined,
                Revision.initial()
            ),
            (payload) => ({ ...payload, project: 3 })
        );
        const workspace = new Workspace(
            new WorkspaceId("hard-workspace"),
            tenantId,
            undefined,
            Revision.initial()
        );
        expect(Workspace.decode(Workspace.encode(workspace)).scope.kind).toBe("workspace");
    });

    test("strictly restores every identity repository branch", () => {
        const principal = new Principal(principalId, "user", "active");
        const record = {
            kind: "principal" as const,
            id: principal.id.value,
            bytes: Principal.encode(principal)
        };
        expect(
            () => new MemoryIdentityRepository({ version: 1, records: [record, record] })
        ).toThrow(/duplicate/);
        const repository = new MemoryIdentityRepository({ version: 1, records: [record] });
        expect(repository.loadPrincipal(new PrincipalId("missing"))).toBeUndefined();
        expect(
            () =>
                new MemoryIdentityRepository({
                    version: 1,
                    records: [{ ...record, kind: "unknown" as never }]
                })
        ).toThrow(AgentCoreError);
        expect(() => new RoleName(" ")).toThrow(TypeError);
        expect(() => new RoleName(" padded ")).toThrow(TypeError);
    });
});

function capability(): CapabilitySpec {
    return new CapabilitySpec({
        facetPattern: "*",
        impacts: ["observe"]
    });
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

function expectCodecFailure<Value>(
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
