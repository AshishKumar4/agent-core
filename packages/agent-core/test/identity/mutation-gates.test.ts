import { describe, expect, test } from "vitest";
import {
    Digest,
    Revision,
    SecretRef,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonObject,
    type JsonValue
} from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { CapabilitySpec } from "../../src/facets";
import {
    GuestTrust,
    GuestTrustId,
    GuestVerificationScheme,
    Membership,
    MembershipId,
    MemoryIdentityRepository,
    OWNER_ROLE,
    Principal,
    PrincipalId,
    PrincipalRef,
    Project,
    ProjectId,
    Role,
    RoleName,
    RoleRule,
    ScopeRef,
    SubjectRef,
    Team,
    TeamId,
    Tenant,
    TenantId,
    Workspace,
    WorkspaceId,
    decodeScopeRef,
    decodeSubjectRef,
    encodeScopeRef,
    encodeSubjectRef,
    findBuiltInRole,
    type GuestTrustVerifier,
    type StoredIdentityRecord
} from "../../src/identity";
import { GuestVerification } from "../../src/identity/guest-verification";
import { mintGuestVerification } from "../../src/identity/internal";

type IdentityPayload = JsonObject;

const tenantId = new TenantId("gate-tenant");
const homeTenant = new TenantId("gate-home");
const principalId = new PrincipalId("gate-principal");
const guestPrincipalId = new PrincipalId("gate-guest");
const teamId = new TeamId("gate-team");
const projectId = new ProjectId("gate-project");
const workspaceId = new WorkspaceId("gate-workspace");
const trustId = new GuestTrustId("gate-trust");
const readerRole = new RoleName("reader");
const guestSubject = SubjectRef.foreign(
    homeTenant,
    guestPrincipalId,
    GuestVerificationScheme.callback
);
const callbackVerifier: GuestTrustVerifier = Object.freeze({
    kind: "callback",
    endpoint: "https://guest.example/callback"
});
const tokenVerifier: GuestTrustVerifier = Object.freeze({
    kind: "token",
    issuer: "guest-issuer",
    key: new SecretRef("tenant", "oidc", "guest-key")
});
const exhausted = Number.MAX_SAFE_INTEGER;

describe("identity codec guards", () => {
    test("names the subject of every non-object identity payload", { tags: "p1" }, () => {
        const nonObjects: readonly JsonValue[] = [null, [], "tenant", 3, true];
        for (const value of nonObjects) {
            expectIdentityError(
                () => decodeScopeRef(value),
                "codec.invalid",
                "Scope reference must be an object"
            );
            expectIdentityError(
                () => decodeSubjectRef(value),
                "codec.invalid",
                "Subject reference must be an object"
            );
        }
        expect(decodeScopeRef({ kind: "tenant", tenant: tenantId.value }).kind).toBe("tenant");
    });

    test("requires identity strings and non-negative safe revisions", { tags: "p1" }, () => {
        expectIdentityError(
            () => decodeScopeRef({ kind: "tenant", tenant: 5 }),
            "codec.invalid",
            "Scope tenant must be a string"
        );
        const team = new Team(teamId, tenantId, "Gate", [principalId], Revision.initial());
        const revisions: readonly JsonValue[] = ["1", 1.5, -1];
        for (const revision of revisions) {
            expectIdentityError(
                () =>
                    Team.decode(
                        repayload(Team.codec, team, (payload) => ({ ...payload, revision }))
                    ),
                "codec.invalid",
                "Team revision must be a non-negative safe integer"
            );
        }
        expect(Team.decode(Team.encode(team)).revision.value).toBe(0);
    });

    test("orders Team principals by canonical text comparison", { tags: "p1" }, () => {
        const team = new Team(
            teamId,
            tenantId,
            "Gate",
            [new PrincipalId("c"), new PrincipalId("a"), new PrincipalId("b")],
            Revision.initial()
        );
        expect(team.principals.map((principal) => principal.value)).toStrictEqual(["a", "b", "c"]);
    });
});

