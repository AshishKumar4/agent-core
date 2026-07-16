// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { BindingName, FacetRef, ProtectionDomain } from "../../src/facets";
import { PrincipalId, ScopeRef, SubjectRef, TenantId, WorkspaceId } from "../../src/identity";
import { GrantId, ScopeEpoch } from "../../src/authority";
import { PrincipalRef } from "../identity/internal-fixture";
import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    Binding,
    BindingValidationEvidence,
    BindingValidationRequest,
    PathEpochEvidence
} from "../authority/internal-fixture";
import {
    AuthorityCheckPayloadCodec,
    AuthorityCheckReply,
    AuthorityPermitIssuanceRequest,
    BindingValidationPayloadCodec,
    BindingValidationReply
} from "../../src/protocol/authority-evidence";

const tenant = new TenantId("tenant-evidence");
const principal = new PrincipalRef(tenant, new PrincipalId("principal-evidence"));
const scope = ScopeRef.workspace(tenant, new WorkspaceId("workspace-evidence"));
const actor = new ActorRef("workspace", new ActorId("workspace-evidence"));
const issuer = new ActorRef("tenant", new ActorId("tenant-evidence"));
const domain = new ProtectionDomain("backend", "evidence", "no-secrets");
const facet = new FacetRef("workspace:mail.instance");
const grant = new GrantId("grant-evidence");
const binding = Binding.active(
    scope,
    SubjectRef.principal(principal.principalId),
    domain,
    new BindingName("mail"),
    grant,
    facet
);
const path = new PathEpochEvidence([
    new ScopeEpoch(ScopeRef.tenant(tenant), 2),
    new ScopeEpoch(scope, 3)
]);

