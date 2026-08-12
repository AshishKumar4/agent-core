import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { PathEpochEvidence, ScopeEpoch } from "../../src/authority";
import { ContentRef, Digest, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { PrincipalId, PrincipalRef, ScopeRef, TenantId } from "../../src/identity";
import {
    AttemptReceipt,
    AuthorityAdmissionReference,
    ClaimWorkerId,
    EffectAttempt,
    InvocationPlacementPin,
    ItemClaim,
    OperationPin,
    PreparedInvocation,
    RouteReservationId,
    type ItemClaimOwner
} from "../../src/invocations";
import { OperationRef } from "../../src/facets";
import { PackageId } from "../../src/definition";
import { SemVer } from "../../src/core";
import { TurnId } from "../../src/execution-references";
import {
    CanonicalMediationRecords,
    DerivedMediationIdentities,
    MediationClaimOwnerAdmission,
    domainReference,
    leaseReference,
    mediationPreparedCodecs,
    pathEpochReference,
    type MediationLeaseReference,
    type MediationPreparedInvocation
} from "../../src/composition";
import { ProtectionDomain } from "../../src/facets";
import type { LeaseToken } from "../../src/agents";

const tenant = new TenantId("records-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("records-principal"));
const actor = new ActorRef("run", new ActorId("records-run"));
const worker = new ClaimWorkerId("records-worker");
const domain = new ProtectionDomain("backend", "memory", "may-hold-secrets");
const token: LeaseToken = Object.freeze({
    turn: new TurnId("records-turn"),
    holder: principal,
    epoch: 5
});
const lease = leaseReference(token);
const identities = new DerivedMediationIdentities("records-scope");
const LIFETIME = 60_000;
const now = new Date(1_000_000);

function digest(character: string): Digest {
    return new Digest(character.repeat(64));
}

function records(overrides: { readonly actor?: ActorRef } = {}): CanonicalMediationRecords<string> {
    return new CanonicalMediationRecords(
        { actor: overrides.actor ?? actor, tenant, worker },
        identities,
        LIFETIME
    );
}

function operationPin(): OperationPin {
    return OperationPin.create({
        operation: new OperationRef("memory:recall"),
        target: "memory:primary",
        package: new PackageId("memory"),
        version: new SemVer("1.0.0"),
        manifestDigest: digest("f"),
        descriptorDigest: digest("e"),
        configurationDigest: digest("2"),
        runtimeDigest: digest("3"),
        activationGeneration: "generation-1",
        registration: "registration-1",
        impact: "observe",
        approvalRequired: false,
        placement: new InvocationPlacementPin({
            manifest: ["provider"],
            policy: ["provider"],
            substrate: ["provider"],
            trust: ["provider"],
            selected: "provider"
        })
    });
}

/**
 * `leased` is the ordinary executor case; `routed` carries no Lease, which is the state
 * a RouteReservation's durable record is in and the only way to reach the system claim
 * owner.
 */
function invocation(kind: "leased" | "routed"): MediationPreparedInvocation {
    const id = identities.directInvocation(`records-${kind}`);
    return PreparedInvocation.create(
        {
            id,
            operation: operationPin(),
            domain: domainReference(domain),
            actor,
            authority: {
                kind: "initiator" as const,
                tenant: tenant.value,
                principal: "records-principal",
                binding: "recall"
            },
            pathEpochs: pathEpochReference(
                new PathEpochEvidence([ScopeEpoch.initial(ScopeRef.tenant(tenant))])
            ),
            ...(kind === "leased"
                ? { lease }
                : {
                      route: new RouteReservationId("records-route"),
                      projectionDigest: digest("7")
                  }),
            auditCause: identities.invocationAudit(id),
            idempotencySeed: identities.idempotencySeed(id)
        },
        { kind: "single", item: { query: "parking" } },
        mediationPreparedCodecs
    );
}

const admissionCodec = Object.freeze({
    encode: (value: string): JsonValue => value,
    decode: (value: JsonValue): string => String(value)
});

function admissionReference(value: string): AuthorityAdmissionReference<string> {
    return new AuthorityAdmissionReference(
        value,
        Digest.sha256(encodeCanonicalJson(admissionCodec.encode(value)))
    );
}

function attemptFor(
    claim: ItemClaim<MediationLeaseReference>,
    record: MediationPreparedInvocation
): EffectAttempt<MediationLeaseReference, string> {
    return records().attempt(record, claim, admissionReference("admitted"), now);
}

describe("the ledger's claim-owner gate", () => {
    const gate = new MediationClaimOwnerAdmission<undefined, string>();
    const leased = invocation("leased");
    const claim = records().claim(leased, 0, undefined, now);
    const attempt = attemptFor(claim, leased);

    function claimWith(
        overrides: {
            readonly id?: ItemClaim<MediationLeaseReference>["id"];
            readonly invocation?: ItemClaim<MediationLeaseReference>["invocation"];
            readonly itemIndex?: number;
            readonly attemptOrdinal?: number;
            readonly owner?: ItemClaimOwner<MediationLeaseReference>;
        } = {}
    ): ItemClaim<MediationLeaseReference> {
        return new ItemClaim(
            overrides.id ?? claim.id,
            overrides.invocation ?? claim.invocation,
            overrides.itemIndex ?? claim.itemIndex,
            overrides.attemptOrdinal ?? claim.attemptOrdinal,
            overrides.owner ?? claim.owner,
            claim.expiresAt
        );
    }

    test("admits the attempt its own claim names", { tags: "p0" }, () => {
        expect(gate.admits(undefined, claim, attempt)).toBe(true);
    });

    test("refuses an attempt any part of the claim does not name", { tags: "p0" }, () => {
        // §7.3 admits an EffectAttempt only for the exact ItemClaim that names it. Each
        // operand is a different way two records could be paired wrongly: a claim taken
        // for another item, another Invocation, another retry, or simply another claim.
        // A comparison dropped here admits an attempt under a claim someone else holds.
        const elsewhere = invocation("routed");
        const variants = {
            id: claimWith({ id: identities.claim(claim.invocation, 9, 0, worker) }),
            invocation: claimWith({ invocation: elsewhere.header.id }),
            itemIndex: claimWith({ itemIndex: 1 }),
            attemptOrdinal: claimWith({ attemptOrdinal: 1 })
        };
        for (const [field, variant] of Object.entries(variants)) {
            expect(gate.admits(undefined, variant, attempt), field).toBe(false);
        }
    });

    test(
        "holds an executor attempt to the exact token its claim was taken with",
        { tags: "p0" },
        () => {
            // The claim's token is the fencing of §5.3. An attempt under a different epoch is
            // a stale executor still acting after its Lease moved on, and an attempt under no
            // token at all is a system worker borrowing an executor's claim.
            const stale = new EffectAttempt<MediationLeaseReference, string>(
                attempt.id,
                attempt.invocation,
                attempt.itemIndex,
                attempt.ordinal,
                attempt.claim,
                { ...lease, epoch: lease.epoch + 1 },
                attempt.admission,
                now,
                attempt.idempotencyKey,
                attempt.auditCause
            );
            expect(gate.admits(undefined, claim, stale)).toBe(false);

            const untokened = new EffectAttempt<MediationLeaseReference, string>(
                attempt.id,
                attempt.invocation,
                attempt.itemIndex,
                attempt.ordinal,
                attempt.claim,
                undefined,
                attempt.admission,
                now,
                attempt.idempotencyKey,
                attempt.auditCause
            );
            expect(gate.admits(undefined, claim, untokened)).toBe(false);
        }
    );

    test("refuses a system claim an attempt fences against", { tags: "p0" }, () => {
        // The mirror rule: a system claim carries no token, so an attempt presenting one
        // was not taken under that claim's authority.
        const routed = invocation("routed");
        const systemClaim = records().claim(routed, 0, undefined, now);
        const systemAttempt = attemptFor(systemClaim, routed);
        expect(systemClaim.owner.kind).toBe("system");
        expect(gate.admits(undefined, systemClaim, systemAttempt)).toBe(true);

        const fenced = new EffectAttempt<MediationLeaseReference, string>(
            systemAttempt.id,
            systemAttempt.invocation,
            systemAttempt.itemIndex,
            systemAttempt.ordinal,
            systemAttempt.claim,
            lease,
            systemAttempt.admission,
            now,
            systemAttempt.idempotencyKey,
            systemAttempt.auditCause
        );
        expect(gate.admits(undefined, systemClaim, fenced)).toBe(false);
    });
});

describe("mediation records carry the evidence their chain needs", () => {
    test(
        "takes a claim under the authority the Invocation was prepared with",
        { tags: "p0" },
        () => {
            // An Invocation carrying a Lease is claimed by that executor and fences under its
            // token; a routed Invocation carries none and is claimed by this worker as the
            // system. Naming the wrong one either strands a claim no attempt can satisfy or
            // hands an executor's fencing to a system worker.
            const executor = records().claim(invocation("leased"), 0, undefined, now);
            expect(executor.owner).toEqual({ kind: "executor", token: lease, worker });

            const system = records().claim(invocation("routed"), 0, undefined, now);
            expect(system.owner).toEqual({ kind: "system", actor, worker });
        }
    );

    test("gives a retried claim a fresh lifetime and the next ordinal", { tags: "p0" }, () => {
        // A retry is a new claim over the same item, so it takes the ordinal that
        // separates it from the attempt it follows and an expiry the retrying worker can
        // actually act within — an expiry behind `now` is a claim dead on arrival.
        const leased = invocation("leased");
        const first = records().claim(leased, 0, undefined, now);
        const previous = attemptFor(first, leased);
        const retry = records().retryClaim(leased, previous, now);

        expect(retry.attemptOrdinal).toBe(previous.ordinal + 1);
        expect(retry.expiresAt.getTime()).toBe(now.getTime() + LIFETIME);
        expect(() => retry.requireFuture(now)).not.toThrow();
        expect(retry.id.equals(first.id)).toBe(false);
    });

    test("refuses a claim lifetime that is not a positive duration", { tags: "p1" }, () => {
        for (const lifetime of [0, -1, 1.5, Number.NaN]) {
            expect(
                () =>
                    new CanonicalMediationRecords({ actor, tenant, worker }, identities, lifetime),
                String(lifetime)
            ).toThrow(TypeError);
        }
    });

    test("supersedes a Receipt with one naming what it replaced", { tags: "p0" }, () => {
        // §7.4 reconciliation replaces an indeterminate Receipt rather than deleting it,
        // so the new Receipt has to name the old one and carry the settled outcome.
        const leased = invocation("leased");
        const claim = records().claim(leased, 0, undefined, now);
        const attempt = attemptFor(claim, leased);
        const indeterminate = records().attemptReceipt(attempt, "indeterminate", now, undefined);
        const result = new ContentRef(`sha256:${"a".repeat(64)}`);
        const reconciled = records().reconciledReceipt(
            attempt,
            indeterminate,
            { kind: "succeeded", result },
            now
        );

        expect(reconciled).toBeInstanceOf(AttemptReceipt);
        expect(reconciled.outcome).toBe("succeeded");
        expect(reconciled.previous?.equals(indeterminate.id)).toBe(true);
        expect(reconciled.result?.value).toBe(result.value);
        expect(reconciled.attempt.equals(attempt.id)).toBe(true);
        expect(reconciled.id.equals(indeterminate.id)).toBe(false);
    });

    test("chains each audit record to the record that caused it", { tags: "p0" }, () => {
        // The §7.4 chain: the Invocation root causes each attempt record, each attempt
        // record causes its Receipt record, and a supersession record is caused by the
        // Receipt record it supersedes. The root itself has no cause — an audit root
        // carrying one is not a root.
        const leased = invocation("leased");
        const claim = records().claim(leased, 0, undefined, now);
        const attempt = attemptFor(claim, leased);
        const invocationAudit = records().invocationAudit(leased);
        expect(invocationAudit.cause).toBeUndefined();
        expect(invocationAudit.kind).toEqual({ kind: "invocation", id: leased.header.id });
        expect(invocationAudit.actor.equals(actor)).toBe(true);
        expect(invocationAudit.tenant.equals(tenant)).toBe(true);
        expect(invocationAudit.correlation.equals(identities.correlation(leased.header.id))).toBe(
            true
        );

        const attemptAudit = records().attemptAudit(leased, attempt);
        expect(attemptAudit.cause?.equals(invocationAudit.id)).toBe(true);

        const receipt = records().attemptReceipt(attempt, "indeterminate", now, undefined);
        const receiptAudit = records().receiptAudit(leased, attemptAudit, receipt);
        expect(receiptAudit.cause?.equals(attemptAudit.id)).toBe(true);

        // A pre-effect denial has no attempt, so its Receipt record roots at the
        // Invocation directly rather than dangling.
        const denial = records().preEffectReceipt(leased, claim, now, "denied");
        expect(denial.outcome).toBe("deniedPreEffect");
        expect(
            records()
                .receiptAudit(leased, undefined, denial)
                .cause?.equals(leased.header.auditCause)
        ).toBe(true);

        const next = records().reconciledReceipt(
            attempt,
            records().attemptReceipt(attempt, "indeterminate", now, undefined),
            { kind: "failed" },
            now
        );
        const supersession = records().receiptSupersessionAudit(
            leased,
            receiptAudit,
            receipt,
            next
        );
        expect(supersession.cause?.equals(receiptAudit.id)).toBe(true);
        expect(supersession.kind).toEqual({
            kind: "receiptSuperseded",
            previous: receipt.id,
            next: next.id
        });
    });

    test("refuses to mint records for another Actor's Invocation", { tags: "p0" }, () => {
        // Audit records are written under this pipeline's own Actor and Tenant. Minting
        // one for an Invocation another Actor owns would attribute that Actor's effect to
        // this one, so the refusal is the ledger's own denial rather than a crash.
        const foreign = records({ actor: new ActorRef("run", new ActorId("other-run")) });
        expect(() => foreign.invocationAudit(invocation("leased"))).toThrow(
            expect.objectContaining({
                code: "invocation.invalid",
                message: "Mediation records belong to the Actor that owns the Invocation"
            })
        );
    });
});