describe("memory identity repository snapshots", () => {
    test("restores an empty snapshot and orders records canonically", { tags: "p1" }, () => {
        expect(new MemoryIdentityRepository().snapshot()).toStrictEqual({
            version: 1,
            records: []
        });
        const principal = new Principal(principalId, "user", "active");
        const tenant = new Tenant(tenantId, "organization", "active", Revision.initial());
        const role = new Role(new RoleName("gate-role"), []);
        const records: readonly StoredIdentityRecord[] = [
            { kind: "tenant", id: tenant.id.value, bytes: Tenant.encode(tenant) },
            { kind: "role", id: role.name.value, bytes: Role.encode(role) },
            { kind: "principal", id: principal.id.value, bytes: Principal.encode(principal) }
        ];
        const repository = new MemoryIdentityRepository({ version: 1, records });
        expect(
            repository.snapshot().records.map((record) => `${record.kind}/${record.id}`)
        ).toStrictEqual(["principal/gate-principal", "role/gate-role", "tenant/gate-tenant"]);
        expect(repository.loadPrincipal(principalId)?.status).toBe("active");
        expect(repository.loadRole(role.name)?.rules).toHaveLength(0);
    });

    test("rejects every malformed memory identity snapshot shape", { tags: "p1" }, () => {
        const malformed = "Memory identity snapshot is malformed";
        const snapshots: readonly unknown[] = [
            null,
            "snapshot",
            3,
            { version: 2, records: [] },
            { version: 1, records: [], extra: 0 },
            { version: 1 },
            { version: 1, records: "records" },
            Object.assign(() => undefined, { version: 1, records: [] })
        ];
        for (const snapshot of snapshots) {
            expectIdentityError(
                () => {
                    // @ts-expect-error Runtime callers can supply malformed snapshot roots.
                    new MemoryIdentityRepository(snapshot);
                },
                "codec.invalid",
                malformed
            );
        }
    });

    test("rejects every malformed stored identity record shape", { tags: "p1" }, () => {
        const malformed = "Memory identity snapshot record is malformed";
        const principal = new Principal(principalId, "user", "active");
        const bytes = Principal.encode(principal);
        const records: readonly unknown[] = [
            null,
            "record",
            { kind: "principal", id: principalId.value, bytes, extra: 0 },
            { kind: "principal", id: principalId.value },
            { kind: "unknown", id: principalId.value, bytes },
            { kind: "principal", id: 3, bytes },
            { kind: "principal", id: "", bytes },
            { kind: "principal", id: principalId.value, bytes: [1, 2, 3] },
            Object.assign(() => undefined, { kind: "principal", id: principalId.value, bytes })
        ];
        for (const record of records) {
            expectIdentityError(
                () => {
                    // @ts-expect-error Runtime snapshots can contain malformed records.
                    new MemoryIdentityRepository({ version: 1, records: [record] });
                },
                "codec.invalid",
                malformed
            );
        }
        expectIdentityError(
            () =>
                new MemoryIdentityRepository({
                    version: 1,
                    records: [{ kind: "principal", id: "other", bytes }]
                }),
            "codec.invalid",
            "Stored identity key does not match its codec record"
        );
    });
});