describe("authority protocol evidence", () => {
    test("[authority.check-request] [authority.check-evidence] [protocol.authority-check-reply] round-trips complete check identity without accepting altered arguments", () => {
        const request = checkRequest();
        const codec = new AuthorityCheckPayloadCodec();
        const decoded = codec.decode(codec.encode(request));
        const evidence = new AuthorityCheckEvidence(
            tenant,
            issuer,
            decoded.digest(),
            binding.key,
            binding.generation,
            "allow",
            "allowed",
            [grant],
            [],
            path,
            new Date(1_000)
        );
        const reply = AuthorityCheckReply.decode(
            AuthorityCheckReply.encode(new AuthorityCheckReply(evidence))
        );
        const direct = AuthorityCheckEvidence.decode(AuthorityCheckEvidence.encode(evidence));

        expect(reply.evidence.binds(request)).toBe(true);
        expect(reply.evidence.allowed).toBe(true);
        expect(direct.checkedAt).toEqual(new Date(1_000));
        expect(
            () =>
                new AuthorityCheckRequest({
                    ownerTenant: request.ownerTenant,
                    owner: request.owner,
                    ownerFence: request.ownerFence,
                    principal: request.principal,
                    binding: request.binding,
                    expectedPath: request.expectedPath,
                    intent: {
                        ...request.intent,
                        arguments: { channel: "external" }
                    },
                    invocationDigest: request.invocationDigest,
                    itemIndex: request.itemIndex,
                    attemptOrdinal: request.attemptOrdinal,
                    nonce: request.nonce
                })
        ).toThrow(/digest/);
    });

    test("[authority.binding-validation-request] [authority.binding-validation-evidence] [protocol.binding-validation-reply] round-trips Binding validation request and source-bound evidence", () => {
        const request = new BindingValidationRequest({
            ownerTenant: tenant,
            workspaceActor: actor,
            workspaceFence: 7,
            scope,
            domain,
            name: binding.name,
            grantId: grant,
            facet,
            nonce: "binding-validation"
        });
        const codec = new BindingValidationPayloadCodec();
        const decoded = codec.decode(codec.encode(request));
        const evidence = new BindingValidationEvidence(
            tenant,
            issuer,
            decoded.digest(),
            scope,
            binding.subject,
            grant,
            path,
            new Date(2_000)
        );
        const reply = BindingValidationReply.decode(
            BindingValidationReply.encode(new BindingValidationReply(evidence))
        );
        const direct = BindingValidationEvidence.decode(BindingValidationEvidence.encode(evidence));

        expect(reply.evidence.binds(request)).toBe(true);
        expect(decoded.workspaceFence).toBe(7);
        expect(direct.checkedAt).toEqual(new Date(2_000));

        const mutable = {
            kind: "principal" as const,
            principalId: new PrincipalId("mutable-validation")
        };
        const detached = new BindingValidationEvidence(
            tenant,
            issuer,
            decoded.digest(),
            scope,
            mutable,
            grant,
            path,
            new Date(2_001)
        );
        mutable.principalId = new PrincipalId("changed-validation");
        expect(detached.subject.kind === "principal" && detached.subject.principalId.value).toBe(
            "mutable-validation"
        );
    });

    test("[C13-AUTH-PATH-ORDER] rejects evidence with inconsistent issuer, path, reason, or matched Grants", () => {
        const request = checkRequest();
        expect(
            () =>
                new AuthorityCheckEvidence(
                    tenant,
                    issuer,
                    request.digest(),
                    binding.key,
                    binding.generation,
                    "deny",
                    "matchingDeny",
                    [],
                    [],
                    path,
                    new Date(3_000)
                )
        ).toThrow(/deny Grant/);
        expect(
            () =>
                new AuthorityCheckEvidence(
                    new TenantId("other-tenant"),
                    issuer,
                    request.digest(),
                    binding.key,
                    binding.generation,
                    "deny",
                    "noMatchingAllow",
                    [],
                    [],
                    path,
                    new Date(3_000)
                )
        ).toThrow(/issuer Tenant/);
        expect(
            () =>
                new AuthorityCheckEvidence(
                    tenant,
                    issuer,
                    request.digest(),
                    binding.key,
                    binding.generation,
                    "deny",
                    "noMatchingAllow",
                    [grant],
                    [],
                    path,
                    new Date(3_000)
                )
        ).toThrow(/cannot carry matched Grants/);
    });

    test("rejects protocol reply envelopes with extra fields", () => {
        const evidence = new AuthorityCheckEvidence(
            tenant,
            issuer,
            checkRequest().digest(),
            binding.key,
            binding.generation,
            "allow",
            "allowed",
            [grant],
            [],
            path,
            new Date(4_000)
        );
        const encoded = decodeCanonicalJson(
            AuthorityCheckReply.encode(new AuthorityCheckReply(evidence))
        ) as Record<string, JsonValue>;
        expect(() =>
            AuthorityCheckReply.decode(
                encodeCanonicalJson({
                    ...encoded,
                    payload: {
                        ...(encoded["payload"] as Record<string, JsonValue>),
                        extra: true
                    }
                })
            )
        ).toThrow(AgentCoreError);
    });

    test("rejects malformed permit issuance identity, expiry, and payload shapes", () => {
        expect(
            () => new AuthorityPermitIssuanceRequest({} as never, " noncanonical ", new Date(1_000))
        ).toThrow(/nonce/);
        expect(
            () => new AuthorityPermitIssuanceRequest({} as never, "permit", new Date(Number.NaN))
        ).toThrow(/expiry/);
        expect(
            () => new AuthorityPermitIssuanceRequest({} as never, "permit", new Date(-1))
        ).toThrow(/expiry/);
        expect(
            new AuthorityPermitIssuanceRequest({} as never, "permit", new Date(0)).expiresAt
        ).toEqual(new Date(0));

        const envelope = (payload: JsonValue) =>
            encodeCanonicalJson({
                kind: "protocol.authority-permit-issuance-request",
                version: { major: 1, minor: 0 },
                payload
            });
        for (const payload of [
            null,
            [],
            {},
            { expectation: null, expiresAt: 1_000, nonce: "permit", extra: true },
            { expectation: null, expiresAt: "soon", nonce: "permit" },
            { expectation: null, expiresAt: 1_000, nonce: 4 }
        ] as JsonValue[]) {
            expect(() => AuthorityPermitIssuanceRequest.decode(envelope(payload))).toThrow(
                AgentCoreError
            );
        }
    });
});

function checkRequest(): AuthorityCheckRequest {
    const argumentsValue = { channel: "internal" } as const;
    return new AuthorityCheckRequest({
        ownerTenant: tenant,
        owner: actor,
        ownerFence: 5,
        principal,
        binding,
        intent: {
            facet,
            operation: "send",
            impact: "observe",
            arguments: argumentsValue,
            argumentsDigest: Digest.sha256(encodeCanonicalJson(argumentsValue))
        },
        expectedPath: path,
        invocationDigest: Digest.sha256(Uint8Array.of(1, 2)),
        itemIndex: 1,
        attemptOrdinal: 2,
        nonce: "authority-check"
    });
}
