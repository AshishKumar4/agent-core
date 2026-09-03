import { describe, expect, test } from "vitest";
import { MemoryContentStore } from "../../src/content";
import { Digest, JsonSchema, encodeCanonicalJson } from "../../src/core";
import {
    FacetRef,
    Operation,
    OperationDescriptor,
    OperationName,
    OperationRef,
    type FacetData,
    type OperationContext
} from "../../src/facets";
import { InvocationId } from "../../src/interaction-references";
import { EffectAttemptId } from "../../src/invocation-references";
import {
    AdmittedInvocationItem,
    AttemptCancellationObservation,
    PreparedItem,
    type InvocationTransactionPort,
    type OperationPin
} from "../../src/invocations";
import type { ValidatedFacetRuntime } from "../../src/operations";
import { FacetRuntimeHost } from "../../src/operations/internal";
import {
    DetachedMediationTarget,
    type MediationPersistence,
    type MediationPreparedInvocation
} from "../../src/composition";
import { forwarded, reaching } from "./fixture";
import { expectAgentCoreError, expectAgentCoreRejection } from "../protocol/error-assertion";

/** The one transaction shape this target opens; nothing here reads it. */
type Read = Record<never, never>;

/** The Facet a validated runtime answers with, which is what the pin resolves against. */
type CorrespondentFacet = ValidatedFacetRuntime["facets"][number];

const schema = new JsonSchema({ type: "object" });
const facet = new FacetRef("memory:primary");
const operationRef = new OperationRef("memory:recall");
const invocation = new InvocationId("detached-invocation");
const attempt = new EffectAttemptId("detached-attempt");
const second = new EffectAttemptId("detached-attempt-2");
const items = [
    new PreparedItem({ query: "parking" }, "detached-item-0"),
    new PreparedItem({ query: "garage" }, "detached-item-1")
];

/** The Operation the pin names, answering with exactly the arguments it was handed. */
class Recall extends Operation {
    public readonly descriptor = new OperationDescriptor(
        new OperationName("recall"),
        "observe",
        schema,
        schema,
        "Perform recall."
    );

    public execute(_context: OperationContext, input: FacetData): Promise<FacetData> {
        return Promise.resolve(input);
    }
}

/** An Operation declared under the pinned name whose declared shape has since moved. */
class DriftedRecall extends Operation {
    public readonly descriptor = new OperationDescriptor(
        new OperationName("recall"),
        "observe",
        schema,
        new JsonSchema({ type: "string" }),
        "Perform recall."
    );

    public execute(_context: OperationContext, input: FacetData): Promise<FacetData> {
        return Promise.resolve(input);
    }
}

interface TargetOptions {
    /** The Operation the live runtime declares under the pinned name, if it declares one. */
    readonly declares?: Operation;
    /** The stored PreparedInvocation a detached item's Invocation resolves to. */
    readonly stored?: MediationPreparedInvocation;
}

/** The target plus the one live fact its resources report: whether this host still hosts the
pinned Facet. */
interface Harness {
    readonly target: DetachedMediationTarget<Read, undefined>;
    /** Flipped to withdraw the pinned Facet from under a rebuilt execution. */
    readonly hosting: { current: boolean };
}

const recall = new Recall();
const descriptorDigest = Digest.sha256(encodeCanonicalJson(recall.descriptor.toData()));
const pin = reaching<OperationPin>({
    target: facet.value,
    operation: operationRef,
    descriptorDigest
});

function stored(itemCount = items.length): MediationPreparedInvocation {
    return reaching<MediationPreparedInvocation>({
        header: reaching<MediationPreparedInvocation["header"]>({ operation: pin }),
        itemCount,
        item: (index: number): PreparedItem => {
            const item = items[index];
            if (item === undefined) throw new TypeError(`No stored item ${index}`);
            return item;
        }
    });
}

function admitted(itemIndex: number, itemKey: string): AdmittedInvocationItem {
    return new AdmittedInvocationItem({ invocation, itemIndex, itemKey, attempt });
}

function harness(options: TargetOptions = {}): Harness {
    const hosting = { current: true };
    const runtime = reaching<CorrespondentFacet>({
        operation: (name: OperationName): Operation | undefined =>
            options.declares !== undefined && name.value === "recall" ? options.declares : undefined
    });
    const target = new DetachedMediationTarget<Read, undefined>(
        reaching<FacetRuntimeHost>({
            facet: (ref: FacetRef): CorrespondentFacet | undefined =>
                hosting.current && ref.equals(facet) ? runtime : undefined
        }),
        reaching<InvocationTransactionPort<Read>>({
            transact: <Result>(operation: (transaction: Read) => Result): Result => operation({})
        }),
        reaching<MediationPersistence<Read, undefined>>({
            prepared: () => options.stored
        }),
        new MemoryContentStore()
    );
    return { target, hosting };
}

