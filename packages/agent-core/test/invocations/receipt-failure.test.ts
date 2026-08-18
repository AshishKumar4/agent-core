import { describe, expect, test } from "vitest";
import {
    ContentRef,
    Digest,
    JsonSchema,
    encodeCanonicalJson,
    type JsonObject,
    type JsonValue
} from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { OperationDescriptor, OperationName, type FacetData } from "../../src/facets";
import {
    AttemptCompletion,
    AttemptFailureKind,
    AttemptReceipt,
    EffectAttemptId,
    PreEffectReceipt,
    Receipt,
    ReceiptId,
    deriveBatchOutcome,
    type AttemptTargetDomain,
    type CanonicalBatchInvocationRequest
} from "../../src/invocations";
import { InvocationId } from "../../src/interaction-references";
import { outsideVocabulary } from "./fixture";
import { ConfirmedOperationFailure, OperationRequestKey } from "../../src/operations";
import {
    CanonicalBatchHarness as Harness,
    canonicalBatchDescriptor as descriptor,
    canonicalBatchFacet as facet
} from "../integration/canonical-batch-harness";

const answering: AttemptTargetDomain = { answering: (): boolean => true };
const lost: AttemptTargetDomain = { answering: (): boolean => false };
const open = new AbortController().signal;
const cancelled = AbortSignal.abort();
const past = new Date(1_000);
const later = new Date(2_000);
const evidence = ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode("confirmation")));

function time(value: number): Date {
    return new Date(value);
}

