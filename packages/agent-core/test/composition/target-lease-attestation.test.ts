import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityPermitExpectation,
    AuthorityPermitIssuer as TenantAuthorityPermitIssuer,
    Binding,
    GrantId,
    MemoryAuthorityPermitStore,
    MemoryTargetLeaseSourceStore,
    PathEpochEvidence,
    ScopeEpoch,
    TargetAuthorityPermitRequest,
    TargetLeaseEvidence,
    TargetLeaseEvidenceIssuer,
} from "../../src/authority";
import {
    StoredProjectedTargetLeaseEvidence,
    TargetLeaseEvidenceProjectionTransport
} from "../../src/composition";
import { Digest, Revision, SemVer, encodeCanonicalJson } from "../../src/core";
import { RunId, TurnId } from "../../src/agents";
import { PackageId, PackagePin } from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import { BindingName, FacetRef, OperationRef, ProtectionDomain } from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { InvocationId } from "../../src/interaction-references";
import { ClaimWorkerId, ItemClaimId } from "../../src/invocation-references";

const tenant = new TenantId("lease-attest-tenant");
const otherTenant = new TenantId("lease-attest-other-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("lease-attest-principal"));
const otherPrincipal = new PrincipalRef(otherTenant, new PrincipalId("lease-attest-other"));
const sourceActor = new ActorRef("workspace", new ActorId("lease-attest-source"));
const targetActor = new ActorRef("run", new ActorId("lease-attest-target"));
const tenantActor = new ActorRef("tenant", new ActorId("lease-attest-tenant-actor"));
const lease = Object.freeze({
    turn: new TurnId("lease-attest-turn"),
    holder: principal,
    epoch: 1
});
const run = new RunId("lease-attest-run");
const invocation = new InvocationId("lease-attest-invocation");
const permitArguments = Object.freeze({ channel: "external" });
const issuedAt = new Date("2026-08-23T12:00:00.000Z");
const leaseExpiry = new Date("2026-08-23T12:00:05.000Z");
const provisionalExpiry = new Date("2026-08-23T12:00:30.000Z");

function digestOf(label: string): Digest {
    return Digest.sha256(new TextEncoder().encode(label));
}

function argumentsDigest(): Digest {
    return Digest.sha256(encodeCanonicalJson(permitArguments));
}

interface ExpectationOverrides {
    readonly tenant?: TenantId;
    readonly itemIndex?: number;
}

function expectation(overrides: ExpectationOverrides = {}): AuthorityPermitExpectation {
    const selectedTenant = overrides.tenant ?? tenant;
    const selectedPrincipal = selectedTenant.equals(tenant) ? principal : otherPrincipal;
    const itemIndex = overrides.itemIndex ?? 2;
    return new AuthorityPermitExpectation({
        tenant: selectedTenant,
        issuer: tenantActor,
        source: sourceActor,
        target: {
            actor: targetActor,
            fence: 11,
            domain: new ProtectionDomain("backend", "lease-attest-domain", "no-secrets")
        },
        principal: selectedPrincipal,
        binding: { name: new BindingName("mail"), generation: Revision.initial() },
        facet: new FacetRef("workspace:mail"),
        operation: new OperationRef("workspace:send"),
        package: new PackagePin(
            new PackageId("mail-package"),
            new SemVer("1.2.3"),
            digestOf("manifest"),
            digestOf("code")
        ),
        impact: "externalSend",
        invocation,
        reservation: {
            run,
            registryEpoch: 5,
            obligation: {
                kind: "invocationItem",
                invocation,
                itemIndex,
                itemKey: "lease-attest-item"
            }
        },
        itemIndex,
        attemptOrdinal: 1,
        claim: new ItemClaimId("lease-attest-claim"),
        claimOwner: {
            kind: "executor",
            token: { ...lease, holder: selectedPrincipal },
            worker: new ClaimWorkerId("lease-attest-worker")
        },
        itemKey: "lease-attest-item",
        argumentsDigest: argumentsDigest(),
        intentDigest: digestOf("intent"),
        pathEpochs: new PathEpochEvidence([
            new ScopeEpoch(ScopeRef.tenant(selectedTenant), 0),
            new ScopeEpoch(
                ScopeRef.workspace(selectedTenant, new WorkspaceId("lease-attest-workspace")),
                0
            )
        ]),
        authority: {
            kind: "initiator",
            principal: selectedPrincipal,
            binding: new BindingName("mail")
        },
        lease: { ...lease, holder: selectedPrincipal }
    });
}

function provisionalRequestFor(
    expected: AuthorityPermitExpectation,
    nonce: string,
    expiresAt: Date
): TargetAuthorityPermitRequest {
    const binding = new Binding(
        expected.pathEpochs.target.scope,
        SubjectRef.principal(expected.principal),
        expected.target.domain,
        expected.binding.name,
        new GrantId("lease-attest-grant"),
        expected.facet,
        expected.binding.generation.value,
        "active",
        new Revision(expected.binding.generation.value)
    );
    const authority = new AuthorityCheckRequest({
        ownerTenant: expected.tenant,
        owner: expected.target.actor,
        ownerFence: expected.target.fence,
        principal: expected.principal,
        binding,
        intent: {
            facet: expected.facet,
            operation: expected.operation.operation.value,
            impact: expected.impact,
            arguments: permitArguments,
            argumentsDigest: argumentsDigest()
        },
        expectedPath: expected.pathEpochs,
        invocationDigest: expected.intentDigest,
        itemIndex: expected.itemIndex,
        attemptOrdinal: expected.attemptOrdinal,
        nonce
    });
    return new TargetAuthorityPermitRequest(expected, authority, nonce, expiresAt);
}

/**
 * The Tenant-side end of the projection channel. It enforces the same rule the
 * protocol command does: only the evidence's own source caller may project it,
 * and the envelope idempotency key must be the evidence key.
 */
class TenantProjectionChannel extends TargetLeaseEvidenceProjectionTransport {
    public calls = 0;
    #failOnce = false;

    public constructor(
        private readonly caller: ActorRef,
        private readonly tenantStore: MemoryAuthorityPermitStore
    ) {
        super();
    }

    public loseNextReply(): void {
        this.#failOnce = true;
    }

    public async project(evidenceBytes: Uint8Array, idempotencyKey: string): Promise<Uint8Array> {
        const evidence = TargetLeaseEvidence.decode(evidenceBytes);
        if (!this.caller.equals(evidence.key.source)) {
            throw new AgentCoreError(
                "authority.denied",
                "Projection requires the evidence source's own authenticated caller"
            );
        }
        if (idempotencyKey !== evidence.key.idempotencyKey) {
            throw new AgentCoreError(
                "authority.denied",
                "Projection idempotency key must be the evidence key"
            );
        }
        if (this.#failOnce) {
            this.#failOnce = false;
            throw new TypeError("projection reply was lost");
        }
        this.calls += 1;
        const projected = this.tenantStore.transaction((tx) =>
            this.tenantStore.projectEvidence(tx, evidence)
        );
        return TargetLeaseEvidence.encode(projected);
    }
}

function allowedTenantEvidence(request: TargetAuthorityPermitRequest): AuthorityCheckEvidence {
    return new AuthorityCheckEvidence(
        request.expectation.tenant,
        request.expectation.issuer,
        request.authority.digest(),
        request.authority.binding.key,
        request.authority.binding.generation,
        "allow",
        "allowed",
        [new GrantId("lease-attest-grant")],
        [],
        request.authority.expectedPath,
        issuedAt
    );
}

function seedSource(store: MemoryTargetLeaseSourceStore, intent: Digest): void {
    store.transaction((transaction) => {
        store.claimTurn(transaction, lease.turn, principal, leaseExpiry, issuedAt);
        store.delegateInvocation(transaction, run, intent);
    });
}

describe("source-hosted target lease attestation across three distinct hosts", () => {
    const expected = expectation();
    const nonce = "lease-attest-nonce";
    const provisional = provisionalRequestFor(expected, nonce, provisionalExpiry);

    function buildHosts() {
        const source = new MemoryTargetLeaseSourceStore(tenant, sourceActor);
        seedSource(source, expected.intentDigest);
        const tenantStore = new MemoryAuthorityPermitStore(tenantActor);
        const channel = new TenantProjectionChannel(sourceActor, tenantStore);
        const host = new StoredProjectedTargetLeaseEvidence(
            source,
            new TargetLeaseEvidenceIssuer(source, source.source),
            channel,
            () => issuedAt
        );
        return { source, tenantStore, channel, host };
    }
    test(
        "commits, self-projects, and returns only an immutable reference to the target",
        { tags: "p0" },
        async () => {
            const { source, tenantStore, channel, host } = buildHosts();

            const attestation = await host.attest(TargetAuthorityPermitRequest.encode(provisional));

            expect(Object.keys(attestation ?? {}).sort()).toEqual(["deadline", "reference"]);
            expect(attestation?.deadline).toEqual(leaseExpiry);
            expect(attestation?.reference.key.idempotencyKey).toBe(nonce);
            expect(channel.calls).toBe(1);
            expect(
                tenantStore.transaction((transaction) =>
                    tenantStore.projectedEvidence(transaction, attestation!.reference)
                )
            ).toBeDefined();

            // The target names the projected reference and clamps its expiry to the
            // attested deadline; the Tenant independently verifies the projected record
            // against the exact final request at issuance time.
            const finalRequest = new TargetAuthorityPermitRequest(
                expected,
                provisional.authority,
                nonce,
                new Date(Math.min(provisional.expiresAt.getTime(), attestation!.deadline.getTime())),
                attestation?.reference
            );
            const permit = tenantStore.transaction((transaction) =>
                new TenantAuthorityPermitIssuer(tenantStore).issue(
                    transaction,
                    finalRequest,
                    allowedTenantEvidence(finalRequest),
                    issuedAt
                )
            );
            expect(permit.requestDigest.equals(finalRequest.digest())).toBe(true);
            expect(
                source.transaction((transaction) => source.evidence(transaction, nonce))
            ).toBeDefined();
        }
    );

    test("replays the committed attestation across a lost projection reply and a renewal", { tags: "p0" }, async () => {
        const { source, channel, host } = buildHosts();

        const first = await host.attest(TargetAuthorityPermitRequest.encode(provisional));

        // The commit stands even when the projection reply is lost on the way back;
        // the next attempt replays the committed record instead of regenerating it.
        channel.loseNextReply();
        await expect(host.attest(TargetAuthorityPermitRequest.encode(provisional))).rejects.toThrow(
            /projection reply was lost/
        );
        source.transaction((transaction) =>
            source.renewTurn(transaction, lease, provisionalExpiry, issuedAt)
        );

        const replayed = await host.attest(TargetAuthorityPermitRequest.encode(provisional));

        expect(replayed?.reference.equals(first!.reference)).toBe(true);
        expect(replayed?.deadline).toEqual(first!.deadline);
        expect(channel.calls).toBe(2);
    });

    test("refuses a projection channel that does not speak as the source", { tags: "p0" }, async () => {
        const source = new MemoryTargetLeaseSourceStore(tenant, sourceActor);
        seedSource(source, expected.intentDigest);
        const forgedChannel = new TenantProjectionChannel(
            targetActor,
            new MemoryAuthorityPermitStore(tenantActor)
        );
        const host = new StoredProjectedTargetLeaseEvidence(
            source,
            new TargetLeaseEvidenceIssuer(source, source.source),
            forgedChannel,
            () => issuedAt
        );

        await expect(
            host.attest(TargetAuthorityPermitRequest.encode(provisional))
        ).rejects.toThrow(/source's own authenticated caller/);
        expect(forgedChannel.calls).toBe(0);
    });

    test("attests nothing for a request naming another Tenant", { tags: "p0" }, async () => {
        const { channel, host } = buildHosts();
        const foreign = provisionalRequestFor(
            expectation({ tenant: otherTenant }),
            "lease-attest-foreign-tenant",
            provisionalExpiry
        );

        await expect(
            host.attest(TargetAuthorityPermitRequest.encode(foreign))
        ).resolves.toBeUndefined();
        expect(channel.calls).toBe(0);
    });

    test("keeps issuance closed when a request substitutes the attested binding", { tags: "p0" }, async () => {
        const { tenantStore, channel, host } = buildHosts();
        const attestation = await host.attest(TargetAuthorityPermitRequest.encode(provisional));
        const substitutedBase = provisionalRequestFor(
            expectation({ itemIndex: 3 }),
            nonce,
            attestation!.deadline
        );
        const substituted = new TargetAuthorityPermitRequest(
            substitutedBase.expectation,
            substitutedBase.authority,
            nonce,
            attestation!.deadline,
            attestation?.reference
        );
        expect(() =>
            tenantStore.transaction((transaction) =>
                new TenantAuthorityPermitIssuer(tenantStore).issue(
                    transaction,
                    substituted,
                    allowedTenantEvidence(substituted),
                    issuedAt
                )
            )
        ).toThrow(/stale or substituted/);
        expect(channel.calls).toBe(1);
    });
});