describe("guest trust lifecycle gates", () => {
    test("rejects malformed guest trust payloads with exact reasons", { tags: "p1" }, () => {
        const trust = activeTrust();
        expectIdentityError(
            () =>
                GuestTrust.decode(
                    repayload(GuestTrust.codec, trust, (payload) => ({
                        ...payload,
                        handshakeDigest: 3
                    }))
                ),
            "codec.invalid",
            "Invalid identity.guest-trust record: Guest trust handshake digest must be a string or null"
        );
        expectIdentityError(
            () =>
                GuestTrust.decode(
                    repayload(GuestTrust.codec, trust, (payload) => ({
                        ...payload,
                        verifier: { kind: "unknown" }
                    }))
                ),
            "codec.invalid",
            "Invalid identity.guest-trust record: Guest trust verifier kind is invalid"
        );
        expect(GuestTrust.decode(GuestTrust.encode(trust)).handshakeDigest).toBeUndefined();
        const digest = Digest.sha256(Uint8Array.of(7));
        const shaken = new GuestTrust(
            trustId,
            tenantId,
            homeTenant,
            tokenVerifier,
            "active",
            Revision.initial(),
            digest
        );
        expect(GuestTrust.decode(GuestTrust.encode(shaken)).handshakeDigest?.value).toBe(
            digest.value
        );
    });

    test("gates guest trust verifier configuration exactly", { tags: "p1" }, () => {
        const issuers: readonly string[] = [" padded ", "", " "];
        for (const issuer of issuers) {
            expectTypeError(
                () =>
                    trustWith({ kind: "token", issuer, key: new SecretRef("tenant", "oidc", "k") }),
                "Guest token issuer must be canonical and nonblank"
            );
        }
        expectTypeError(
            () => trustWith({ kind: "callback", endpoint: "guest.example/callback" }),
            "Guest callback endpoint must be an absolute HTTPS URL"
        );
        expectTypeError(
            () => trustWith({ kind: "callback", endpoint: "http://guest.example/callback" }),
            "Guest callback endpoint must be a canonical HTTPS URL"
        );
        expect(trustWith(tokenVerifier).verifier.kind).toBe("token");
        expect(trustWith(callbackVerifier).verifier.kind).toBe("callback");
    });

    test("keeps guest trust revision exhaustion and revocation terminal", { tags: "p0" }, () => {
        const active = new GuestTrust(
            trustId,
            tenantId,
            homeTenant,
            callbackVerifier,
            "active",
            new Revision(exhausted)
        );
        expectIdentityError(
            () => active.rotate(tokenVerifier),
            "protocol.invalid-state",
            "Guest trust revision is exhausted"
        );
        expectIdentityError(
            () => active.revoke(),
            "protocol.invalid-state",
            "Guest trust revision is exhausted"
        );
        const revoked = new GuestTrust(
            trustId,
            tenantId,
            homeTenant,
            callbackVerifier,
            "revoked",
            new Revision(exhausted)
        );
        expect(revoked.revoke()).toBe(revoked);
        expect(revoked.isActive).toBe(false);
        expectIdentityError(
            () => revoked.rotate(tokenVerifier),
            "protocol.invalid-state",
            "Revoked guest trust cannot rotate"
        );
        const rotated = activeTrust().rotate(tokenVerifier);
        expect(rotated.revision.value).toBe(1);
        expect(rotated.state).toBe("active");
    });

    test("separates verifier shape failures from rotation failures", { tags: "p1" }, () => {
        const trust = activeTrust();
        const probe = new AgentCoreError("authority.denied", "verifier probe failed");
        const failing: GuestTrustVerifier = {
            kind: "token",
            get issuer(): string {
                throw probe;
            },
            key: new SecretRef("tenant", "oidc", "guest-key")
        };
        try {
            trust.rotate(failing);
            throw new TypeError("Expected verifier failure");
        } catch (error) {
            expect(error).toBe(probe);
        }
        expectIdentityError(
            () => trust.rotate({ kind: "callback", endpoint: "guest.example/callback" }),
            "protocol.invalid-state",
            "Guest callback endpoint must be an absolute HTTPS URL"
        );
    });

    test("enforces guest trust replacement identity and revision", { tags: "p0" }, () => {
        const active = activeTrust();
        const conflict = "Guest trust updates require immutable identity and the next revision";
        const replacements: readonly GuestTrust[] = [
            new GuestTrust(
                trustId,
                tenantId,
                homeTenant,
                callbackVerifier,
                "active",
                new Revision(1),
                Digest.sha256(Uint8Array.of(9))
            ),
            new GuestTrust(
                new GuestTrustId("other-trust"),
                tenantId,
                homeTenant,
                callbackVerifier,
                "active",
                new Revision(1)
            ),
            new GuestTrust(
                trustId,
                tenantId,
                homeTenant,
                callbackVerifier,
                "active",
                new Revision(2)
            )
        ];
        for (const replacement of replacements) {
            expectIdentityError(
                () => active.assertCanReplace(replacement),
                "protocol.revision-conflict",
                conflict
            );
        }
        expect(() => active.assertCanReplace(active.rotate(tokenVerifier))).not.toThrow();
        const revoked = active.revoke();
        expectIdentityError(
            () =>
                revoked.assertCanReplace(
                    new GuestTrust(
                        trustId,
                        tenantId,
                        homeTenant,
                        callbackVerifier,
                        "revoked",
                        new Revision(2)
                    )
                ),
            "protocol.invalid-state",
            "Revoked guest trust is terminal"
        );
    });
});