describe("§7.4 attempt failure kinds", () => {
    test(
        "[C13-RECEIPT-FAILURE-KIND] admits each kind only from the fact that defines it",
        { tags: "p0" },
        () => {
            // The whole taxonomy, asserted in one pass so a run describes the shape of any gap
            // rather than only its first edge.
            const refused: string[] = [];
            const admitted: string[] = [];
            const cases: readonly (readonly [string, () => AttemptFailureKind])[] = [
                ["deadline/elapsed", () => AttemptFailureKind.deadline(past, later)],
                ["deadline/exactly-at-bound", () => AttemptFailureKind.deadline(past, past)],
                ["deadline/not-yet-elapsed", () => AttemptFailureKind.deadline(later, past)],
                ["aborted/cancelled", () => AttemptFailureKind.aborted(cancelled)],
                ["aborted/still-open", () => AttemptFailureKind.aborted(open)],
                ["domainLost/silent", () => AttemptFailureKind.domainLost(lost)],
                ["domainLost/answering", () => AttemptFailureKind.domainLost(answering)],
                [
                    "outputInvalid/rejected",
                    () =>
                        AttemptFailureKind.outputInvalid(
                            new JsonSchema({ type: "boolean" }),
                            { value: 1 }
                        )
                ],
                [
                    "outputInvalid/accepted",
                    () => AttemptFailureKind.outputInvalid(new JsonSchema({}), { value: 1 })
                ]
            ];
            for (const [name, build] of cases) {
                try {
                    admitted.push(`${name}=${build().kind}`);
                } catch (error) {
                    refused.push(
                        `${name}=${error instanceof AgentCoreError ? error.code : "other"}`
                    );
                }
            }

            expect(admitted).toEqual([
                "deadline/elapsed=deadline",
                "deadline/exactly-at-bound=deadline",
                "aborted/cancelled=aborted",
                "domainLost/silent=domainLost",
                "outputInvalid/rejected=outputInvalid"
            ]);
            expect(refused).toEqual([
                "deadline/not-yet-elapsed=invocation.invalid",
                "aborted/still-open=invocation.invalid",
                "domainLost/answering=invocation.invalid",
                "outputInvalid/accepted=invocation.invalid"
            ]);
            expect(AttemptFailureKind.raised.kind).toBe("raised");
            expect(AttemptFailureKind.raised.authoredByHandler).toBe(true);
            for (const kind of [
                AttemptFailureKind.deadline(past, later),
                AttemptFailureKind.aborted(cancelled),
                AttemptFailureKind.domainLost(lost),
                AttemptFailureKind.outputInvalid(new JsonSchema({ type: "boolean" }), 1)
            ]) {
                expect(kind.authoredByHandler).toBe(false);
            }
        }
    );

    test(
        "[C13-RECEIPT-FAILURE-KIND] classifies each host boundary as the kind that names it",
        { tags: "p0" },
        () => {
            const observed = [
                ["nothing closed", { confirmed: false, elapsedBound: undefined }],
                ["bound elapsed", { confirmed: false, elapsedBound: past }],
                ["handler confirmed", { confirmed: true, elapsedBound: undefined }]
            ] as const;
            const derived = observed.map(([name, facts]) => [
                name,
                AttemptFailureKind.classify({
                    ...facts,
                    cancellation: open,
                    target: answering,
                    observedAt: later
                })?.kind ?? "indeterminate"
            ]);
            expect(derived).toEqual([
                ["nothing closed", "indeterminate"],
                ["bound elapsed", "deadline"],
                ["handler confirmed", "raised"]
            ]);

            // Each boundary in isolation, then the documented precedence when several close.
            const derive = (facts: {
                readonly confirmed?: boolean;
                readonly cancellation?: AbortSignal;
                readonly target?: AttemptTargetDomain;
                readonly elapsedBound?: Date;
            }): string =>
                AttemptFailureKind.classify({
                    confirmed: facts.confirmed ?? false,
                    elapsedBound: facts.elapsedBound,
                    cancellation: facts.cancellation ?? open,
                    target: facts.target ?? answering,
                    observedAt: later
                })?.kind ?? "indeterminate";
            const only = (facts: {
                readonly cancellation?: AbortSignal;
                readonly target?: AttemptTargetDomain;
                readonly elapsedBound?: Date;
            }): string => derive(facts);
            expect([
                only({ elapsedBound: past }),
                only({ cancellation: cancelled }),
                only({ target: lost })
            ]).toEqual(["deadline", "aborted", "domainLost"]);
            expect([
                only({ elapsedBound: past, cancellation: cancelled }),
                only({ elapsedBound: past, target: lost }),
                only({ cancellation: cancelled, target: lost })
            ]).toEqual(["aborted", "domainLost", "domainLost"]);

            // A handler that answered proves it was reachable and running, so its own verdict
            // outranks every host boundary the host may also have observed closing. The three
            // host kinds describe an attempt that produced no answer, which this one did.
            expect([
                derive({ confirmed: true, target: lost }),
                derive({ confirmed: true, cancellation: cancelled }),
                derive({ confirmed: true, elapsedBound: past }),
                derive({
                    confirmed: true,
                    target: lost,
                    cancellation: cancelled,
                    elapsedBound: past
                })
            ]).toEqual(["raised", "raised", "raised", "raised"]);
        }
    );

    test(
        "[C13-RECEIPT-FAILURE-KIND] records a kind on exactly a failed attempted outcome",
        { tags: "p0" },
        () => {
            const id = new ReceiptId("failure-kind");
            const attempt = new EffectAttemptId("failure-kind-attempt");
            const failed = new AttemptReceipt(
                id,
                attempt,
                AttemptCompletion.failed(AttemptFailureKind.deadline(past, later)),
                undefined,
                time(1),
                undefined
            );
            expect(failed.outcome).toBe("failed");
            expect(failed.failure?.kind).toBe("deadline");

            // §7.4's pairing is unrepresentable rather than merely rejected: `succeeded` and
            // `indeterminate` are values that take no argument, `failed` is the only call that
            // accepts one, and no call accepts two. Only a hostile subclass can offer an
            // illegal pair, so that is what the record must refuse.
            for (const [name, completion] of hostileCompletions()) {
                expect(
                    () => new AttemptReceipt(id, attempt, completion, undefined, time(1), undefined),
                    name
                ).toThrow(TypeError);
            }

            for (const legal of [AttemptCompletion.succeeded, AttemptCompletion.indeterminate]) {
                expect(legal.failure).toBeUndefined();
            }
            expect(
                new AttemptReceipt(id, attempt, AttemptCompletion.indeterminate, undefined, time(1), undefined)
                    .failure
            ).toBeUndefined();

            // "Exactly one" is a property of the record, not of the outcome it was built from:
            // an outcome that answers differently on each read must still yield a Receipt that
            // answers the same way every time.
            const shifting = new ShiftingKindCompletion();
            const pinned = new AttemptReceipt(id, attempt, shifting, undefined, time(1), undefined);
            expect(shifting.reads).toBe(1);
            expect([pinned.failure?.kind, pinned.failure?.kind, pinned.failure?.kind]).toEqual([
                "raised",
                "raised",
                "raised"
            ]);
        }
    );

    test(
        "[C13-RECEIPT-FAILURE-ORTHOGONAL] keeps a kind off every pre-effect and indeterminate Receipt",
        { tags: "p0" },
        () => {
            for (const outcome of ["deniedPreEffect", "cancelledPreEffect"] as const) {
                const receipt = new PreEffectReceipt(
                    new ReceiptId(`pre-effect-${outcome}`),
                    new InvocationId("pre-effect-invocation"),
                    0,
                    outcome,
                    time(1),
                    "reason"
                );
                expect("failure" in receipt).toBe(false);
                expect(Reflect.ownKeys(receipt)).not.toContain("failure");
            }

            // The wire is the only place a pre-effect Receipt could acquire one, and the exact
            // key set is what refuses it.
            expect(() =>
                Receipt.decode(
                    envelope({
                        failure: "raised",
                        id: "smuggled",
                        invocation: "smuggled-invocation",
                        itemIndex: 0,
                        outcome: "deniedPreEffect",
                        reason: "denied",
                        recordedAt: time(1).toISOString(),
                        variant: "preEffect"
                    })
                )
            ).toThrow(/Pre-effect Receipt contains missing or unknown fields/);

            expect(() => Receipt.decode(envelope(attemptPayload({ outcome: "indeterminate" })))).toThrow(
                /Only a failed Attempt Receipt may name a failure kind/
            );
            expect(() => Receipt.decode(envelope(attemptPayload({ outcome: "succeeded" })))).toThrow(
                /Only a failed Attempt Receipt may name a failure kind/
            );
            expect(() =>
                Receipt.decode(envelope(attemptPayload({ failure: null })))
            ).toThrow(/A failed Attempt Receipt must name one failure kind/);
            expect(() =>
                Receipt.decode(envelope(attemptPayload({ failure: "workerExit" })))
            ).toThrow(/Attempt Receipt failure kind is invalid/);
        }
    );

    test(
        "[C13-RECEIPT-FAILURE-KIND] round-trips every kind through the versioned codec",
        { tags: "p1" },
        () => {
            const kinds = [
                AttemptFailureKind.raised,
                AttemptFailureKind.deadline(past, later),
                AttemptFailureKind.aborted(cancelled),
                AttemptFailureKind.domainLost(lost),
                AttemptFailureKind.outputInvalid(new JsonSchema({ type: "boolean" }), 1)
            ];
            const decoded = kinds.map((failure) => {
                const record = new AttemptReceipt(
                    new ReceiptId(`round-trip-${failure.kind}`),
                    new EffectAttemptId("round-trip-attempt"),
                    AttemptCompletion.failed(failure),
                    undefined,
                    time(1),
                    undefined
                );
                const back = Receipt.decode(Receipt.encode(record));
                if (!(back instanceof AttemptReceipt)) throw new TypeError("Expected an attempt");
                return [back.outcome, back.failure?.kind, back.failure?.equals(failure)];
            });
            expect(decoded).toEqual([
                ["failed", "raised", true],
                ["failed", "deadline", true],
                ["failed", "aborted", true],
                ["failed", "domainLost", true],
                ["failed", "outputInvalid", true]
            ]);

            // Version 1 carried no failure field, so a version 1 `failed` payload has no
            // upcast: the kind is not derivable from bytes that never held it and inventing
            // one would manufacture the determination this rule withholds. §8.3 requires the
            // unknown major to fail with a typed error instead.
            const legacy = encodeCanonicalJson({
                kind: "invocation.receipt",
                version: { major: 1, minor: 0 },
                payload: {
                    attempt: "legacy-attempt",
                    id: "legacy-receipt",
                    outcome: "failed",
                    previous: null,
                    recordedAt: time(1).toISOString(),
                    result: null,
                    variant: "attempt"
                }
            });
            expect(() => Receipt.decode(legacy)).toThrow(AgentCoreError);
            expect(() => Receipt.decode(legacy)).toThrow(
                /Unsupported invocation.receipt codec major 1/
            );
        }
    );

    test(
        "[C13-RECEIPT-FAILURE-ORTHOGONAL] derives the same batch outcome whatever the kind",
        { tags: "p1" },
        () => {
            const outcomes = [
                AttemptFailureKind.raised,
                AttemptFailureKind.deadline(past, later),
                AttemptFailureKind.aborted(cancelled),
                AttemptFailureKind.domainLost(lost),
                AttemptFailureKind.outputInvalid(new JsonSchema({ type: "boolean" }), 1)
            ].map((failure) =>
                deriveBatchOutcome(1, [
                    new AttemptReceipt(
                        new ReceiptId(`outcome-${failure.kind}`),
                        new EffectAttemptId("outcome-attempt"),
                        AttemptCompletion.failed(failure),
                        undefined,
                        time(1),
                        undefined
                    )
                ])
            );
            expect(outcomes).toEqual(["failed", "failed", "failed", "failed", "failed"]);
        }
    );
});

