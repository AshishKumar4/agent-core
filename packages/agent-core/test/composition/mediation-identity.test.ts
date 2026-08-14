import { describe, expect, test } from "vitest";
import { DerivedMediationIdentities } from "../../src/composition";
import { Digest, JsonSchema } from "../../src/core";
import { FacetRef, OperationDescriptor, OperationName } from "../../src/facets";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { ClaimWorkerId, EffectAttemptId, InvocationId, ReceiptId } from "../../src/invocations";
import { OperationRequestKey } from "../../src/operations";
import type {
    MediatedInvocationPreflight,
    MediatedReplayBinding,
    OperationPayloadCardinality
} from "../../src/operations";

const schema = new JsonSchema({ type: "object" });

function digest(character: string): Digest {
    return new Digest(character.repeat(64));
}

function descriptor(name = "recall"): OperationDescriptor {
    return new OperationDescriptor(
        new OperationName(name),
        "observe",
        schema,
        schema,
        "Perform recall."
    );
}

function replayBinding(): MediatedReplayBinding {
    return {
        principal: new PrincipalRef(
            new TenantId("identity-tenant"),
            new PrincipalId("identity-principal")
        ),
        authorityIdentity: digest("a"),
        packageOperationPin: digest("b"),
        execution: { kind: "lease", digest: digest("c") }
    };
}

function preflight(
    overrides: Partial<MediatedInvocationPreflight<undefined>> = {}
): MediatedInvocationPreflight<undefined> {
    return {
        requestKey: new OperationRequestKey("identity-request"),
        facet: new FacetRef("memory:primary"),
        descriptor: descriptor(),
        cardinality: { kind: "single" },
        inputs: [{ query: "parking" }],
        authorization: undefined,
        replayBinding: replayBinding(),
        ...overrides
    };
}

function bound(binding: Partial<MediatedReplayBinding>): MediatedInvocationPreflight<undefined> {
    return preflight({ replayBinding: { ...replayBinding(), ...binding } });
}

const identities = new DerivedMediationIdentities("identity-scope");
const invocation = new InvocationId("agent-core.identity.invocation.v1:" + "1".repeat(64));
const other = new InvocationId("agent-core.identity.invocation.v1:" + "2".repeat(64));
const attempt = new EffectAttemptId("agent-core.identity.effect-attempt.v1:" + "3".repeat(64));
const receipt = new ReceiptId("agent-core.identity.attempt-receipt.v1:" + "4".repeat(64));
const superseding = new ReceiptId("agent-core.identity.attempt-receipt.v1:" + "6".repeat(64));

