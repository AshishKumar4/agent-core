import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { RunId } from "../../src/agents";
import {
    Digest,
    Revision,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { PackageId, PackagePin } from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import { BindingName, FacetRef, OperationRef, ProtectionDomain } from "../../src/facets";
import { PrincipalId, ScopeRef, SubjectRef, TenantId, WorkspaceId } from "../../src/identity";
import { ClaimWorkerId, InvocationId, ItemClaimId } from "../../src/invocations";
import {
    AuthorityPermit,
    AuthorityPermitExpectation,
    GrantId,
    ScopeEpoch,
    type AuthorityPermitExpectationInit
} from "../../src/authority";
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
    AuthorityPermitIssuancePayloadCodec,
    AuthorityPermitIssuanceReply,
    AuthorityPermitIssuanceRequest,
    BindingValidationPayloadCodec,
    BindingValidationReply
} from "../../src/protocol/authority-evidence";
import { expectAgentCoreError } from "./error-assertion";

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
    test("[authority.check-request] [authority.check-evidence] [protocol.authority-check-reply] round-trips complete check identity without accepting altered arguments", { tags: "p1" }, () => {
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

    test("[authority.binding-validation-request] [authority.binding-validation-evidence] [protocol.binding-validation-reply] round-trips Binding validation request and source-bound evidence", { tags: "p1" }, () => {
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

    test("[C13-AUTH-PATH-ORDER] rejects evidence with inconsistent issuer, path, reason, or matched Grants", { tags: "p0" }, () => {
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

    test("rejects protocol reply envelopes with extra fields", { tags: "p1" }, () => {
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

    test("rejects malformed permit issuance identity, expiry, and payload shapes", { tags: "p1" }, () => {
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

test("authority protocol replies freeze and reject inexact payload shapes", { tags: "p1" }, () => {
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
        new Date(5_000)
    );
    expect(Object.isFrozen(new AuthorityCheckReply(evidence))).toBe(true);

    const checkEnvelope = (payload: JsonValue): Uint8Array =>
        encodeCanonicalJson({
            kind: "protocol.authority-check-reply",
            version: { major: 1, minor: 0 },
            payload
        });
    const malformed: readonly JsonValue[] = [
        null,
        [],
        {},
        { wrong: true },
        { evidence: null, extra: true }
    ];
    for (const payload of malformed) {
        expect(() => AuthorityCheckReply.decode(checkEnvelope(payload))).toThrow(
            "Authority protocol reply is malformed"
        );
    }

    const validationEvidence = new BindingValidationEvidence(
        tenant,
        issuer,
        Digest.sha256(Uint8Array.of(7)),
        scope,
        binding.subject,
        grant,
        path,
        new Date(6_000)
    );
    expect(Object.isFrozen(new BindingValidationReply(validationEvidence))).toBe(true);
    expect(() =>
        BindingValidationReply.decode(
            encodeCanonicalJson({
                kind: "protocol.binding-validation-reply",
                version: { major: 1, minor: 0 },
                payload: { permit: 1 }
            })
        )
    ).toThrow("Authority protocol reply is malformed");
});

test("permit issuance codec diagnostics are exact", { tags: "p1" }, () => {
    const issuanceEnvelope = (payload: JsonValue): Uint8Array =>
        encodeCanonicalJson({
            kind: "protocol.authority-permit-issuance-request",
            version: { major: 1, minor: 0 },
            payload
        });
    const inexact: readonly JsonValue[] = [
        null,
        [],
        {},
        { expectation: null, expiresAt: 1_000, nonce: "permit", extra: true }
    ];
    for (const payload of inexact) {
        expect(() => AuthorityPermitIssuanceRequest.decode(issuanceEnvelope(payload))).toThrow(
            "Authority protocol payload is malformed"
        );
    }
    const wrongTypes: readonly JsonValue[] = [
        { expectation: null, expiresAt: "soon", nonce: "permit" },
        { expectation: null, expiresAt: 1_000, nonce: 4 }
    ];
    for (const payload of wrongTypes) {
        expect(() => AuthorityPermitIssuanceRequest.decode(issuanceEnvelope(payload))).toThrow(
            "Authority permit issuance request is malformed"
        );
    }

    expect(() => new AuthorityPermitIssuanceRequest({} as never, "", new Date(0))).toThrow(
        "Authority permit issuance nonce must be canonical and nonblank"
    );
    const request = new AuthorityPermitIssuanceRequest({} as never, "permit", new Date(2_000));
    expect(Object.isFrozen(request)).toBe(true);
    const exposed = request.expiresAt;
    exposed.setTime(0);
    expect(request.expiresAt).toEqual(new Date(2_000));
});

test("authority protocol codec failures carry the codec.invalid code", { tags: "p1" }, () => {
    const issuanceEnvelope = (payload: JsonValue): Uint8Array =>
        encodeCanonicalJson({
            kind: "protocol.authority-permit-issuance-request",
            version: { major: 1, minor: 0 },
            payload
        });

    expectAgentCoreError(
        () =>
            AuthorityPermitIssuanceRequest.decode(
                issuanceEnvelope({ expectation: null, expiresAt: "soon", nonce: "permit" })
            ),
        "codec.invalid"
    );
    expectAgentCoreError(() => AuthorityPermitIssuanceRequest.decode(issuanceEnvelope({})), "codec.invalid");
    expectAgentCoreError(
        () =>
            AuthorityCheckReply.decode(
                encodeCanonicalJson({
                    kind: "protocol.authority-check-reply",
                    version: { major: 1, minor: 0 },
                    payload: { wrong: true }
                })
            ),
        "codec.invalid"
    );
});

test("permit issuance replies and payload codecs round-trip frozen permits", { tags: "p2" }, () => {
    const permit = new AuthorityPermit({
        ...permitExpectationInit(),
        nonce: "permit-nonce",
        issuedAt: new Date(1_000),
        expiresAt: new Date(2_000)
    });
    const reply = new AuthorityPermitIssuanceReply(permit);
    expect(Object.isFrozen(reply)).toBe(true);
    const decodedReply = AuthorityPermitIssuanceReply.decode(
        AuthorityPermitIssuanceReply.encode(reply)
    );
    expect(decodedReply.permit.expectation.equals(permit.expectation)).toBe(true);

    const codec = new AuthorityPermitIssuancePayloadCodec();
    const expectation = new AuthorityPermitExpectation(permitExpectationInit());
    const request = new AuthorityPermitIssuanceRequest(expectation, "permit-nonce", new Date(2_000));
    const encoded = codec.encode(request);
    expect(encoded).toBeInstanceOf(Uint8Array);
    const decoded = codec.decode(encoded);
    expect(decoded.expectation.equals(expectation)).toBe(true);
    expect(decoded.nonce).toBe("permit-nonce");
    expect(decoded.expiresAt).toEqual(new Date(2_000));
});

function permitExpectationInit(): AuthorityPermitExpectationInit {
    const invocation = new InvocationId("permit-invocation");
    return {
        tenant,
        issuer,
        source: actor,
        target: { actor: new ActorRef("run", new ActorId("permit-target")), fence: 1, domain },
        principal,
        binding: { name: new BindingName("mail"), generation: new Revision(1) },
        facet,
        operation: new OperationRef("mail:send"),
        package: new PackagePin(
            new PackageId("permit-package"),
            new SemVer("1.0.0"),
            Digest.sha256(new TextEncoder().encode("permit-manifest")),
            Digest.sha256(new TextEncoder().encode("permit-code"))
        ),
        impact: "observe",
        invocation,
        reservation: {
            run: new RunId("permit-run"),
            registryEpoch: 1,
            obligation: { kind: "invocationItem", invocation, itemIndex: 0, itemKey: "permit-item" }
        },
        itemIndex: 0,
        attemptOrdinal: 0,
        claim: new ItemClaimId("permit-claim"),
        claimOwner: { kind: "system", actor: issuer, worker: new ClaimWorkerId("permit-worker") },
        itemKey: "permit-item",
        argumentsDigest: Digest.sha256(new TextEncoder().encode("permit-arguments")),
        intentDigest: Digest.sha256(new TextEncoder().encode("permit-intent")),
        pathEpochs: path,
        authority: { kind: "initiator", principal, binding: new BindingName("mail") }
    };
}

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