describe("guest verification gates", () => {
    test("mints, restores, and refuses unminted guest verification", { tags: "p0" }, () => {
        expectTypeError(
            () =>
                new GuestVerification(
                    new PrincipalRef(homeTenant, guestPrincipalId),
                    trustId,
                    Revision.initial(),
                    GuestVerificationScheme.callback,
                    Digest.sha256(Uint8Array.of(1)),
                    new Date(100),
                    new Date(200),
                    // @ts-expect-error Runtime callers cannot forge the host construction token.
                    {}
                ),
            "Guest verification must be minted or restored by the host"
        );
        const minted = mintVerification();
        expect(minted.isHostMinted).toBe(true);
        expect(minted.verifiedAt.getTime()).toBe(100);
        expect(minted.expiresAt.getTime()).toBe(200);
        const decoded = GuestVerification.decode(GuestVerification.encode(minted));
        expect(decoded.isHostMinted).toBe(false);
        expect(decoded.verifiedAt.getTime()).toBe(100);
        expect(decoded.expiresAt.getTime()).toBe(200);
        expect(decoded.trustId.value).toBe(trustId.value);
        expect(decoded.verifiedVia).toBe(GuestVerificationScheme.callback);
    });

    test("gates guest verification instants at their exact boundaries", { tags: "p0" }, () => {
        expectTypeError(
            () =>
                mintVerification(
                    GuestVerificationScheme.callback,
                    undefined,
                    new Date(Number.NaN),
                    new Date(200)
                ),
            "Guest verification time is invalid"
        );
        expectTypeError(
            () =>
                mintVerification(
                    GuestVerificationScheme.callback,
                    undefined,
                    new Date(-1),
                    new Date(200)
                ),
            "Guest verification time is invalid"
        );
        expectTypeError(
            () =>
                mintVerification(
                    GuestVerificationScheme.callback,
                    undefined,
                    new Date(100),
                    new Date(Number.NaN)
                ),
            "Guest verification expiry is invalid"
        );
        expectTypeError(
            () =>
                mintVerification(
                    GuestVerificationScheme.callback,
                    undefined,
                    new Date(100),
                    new Date(100)
                ),
            "Guest verification must expire after verification"
        );
        expectTypeError(
            () => mintVerification(GuestVerificationScheme.handshake),
            "Guest verification is never minted via the handshake scheme"
        );
        const epoch = mintVerification(
            GuestVerificationScheme.token,
            undefined,
            new Date(0),
            new Date(1)
        );
        expect(epoch.verifiedAt.getTime()).toBe(0);
        expect(epoch.expiresAt.getTime()).toBe(1);
    });

    test("admits only a matching subject inside the exact window", { tags: "p0" }, () => {
        const verification = mintVerification();
        const matching = SubjectRef.foreign(
            homeTenant,
            guestPrincipalId,
            GuestVerificationScheme.callback
        );
        expect(verification.admits(matching, new Date(100))).toBe(true);
        expect(verification.admits(matching, new Date(199))).toBe(true);
        expect(verification.admits(matching, new Date(200))).toBe(false);
        expect(verification.admits(matching, new Date(99))).toBe(false);
        expect(verification.admits(matching, new Date(0))).toBe(false);
        expect(
            verification.admits(
                SubjectRef.foreign(homeTenant, guestPrincipalId, GuestVerificationScheme.token),
                new Date(150)
            )
        ).toBe(false);
        expect(
            verification.admits(
                SubjectRef.foreign(tenantId, guestPrincipalId, GuestVerificationScheme.callback),
                new Date(150)
            )
        ).toBe(false);
        expect(
            verification.admits(
                SubjectRef.foreign(homeTenant, principalId, GuestVerificationScheme.callback),
                new Date(150)
            )
        ).toBe(false);
        expectIdentityError(
            () => verification.admits(matching, new Date(-1)),
            "protocol.invalid-state",
            "Guest verification check time is invalid"
        );
        expectIdentityError(
            () => verification.admits(matching, new Date(Number.NaN)),
            "protocol.invalid-state",
            "Guest verification check time is invalid"
        );
    });

    test("restores guest verification only under a minting scheme", { tags: "p1" }, () => {
        const minted = mintVerification();
        // handshake is a real scheme GuestVerificationScheme.from accepts, so a restore
        // that merely forwarded the value would still be turned away — by the
        // constructor's handshake guard, under a different account of what is wrong.
        // The refusal belongs to the restore: a stored record naming handshake was never
        // minted, whatever the constructor would go on to say about it.
        for (const scheme of ["handshake", "bogus"]) {
            expectIdentityError(
                () =>
                    GuestVerification.decode(
                        repayload(GuestVerification.codec, minted, (payload) => ({
                            ...payload,
                            verifiedVia: scheme
                        }))
                    ),
                "codec.invalid",
                "Invalid identity.guest-verification record: Guest verification is only " +
                    "minted via the token or callback scheme"
            );
        }
    });

    test("restores guest verification instants only from safe integers", { tags: "p1" }, () => {
        const minted = mintVerification();
        expectIdentityError(
            () =>
                GuestVerification.decode(
                    repayload(GuestVerification.codec, minted, (payload) => ({
                        ...payload,
                        verifiedAt: "invalid"
                    }))
                ),
            "codec.invalid",
            "Invalid identity.guest-verification record: Guest verification time must be a safe integer"
        );
        expectIdentityError(
            () =>
                GuestVerification.decode(
                    repayload(GuestVerification.codec, minted, (payload) => ({
                        ...payload,
                        expiresAt: 1.5
                    }))
                ),
            "codec.invalid",
            "Invalid identity.guest-verification record: Guest verification expiry must be a safe integer"
        );
        expectIdentityError(
            () =>
                GuestVerification.decode(
                    repayload(GuestVerification.codec, minted, (payload) => ({
                        ...payload,
                        verifiedAt: 300
                    }))
                ),
            "codec.invalid",
            "Invalid identity.guest-verification record: Guest verification must expire after verification"
        );
    });
});

describe("identity identifier vocabulary", () => {
    test("names every identity identifier in its length failure", { tags: "p2" }, () => {
        const constructions: readonly (readonly [() => void, string])[] = [
            [() => new PrincipalId(""), "Principal ID"],
            [() => new TeamId(""), "Team ID"],
            [() => new TenantId(""), "Tenant ID"],
            [() => new ProjectId(""), "Project ID"],
            [() => new WorkspaceId(""), "Workspace ID"],
            [() => new MembershipId(""), "Membership ID"],
            [() => new GuestTrustId(""), "Guest trust ID"],
            [() => new RoleName(""), "Role name"]
        ];
        for (const [construct, name] of constructions) {
            expectTypeError(construct, `${name} must contain between 1 and 256 characters`);
        }
        expectTypeError(
            () => new RoleName(" padded "),
            "Role name must be a nonblank canonical string"
        );
        expect(new RoleName("reader").value).toBe("reader");
    });
});

