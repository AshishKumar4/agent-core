import { describe, expect, it } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Binding, GrantId, PathEpochEvidence, ScopeEpoch } from "../../src/authority";
import { Digest, JsonSchema, SemVer } from "../../src/core";
import { MemoryContentStore } from "../../src/content";
import { PackageId, PackagePin, PolicySet } from "../../src/definition";
import {
    BindingName,
    FacetRef,
    OperationDescriptor,
    OperationName,
    ProtectionDomain
} from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { TurnId, type LeaseToken } from "../../src/agents";
import {
    AuditRecordId,
    AuthorityAdmissionReference,
    ClaimWorkerId,
    EffectAttempt,
    EffectAttemptId,
    InvocationId,
    InvocationPlacementPin,
    ItemClaim,
    ItemClaimId,
    PreparedInvocation,
    type CanonicalBatchInvocationRequest
} from "../../src/invocations";
import { OperationRequestKey, type MediatedInvocationRequest } from "../../src/operations";
import {
    CanonicalMediationPreparation,
    CanonicalMediationRecords,
    DerivedDirectOperationContext,
    DerivedMediationIdentities,
    DerivedPreparationAdmission,
    MediatedAuthorityIntent,
    MediationClaimOwnerAdmission,
    leaseReference,
    mediationPreparedCodecs,
    type FacetActivationPinPort,
    type MediationLeaseReference,
    type MediationPreparedInvocation,
    type MediationPersistence
} from "../../src/composition";