describe("§7.4 failure kinds at the mediated seam", () => {
    test(
        "[C13-RECEIPT-FAILURE-KIND] names the boundary the host observed and no other",
        { tags: "p0" },
        async () => {
            const observed: (readonly [string, string, string | undefined])[] = [];
            for (const scenario of seamScenarios()) {
                const harness = new Harness(false, facet, scenario.descriptor ?? descriptor);
                scenario.arm(harness);
                const result = await harness.port.invoke(
                    seamRequest(
                        new InvocationId(`seam-${scenario.name}`),
                        scenario.execute,
                        scenario.descriptor ?? descriptor
                    )
                );
                const receipt = result.items[0]?.receipt;
                if (!(receipt instanceof AttemptReceipt)) {
                    throw new TypeError(`Expected an attempted Receipt for ${scenario.name}`);
                }
                observed.push([scenario.name, receipt.outcome, receipt.failure?.kind]);
            }

            expect(observed).toEqual([
                ["raised", "failed", "raised"],
                ["outputInvalid", "failed", "outputInvalid"],
                ["deadline", "failed", "deadline"],
                ["aborted", "failed", "aborted"],
                ["domainLost", "failed", "domainLost"],
                ["unexplained", "indeterminate", undefined]
            ]);
        }
    );

    test(
        "[C13-RECEIPT-FAILURE-KIND] refuses every kind the invoked Operation tries to author",
        { tags: "p0" },
        async () => {
            // §7.1: a classification the callee could author is one the callee could choose. A
            // handler naming a host boundary in its own rejection must reach no kind at all,
            // because each host kind is read off the boundary and never off the error.
            const claimed = ["deadline", "aborted", "domainLost", "outputInvalid"] as const;
            const codes = ["actor.closed", "facet.inactive", "lease.invalid", "turn.invalid-state"] as const;
            const observed: (readonly [string, string, string | undefined])[] = [];
            for (const [index, kind] of claimed.entries()) {
                const harness = new Harness(false);
                const result = await harness.port.invoke(
                    seamRequest(new InvocationId(`authored-${kind}`), () => {
                        throw new AgentCoreError(codes[index]!, kind);
                    })
                );
                const receipt = result.items[0]?.receipt;
                if (!(receipt instanceof AttemptReceipt)) {
                    throw new TypeError(`Expected an attempted Receipt for ${kind}`);
                }
                observed.push([kind, receipt.outcome, receipt.failure?.kind]);
            }
            expect(observed).toEqual([
                ["deadline", "indeterminate", undefined],
                ["aborted", "indeterminate", undefined],
                ["domainLost", "indeterminate", undefined],
                ["outputInvalid", "indeterminate", undefined]
            ]);

            // The one kind the callee does originate still reaches the Receipt, so the refusal
            // above is about which kind rather than about rejections in general.
            const harness = new Harness(false);
            const result = await harness.port.invoke(
                seamRequest(new InvocationId("authored-raised"), () => {
                    throw new ConfirmedOperationFailure("handler declined", evidence);
                })
            );
            const receipt = result.items[0]?.receipt;
            if (!(receipt instanceof AttemptReceipt)) throw new TypeError("Expected an attempt");
            expect([receipt.outcome, receipt.failure?.kind, receipt.result?.equals(evidence)]).toEqual([
                "failed",
                "raised",
                true
            ]);
        }
    );

    test(
        "[C13-RECEIPT-FAILURE-KIND] leaves an elapsed bound distinguishable from claim recovery",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            harness.attemptDeadline = past;
            const invocation = new InvocationId("deadline-versus-recovery");
            const result = await harness.port.invoke(
                seamRequest(invocation, () => new Promise<FacetData>(() => undefined))
            );
            const receipt = result.items[0]?.receipt;
            if (!(receipt instanceof AttemptReceipt)) throw new TypeError("Expected an attempt");
            expect([receipt.outcome, receipt.failure?.kind]).toEqual(["failed", "deadline"]);

            // An elapsed bound is not an expired claim. §7.4 sends an ordinal that already has
            // an EffectAttempt through Receipt reconciliation rather than abandoned-claim
            // recovery, and the attempt this Receipt names is exactly that attempt — so the
            // recorded kind and the recovery path answer different questions about one item.
            const persisted = harness.transactions.transact((transaction) => {
                const claims = harness.persistence.claimsForItem(transaction, invocation, 0);
                const claim = claims.at(-1);
                if (claim === undefined) throw new TypeError("Expected a claim for the item");
                return {
                    ordinal: claim.attemptOrdinal,
                    attempt: harness.persistence.attemptForClaim(transaction, claim.id)?.id.value
                };
            });
            expect(persisted.ordinal).toBe(0);
            expect(persisted.attempt).toBe(receipt.attempt.value);
        }
    );
});

