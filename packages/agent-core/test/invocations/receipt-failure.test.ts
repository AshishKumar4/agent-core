import { describe, expect, test } from "vitest";
import {
    ContentRef,
    Digest,
    JsonSchema,
    decodeCanonicalJson,
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
    type CanonicalBatchFinalAdmissionContext,
    type CanonicalBatchFinalAdmissionPort,
    type CanonicalBatchFinalAdmissionResult,
    type CanonicalBatchInvocationRequest
} from "../../src/invocations";
import { InvocationId } from "../../src/interaction-references";
import { admissionFor, claimCodec, preparedCodec } from "../invocations/fixture";
import { outsideVocabulary } from "./fixture";
import { ConfirmedOperationFailure, OperationRequestKey } from "../../src/operations";
import {
    CanonicalBatchHarness as Harness,
    canonicalBatchDescriptor as descriptor,
    canonicalBatchFacet as facet,
    type CanonicalBatchHarnessState
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
                        AttemptFailureKind.outputInvalid(new JsonSchema({ type: "boolean" }), {
                            value: 1
                        })
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
                    () =>
                        new AttemptReceipt(id, attempt, completion, undefined, time(1), undefined),
                    name
                ).toThrow(TypeError);
            }

            for (const legal of [AttemptCompletion.succeeded, AttemptCompletion.indeterminate]) {
                expect(legal.failure).toBeUndefined();
            }
            expect(
                new AttemptReceipt(
                    id,
                    attempt,
                    AttemptCompletion.indeterminate,
                    undefined,
                    time(1),
                    undefined
                ).failure
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

            expect(() =>
                Receipt.decode(envelope(attemptPayload({ outcome: "indeterminate" })))
            ).toThrow(/Only a failed Attempt Receipt may name a failure kind/);
            expect(() =>
                Receipt.decode(envelope(attemptPayload({ outcome: "succeeded" })))
            ).toThrow(/Only a failed Attempt Receipt may name a failure kind/);
            expect(() => Receipt.decode(envelope(attemptPayload({ failure: null })))).toThrow(
                /A failed Attempt Receipt must name one failure kind/
            );
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

    test(
        "[C13-RECEIPT-FAILURE-ORTHOGONAL] refuses rather than drops a kind offered on the pre-effect wire seam",
        { tags: "p0" },
        () => {
            // The case above refuses the extra key on the way in. This is the way out: a field
            // initializer cannot reach a frozen instance, so the one shape a store could ever
            // be handed is a subclass answering from its prototype. Encoding is the seam every
            // store writes through, so dropping the field would persist bytes that disagree
            // with the live record a caller still holds.
            const smuggled = new SmuggledKindReceipt(
                new ReceiptId("smuggled-pre-effect"),
                new InvocationId("smuggled-invocation"),
                0,
                "cancelledPreEffect",
                time(1),
                "cancelled before the effect"
            );
            expect(smuggled.failure.kind).toBe("aborted");
            expect(() => Receipt.encode(smuggled)).toThrow(TypeError);
            expect(() => Receipt.encode(smuggled)).toThrow(
                /pre-effect Receipt cannot carry an attempt failure kind/
            );

            // The legitimate record still round-trips, so the refusal is about the extra field
            // and not about the variant.
            const honest = new PreEffectReceipt(
                new ReceiptId("smuggled-pre-effect"),
                new InvocationId("smuggled-invocation"),
                0,
                "cancelledPreEffect",
                time(1),
                "cancelled before the effect"
            );
            const decoded = Receipt.decode(Receipt.encode(honest));
            expect(decoded).toBeInstanceOf(PreEffectReceipt);
            expect("failure" in decoded).toBe(false);
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
            const codes = [
                "actor.closed",
                "facet.inactive",
                "lease.invalid",
                "turn.invalid-state"
            ] as const;
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
            expect([
                receipt.outcome,
                receipt.failure?.kind,
                receipt.result?.equals(evidence)
            ]).toEqual(["failed", "raised", true]);
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
    test(
        "[C13-RECEIPT-FAILURE-ORTHOGONAL] keeps lineage identity fixed across every boundary and codec restart",
        { tags: "p0" },
        async () => {
            const observed: (readonly [string, string, string | undefined])[] = [];
            for (const scenario of [...seamScenarios(), denialScenario()]) {
                const operation = scenario.descriptor ?? descriptor;
                const harness = new Harness(false, facet, operation);
                scenario.arm(harness);
                const invocation = new InvocationId(`lineage-${scenario.name}`);
                const result = await harness.port.invoke(
                    seamRequest(invocation, scenario.execute, operation)
                );
                const receipt = result.items[0]?.receipt;
                if (receipt === undefined) {
                    throw new TypeError(`Expected a Receipt for ${scenario.name}`);
                }
                const attempts = harness.transactions.transact((transaction) =>
                    harness.persistence.attemptsForItem(transaction, invocation, 0)
                );

                // Which Receipt variant an item has is the only answer to whether an effect
                // was attempted: a pre-effect denial leaves no EffectAttempt at all, and an
                // attempted Receipt names exactly the one attempt of ordinal 0 whatever it
                // recorded — including nothing (indeterminate).
                expect(attempts.map((attempt) => attempt.ordinal)).toEqual(
                    receipt instanceof AttemptReceipt ? [0] : []
                );
                if (receipt instanceof AttemptReceipt) {
                    expect(receipt.attempt.equals(attempts[0]!.id)).toBe(true);
                }

                // The identity survives the codec and a restart that re-decodes every record
                // through the store.
                harness.restartRuntime();
                expectIdentity(Receipt.decode(Receipt.encode(receipt)), receipt);
                const persisted = harness.transactions.transact((transaction) =>
                    harness.persistence.receipt(transaction, receipt.id)
                );
                if (persisted === undefined) throw new TypeError("Expected the stored Receipt");
                expectIdentity(persisted, receipt);
                observed.push([
                    scenario.name,
                    receipt.outcome,
                    receipt instanceof AttemptReceipt ? receipt.failure?.kind : undefined
                ]);
            }
            expect(observed).toEqual([
                ["raised", "failed", "raised"],
                ["outputInvalid", "failed", "outputInvalid"],
                ["deadline", "failed", "deadline"],
                ["aborted", "failed", "aborted"],
                ["domainLost", "failed", "domainLost"],
                ["unexplained", "indeterminate", undefined],
                ["deniedPreEffect", "deniedPreEffect", undefined]
            ]);
        }
    );

    test(
        "[C13-RECEIPT-FAILURE-ORTHOGONAL] admits the retry through identical admission inputs whatever the kind recorded",
        { tags: "p0" },
        async () => {
            for (const scenario of seamScenarios().filter(
                (entry) => entry.name !== "unexplained"
            )) {
                const operation = scenario.descriptor ?? descriptor;
                const harness = new Harness(false, facet, operation);
                scenario.arm(harness);
                const invocation = new InvocationId(`retry-${scenario.name}`);
                let execute = scenario.execute;
                const request = seamRequest(
                    invocation,
                    (): Promise<FacetData> | FacetData => execute(),
                    operation
                );

                const first = await harness.port.invoke(request);
                const failed = first.items[0]?.receipt;
                if (!(failed instanceof AttemptReceipt)) {
                    throw new TypeError(`Expected an attempted Receipt for ${scenario.name}`);
                }
                expect([failed.outcome, failed.failure?.kind]).toEqual(["failed", scenario.name]);

                // The kind the first attempt recorded must not shape the retry: only the
                // elapsed bound itself is disarmed, and success needs no classification.
                execute = (): FacetData => true;
                if (scenario.name === "deadline") harness.attemptDeadline = undefined;
                const retried = await harness.port.invoke(request);
                expect(retried.items[0]).toMatchObject({ kind: "succeeded" });

                // Both authority seams re-entered with inputs derived from exactly
                // (invocation, item index, ordinal) — ordinal 1 now, never the kind.
                expect(
                    harness.permits.issuedAdmissions.map((admission) => [
                        admission.reference,
                        admission.digest.equals(admissionFor(invocation.value, 0, 1).digest)
                    ])
                ).toEqual([
                    [admissionFor(invocation.value, 0, 0).reference, false],
                    [admissionFor(invocation.value, 0, 1).reference, true]
                ]);
                expect(harness.finalAdmissions.calls).toBe(2);

                const attempts = harness.transactions.transact((transaction) =>
                    harness.persistence.attemptsForItem(transaction, invocation, 0)
                );
                expect(attempts.map((attempt) => attempt.ordinal)).toEqual([0, 1]);
                const succeeded = retried.items[0]?.receipt;
                if (!(succeeded instanceof AttemptReceipt)) {
                    throw new TypeError("Expected an attempted Receipt after the retry");
                }
                expect(succeeded.attempt.equals(attempts[1]!.id)).toBe(true);
            }

            // An indeterminate head admits no concurrent retry: the second invoke replays the
            // stored Receipt without issuing another permit or appending an EffectAttempt.
            const harness = new Harness(false);
            const invocation = new InvocationId("retry-indeterminate");
            const request = seamRequest(invocation, () => {
                throw new Error("handler stopped");
            });
            const first = await harness.port.invoke(request);
            const again = await harness.port.invoke(request);
            const heads = [first, again].map((result) => result.items[0]?.receipt);
            if (!(heads[0] instanceof AttemptReceipt) || !(heads[1] instanceof AttemptReceipt)) {
                throw new TypeError("Expected attempted Receipts");
            }
            expect(heads[1].id.equals(heads[0].id)).toBe(true);
            expect(heads[1].outcome).toBe("indeterminate");
            expect(
                harness.transactions
                    .transact((transaction) =>
                        harness.persistence.attemptsForItem(transaction, invocation, 0)
                    )
                    .map((attempt) => attempt.ordinal)
            ).toEqual([0]);
            expect(harness.permits.issuedAdmissions).toHaveLength(1);
            expect(harness.finalAdmissions.calls).toBe(1);
        }
    );

    test(
        "[C13-RECEIPT-FAILURE-ORTHOGONAL] carries no Receipt state into any admission input",
        { tags: "p0" },
        async () => {
            // The case above compares the admission decision's own fields. This one compares
            // the complete argument set as bytes: every run states the same intent and the same
            // retry instant, and only the first attempt's host-observed kind differs. If that
            // Receipt state entered a claim, a permit input, or a final-admission input
            // directly or by hashing into an existing field, the canonical bytes differ.
            //
            // One descriptor for every scenario, because the intent is part of what is being
            // held equal: `outputInvalid` needs a declared output shape to violate, and the
            // others fail before output validation, so the boolean-output operation is the one
            // intent all five can share. The retry then returns a value it accepts.
            const observed: (readonly [string, string])[] = [];
            for (const scenario of seamScenarios().filter(
                (entry) => entry.name !== "unexplained"
            )) {
                const admissions = new RecordingFinalAdmissions();
                const harness = new Harness<string>(false, facet, booleanOutput, admissions);
                scenario.arm(harness);
                const invocation = new InvocationId("admission-inputs");
                let execute = scenario.execute;
                const request = seamRequest(
                    invocation,
                    (): Promise<FacetData> | FacetData => execute(),
                    booleanOutput
                );

                const first = await harness.port.invoke(request);
                const failed = first.items[0]?.receipt;
                if (!(failed instanceof AttemptReceipt) || failed.failure === undefined) {
                    throw new TypeError(`Expected a failed Receipt for ${scenario.name}`);
                }
                expect([failed.outcome, failed.failure.kind]).toEqual(["failed", scenario.name]);

                execute = (): FacetData => true;
                if (scenario.name === "deadline") harness.attemptDeadline = undefined;
                // All first attempts can consume different clock reads while observing their
                // boundary. Set one exact retry instant so timing cannot mask a data difference.
                harness.setTime(10_000);
                await harness.port.invoke(request);

                const issued = harness.permits.issueInputs.at(-1);
                const admitted = admissions.contexts.at(-1);
                if (issued === undefined || admitted === undefined) {
                    throw new TypeError(`Expected retry admission inputs for ${scenario.name}`);
                }
                const inputs = new TextDecoder().decode(
                    encodeCanonicalJson({
                        finalAdmission: {
                            admittedAt: admitted.admittedAt.toISOString(),
                            authorityAdmission: {
                                digest: admitted.authorityAdmission.digest.value,
                                reference: admitted.authorityAdmission.reference
                            },
                            claim: decodeCanonicalJson(claimCodec.encode(admitted.claim)),
                            invocation: decodeCanonicalJson(
                                preparedCodec.encode(admitted.invocation)
                            )
                        },
                        permitIssue: {
                            claim: decodeCanonicalJson(claimCodec.encode(issued.claim)),
                            invocation: decodeCanonicalJson(preparedCodec.encode(issued.invocation))
                        }
                    })
                );

                // Named directly and not only by whole-set equality: identical bytes would also
                // hold if every run leaked the same Receipt state. The prior Receipt's id, its
                // outcome, and its kind are the three facts this rule keeps out of admission.
                for (const forbidden of [failed.id.value, failed.outcome, failed.failure.kind]) {
                    expect(inputs.includes(forbidden), `${scenario.name}/${forbidden}`).toBe(false);
                }
                observed.push([scenario.name, inputs]);
            }

            const [reference, ...rest] = observed;
            if (reference === undefined) throw new TypeError("Expected admission inputs");
            for (const [name, inputs] of rest) {
                expect(inputs, name).toBe(reference[1]);
            }
        }
    );
});

/**
 * The final admission point, recording the complete context the runtime passes it. Admitting
 * unconditionally keeps the recording free of any decision of its own, so what the suite reads
 * back is exactly the input set §3.4 rule 7 compares.
 */
class RecordingFinalAdmissions implements CanonicalBatchFinalAdmissionPort<
    CanonicalBatchHarnessState,
    string,
    string,
    string,
    string,
    string,
    string
> {
    public readonly contexts: CanonicalBatchFinalAdmissionContext<
        string,
        string,
        string,
        string,
        string
    >[] = [];

    public admit(
        _transaction: CanonicalBatchHarnessState,
        _request: CanonicalBatchInvocationRequest<string>,
        context: CanonicalBatchFinalAdmissionContext<string, string, string, string, string>
    ): CanonicalBatchFinalAdmissionResult {
        this.contexts.push(context);
        return { kind: "admitted" };
    }
}

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

/**
 * A pre-effect Receipt that answers with a failure kind. The base constructor freezes the
 * instance, so no own field can reach one and a prototype accessor is the only shape a store
 * could ever be handed — which is exactly the shape a codec that omitted the field instead of
 * refusing it would let through.
 */
class SmuggledKindReceipt extends PreEffectReceipt {
    public get failure(): AttemptFailureKind {
        return AttemptFailureKind.aborted(cancelled);
    }
}

/**
 * Every §7.4 lineage field a codec round-trip or a store restart must carry unchanged: which
 * Receipt, over which attempt, with which predecessor, result, outcome, and instant. The
 * failure kind is deliberately absent — kinds may differ across one item's lineage, and this
 * helper must not let an identity check drift into re-asserting what the taxonomy tests own.
 */
function expectIdentity(decoded: Receipt, receipt: Receipt): void {
    expect(decoded.variant).toBe(receipt.variant);
    expect(decoded.id.equals(receipt.id)).toBe(true);
    expect(decoded.outcome).toBe(receipt.outcome);
    expect(decoded.recordedAt.getTime()).toBe(receipt.recordedAt.getTime());
    if (!(decoded instanceof AttemptReceipt && receipt instanceof AttemptReceipt)) return;
    expect(decoded.attempt.equals(receipt.attempt)).toBe(true);
    expect(decoded.previous === undefined).toBe(receipt.previous === undefined);
    if (decoded.previous !== undefined && receipt.previous !== undefined) {
        expect(decoded.previous.equals(receipt.previous)).toBe(true);
    }
    expect(decoded.result === undefined).toBe(receipt.result === undefined);
    if (decoded.result !== undefined && receipt.result !== undefined) {
        expect(decoded.result.equals(receipt.result)).toBe(true);
    }
}

/**
 * The final admission denies before any effect, so the pipeline records a pre-effect denial:
 * the one seam shape whose attempted lineage must stay empty.
 */
function denialScenario(): SeamScenario {
    return {
        name: "deniedPreEffect",
        arm: (harness) => {
            harness.finalAdmissions.decide = () => ({
                kind: "denied" as const,
                reason: "final admission denied before any effect"
            });
        },
        execute: (): FacetData => ({ value: 1 })
    };
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
