import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityPermitExpectation,
    AuthorityPermitIssuer as TenantAuthorityPermitIssuer,
    Binding,
    GrantId,
    InvalidationWatermark,
    MemoryInvalidationWatermarkStore,
    MemoryAuthorityPermitStore,
    PathEpochEvidence,
    RunTargetLeaseEvidenceStore,
    ScopeEpoch,
    TargetAuthorityPermitRequest,
    TargetLeaseEvidence,
    TargetLeaseEvidenceIssuer,
    TargetLeaseEvidenceKey,
    watermarkKey,
    type TargetLeaseEvidenceSourceFacts
} from "../../src/authority";
import {
    StoredProjectedTargetLeaseEvidence,
    TargetLeaseEvidenceProjectionTransport
} from "../../src/composition";
import { Digest, Revision, SemVer, encodeCanonicalJson } from "../../src/core";
import { RunId, Turn, TurnId, type RunTransaction } from "../../src/agents";
import { TurnPlacementSnapshot } from "../../src/agents/runs/placement";
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
import {
    content,
    genesis,
    harness,
    ids,
    pins,
} from "../agents/runs/fixture";

const tenant = new TenantId("lease-attest-tenant");
const otherTenant = new TenantId("lease-attest-other-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("lease-attest-principal"));
const otherPrincipal = new PrincipalRef(otherTenant, new PrincipalId("lease-attest-other"));
const sourceActor = new ActorRef("workspace", new ActorId("lease-attest-source"));
const targetActor = new ActorRef("run", new ActorId("lease-attest-target"));
const tenantActor = new ActorRef("tenant", new ActorId("lease-attest-tenant-actor"));
const leaseToken = Object.freeze({
    turn: new TurnId("lease-attest-turn"),
    holder: principal,
    epoch: 1
});
const run = ids.run;
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
            token: { ...leaseToken, holder: selectedPrincipal },
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
        lease: { ...leaseToken, holder: selectedPrincipal }
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

describe("source-hosted target lease attestation across three distinct hosts", () => {
    const expected = expectation();
    const nonce = "lease-attest-nonce";
    const provisional = provisionalRequestFor(expected, nonce, provisionalExpiry);
    let seededTurnId: TurnId | undefined;

    function buildHosts(): {
        runtime: ReturnType<typeof harness>["runtime"];
        repository: ReturnType<typeof harness>["repository"];
        tenantStore: MemoryAuthorityPermitStore;
        channel: TenantProjectionChannel;
        issuer: TargetLeaseEvidenceIssuer<RunTransaction>;
        transport: StoredProjectedTargetLeaseEvidence<RunTransaction>;
    } {
        const value = harness();
        // Canonical owners for this source host: the RunRepository above, the
        // canonical watermark store here, one delegation ledger for intent.
        const watermarks = new MemoryInvalidationWatermarkStore(tenant, sourceActor);
        const intents = new Map<string, Digest>();
        const facts: TargetLeaseEvidenceSourceFacts<RunTransaction> = {
            turnLease: (tx, turn) => value.repository.loadTurn(tx, turn)?.lease,
            watermark: (_tx, holder) => {
                const empty = InvalidationWatermark.empty(tenant, sourceActor, holder);
                return watermarks.load(watermarkKey(empty)) ?? empty;
            },
            invocationIntent: (_tx, runId) => intents.get(runId.value)
        };
        const store = new RunTargetLeaseEvidenceStore(tenant, sourceActor, value.storage, facts);
        const tenantStore = new MemoryAuthorityPermitStore(tenantActor);
        const channel = new TenantProjectionChannel(sourceActor, tenantStore);
        const issuer = new TargetLeaseEvidenceIssuer(store, store.source);
        const transport = new StoredProjectedTargetLeaseEvidence(store, issuer, channel, () => issuedAt);

        intents.set(run.value, expected.intentDigest);
        if (
            value.repository.transaction((tx) => value.repository.loadRun(tx, run)) === undefined
        ) {
            value.runtime.createRun(genesis());
        }
        const turnId = new TurnId("lease-attest-source-turn");
        const placement = new TurnPlacementSnapshot(turnId, pins(), []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: turnId,
                    run,
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: placement.digest,
                    input: content("a"),
                    revision: new Revision(0)
                }),
                placement
            },
            new Revision(0)
        );
        value.runtime.claimTurn(turnId, new Revision(0), principal, issuedAt, leaseExpiry);

        return { runtime: value.runtime, repository: value.repository, tenantStore, channel, issuer, transport };
    }

    test(
        "commits, self-projects, and returns only an immutable reference to the target",
        { tags: "p0" },
        async () => {
            const { repository, tenantStore, channel, transport } = buildHosts();

            const attestation = await transport.attest(TargetAuthorityPermitRequest.encode(provisional));

            expect(Object.keys(attestation ?? {}).sort()).toEqual(["deadline", "reference"]);
            expect(attestation?.deadline).toEqual(leaseExpiry);
            expect(attestation?.reference.key.idempotencyKey).toBe(nonce);
            expect(channel.calls).toBe(1);
            expect(
                tenantStore.transaction((transaction) =>
                    tenantStore.projectedEvidence(transaction, attestation!.reference)
                )
            ).toBeDefined();

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
            expect(repository.transaction((tx) => repository.loadTurn(tx, seededTurnId!))).toBeDefined();
        }
    );

    test("replays the committed attestation across a lost projection reply and a renewal", { tags: "p0" }, async () => {
        const { runtime, repository, channel, transport } = buildHosts();

        const first = await transport.attest(TargetAuthorityPermitRequest.encode(provisional));

        // The commit stands even when the projection reply is lost on the way back.
        channel.loseNextReply();
        await expect(
            transport.attest(TargetAuthorityPermitRequest.encode(provisional))
        ).rejects.toThrow(/projection reply was lost/);

        // Renewal goes through the real runtime against the canonical lease.
        const stored = repository.transaction((tx) => {
            const turn = seededTurnId === undefined ? undefined : repository.loadTurn(tx, seededTurnId);
            if (turn === undefined) throw new TypeError("Seeded Turn vanished");
            return turn;
        });
        runtime.renewTurn(
            stored.id,
            stored.revision,
            { turn: stored.id, holder: principal, epoch: stored.lease.epoch },
            issuedAt,
            provisionalExpiry
        );

        const replayed = await transport.attest(TargetAuthorityPermitRequest.encode(provisional));

        expect(replayed?.reference.equals(first!.reference)).toBe(true);
        expect(replayed?.deadline).toEqual(first!.deadline);
        expect(channel.calls).toBe(2);
    });

    test("refuses a projection channel that does not speak as the source", { tags: "p0" }, async () => {
        // A channel whose caller is the target Actor can never project: the source's
        // own authenticated caller is enforced before anything reaches the Tenant.
        const { tenantStore, channel } = buildHosts();
        const forgedChannel = new TenantProjectionChannel(targetActor, tenantStore);
        void channel;
        await expect(forgedChannel.project(TargetLeaseEvidence.encode(
            new TargetLeaseEvidence({
                key: new TargetLeaseEvidenceKey(sourceActor, nonce),
                tenant,
                run,
                lease: { ...leaseToken, holder: principal },
                target: {
                    actor: targetActor,
                    fence: 11,
                    domain: new ProtectionDomain("backend", "lease-attest-domain", "no-secrets")
                },
                requestIdentity: provisional.identity(),
                deadline: leaseExpiry,
                watermark: InvalidationWatermark.empty(tenant, sourceActor, principal)
            })
        ), nonce)).rejects.toThrow(/source's own authenticated caller/);
        expect(forgedChannel.calls).toBe(0);
    });

    test("attests nothing for a request naming another Tenant", { tags: "p0" }, async () => {
        const { transport } = buildHosts();
        const foreign = provisionalRequestFor(
            expectation({ tenant: otherTenant }),
            "lease-attest-foreign-tenant",
            provisionalExpiry
        );

        await expect(
            transport.attest(TargetAuthorityPermitRequest.encode(foreign))
        ).resolves.toBeUndefined();
    });

    test("keeps issuance closed when a request substitutes the attested binding", { tags: "p0" }, async () => {
        const { tenantStore, channel, transport } = buildHosts();
        const attestation = await transport.attest(TargetAuthorityPermitRequest.encode(provisional));
        expect(channel.calls).toBe(1);

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
    });
});