describe("identity scope references", () => {
    test("freezes scope references and compares every component", { tags: "p0" }, () => {
        const tenantScope = ScopeRef.tenant(tenantId);
        const projectScope = ScopeRef.project(tenantId, projectId);
        const rooted = ScopeRef.workspace(tenantId, workspaceId);
        const nested = ScopeRef.workspace(tenantId, projectId, workspaceId);
        expect(Object.isFrozen(tenantScope)).toBe(true);
        expect(Object.isFrozen(new PrincipalRef(tenantId, principalId))).toBe(true);
        expect(tenantScope.equals(ScopeRef.tenant(tenantId))).toBe(true);
        expect(tenantScope.equals(ScopeRef.tenant(homeTenant))).toBe(false);
        expect(tenantScope.equals(projectScope)).toBe(false);
        expect(projectScope.equals(ScopeRef.project(tenantId, new ProjectId("other")))).toBe(false);
        expect(projectScope.equals(ScopeRef.project(tenantId, projectId))).toBe(true);
        expect(rooted.equals(nested)).toBe(false);
        expect(nested.equals(rooted)).toBe(false);
        expect(nested.equals(ScopeRef.workspace(tenantId, projectId, workspaceId))).toBe(true);
        expect(
            nested.equals(ScopeRef.workspace(tenantId, new ProjectId("other"), workspaceId))
        ).toBe(false);
        expect(
            nested.equals(ScopeRef.workspace(tenantId, projectId, new WorkspaceId("other")))
        ).toBe(false);
        expect(rooted.equals(ScopeRef.workspace(tenantId, workspaceId))).toBe(true);
        expect(rooted.path.map((scope) => scope.kind)).toStrictEqual(["tenant", "workspace"]);
        expect(nested.path.map((scope) => scope.kind)).toStrictEqual([
            "tenant",
            "project",
            "workspace"
        ]);
    });

    test("validates scope construction and decoding exactly", { tags: "p0" }, () => {
        expectTypeError(
            () => ScopeRef.workspace(tenantId, projectId),
            "Workspace scope requires a Workspace ID"
        );
        expectTypeError(
            () => ScopeRef.workspace(tenantId, workspaceId, workspaceId),
            "Workspace project must be a Project ID"
        );
        expectIdentityError(
            () => decodeScopeRef({ kind: "bogus" }),
            "codec.invalid",
            "Scope reference kind is invalid"
        );
        const scopes: readonly ScopeRef[] = [
            ScopeRef.tenant(tenantId),
            ScopeRef.project(tenantId, projectId),
            ScopeRef.workspace(tenantId, workspaceId),
            ScopeRef.workspace(tenantId, projectId, workspaceId)
        ];
        for (const scope of scopes) {
            expect(decodeScopeRef(encodeScopeRef(scope)).equals(scope)).toBe(true);
        }
    });
});

describe("identity subject references", () => {
    test("fixes the guest verification scheme vocabulary", { tags: "p1" }, () => {
        expect(GuestVerificationScheme.from("token")).toBe(GuestVerificationScheme.token);
        expect(GuestVerificationScheme.from("callback")).toBe(GuestVerificationScheme.callback);
        expect(GuestVerificationScheme.from("handshake")).toBe(GuestVerificationScheme.handshake);
        expectTypeError(
            () =>
                // @ts-expect-error Runtime subject records can contain an unknown scheme.
                GuestVerificationScheme.from("bogus"),
            "Guest verification scheme is invalid"
        );
    });

    test("decodes only the fixed subject reference kinds", { tags: "p1" }, () => {
        expectIdentityError(
            () => decodeSubjectRef({ kind: "bogus" }),
            "codec.invalid",
            "Subject reference kind is invalid"
        );
        expectIdentityError(
            () =>
                decodeSubjectRef({
                    homeTenant: homeTenant.value,
                    kind: "foreign",
                    principal: guestPrincipalId.value,
                    verifiedVia: "bogus"
                }),
            "codec.invalid",
            "Guest verification scheme is invalid"
        );
        const subjects: readonly SubjectRef[] = [
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            SubjectRef.team(teamId),
            guestSubject
        ];
        for (const subject of subjects) {
            const restored = decodeSubjectRef(encodeSubjectRef(subject));
            expect(restored.kind).toBe(subject.kind);
            expect(encodeSubjectRef(restored)).toStrictEqual(encodeSubjectRef(subject));
        }
    });
});

