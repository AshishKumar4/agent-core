import { describe, expect, test } from "vitest";
import { SecretRef } from "../../src/core";
import { BindingName, FacetRef, ProtectionDomain } from "../../src/facets";
import { BindingCredentialCustody } from "../../src/authority";
import { Binding } from "../../src/authority/binding";
import { GrantId } from "../../src/authority/id";
import { subjectKey } from "../../src/authority/reference";
import {
    GuestVerificationScheme,
    PrincipalId,
    PrincipalRef,
    SubjectRef,
    TenantId
} from "../../src/identity";
import { otherPrincipalId, principal, tenantId, workspaceScope } from "./fixture";

const credential = new SecretRef(tenantId.value, "vault", "shared-integration-token");
const endpoint = "https://integration.example/v1/requests";
const domain = new ProtectionDomain("backend", "secret-scope", "may-hold-secrets");
const otherPrincipal = SubjectRef.principal(new PrincipalRef(tenantId, otherPrincipalId));

function boundFor(
    subject: SubjectRef,
    custody: readonly BindingCredentialCustody[] = [
        new BindingCredentialCustody(credential, endpoint)
    ]
): Binding {
    return Binding.active(
        workspaceScope,
        subject,
        domain,
        new BindingName("secret-scope"),
        new GrantId("secret-scope-grant"),
        new FacetRef("workspace:secret-scope"),
        custody
    );
}

describe("SecretRef resolution scope", () => {
    test(
        "[C13-AUTH-SECRET-SCOPE] [authority.binding] resolves identically for two Principals of one Tenant",
        { tags: "p0" },
        () => {
            const first = boundFor(principal);
            const second = boundFor(otherPrincipal);

            // The two Bindings differ only in subject. Under a per-Principal reading the second
            // Principal would observe a different secret or none; under the Tenant-scoped rule
            // both observe the identical custody answer.
            expect(subjectKey(first.subject)).not.toBe(subjectKey(second.subject));
            expect(first.hasCredentialCustody(credential, endpoint)).toBe(true);
            expect(second.hasCredentialCustody(credential, endpoint)).toBe(true);
            expect(first.credentialCustody.map((custody) => custody.toData())).toEqual(
                second.credentialCustody.map((custody) => custody.toData())
            );

            const guest = boundFor(
                SubjectRef.foreign(
                    new TenantId("tenant-home"),
                    new PrincipalId("guest"),
                    GuestVerificationScheme.token
                )
            );
            // A guest Binding records the same Tenant-scoped fact; §3.3's guest prohibition is
            // enforced on the Grant plane and is not a per-Principal secret partition here.
            expect(guest.hasCredentialCustody(credential, endpoint)).toBe(true);
        }
    );

    test(
        "[C13-AUTH-SECRET-SCOPE] [authority.binding] discriminates on the ref, the endpoint, and the owning Tenant",
        { tags: "p0" },
        () => {
            const binding = boundFor(principal);

            expect(
                binding.hasCredentialCustody(credential, "https://integration.example/v2/requests")
            ).toBe(false);
            expect(
                binding.hasCredentialCustody(
                    new SecretRef(tenantId.value, "vault", "another-token"),
                    endpoint
                )
            ).toBe(false);
            expect(
                binding.hasCredentialCustody(
                    new SecretRef(tenantId.value, "other-vault", "shared-integration-token"),
                    endpoint
                )
            ).toBe(false);
            // A ref whose source is not the owning Tenant is refused where custody is recorded.
            expect(() =>
                boundFor(principal, [
                    new BindingCredentialCustody(
                        new SecretRef("tenant-elsewhere", "vault", "shared-integration-token"),
                        endpoint
                    )
                ])
            ).toThrow(TypeError);
        }
    );

    test(
        "[C13-AUTH-SECRET-SCOPE] [authority.binding] refuses a custody fact qualified by a presenting Principal",
        { tags: "p0" },
        () => {
            const recorded = new BindingCredentialCustody(credential, endpoint).toData();

            expect(Object.keys(recorded).sort()).toEqual(["endpoint", "secret"]);
            expect(BindingCredentialCustody.fromData(recorded).matches(credential, endpoint)).toBe(
                true
            );
            // A substrate that narrowed custody to one Principal would have to persist the
            // discriminant. Refusing it at the durable boundary is what keeps the recorded scope
            // from silently becoming narrower than the ref's name says it is.
            for (const discriminant of ["principal", "subject", "presenter"]) {
                expect(() =>
                    BindingCredentialCustody.fromData({
                        ...recorded,
                        [discriminant]: "principal-authority"
                    })
                ).toThrow(TypeError);
            }
            expect(() =>
                BindingCredentialCustody.fromData({
                    endpoint,
                    secret: {
                        id: credential.id,
                        principal: "principal-authority",
                        provider: credential.provider,
                        source: credential.source
                    }
                })
            ).toThrow(TypeError);
        }
    );
});
