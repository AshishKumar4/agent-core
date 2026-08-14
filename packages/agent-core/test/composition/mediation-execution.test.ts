import { describe, expect, test } from "vitest";
import { MemoryContentStore } from "../../src/content";
import { OperationRequestKey, type OperationPayloadCardinality } from "../../src/operations";
import { DerivedDirectOperationContext, DerivedMediationIdentities } from "../../src/composition";

const identities = new DerivedMediationIdentities("execution-scope");
const content = new MemoryContentStore();
const signal = new AbortController().signal;
const context = new DerivedDirectOperationContext<string>(identities, () => ({ signal, content }));
const requestKey = new OperationRequestKey("direct-request");

describe("the direct tier's Operation context", () => {
    test("carries no EffectAttempt and no target admission", { tags: "p0" }, () => {
        // §7.2: a direct Invocation creates no durable Invocation, Receipt or replay
        // record. A context carrying an attempt or a target admission would let a direct
        // dispatch present itself as mediated evidence.
        const value = context.context(requestKey, 0, { kind: "single" }, "authorization");
        expect(value.attempt).toBeUndefined();
        expect(value.targetAdmission).toBeUndefined();
        expect(value.invocation.value).toBe(identities.directInvocation("direct-request").value);
        expect(value.idempotencyKey).toBe(identities.directItemKey(value.invocation, 0));
        expect(value.content).toBe(content);
        expect(value.signal).toBe(signal);
    });

    test("names the same call for a repeated direct dispatch", { tags: "p1" }, () => {
        // The identity is derived from the request key, so a retried direct dispatch is
        // the same call rather than a second one.
        expect(context.context(requestKey, 0, { kind: "single" }, "a").invocation.value).toBe(
            context.context(requestKey, 0, { kind: "single" }, "b").invocation.value
        );
        expect(
            context.context(new OperationRequestKey("other-request"), 0, { kind: "single" }, "a")
                .invocation.value
        ).not.toBe(context.context(requestKey, 0, { kind: "single" }, "a").invocation.value);
    });

    test("gives every item of a batch its own context", { tags: "p0" }, () => {
        // A batch's item count comes from the shape, not from the single tier's one item.
        // Reading it as 1 would refuse every item after the first, so a batch could never
        // run past index 0 — and each item still needs its own idempotency key.
        const cardinality: OperationPayloadCardinality = { kind: "batch", itemCount: 3 };
        const keys = [0, 1, 2].map((itemIndex) => {
            const value = context.context(requestKey, itemIndex, cardinality, "a");
            expect(value.itemIndex).toBe(itemIndex);
            return value.idempotencyKey;
        });
        expect(new Set(keys).size).toBe(keys.length);
    });

    test("refuses an item index outside its payload shape", { tags: "p0" }, () => {
        for (const [cardinality, itemIndex] of [
            [{ kind: "single" } as const, 1],
            [{ kind: "batch", itemCount: 2 } as const, 2],
            [{ kind: "batch", itemCount: 2 } as const, -1],
            [{ kind: "batch", itemCount: 2 } as const, 1.5]
        ] as const) {
            expect(
                () => context.context(requestKey, itemIndex, cardinality, "a"),
                String(itemIndex)
            ).toThrow(/payload shape/u);
        }
    });
});