describe("identity record vocabularies", () => {
    test("keeps Principal and Tenant vocabularies exact", { tags: "p1" }, () => {
        const kinds: readonly ["user" | "service" | "agent", string][] = [
            ["user", "user"],
            ["service", "service"],
            ["agent", "agent"]
        ];
        for (const [kind, expected] of kinds) {
            const principal = new Principal(principalId, kind, "active");
            expect(principal.kind).toBe(expected);
            expect(Principal.decode(Principal.encode(principal)).kind).toBe(expected);
        }
        expectTypeError(
            () =>
                // @ts-expect-error Runtime records can contain an unknown Principal kind.
                new Principal(principalId, "bogus", "active"),
            "Principal kind is invalid"
        );
        expectTypeError(
            () =>
                // @ts-expect-error Runtime records can contain an unknown Principal status.
                new Principal(principalId, "user", "bogus"),
            "Principal status is invalid"
        );
        expect(new Tenant(tenantId, "personal", "active", Revision.initial()).acceptsMutation).toBe(
            true
        );
        const suspended = new Tenant(tenantId, "organization", "suspended", Revision.initial());
        expect(suspended.status).toBe("suspended");
        expect(suspended.acceptsMutation).toBe(false);
        expect(new Tenant(tenantId, "service", "deleted", Revision.initial()).status).toBe(
            "deleted"
        );
        expectTypeError(
            () =>
                // @ts-expect-error Runtime records can contain an unknown Tenant kind.
                new Tenant(tenantId, "bogus", "active", Revision.initial()),
            "Tenant kind is invalid"
        );
    });

    test("keeps Tenant transitions and revision exhaustion exact", { tags: "p0" }, () => {
        const active = new Tenant(tenantId, "organization", "active", Revision.initial());
        expect(active.revise("active")).toBe(active);
        expect(active.revise("suspended").authorizationRevision.value).toBe(1);
        expectIdentityError(
            () =>
                // @ts-expect-error Runtime transitions can contain an unknown Tenant status.
                active.revise("bogus"),
            "protocol.invalid-state",
            "Tenant status is invalid"
        );
        const deleted = new Tenant(tenantId, "organization", "deleted", Revision.initial());
        expect(deleted.revise("deleted")).toBe(deleted);
        expectIdentityError(
            () => deleted.revise("active"),
            "protocol.invalid-state",
            "Deleted Tenants are terminal"
        );
        expectIdentityError(
            () =>
                new Tenant(tenantId, "organization", "active", new Revision(exhausted)).revise(
                    "suspended"
                ),
            "protocol.invalid-state",
            "Tenant revision is exhausted"
        );
    });

    test("keeps Project naming and revision exhaustion exact", { tags: "p1" }, () => {
        const invalid = "Project name must contain between 1 and 256 canonical characters";
        const rejected: readonly string[] = [" padded ", "", "x".repeat(257)];
        for (const name of rejected) {
            expectTypeError(
                () => new Project(projectId, tenantId, name, Revision.initial()),
                invalid
            );
        }
        expect(
            new Project(projectId, tenantId, "x".repeat(256), Revision.initial()).name
        ).toHaveLength(256);
        const project = new Project(projectId, tenantId, "Gate", Revision.initial());
        for (const name of rejected) {
            expectIdentityError(() => project.rename(name), "protocol.invalid-state", invalid);
        }
        expect(project.rename("x".repeat(256)).name).toHaveLength(256);
        expect(project.rename("Renamed").revision.value).toBe(1);
        expectIdentityError(
            () =>
                new Project(projectId, tenantId, "Gate", new Revision(exhausted)).rename("Renamed"),
            "protocol.invalid-state",
            "Project revision is exhausted"
        );
    });

    test("keeps Team naming, membership, and revision rules exact", { tags: "p1" }, () => {
        const invalidName = "Team name must contain between 1 and 256 canonical characters";
        const rejected: readonly string[] = [" padded ", "", "x".repeat(257)];
        for (const name of rejected) {
            expectTypeError(
                () => new Team(teamId, tenantId, name, [], Revision.initial()),
                invalidName
            );
        }
        expect(
            new Team(teamId, tenantId, "x".repeat(256), [], Revision.initial()).name
        ).toHaveLength(256);
        expectTypeError(
            () =>
                new Team(
                    teamId,
                    tenantId,
                    "Gate",
                    [principalId, new PrincipalId(principalId.value)],
                    Revision.initial()
                ),
            "Team principals must be unique"
        );
        const team = new Team(
            teamId,
            tenantId,
            "Gate",
            [principalId, guestPrincipalId],
            Revision.initial()
        );
        expect(team.has(principalId)).toBe(true);
        expect(team.has(guestPrincipalId)).toBe(true);
        expect(team.has(new PrincipalId("absent"))).toBe(false);
        const invalidRevision = "Team revision is invalid";
        for (const name of rejected) {
            expectIdentityError(
                () => team.revise(name, [principalId]),
                "protocol.invalid-state",
                invalidRevision
            );
        }
        expectIdentityError(
            () => team.revise("Gate", [principalId, principalId]),
            "protocol.invalid-state",
            invalidRevision
        );
        const revised = team.revise("x".repeat(256), [principalId, guestPrincipalId]);
        expect(revised.name).toHaveLength(256);
        expect(revised.principals).toHaveLength(2);
        expect(revised.revision.value).toBe(1);
        expectIdentityError(
            () =>
                new Team(teamId, tenantId, "Gate", [], new Revision(exhausted)).revise("Gate", []),
            "protocol.invalid-state",
            "Team revision is exhausted"
        );
    });

    test("rejects malformed Team, Workspace, and Role payloads exactly", { tags: "p1" }, () => {
        const team = new Team(
            teamId,
            tenantId,
            "Gate",
            [principalId, guestPrincipalId],
            Revision.initial()
        );
        const principals: readonly JsonValue[] = [false, [3], [null], "gate"];
        for (const value of principals) {
            expectIdentityError(
                () =>
                    Team.decode(
                        repayload(Team.codec, team, (payload) => ({
                            ...payload,
                            principals: value
                        }))
                    ),
                "codec.invalid",
                "Team principals must be an array of Principal IDs"
            );
        }
        expect(Team.decode(Team.encode(team)).principals).toHaveLength(2);

        const nested = new Workspace(workspaceId, tenantId, projectId, Revision.initial());
        expectIdentityError(
            () =>
                Workspace.decode(
                    repayload(Workspace.codec, nested, (payload) => ({ ...payload, project: 3 }))
                ),
            "codec.invalid",
            "Invalid identity.workspace record: Workspace Project must be a string or null"
        );
        expect(Workspace.decode(Workspace.encode(nested)).projectId?.value).toBe(projectId.value);
        const rooted = new Workspace(workspaceId, tenantId, undefined, Revision.initial());
        expect(Workspace.decode(Workspace.encode(rooted)).projectId).toBeUndefined();

        const role = new Role(new RoleName("gate-role"), [new RoleRule("allow", capability())]);
        expectIdentityError(
            () =>
                Role.decode(
                    repayload(Role.codec, role, (payload) => ({ ...payload, rules: false }))
                ),
            "codec.invalid",
            "Role rules must be an array"
        );
        expectIdentityError(
            () =>
                Role.decode(
                    repayload(Role.codec, role, (payload) => ({
                        ...payload,
                        rules: [{ capability: capability().toData(), effect: "bogus" }]
                    }))
                ),
            "codec.invalid",
            "Role rule effect is invalid"
        );
        expect(Role.decode(Role.encode(role)).rules).toHaveLength(1);
        expect(findBuiltInRole("owner")).toBe(OWNER_ROLE);
        expect(findBuiltInRole(new RoleName("owner"))).toBe(OWNER_ROLE);
        expect(findBuiltInRole("absent")).toBeUndefined();
    });
});