/**
 * Only a subclass can offer an outcome and a kind that §7.4 forbids together, because no
 * factory call composes them. Each entry is a pairing the record must refuse.
 */
function hostileCompletions(): readonly (readonly [string, AttemptCompletion])[] {
    // SAFETY: AttemptCompletion pairs an outcome with its kind by construction, so the illegal
    // pairings its consumers must refuse are unreachable from the factories and have to be
    // built by subclassing.
    class FailedWithoutKind extends AttemptCompletion {
        public readonly outcome = "failed" as const;
        public readonly failure = undefined;
    }
    class IndeterminateWithKind extends AttemptCompletion {
        public readonly outcome = "indeterminate" as const;
        public readonly failure = AttemptFailureKind.raised;
    }
    class SucceededWithKind extends AttemptCompletion {
        public readonly outcome = "succeeded" as const;
        public readonly failure = AttemptFailureKind.deadline(past, later);
    }
    class UnknownOutcome extends AttemptCompletion {
        public readonly outcome = outsideVocabulary("invalid");
        public readonly failure = AttemptFailureKind.raised;
    }
    return [
        ["a failed outcome naming no kind", new FailedWithoutKind()],
        ["an indeterminate outcome naming a kind", new IndeterminateWithKind()],
        ["a succeeded outcome naming a kind", new SucceededWithKind()],
        ["an outcome outside the closed vocabulary", new UnknownOutcome()]
    ];
}