describe("mediation identifiers derive from the evidence that determines them", () => {
    test("recomputes every identifier from the same evidence", { tags: "p0" }, () => {
        // Restartability (§7.3): a worker that crashes between minting an identifier and
        // persisting the record it names must recompute the identifier, not mint a second
        // identity for one item. A second instance of the port is that restarted worker.
        const restarted = new DerivedMediationIdentities("identity-scope");
        expect(restarted.invocation(preflight()).value).toBe(
            identities.invocation(preflight()).value
        );
        expect(restarted.idempotencySeed(invocation)).toBe(identities.idempotencySeed(invocation));
        expect(restarted.claim(invocation, 0, 0, new ClaimWorkerId("w")).value).toBe(
            identities.claim(invocation, 0, 0, new ClaimWorkerId("w")).value
        );
        expect(restarted.attempt(invocation, 0, 0).value).toBe(
            identities.attempt(invocation, 0, 0).value
        );
    });

    test("mints a different Invocation for every bound field", { tags: "p0" }, () => {
        // Each field named in the derivation is a field a caller can change, and changing
        // any one of them is a different intent that must reserve a different Invocation
        // rather than replay this one. Grouping them in one test is deliberate: the
        // property is that the *set* is complete, so a field dropped from the derivation
        // has to fail here rather than in a test nobody wrote for it.
        const base = identities.invocation(preflight()).value;
        const variants = {
            requestKey: preflight({ requestKey: new OperationRequestKey("other-request") }),
            facet: preflight({ facet: new FacetRef("memory:secondary") }),
            descriptor: preflight({ descriptor: descriptor("forget") }),
            inputs: preflight({ inputs: [{ query: "garage" }] }),
            tenant: bound({
                principal: new PrincipalRef(
                    new TenantId("other-tenant"),
                    new PrincipalId("identity-principal")
                )
            }),
            principal: bound({
                principal: new PrincipalRef(
                    new TenantId("identity-tenant"),
                    new PrincipalId("other-principal")
                )
            }),
            authorityIdentity: bound({ authorityIdentity: digest("9") }),
            packageOperationPin: bound({ packageOperationPin: digest("8") }),
            executionDigest: bound({ execution: { kind: "lease", digest: digest("7") } }),
            executionKind: bound({ execution: { kind: "route", digest: digest("c") } })
        };
        const minted = new Map<string, string>();
        for (const [field, request] of Object.entries(variants)) {
            const value = identities.invocation(request).value;
            expect(value, `${field} does not bind the Invocation`).not.toBe(base);
            expect(
                minted.get(value),
                `${field} collides with ${minted.get(value)}`
            ).toBeUndefined();
            minted.set(value, field);
        }
    });

    test("binds the Invocation to the mediation scope", { tags: "p0" }, () => {
        // Two Actors running the same pipeline see the same request key over the same
        // intent. The scope is what keeps their Invocations apart, so it is evidence.
        const elsewhere = new DerivedMediationIdentities("other-scope");
        expect(elsewhere.invocation(preflight()).value).not.toBe(
            identities.invocation(preflight()).value
        );
        expect(elsewhere.directInvocation("key")).not.toBe(identities.directInvocation("key"));
    });

    test("separates a single payload from its one-item batch", { tags: "p0" }, () => {
        // The shape is bound, not inferred from the input count: a one-item batch and a
        // single carry identical inputs, so without the shape in the derivation the two
        // reserve one Invocation and the second caller replays a result whose payload
        // shape it never asked for.
        const batch: OperationPayloadCardinality = { kind: "batch", itemCount: 1 };
        expect(identities.invocation(preflight({ cardinality: batch })).value).not.toBe(
            identities.invocation(preflight()).value
        );
    });

    test("separates every derivation that reads one Invocation", { tags: "p0" }, () => {
        // idempotencySeed, correlation and invocationAudit read exactly the same evidence
        // — the InvocationId — so only the domain separates them. They are three different
        // things about one Invocation and must never collide.
        const derived = [
            identities.idempotencySeed(invocation),
            identities.correlation(invocation).value,
            identities.invocationAudit(invocation).value
        ];
        expect(new Set(derived).size).toBe(derived.length);
    });

    test("binds every per-Invocation derivation to its Invocation", { tags: "p0" }, () => {
        // The evidence, not the domain, is what makes two Invocations' records distinct:
        // a derivation that dropped its evidence would still be domain-separated from its
        // siblings while collapsing every Invocation onto one identifier.
        expect(identities.idempotencySeed(other)).not.toBe(identities.idempotencySeed(invocation));
        expect(identities.correlation(other).value).not.toBe(
            identities.correlation(invocation).value
        );
        expect(identities.invocationAudit(other).value).not.toBe(
            identities.invocationAudit(invocation).value
        );
        expect(identities.directItemKey(other, 0)).not.toBe(
            identities.directItemKey(invocation, 0)
        );
    });

    test("separates the items of one direct Invocation", { tags: "p0" }, () => {
        // A direct Invocation persists nothing, but its items still run under distinct
        // keys: the item index is the only evidence that tells them apart.
        expect(identities.directItemKey(invocation, 1)).not.toBe(
            identities.directItemKey(invocation, 0)
        );
    });

    test("binds a direct Invocation to its request key", { tags: "p0" }, () => {
        expect(identities.directInvocation("second")).not.toBe(
            identities.directInvocation("first")
        );
        // A direct Invocation is minted under its own domain, so it can never be mistaken
        // for the mediated Invocation of the same request key.
        expect(identities.directInvocation("identity-request").value).not.toBe(
            identities.invocation(preflight()).value
        );
    });

    test("separates the claims that legitimately coexist for one item", { tags: "p0" }, () => {
        // Recovery requires a different worker, retry a different ordinal, and a batch
        // holds one claim per item. Each of those is what distinguishes two live claims,
        // so each must reach the derivation.
        const worker = new ClaimWorkerId("worker-1");
        const base = identities.claim(invocation, 0, 0, worker).value;
        const claims = [
            base,
            identities.claim(invocation, 1, 0, worker).value,
            identities.claim(invocation, 0, 1, worker).value,
            identities.claim(invocation, 0, 0, new ClaimWorkerId("worker-2")).value,
            identities.claim(other, 0, 0, worker).value
        ];
        expect(new Set(claims).size).toBe(claims.length);
    });

    test("separates the attempts and Receipts of one item", { tags: "p0" }, () => {
        // The attempt ordinal separates retries; the outcome separates a superseded
        // Receipt from the indeterminate one it replaces.
        const attempts = [
            identities.attempt(invocation, 0, 0).value,
            identities.attempt(invocation, 1, 0).value,
            identities.attempt(invocation, 0, 1).value,
            identities.attempt(other, 0, 0).value
        ];
        expect(new Set(attempts).size).toBe(attempts.length);

        const receipts = [
            identities.attemptReceipt(attempt, "succeeded").value,
            identities.attemptReceipt(attempt, "failed").value,
            identities.attemptReceipt(attempt, "indeterminate").value,
            identities.preEffectReceipt(invocation, 0, "deniedPreEffect").value,
            identities.preEffectReceipt(invocation, 0, "cancelledPreEffect").value,
            identities.preEffectReceipt(invocation, 1, "deniedPreEffect").value,
            identities.preEffectReceipt(other, 0, "deniedPreEffect").value
        ];
        expect(new Set(receipts).size).toBe(receipts.length);
    });

    test("binds each audit record to the record it describes", { tags: "p0" }, () => {
        // The audit chain of §7.4 is only a chain if each link names one record. An audit
        // derivation that dropped its evidence would give every attempt in a batch the
        // same AuditRecordId and collapse the chain onto a single node.
        const second = new EffectAttemptId(
            "agent-core.identity.effect-attempt.v1:" + "5".repeat(64)
        );
        expect(identities.attemptAudit(second).value).not.toBe(
            identities.attemptAudit(attempt).value
        );

        expect(identities.receiptAudit(superseding).value).not.toBe(
            identities.receiptAudit(receipt).value
        );

        // Supersession is directional: the record for "receipt supersedes superseding" is
        // not the record for the reverse, so both operands are evidence.
        expect(identities.supersessionAudit(receipt, superseding).value).not.toBe(
            identities.supersessionAudit(superseding, receipt).value
        );
        expect(identities.supersessionAudit(receipt, superseding).value).not.toBe(
            identities.receiptAudit(superseding).value
        );
    });

    test("pins the derived identifiers of a stable evidence set", { tags: "p0" }, () => {
        // These identifiers are durable: they name records already in storage, so the
        // derivation is a wire format and a change to it forks the identity of every
        // record a running deployment has already written. Distinctness tests cannot see
        // that — a uniformly relabelled derivation stays distinct — so the vectors are
        // pinned. A diff here is a migration question, never a refactor.
        expect(identities.invocation(preflight()).value).toBe(
            "agent-core.identity.invocation.v1:" +
                "5732ed80ae8ad7c008a4c4ea0b07f12dc3a41826de1e4870d0e7639fbb154a0d"
        );
        expect(
            identities.invocation(preflight({ cardinality: { kind: "batch", itemCount: 1 } })).value
        ).toBe(
            "agent-core.identity.invocation.v1:" +
                "2971b6a834c5812522e47d9b900dfb126dfa9d9cb9a422bf9e0240fd17b12769"
        );
        expect(identities.directInvocation("identity-request").value).toBe(
            "agent-core.identity.direct-invocation.v1:" +
                "f9998e1a0728ce1737474c7905956516d8e79d89a88155cb0063ac785508c0b5"
        );
        expect(identities.directItemKey(invocation, 0)).toBe(
            "agent-core.identity.direct-item.v1:" +
                "69a632eef295e4c7baae20ece87e0324c9089cf3abb19848647da3cec0ead1e9"
        );
        expect(identities.idempotencySeed(invocation)).toBe(
            "agent-core.identity.idempotency-seed.v1:" +
                "8e1e38f82517e09386d46593ccf0b7dc8c871c80d5e89cea5cfc295a886d04c7"
        );
        expect(identities.correlation(invocation).value).toBe(
            "agent-core.identity.correlation.v1:" +
                "6bbb6ed257810107301d11beff5e67ca3f0216b95b11221e9e980ee70743a1f1"
        );
        expect(identities.claim(invocation, 0, 0, new ClaimWorkerId("worker-1")).value).toBe(
            "agent-core.identity.item-claim.v1:" +
                "67343456f5dbd2622979f9394be8929717b31d04ded4aada3bfed48b4002a9a4"
        );
        expect(identities.attempt(invocation, 0, 0).value).toBe(
            "agent-core.identity.effect-attempt.v1:" +
                "a60467e582cf4223f388d359bc8269d2a339df2d4ed08a532c007f614f363529"
        );
        expect(identities.preEffectReceipt(invocation, 0, "deniedPreEffect").value).toBe(
            "agent-core.identity.pre-effect-receipt.v1:" +
                "e8a6c9082852dcf261b2d4a6b87c4a47787b94fa11a7683c6a7daa8e0fe02cff"
        );
        expect(identities.attemptReceipt(attempt, "succeeded").value).toBe(
            "agent-core.identity.attempt-receipt.v1:" +
                "349b81e8ee1d85314d985bc635c00476d1237b85b9f442e587688b055811457b"
        );
        expect(identities.invocationAudit(invocation).value).toBe(
            "agent-core.identity.invocation-audit.v1:" +
                "dc86f18bfda573d69db4c8f0e4836909432eeeaf0a38dbbd116208b19aa02d85"
        );
        expect(identities.attemptAudit(attempt).value).toBe(
            "agent-core.identity.attempt-audit.v1:" +
                "bc1ede3437d2bd2ac81c2db83e37ae01a868d1f88913e49b59b9a2c4d9a455ad"
        );
        expect(identities.receiptAudit(receipt).value).toBe(
            "agent-core.identity.receipt-audit.v1:" +
                "e65b38ff50c3a2532723e6a01488affd25d4589d51045bc409d7e3e8e522c4f4"
        );
        expect(identities.supersessionAudit(receipt, superseding).value).toBe(
            "agent-core.identity.supersession-audit.v1:" +
                "4037089ed6e1cc2751b7e1381ec024ce99bde7e0136c62e852e2c72fd4ad7225"
        );
    });

    test("refuses a mediation scope that is not canonical", { tags: "p1" }, () => {
        expect(() => new DerivedMediationIdentities("")).toThrow(TypeError);
        expect(() => new DerivedMediationIdentities("   ")).toThrow(TypeError);
        expect(() => new DerivedMediationIdentities(" scope")).toThrow(TypeError);
        expect(() => new DerivedMediationIdentities("scope ")).toThrow(TypeError);
    });
});