describe("identity membership gates", () => {
    test("binds foreign Membership proof to host provenance", { tags: "p0" }, () => {
        const verification = mintVerification();
        const verified = foreignMembership("gate-member").withGuestVerification(verification);
        expect(verified.guestVerification?.isHostMinted).toBe(true);
        const direct = new Membership(
            new MembershipId("gate-direct"),
            ScopeRef.tenant(tenantId),
            guestSubject,
            readerRole,
            "active",
            Revision.initial(),
            verification
        );
        expect(direct.guestVerification).toBe(verification);
        const restored = Membership.decode(Membership.encode(verified));
        const restoredVerification = restored.guestVerification;
        if (restoredVerification === undefined) {
            throw new TypeError("Expected a restored guest verification");
        }
        expect(restoredVerification.isHostMinted).toBe(false);
        expect(restored.revise(restored.role, "suspended").state).toBe("suspended");
        expectTypeError(
            () =>
                new Membership(
                    new MembershipId("gate-reuse"),
                    ScopeRef.tenant(tenantId),
                    guestSubject,
                    readerRole,
                    "active",
                    Revision.initial(),
                    restoredVerification
                ),
            "Membership guest verification lacks host provenance"
        );
        expectTypeError(
            () =>
                new Membership(
                    new MembershipId("gate-local"),
                    ScopeRef.tenant(tenantId),
                    SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                    readerRole,
                    "active",
                    Revision.initial(),
                    verification
                ),
            "Only foreign Memberships may carry guest verification"
        );
        expectTypeError(
            () =>
                new Membership(
                    new MembershipId("gate-mismatch"),
                    ScopeRef.tenant(tenantId),
                    guestSubject,
                    readerRole,
                    "active",
                    Revision.initial(),
                    mintVerification(
                        GuestVerificationScheme.callback,
                        new PrincipalRef(homeTenant, principalId)
                    )
                ),
            "Membership guest verification does not match its subject"
        );
    });

    test("denies guest proof that does not match an unverified subject", { tags: "p0" }, () => {
        const denial = "Guest verification does not match an unverified foreign Membership";
        const verification = mintVerification();
        expectIdentityError(
            () => localMembership("gate-local").withGuestVerification(verification),
            "authority.denied",
            denial
        );
        const verified = foreignMembership("gate-verified").withGuestVerification(verification);
        expectIdentityError(
            () => verified.withGuestVerification(mintVerification()),
            "authority.denied",
            denial
        );
        const restoredVerification = Membership.decode(
            Membership.encode(verified)
        ).guestVerification;
        if (restoredVerification === undefined) {
            throw new TypeError("Expected a restored guest verification");
        }
        expectIdentityError(
            () => foreignMembership("gate-restored").withGuestVerification(restoredVerification),
            "authority.denied",
            denial
        );
        expectIdentityError(
            () =>
                foreignMembership("gate-foreign").withGuestVerification(
                    mintVerification(
                        GuestVerificationScheme.callback,
                        new PrincipalRef(homeTenant, principalId)
                    )
                ),
            "authority.denied",
            denial
        );
    });

    test("keeps Membership transitions and revisions exact", { tags: "p0" }, () => {
        const member = localMembership("gate-member");
        expect(member.isActive).toBe(true);
        const activated = member.activate();
        expect(activated.state).toBe("active");
        expect(activated.revision.value).toBe(1);
        expect(member.suspend().state).toBe("suspended");
        expect(member.revoke().state).toBe("revoked");
        expectIdentityError(
            () =>
                // @ts-expect-error Runtime transitions can contain an unknown Membership state.
                member.revise(member.role, "bogus"),
            "protocol.invalid-state",
            "Membership state is invalid"
        );
        expectIdentityError(
            () => member.suspend().activate(),
            "protocol.invalid-state",
            "Suspended Memberships require replacement rather than reactivation"
        );
        expectIdentityError(
            () => member.revoke().activate(),
            "protocol.invalid-state",
            "A revoked Membership cannot be reactivated"
        );
        expectIdentityError(
            () =>
                new Membership(
                    new MembershipId("gate-exhausted"),
                    ScopeRef.tenant(tenantId),
                    SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                    readerRole,
                    "active",
                    new Revision(exhausted)
                ).suspend(),
            "protocol.invalid-state",
            "Membership revision is exhausted"
        );
    });
});

