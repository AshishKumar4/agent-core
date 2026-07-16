// @ts-nocheck
import { describe, expect, test } from "vitest";
import { Digest, Revision, SecretRef } from "../../src/core";
import { GuestTrust } from "../../src/identity/guest-trust";
import { GuestVerification } from "./internal-fixture";
import { GuestTrustId, PrincipalId, ProjectId, TenantId, WorkspaceId } from "../../src/identity/id";
import { PrincipalRef } from "../../src/identity/principal-ref";
import { GuestVerificationScheme, SubjectRef } from "../../src/identity/subject";
import { Workspace } from "../../src/identity/workspace";

describe("qualified identity and Tenant topology", () => {
    test("[C13-AUTH-PRINCIPAL-REF] [identity.principal-ref] qualifies equal Principal IDs by Tenant and round-trips canonically", () => {
        const first = new PrincipalRef(new TenantId("tenant:a"), new PrincipalId("principal:b:c"));
        const second = new PrincipalRef(new TenantId("tenant:a:b"), new PrincipalId("principal:c"));

        expect(first.equals(second)).toBe(false);
        expect(PrincipalRef.decode(PrincipalRef.encode(first)).equals(first)).toBe(true);
    });

    test("[identity.workspace] derives exact immutable Workspace ancestry from the Tenant record", () => {
        const workspace = new Workspace(
            new WorkspaceId("workspace"),
            new TenantId("tenant"),
            new ProjectId("project"),
            Revision.initial()
        );
        const decoded = Workspace.decode(Workspace.encode(workspace));

        expect(decoded.scope.path.map((scope) => scope.kind)).toEqual([
            "tenant",
            "project",
            "workspace"
        ]);
        expect(decoded.scope.equals(workspace.scope)).toBe(true);
    });
});

describe("guest trust and verification", () => {
    const host = new TenantId("host");
    const home = new TenantId("home");
    const trust = new GuestTrust(
        new GuestTrustId("trust"),
        host,
        home,
        {
            kind: "token",
            issuer: "https://issuer.example/",
            key: new SecretRef("tenant", "oidc", "home-signing-key")
        },
        "active",
        Revision.initial(),
        Digest.sha256(Uint8Array.of(1, 2, 3))
    );

    test("[identity.guest-trust] persists only steady-state token or callback trust", () => {
        const decoded = GuestTrust.decode(GuestTrust.encode(trust));

        expect(decoded.verifier).toEqual(trust.verifier);
        expect(decoded.handshakeDigest?.equals(trust.handshakeDigest!)).toBe(true);
        expect(
            () =>
                new GuestTrust(
                    new GuestTrustId("invalid"),
                    host,
                    host,
                    trust.verifier,
                    "active",
                    Revision.initial()
                )
        ).toThrow(/distinct/);
    });

    test("[identity.guest-verification] binds verification to qualified identity, trust revision, scheme, and expiry", () => {
        const principal = new PrincipalId("guest");
        const verification = new GuestVerification(
            new PrincipalRef(home, principal),
            trust.id,
            trust.revision,
            "token",
            Digest.sha256(Uint8Array.of(9)),
            new Date(1_000),
            new Date(2_000)
        );
        const subject = SubjectRef.foreign(home, principal, GuestVerificationScheme.token);

        expect(verification.admits(subject, new Date(1_999))).toBe(true);
        expect(verification.admits(subject, new Date(2_000))).toBe(false);
        expect(
            GuestVerification.decode(GuestVerification.encode(verification)).admits(
                subject,
                new Date(1_500)
            )
        ).toBe(true);
    });

    test("revocation is terminal and rotation advances revision", () => {
        const rotated = trust.rotate({ kind: "callback", endpoint: "https://home.example/verify" });
        const revoked = rotated.revoke();

        expect(rotated.revision.value).toBe(1);
        expect(revoked.revision.value).toBe(2);
        expect(() => revoked.rotate(trust.verifier)).toThrow(/cannot rotate/);
        expect(() =>
            revoked.assertCanReplace(
                new GuestTrust(
                    revoked.id,
                    revoked.hostTenant,
                    revoked.homeTenant,
                    trust.verifier,
                    "revoked",
                    revoked.revision.next(),
                    revoked.handshakeDigest
                )
            )
        ).toThrow(/terminal/);
    });
});