/**
 * An outcome that offers a different kind on every read. §7.4 requires the Receipt to name
 * exactly one, so the record must capture a single kind rather than defer to its outcome —
 * otherwise one Receipt would answer the question differently each time it was asked.
 */
class ShiftingKindCompletion extends AttemptCompletion {
    #reads = 0;
    public readonly outcome = "failed" as const;

    public get failure(): AttemptFailureKind {
        this.#reads += 1;
        return this.#reads === 1
            ? AttemptFailureKind.raised
            : AttemptFailureKind.aborted(cancelled);
    }

    public get reads(): number {
        return this.#reads;
    }
}

interface SeamScenario {
    readonly name: string;
    readonly arm: (harness: Harness) => void;
    readonly execute: () => Promise<FacetData> | FacetData;
    readonly descriptor?: OperationDescriptor;
}

const booleanOutput = new OperationDescriptor(
    new OperationName("send"),
    "externalSend",
    new JsonSchema({}),
    new JsonSchema({ type: "boolean" })
);

function seamScenarios(): readonly SeamScenario[] {
    const inert = (): void => undefined;
    return [
        {
            name: "raised",
            arm: inert,
            execute: () => {
                throw new ConfirmedOperationFailure("handler declined", evidence);
            }
        },
        {
            name: "outputInvalid",
            arm: inert,
            execute: () => ({ value: 1 }),
            descriptor: booleanOutput
        },
        {
            name: "deadline",
            arm: (harness) => {
                harness.attemptDeadline = past;
            },
            execute: () => new Promise<FacetData>(() => undefined)
        },
        {
            name: "aborted",
            arm: (harness) => harness.cancellation.abort(),
            execute: () => {
                throw new Error("handler stopped");
            }
        },
        {
            name: "domainLost",
            arm: (harness) => {
                harness.domainAnswering = false;
            },
            execute: () => {
                throw new Error("handler stopped");
            }
        },
        {
            name: "unexplained",
            arm: inert,
            execute: () => {
                throw new Error("handler stopped");
            }
        }
    ];
}

function seamRequest(
    invocation: InvocationId,
    execute: () => Promise<FacetData> | FacetData,
    operation: OperationDescriptor = descriptor
): CanonicalBatchInvocationRequest<string> {
    return {
        invocation,
        request: {
            requestKey: new OperationRequestKey(`request:${invocation.value}`),
            facet,
            descriptor: operation,
            cardinality: { kind: "single" },
            inputs: [{ value: 1 }],
            authorization: "authorization",
            interceptions: [[]],
            execute: async () => execute()
        }
    };
}

function attemptPayload(overrides: JsonObject): JsonObject {
    return {
        attempt: "wire-attempt",
        failure: "raised",
        id: "wire-receipt",
        outcome: "failed",
        previous: null,
        recordedAt: time(1).toISOString(),
        result: null,
        variant: "attempt",
        ...overrides
    };
}

function envelope(payload: JsonValue): Uint8Array {
    return encodeCanonicalJson({
        kind: "invocation.receipt",
        version: { major: 2, minor: 0 },
        payload
    });
}