describe("the detached mediation target rebuilds live work from durable records", () => {
    test(
        "runs the stored arguments of the exact item under the attempt's own controller",
        { tags: "p0" },
        async () => {
            // SPEC §5.6: a detached item outlives its Turn, so the execution is rebuilt from
            // the PreparedInvocation alone. The item index selects which stored arguments run,
            // and the signal is the one `cancel` fires — an execution running under any other
            // signal would make a reached cancellation advisory.
            const detached = harness({ declares: recall, stored: stored() }).target;
            const execution = await detached.execution(admitted(1, "detached-item-1"));

            expect(execution.descriptor).toBe(recall.descriptor);
            expect(execution.targetAdmission).toBeUndefined();
            expect(execution.resources.deadline).toBeUndefined();
            expect(execution.resources.target.answering()).toBe(true);
            const context = forwarded<OperationContext>("The detached Operation context");
            expect(await execution.execute(1, context)).toEqual({ query: "garage" });
            expect(await execution.execute(0, context)).toEqual({ query: "parking" });

            expect(execution.resources.signal.aborted).toBe(false);
            expect(await detached.cancel(attempt)).toBe(AttemptCancellationObservation.reached);
            expect(execution.resources.signal.aborted).toBe(true);
        }
    );

    test("holds one controller per in-flight attempt", { tags: "p0" }, async () => {
        // The controllers are keyed by EffectAttemptId because that is the identity a Run's
        // cancellation message names. A second controller for one attempt would leave the
        // running effect on a signal the cancellation never fires.
        const detached = harness({ declares: recall, stored: stored() }).target;
        const controller = detached.controller(attempt);
        expect(detached.controller(attempt)).toBe(controller);
        expect(detached.controller(second)).not.toBe(controller);

        expect(await detached.cancel(attempt)).toBe(AttemptCancellationObservation.reached);
        expect(controller.signal.aborted).toBe(true);
        expect(detached.controller(second).signal.aborted).toBe(false);
    });

    test("answers `absent` for an attempt no controller survived", { tags: "p0" }, async () => {
        // §7.4 leaves an attempt nobody aborted for reconciliation, so a cancellation after a
        // restart reports what actually happened: no live effect was reached. Deriving
        // `reached` from the request would record an abort no running effect observed.
        const detached = harness({ declares: recall, stored: stored() }).target;
        expect(await detached.cancel(attempt)).toBe(AttemptCancellationObservation.absent);

        const controller = detached.controller(attempt);
        detached.restart();
        expect(await detached.cancel(attempt)).toBe(AttemptCancellationObservation.absent);
        expect(controller.signal.aborted).toBe(false);
        expect(detached.controller(attempt)).not.toBe(controller);
    });

    test("refuses a detached item its own records do not bind", { tags: "p0" }, async () => {
        // The two records are what the rebuild stands on. Without the PreparedInvocation
        // there is nothing to run, and an item key that does not match the stored item
        // means this attempt belongs to different frozen intent — running it would execute
        // one item's arguments under another item's admission.
        await expectAgentCoreRejection(
            harness({ declares: recall }).target.execution(admitted(0, "detached-item-0")),
            "invocation.invalid",
            /names no stored PreparedInvocation/u
        );
        await expectAgentCoreRejection(
            harness({ declares: recall, stored: stored() }).target.execution(
                admitted(0, "detached-item-1")
            ),
            "invocation.invalid",
            /does not bind its PreparedInvocation item/u
        );

        // The execution answers for exactly the items its Invocation holds. A request for
        // one beyond them is refused rather than run with no arguments at all.
        const single = harness({ declares: recall, stored: stored(1) });
        const execution = await single.target.execution(admitted(0, "detached-item-0"));
        expectAgentCoreError(
            () => execution.execute(1, forwarded<OperationContext>("The context")),
            "invocation.invalid",
            /requested an item its Invocation does not hold/u
        );
    });

    test("refuses a pin the live Facet runtime no longer answers", { tags: "p0" }, async () => {
        // The pin is verified against the live runtime before anything runs, because the
        // descriptor is the authority for §7.4's `outputInvalid`. A Facet that is gone, an
        // Operation that is no longer declared, and a declaration whose shape has drifted are
        // three different facts about one item, and each belongs to its own reconciliation
        // rather than to an execution under a descriptor the Invocation never admitted.
        const withdrawn = harness({ declares: recall, stored: stored() });
        withdrawn.hosting.current = false;
        await expectAgentCoreRejection(
            withdrawn.target.execution(admitted(0, "detached-item-0")),
            "facet.inactive",
            /is no longer active/u
        );
        await expectAgentCoreRejection(
            harness({ stored: stored() }).target.execution(admitted(0, "detached-item-0")),
            "operation.missing",
            /is not declared/u
        );
        await expectAgentCoreRejection(
            harness({ declares: new DriftedRecall(), stored: stored() }).target.execution(
                admitted(0, "detached-item-0")
            ),
            "invocation.invalid",
            /descriptor differs from its pin/u
        );
    });

    test("reports the pinned Facet's hosting as the target's own", { tags: "p1" }, async () => {
        // §7.4 reads `domainLost` off the domain hosting the target, and this seam is where a
        // detached execution answers it: the witness is this host's own hosting of that exact
        // Facet, read when asked rather than frozen when the execution was rebuilt. A snapshot
        // taken at rebuild time would report a withdrawn Facet as still answering, which is
        // exactly the fact §7.4 needs from a detached item that outlived its Turn.
        const value = harness({ declares: recall, stored: stored() });
        const execution = await value.target.execution(admitted(0, "detached-item-0"));
        expect(execution.resources.target.answering()).toBe(true);

        value.hosting.current = false;
        expect(execution.resources.target.answering()).toBe(false);
    });
});