const tenant = new TenantId("mediation-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("mediation-principal"));
const owner = new ActorRef("run", new ActorId("mediation-run"));
const facet = new FacetRef("memory:primary");
const bindingName = new BindingName("recall");
const domain = new ProtectionDomain("backend", "memory", "may-hold-secrets");
const schema = new JsonSchema({ type: "object" });
const descriptor = new OperationDescriptor(
    new OperationName("recall"),
    "observe",
    schema,
    schema,
    "Perform recall."
);
const token: LeaseToken = Object.freeze({
    turn: new TurnId("mediation-turn"),
    holder: principal,
    epoch: 1
});
const identities = new DerivedMediationIdentities("mediation-scope");

function digest(character: string): Digest {
    return new Digest(character.repeat(64));
}

function intent(
    options: {
        readonly policies?: readonly PolicySet[];
        readonly lease?: LeaseToken | undefined;
        readonly route?: undefined;
    } = {}
): MediatedAuthorityIntent {
    return new MediatedAuthorityIntent(
        principal,
        Binding.active(
            ScopeRef.workspace(tenant, new WorkspaceId("mediation-workspace")),
            SubjectRef.principal(principal),
            domain,
            bindingName,
            new GrantId("mediation-grant"),
            facet
        ),
        new PathEpochEvidence([ScopeEpoch.initial(ScopeRef.tenant(tenant))]),
        domain,
        new PackagePin(new PackageId("memory"), new SemVer("1.0.0"), digest("f"), digest("1")),
        new InvocationPlacementPin({
            manifest: ["provider"],
            policy: ["provider"],
            substrate: ["provider"],
            trust: ["provider"],
            selected: "provider"
        }),
        owner,
        "lease" in options ? options.lease : token,
        options.route,
        options.policies ?? []
    );
}

const activations: FacetActivationPinPort = {
    pin: (target) =>
        target.equals(facet)
            ? {
                  configurationDigest: digest("2"),
                  runtimeDigest: digest("3"),
                  activationGeneration: "generation-1",
                  registration: "registration-1"
              }
            : undefined
};

class UnusedTransactions {
    public transact<Result>(operation: (transaction: object) => Result): Result {
        return operation({});
    }
}

const noPersistence = {
    prepared: () => undefined
} as unknown as MediationPersistence<object, string>;

function request(
    invocation: InvocationId,
    inputs: readonly { readonly query: string }[] = [{ query: "parking" }],
    authorization = intent()
): CanonicalBatchInvocationRequest<MediatedAuthorityIntent> {
    const mediated: MediatedInvocationRequest<MediatedAuthorityIntent> = {
        requestKey: new OperationRequestKey("mediation-request"),
        facet,
        descriptor,
        shape: { kind: "single" },
        inputs,
        authorization,
        interceptions: [[]],
        execute: async () => ({})
    };
    return { invocation, request: mediated };
}

function preparation(): CanonicalMediationPreparation<object, string> {
    return new CanonicalMediationPreparation(
        identities,
        activations,
        new UnusedTransactions(),
        noPersistence
    );
}

function records(
    worker = new ClaimWorkerId("worker-1")
): CanonicalMediationRecords<string> {
    return new CanonicalMediationRecords({ actor: owner, tenant, worker }, identities, 1_000);
}

function prepared(invocation = new InvocationId("mediation-invocation")): MediationPreparedInvocation {
    return preparation().prepare(request(invocation));
}

function admission(): AuthorityAdmissionReference<string> {
    return new AuthorityAdmissionReference("permit", digest("a"));
}

describe("derived mediation identities", () => {
    it("mints one stable identity per piece of durable evidence", { tags: "p0" }, () => {
        const invocation = new InvocationId("mediation-invocation");
        const worker = new ClaimWorkerId("worker-1");
        expect(identities.claim(invocation, 0, 0, worker).value).toBe(
            identities.claim(invocation, 0, 0, worker).value
        );
        expect(identities.attempt(invocation, 0, 0).value).toBe(
            identities.attempt(invocation, 0, 0).value
        );
        expect(identities.invocationAudit(invocation).value).toBe(
            identities.invocationAudit(invocation).value
        );
    });

    it("separates every identity that must not collide", { tags: "p0" }, () => {
        const invocation = new InvocationId("mediation-invocation");
        const other = new InvocationId("mediation-other");
        const attempt = identities.attempt(invocation, 0, 0);
        const values = [
            identities.claim(invocation, 0, 0, new ClaimWorkerId("worker-1")).value,
            // A recovered claim differs only by the worker that recovered it.
            identities.claim(invocation, 0, 0, new ClaimWorkerId("worker-2")).value,
            identities.claim(invocation, 1, 0, new ClaimWorkerId("worker-1")).value,
            identities.claim(invocation, 0, 1, new ClaimWorkerId("worker-1")).value,
            identities.attempt(invocation, 0, 0).value,
            identities.attempt(invocation, 0, 1).value,
            identities.attempt(other, 0, 0).value,
            identities.preEffectReceipt(invocation, 0, "deniedPreEffect").value,
            identities.preEffectReceipt(invocation, 0, "cancelledPreEffect").value,
            // A reconciled Receipt supersedes the indeterminate one for the same attempt.
            identities.attemptReceipt(attempt, "indeterminate").value,
            identities.attemptReceipt(attempt, "succeeded").value,
            identities.attemptReceipt(attempt, "failed").value,
            identities.invocationAudit(invocation).value,
            identities.attemptAudit(attempt).value,
            identities.receiptAudit(identities.attemptReceipt(attempt, "succeeded")).value,
            identities.correlation(invocation).value,
            identities.idempotencySeed(invocation),
            identities.directInvocation("mediation-request").value
        ];
        expect(new Set(values).size).toBe(values.length);
    });

    it("binds the mediated Invocation to its exact replay identity", { tags: "p0" }, () => {
        const preflight = {
            requestKey: new OperationRequestKey("mediation-request"),
            facet,
            descriptor,
            shape: { kind: "single" as const },
            inputs: [{ query: "parking" }],
            authorization: intent(),
            replayBinding: {
                principal,
                authorityIdentity: digest("4"),
                packageOperationPin: digest("5"),
                execution: { kind: "lease" as const, digest: digest("6") }
            }
        };
        const first = identities.invocation(preflight);
        expect(identities.invocation(preflight).value).toBe(first.value);
        expect(
            identities.invocation({ ...preflight, inputs: [{ query: "other" }] }).value
        ).not.toBe(first.value);
        expect(
            identities.invocation({
                ...preflight,
                replayBinding: {
                    ...preflight.replayBinding,
                    execution: { kind: "lease", digest: digest("7") }
                }
            }).value
        ).not.toBe(first.value);
        // A different Actor's replay namespace never reuses another's Invocation.
        expect(new DerivedMediationIdentities("other-scope").invocation(preflight).value).not.toBe(
            first.value
        );
    });

    it("rejects a blank replay scope", { tags: "p2" }, () => {
        for (const scope of ["", " ", " scope"]) {
            expect(() => new DerivedMediationIdentities(scope)).toThrow(/canonical/u);
        }
    });
});

describe("canonical mediation preparation", () => {
    it("freezes the exact intent the gateway resolved", { tags: "p0" }, () => {
        const invocation = new InvocationId("mediation-invocation");
        const record = prepared(invocation);
        expect(record.header.id.equals(invocation)).toBe(true);
        expect(record.header.lease).toEqual<MediationLeaseReference>(leaseReference(token));
        expect(record.header.authority).toEqual({
            kind: "initiator",
            tenant: tenant.value,
            principal: principal.principalId.value,
            binding: bindingName.value
        });
        expect(record.header.domain).toEqual({
            kind: "backend",
            label: "memory",
            secretPolicy: "may-hold-secrets"
        });
        expect(record.header.actor.equals(owner)).toBe(true);
        expect(record.header.operation.target).toBe(facet.value);
        expect(record.header.operation.operation.value).toBe("memory:recall");
        expect(record.header.operation.activationGeneration).toBe("generation-1");
        expect(record.header.auditCause.equals(identities.invocationAudit(invocation))).toBe(true);
        expect(record.header.idempotencySeed).toBe(identities.idempotencySeed(invocation));
    });

    it("reads the approval requirement from policy instead of assuming one", { tags: "p0" }, () => {
        expect(prepared().header.operation.approvalRequired).toBe(false);
        const required = preparation().prepare(
            request(new InvocationId("mediation-approved"), [{ query: "parking" }], intent({
                policies: [new PolicySet({ approvals: ["observe"] })]
            }))
        );
        expect(required.header.operation.approvalRequired).toBe(true);
    });

    it("refuses an intent with neither an exact lease nor a route", { tags: "p0" }, () => {
        expect(() =>
            preparation().prepare(
                request(new InvocationId("mediation-unleased"), [{ query: "parking" }], intent({
                    lease: undefined
                }))
            )
        ).toThrow(/exact lease or a routed reservation/u);
    });

    it("refuses a Facet with no activation pin to freeze", { tags: "p1" }, () => {
        const other = new FacetRef("memory:other");
        expect(() =>
            preparation().prepare({
                invocation: new InvocationId("mediation-unpinned"),
                request: { ...request(new InvocationId("mediation-unpinned")).request, facet: other }
            })
        ).toThrow(/activation pin/u);
    });

    it("admits only a preparation whose evidence its own identity derives", { tags: "p0" }, () => {
        const gate = new DerivedPreparationAdmission<object>(identities);
        const invocation = new InvocationId("mediation-invocation");
        const record = prepared(invocation);
        expect(gate.admits({}, record)).toBe(true);

        // A substituted audit cause or idempotency seed is exactly what would let one
        // Invocation's evidence hang off another's audit root.
        const header = record.header;
        const substituted = (
            overrides: Partial<{ auditCause: AuditRecordId; idempotencySeed: string }>
        ) =>
            PreparedInvocation.create(
                {
                    id: header.id,
                    operation: header.operation,
                    domain: header.domain,
                    actor: header.actor,
                    authority: header.authority,
                    pathEpochs: header.pathEpochs,
                    lease: header.lease!,
                    auditCause: overrides.auditCause ?? header.auditCause,
                    idempotencySeed: overrides.idempotencySeed ?? header.idempotencySeed
                },
                { kind: "single", item: record.item(0).arguments },
                mediationPreparedCodecs
            );
        expect(
            gate.admits(
                {},
                substituted({
                    auditCause: identities.invocationAudit(new InvocationId("mediation-other"))
                })
            )
        ).toBe(false);
        expect(gate.admits({}, substituted({ idempotencySeed: "forged-seed" }))).toBe(false);
    });
});

describe("canonical mediation records", () => {
    it("chains invocation, attempt, and receipt audit evidence", { tags: "p0" }, () => {
        const record = prepared();
        const port = records();
        const invocationAudit = port.invocationAudit(record);
        const claim = port.claim(record, 0, undefined, new Date(1_000));
        const attempt = port.attempt(record, claim, admission(), new Date(1_100));
        const attemptAudit = port.attemptAudit(record, attempt);
        const receipt = port.attemptReceipt(attempt, "succeeded", new Date(1_200), undefined);
        const receiptAudit = port.receiptAudit(record, attemptAudit, receipt);

        expect(invocationAudit.id.equals(record.header.auditCause)).toBe(true);
        expect(invocationAudit.cause).toBeUndefined();
        expect(attempt.auditCause.equals(invocationAudit.id)).toBe(true);
        expect(attemptAudit.cause?.equals(invocationAudit.id)).toBe(true);
        expect(receiptAudit.cause?.equals(attemptAudit.id)).toBe(true);
        for (const audit of [invocationAudit, attemptAudit, receiptAudit]) {
            expect(audit.actor.equals(owner)).toBe(true);
            expect(audit.tenant.equals(tenant)).toBe(true);
            expect(audit.correlation.equals(invocationAudit.correlation)).toBe(true);
        }
    });

    it("causes a pre-effect denial Receipt from the Invocation root", { tags: "p0" }, () => {
        const record = prepared();
        const port = records();
        const claim = port.claim(record, 0, undefined, new Date(1_000));
        const denial = port.preEffectReceipt(record, claim, new Date(1_100), "denied");
        const audit = port.receiptAudit(record, undefined, denial);
        expect(denial.outcome).toBe("deniedPreEffect");
        expect(audit.cause?.equals(record.header.auditCause)).toBe(true);
    });

    it("recovers an expired claim under a different worker", { tags: "p0" }, () => {
        const record = prepared();
        const first = records(new ClaimWorkerId("worker-1")).claim(
            record,
            0,
            undefined,
            new Date(1_000)
        );
        const recovered = records(new ClaimWorkerId("worker-2")).claim(
            record,
            0,
            first,
            new Date(3_000)
        );
        expect(recovered.id.equals(first.id)).toBe(false);
        expect(recovered.attemptOrdinal).toBe(first.attemptOrdinal);
        expect(recovered.owner.worker.value).toBe("worker-2");
        // The same worker may not recover its own claim (§7.3).
        expect(() =>
            records(new ClaimWorkerId("worker-1")).claim(record, 0, first, new Date(3_000))
        ).toThrow(/different worker/u);
    });

    it("advances the ordinal only on retry after a failed attempt", { tags: "p0" }, () => {
        const record = prepared();
        const port = records();
        const claim = port.claim(record, 0, undefined, new Date(1_000));
        const attempt = port.attempt(record, claim, admission(), new Date(1_100));
        const retry = port.retryClaim(record, attempt, new Date(2_000));
        expect(retry.attemptOrdinal).toBe(1);
        expect(port.attempt(record, retry, admission(), new Date(2_100)).id.equals(attempt.id)).toBe(
            false
        );
    });

    it("refuses to author records for another Actor's Invocation", { tags: "p0" }, () => {
        const port = new CanonicalMediationRecords<string>(
            {
                actor: new ActorRef("run", new ActorId("other-run")),
                tenant,
                worker: new ClaimWorkerId("worker-1")
            },
            identities,
            1_000
        );
        expect(() => port.invocationAudit(prepared())).toThrow(/Actor that owns the Invocation/u);
    });

    it("rejects a non-positive claim lifetime", { tags: "p2" }, () => {
        for (const lifetime of [0, -1, 1.5, Number.NaN]) {
            expect(
                () =>
                    new CanonicalMediationRecords<string>(
                        { actor: owner, tenant, worker: new ClaimWorkerId("worker-1") },
                        identities,
                        lifetime
                    )
            ).toThrow(/positive safe integer/u);
        }
    });
});

describe("mediation claim ownership", () => {
    const gate = new MediationClaimOwnerAdmission<object, string>();

    function claimFor(owner_: ItemClaim<MediationLeaseReference>["owner"]) {
        return new ItemClaim<MediationLeaseReference>(
            new ItemClaimId("claim-1"),
            new InvocationId("mediation-invocation"),
            0,
            0,
            owner_,
            new Date(9_000)
        );
    }

    function attemptFor(
        claim: ItemClaim<MediationLeaseReference>,
        lease: MediationLeaseReference | undefined
    ) {
        return new EffectAttempt<MediationLeaseReference, string>(
            new EffectAttemptId("attempt-1"),
            claim.invocation,
            claim.itemIndex,
            claim.attemptOrdinal,
            claim.id,
            lease,
            admission(),
            new Date(1_000),
            "item-key",
            identities.invocationAudit(claim.invocation)
        );
    }

    it("admits an executor claim attempting under its own exact lease", { tags: "p0" }, () => {
        const claim = claimFor({
            kind: "executor",
            token: leaseReference(token),
            worker: new ClaimWorkerId("worker-1")
        });
        expect(gate.admits({}, claim, attemptFor(claim, leaseReference(token)))).toBe(true);
        expect(
            gate.admits(
                {},
                claim,
                attemptFor(claim, { ...leaseReference(token), epoch: token.epoch + 1 })
            )
        ).toBe(false);
        expect(gate.admits({}, claim, attemptFor(claim, undefined))).toBe(false);
    });

    it("refuses a system claim that borrows executor fencing", { tags: "p0" }, () => {
        const claim = claimFor({
            kind: "system",
            actor: owner,
            worker: new ClaimWorkerId("worker-1")
        });
        expect(gate.admits({}, claim, attemptFor(claim, undefined))).toBe(true);
        expect(gate.admits({}, claim, attemptFor(claim, leaseReference(token)))).toBe(false);
    });

    it("refuses an attempt that names a different claim position", { tags: "p0" }, () => {
        const claim = claimFor({
            kind: "system",
            actor: owner,
            worker: new ClaimWorkerId("worker-1")
        });
        const attempt = new EffectAttempt<MediationLeaseReference, string>(
            new EffectAttemptId("attempt-1"),
            claim.invocation,
            1,
            0,
            claim.id,
            undefined,
            admission(),
            new Date(1_000),
            "item-key",
            identities.invocationAudit(claim.invocation)
        );
        expect(gate.admits({}, claim, attempt)).toBe(false);
    });
});

describe("direct Operation context", () => {
    const content = new MemoryContentStore();
    const signal = new AbortController().signal;
    const context = new DerivedDirectOperationContext<string>(identities, () => ({
        signal,
        content
    }));

    it("carries no EffectAttempt and no target admission", { tags: "p0" }, () => {
        const value = context.context(
            new OperationRequestKey("direct-request"),
            0,
            { kind: "single" },
            "authorization"
        );
        expect(value.attempt).toBeUndefined();
        expect(value.targetAdmission).toBeUndefined();
        expect(value.invocation.value).toBe(identities.directInvocation("direct-request").value);
        expect(value.idempotencyKey).toBe(identities.directItemKey(value.invocation, 0));
        expect(value.content).toBe(content);
        expect(value.signal).toBe(signal);
    });

    it("refuses an item index outside its payload shape", { tags: "p0" }, () => {
        for (const [shape, itemIndex] of [
            [{ kind: "single" } as const, 1],
            [{ kind: "batch", itemCount: 2 } as const, 2],
            [{ kind: "batch", itemCount: 2 } as const, -1]
        ] as const) {
            expect(() =>
                context.context(new OperationRequestKey("direct-request"), itemIndex, shape, "a")
            ).toThrow(/payload shape/u);
        }
    });
});