function activeTrust(): GuestTrust {
    return new GuestTrust(
        trustId,
        tenantId,
        homeTenant,
        callbackVerifier,
        "active",
        Revision.initial()
    );
}

function trustWith(verifier: GuestTrustVerifier): GuestTrust {
    return new GuestTrust(trustId, tenantId, homeTenant, verifier, "active", Revision.initial());
}

function mintVerification(
    verifiedVia: GuestVerificationScheme = GuestVerificationScheme.callback,
    principal: PrincipalRef = new PrincipalRef(homeTenant, guestPrincipalId),
    verifiedAt: Date = new Date(100),
    expiresAt: Date = new Date(200)
): GuestVerification {
    return mintGuestVerification(
        principal,
        trustId,
        Revision.initial(),
        verifiedVia,
        Digest.sha256(Uint8Array.of(1)),
        verifiedAt,
        expiresAt
    );
}

function localMembership(id: string): Membership {
    return new Membership(
        new MembershipId(id),
        ScopeRef.tenant(tenantId),
        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
        readerRole,
        "active",
        Revision.initial()
    );
}

function foreignMembership(id: string): Membership {
    return new Membership(
        new MembershipId(id),
        ScopeRef.tenant(tenantId),
        guestSubject,
        readerRole,
        "active",
        Revision.initial()
    );
}

function capability(): CapabilitySpec {
    return new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] });
}

function repayload<Value>(
    codec: { encode(value: Value): Uint8Array },
    value: Value,
    mutate: (payload: IdentityPayload) => IdentityPayload
): Uint8Array {
    const envelope = requireJsonObject(decodeCanonicalJson(codec.encode(value)));
    return encodeCanonicalJson({
        ...envelope,
        payload: mutate(requireJsonObject(envelope["payload"]))
    });
}

function requireJsonObject(value: JsonValue | undefined): IdentityPayload {
    if (!isJsonObject(value)) {
        throw new TypeError("Expected a canonical JSON object");
    }
    return value;
}

function expectTypeError(action: () => void, message: string): void {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        if (!(error instanceof TypeError)) throw error;
        expect(error.message).toBe(message);
        return;
    }
    throw new TypeError("Expected the action to throw");
}

function expectIdentityError(action: () => void, code: AgentCoreErrorCode, message: string): void {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        if (!(error instanceof AgentCoreError)) throw error;
        expect(error.code).toBe(code);
        expect(error.message).toBe(message);
        return;
    }
    throw new TypeError("Expected the action to throw");
}
