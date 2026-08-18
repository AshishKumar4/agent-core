import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, decodeCanonicalJson, encodeCanonicalJson } from "../../src/core";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { AuditRecordId } from "../../src/invocations";
import { TurnId } from "../../src/agents";
import { CommandEnvelopeCodec, type LeaseToken } from "../../src/protocol/envelope";
import type { CommandIngressResult, PreDispatchFailure } from "../../src/protocol/ingress";
import type { CommandDispatchResult } from "../../src/protocol/dispatcher";
import { CommandCallerPolicy } from "../../src/protocol/policy";
import { WriteRecordCodec } from "../../src/protocol/write";
import { testContentRef } from "../helpers/content";
import type { CounterFixture, CounterFixtureFactory, FaultBoundary } from "./counter-fixture";

export function counterDispatcherContract(name: string, create: CounterFixtureFactory): void {
    describe(`CommandIngress and CommandDispatcher (${name})`, () => {
        test("accepts an absent caller cause with a host-created Invocation root", { tags: "p1" }, async () => {
            const harness = create();
            const raw = harness.envelope({ amount: 4 });

            const result = await harness.dispatch(raw);
            const snapshot = harness.snapshot();

            expect(result.outcome).toBe("committed");
            expect(snapshot.value).toBe(4);
            expect(snapshot.revision.value).toBe(1);
            expect(decodeCanonicalJson(result.reply)).toEqual({ value: 4, revision: 1 });
            expect(snapshot.writes).toHaveLength(1);
            expect([...snapshot.audits.values()]).toHaveLength(2);

            const root = [...snapshot.audits.values()].find(
                (record) => record.kind.kind === "invocation"
            );
            const audit = snapshot.audits.get(result.write.audit.value);
            expect(root?.cause).toBeUndefined();
            expect(audit?.cause?.equals(root!.id)).toBe(true);
            expect(audit?.kind).toMatchObject({
                kind: "write",
                outcome: "committed",
                id: result.write.id
            });
            expect(result.write.reply).toEqual(result.reply);
            expect(result.write.envelopeDigest.equals(Digest.sha256(raw))).toBe(true);

            const decodedWrite = WriteRecordCodec.decode(WriteRecordCodec.encode(result.write));
            expect(decodedWrite.id.equals(result.write.id)).toBe(true);
            expect(decodedWrite.reply).toEqual(result.reply);
        });

        test("rebinds an existing content ref without requiring resubmission", { tags: "p1" }, async () => {
            const harness = create();

            const result = await harness.dispatch(harness.envelope({ amount: 3 }));

            expect(result.outcome).toBe("committed");
            expect(harness.snapshot()).toMatchObject({ contentGets: 1, contentPuts: 0 });
        });

        test("holds copied submitted bytes outside the actor transaction", { tags: "p1" }, async () => {
            const harness = create();
            const raw = harness.envelope({ key: "submitted", amount: 3 });
            const ref = CommandEnvelopeCodec.decode(raw).payload.value;
            harness.removePayload(ref);
            const submitted = harness.payloadBytes(3);
            const pending = harness.dispatch(raw, harness.caller, submitted);
            submitted.fill(0);

            const result = await pending;

            expect(result.outcome).toBe("committed");
            expect(harness.snapshot()).toMatchObject({ value: 3, contentPuts: 1 });
        });

        test("uses a valid actor-local caller cause without creating another root", { tags: "p1" }, async () => {
            const harness = create();
            const cause = harness.seedInvocationCause();

            const result = await harness.dispatch(harness.envelope({ callerCause: cause.id }));
            const snapshot = harness.snapshot();

            expect(result.outcome).toBe("committed");
            expect(snapshot.audits.size).toBe(2);
            const audit = snapshot.audits.get(result.write.audit.value);
            expect(audit?.cause?.equals(cause.id)).toBe(true);
            expect(audit?.correlation.equals(cause.correlation)).toBe(true);
            expect(snapshot).toMatchObject({ contentGets: 1, contentPuts: 0, identityCount: 1 });
        });

        test.each<readonly [string, InvalidCallerCauseFactory]>([
            ["missing", (harness) => new AuditRecordId(`missing-${harness.actor.id.value}`)],
            [
                "wrong-kind",
                async (harness) => {
                    const source = await harness.dispatch(
                        harness.envelope({
                            key: "wrong-kind-cause-source"
                        })
                    );
                    return source.write.audit;
                }
            ],
            [
                "wrong-Actor",
                (harness) =>
                    harness.seedInvocationCause("wrong-actor-cause", {
                        actor: new ActorRef("run", new ActorId("other-cause-actor"))
                    }).id
            ],
            [
                "wrong-Tenant",
                (harness) =>
                    harness.seedInvocationCause("wrong-tenant-cause", {
                        tenant: new TenantId("other-cause-tenant")
                    }).id
            ]
        ])(
            "[C13-ADV-COMMAND-REJECTIONS] rejects a %s caller cause before content and replays its identity",
            { tags: "p0" },
            async (name, createCause) => {
                const harness = create();
                const callerCause = await createCause(harness);
                const raw = harness.envelope({ key: `invalid-cause-${name}`, callerCause });
                const before = harness.snapshot();

                harness.setFault("contentGet");
                const fromStoredContent = await harness.dispatch(raw);
                harness.setFault("contentPut");
                const fromSubmittedContent = await harness.dispatch(
                    raw,
                    harness.caller,
                    harness.payloadBytes()
                );
                const after = harness.snapshot();

                expect([fromStoredContent.outcome, fromSubmittedContent.outcome]).toEqual([
                    "rejectedMalformed",
                    "duplicate"
                ]);
                expect(after).toMatchObject({
                    value: before.value,
                    revision: before.revision,
                    identityCount: before.identityCount + 1,
                    contentGets: before.contentGets,
                    contentPuts: before.contentPuts
                });
                expect(
                    after.writes.slice(before.writes.length).map((write) => write.outcome)
                ).toEqual(["rejectedMalformed", "duplicate"]);
                expect(
                    after.audits.get(fromStoredContent.write.audit.value)?.cause
                ).toBeUndefined();
                expect(fromSubmittedContent.reply).toEqual(fromStoredContent.reply);
            }
        );

        test("persists duplicate evidence and replays before mutable gates", { tags: "p0" }, async () => {
            const harness = create();
            const raw = harness.envelope({ amount: 2 });
            const first = await harness.dispatch(raw);
            harness.setAuthorized(false);
            harness.setLifecycle(false);

            const unauthenticated = await harness.dispatch(raw, {
                kind: "principal",
                principal: new PrincipalRef(harness.tenant, new PrincipalId("not-the-caller"))
            });
            const duplicate = await harness.dispatch(raw);
            const snapshot = harness.snapshot();

            expect(unauthenticated.outcome).toBe("rejectedAuthentication");
            expect(duplicate.outcome).toBe("duplicate");
            expect(duplicate.reply).toEqual(first.reply);
            expect(duplicate.write.duplicateOf?.equals(first.write.id)).toBe(true);
            expect(snapshot.value).toBe(2);
            expect(snapshot.writes.map((write) => write.outcome)).toEqual([
                "committed",
                "rejectedAuthentication",
                "duplicate"
            ]);
        });

        test("replays duplicates without entering any payload preparation state", { tags: "p0" }, async () => {
            const harness = create();
            const raw = harness.envelope({ key: "all-preparation-states" });
            const first = await harness.dispatch(raw);
            const ref = CommandEnvelopeCodec.decode(raw).payload.value;
            const gets = harness.snapshot().contentGets;
            harness.removePayload(ref);
            harness.setFault("contentGet");

            const infrastructure = await harness.dispatch(raw);
            const mismatch = await harness.dispatch(raw, harness.caller, Uint8Array.of(1));

            expect(infrastructure.outcome).toBe("duplicate");
            expect(mismatch.outcome).toBe("duplicate");
            expect(infrastructure.reply).toEqual(first.reply);
            expect(mismatch.reply).toEqual(first.reply);
            expect(harness.snapshot().contentGets).toBe(gets);
            expect(harness.snapshot().contentPuts).toBe(0);
        });

        test("lets a duplicate with an altered invalid cause win before cause validation", { tags: "p0" }, async () => {
            const harness = create();
            const originalCause = harness.seedInvocationCause("duplicate-original-cause");
            const first = await harness.dispatch(
                harness.envelope({
                    key: "duplicate-altered-cause",
                    callerCause: originalCause.id
                })
            );
            const altered = harness.envelope({
                key: "duplicate-altered-cause",
                callerCause: new AuditRecordId("duplicate-missing-cause")
            });
            const before = harness.snapshot();
            harness.setFault("contentGet");

            const duplicate = await harness.dispatch(altered);
            const after = harness.snapshot();
            const audit = after.audits.get(duplicate.write.audit.value);
            const root =
                audit?.cause === undefined ? undefined : after.audits.get(audit.cause.value);

            expect(duplicate.outcome).toBe("duplicate");
            expect(duplicate.reply).toEqual(first.reply);
            expect(duplicate.write.duplicateOf?.equals(first.write.id)).toBe(true);
            expect(after).toMatchObject({
                value: before.value,
                revision: before.revision,
                identityCount: before.identityCount,
                contentGets: before.contentGets,
                contentPuts: before.contentPuts
            });
            expect(root?.kind.kind).toBe("invocation");
            expect(root?.id.equals(originalCause.id)).toBe(false);
        });

        test("defensively rechecks an admitted caller cause after injected corruption", { tags: "p0" }, async () => {
            const harness = create();
            const cause = harness.seedInvocationCause("removed-before-mutation");
            const raw = harness.envelope({
                key: "cause-mutation-recheck",
                callerCause: cause.id
            });
            const barrier = harness.pauseNextPayloadGet();
            const pending = harness.dispatch(raw);
            await barrier.started;

            harness.corruptRemoveAudit(cause.id);
            barrier.release();
            const result = await pending;

            expect(result.outcome).toBe("rejectedMalformed");
            expect(harness.snapshot()).toMatchObject({ value: 0, identityCount: 1 });
        });

        test("resolves the second duplicate lookup before defensive cause recheck", { tags: "p0" }, async () => {
            const harness = create();
            const cause = harness.seedInvocationCause("removed-before-racing-duplicate");
            const key = "cause-recheck-racing-duplicate";
            const raw = harness.envelope({ key, amount: 2, callerCause: cause.id });
            const barrier = harness.pauseNextPayloadGet();
            const pending = harness.dispatch(raw);
            await barrier.started;

            harness.corruptRemoveAudit(cause.id);
            const committed = await harness.dispatch(harness.envelope({ key, amount: 2 }));
            barrier.release();
            const duplicate = await pending;

            expect(committed.outcome).toBe("committed");
            expect(duplicate.outcome).toBe("duplicate");
            expect(duplicate.reply).toEqual(committed.reply);
            expect(duplicate.write.duplicateOf?.equals(committed.write.id)).toBe(true);
            expect(harness.snapshot().value).toBe(2);
        });

        test("closes the admission/preparation race with a second duplicate lookup", { tags: "p0" }, async () => {
            const harness = create();
            const raw = harness.envelope({ key: "racing", amount: 2 });
            const barrier = harness.pauseNextPayloadGet();
            const slow = harness.dispatch(raw);
            await barrier.started;

            const first = await harness.dispatch(raw);
            barrier.release();
            const raced = await slow;

            expect(first.outcome).toBe("committed");
            expect(raced.outcome).toBe("duplicate");
            expect(raced.reply).toEqual(first.reply);
            expect(harness.snapshot().value).toBe(2);
        });

        test("serializes concurrent originals into one commit and one duplicate", { tags: "p0" }, async () => {
            const harness = create();
            const raw = harness.envelope({ key: "concurrent-original", amount: 2 });

            const results = await Promise.all([harness.dispatch(raw), harness.dispatch(raw)]);

            expect(results.map((result) => result.outcome).sort()).toEqual([
                "committed",
                "duplicate"
            ]);
            const committed = results.find((result) => result.outcome === "committed")!;
            const duplicate = results.find((result) => result.outcome === "duplicate")!;
            expect(duplicate.reply).toEqual(committed.reply);
            expect(duplicate.write.duplicateOf?.equals(committed.write.id)).toBe(true);
            expect(harness.snapshot()).toMatchObject({ value: 2, identityCount: 1 });
        });

        test("encodes and replays typed replies and observations", { tags: "p1" }, async () => {
            const harness = create({ typedExecution: true });
            const raw = harness.envelope({ key: "typed-codecs", amount: 3 });

            const committed = await harness.dispatch(raw);
            const duplicate = await harness.dispatch(raw);
            const decoded = WriteRecordCodec.decode(WriteRecordCodec.encode(committed.write));

            expect(decodeCanonicalJson(committed.reply)).toEqual({ value: 3, revision: 1 });
            expect(decodeCanonicalJson(committed.observation!)).toEqual({ amount: 3 });
            expect(duplicate.reply).toEqual(committed.reply);
            expect(duplicate.observation).toBeUndefined();
            expect(duplicate.write.observation).toBeUndefined();
            expect(decoded.observation).toEqual(committed.observation);
        });

        test("encodes a typed reply without manufacturing an observation", { tags: "p1" }, async () => {
            const harness = create({ typedExecution: true, typedObservation: false });

            const committed = await harness.dispatch(harness.envelope({ key: "typed-reply-only" }));

            expect(decodeCanonicalJson(committed.reply)).toEqual({ value: 1, revision: 1 });
            expect(committed.observation).toBeUndefined();
            expect(committed.write.observation).toBeUndefined();
        });

        test.each([
            ["reply", { includeReplyCodec: false }],
            ["observation", { includeObservationCodec: false }]
        ] as const)("rolls back a typed execution missing its %s codec", { tags: "p1" }, async (_case, options) => {
            const harness = create({ typedExecution: true, ...options });

            const result = await harness.accept(
                harness.envelope({ key: `missing-${_case}-codec` })
            );

            expect(requirePreDispatchFailure(result)).toMatchObject({
                phase: "dispatch",
                commit: "rolledBack"
            });
            expect(harness.snapshot()).toMatchObject({ value: 0, identityCount: 0, writes: [] });
        });

        test.each(["replyEncoding", "observationEncoding"] as const)(
            "rolls back typed %s codec faults",
            { tags: "p1" },
            async (fault) => {
                const harness = create({ typedExecution: true });
                harness.setFault(fault);

                const result = await harness.accept(harness.envelope({ key: fault }));

                expect(requirePreDispatchFailure(result)).toMatchObject({
                    phase: "dispatch",
                    commit: "rolledBack"
                });
                expect(harness.snapshot()).toMatchObject({
                    value: 0,
                    identityCount: 0,
                    writes: []
                });
            }
        );

        test("applies exact command-family caller policy before duplicate lookup", { tags: "p0" }, async () => {
            const harness = create({ caller: CommandCallerPolicy.actor("run") });

            const result = await harness.dispatch(harness.envelope());

            expect(result.outcome).toBe("rejectedAuthentication");
            expect(harness.snapshot()).toMatchObject({ value: 0, contentGets: 0 });
        });

        test("returns preparation infrastructure failure without evidence or mutation", { tags: "p1" }, async () => {
            const harness = create();
            harness.setFault("contentGet");

            const result = await harness.accept(harness.envelope());

            const failure = requirePreDispatchFailure(result);
            expect(failure).toMatchObject({
                phase: "admissionPreflight",
                commit: "notAttempted",
                retry: "mayRetry"
            });
            expect(harness.snapshot()).toMatchObject({ value: 0, identityCount: 0 });
            expect(harness.snapshot().writes).toHaveLength(0);
            expect(harness.snapshot().audits.size).toBe(0);
        });

        test.each<readonly [string, PayloadRejectionRun]>([
            [
                "confirmed missing",
                async (harness, raw) => {
                    harness.removePayload(CommandEnvelopeCodec.decode(raw).payload.value);
                    return harness.dispatch(raw);
                }
            ],
            [
                "submitted mismatch",
                async (harness, raw) => {
                    harness.removePayload(CommandEnvelopeCodec.decode(raw).payload.value);
                    return harness.dispatch(raw, harness.caller, Uint8Array.of(1, 2, 3));
                }
            ]
        ])("records and reserves deterministic %s payload rejection", { tags: "p0" }, async (_case, run) => {
            const harness = create();
            const raw = harness.envelope({ key: `malformed-${_case}` });

            const result = await run(harness, raw);

            expect(result.outcome).toBe("rejectedMalformed");
            expect(harness.snapshot()).toMatchObject({ value: 0, identityCount: 1 });
            expect(harness.snapshot().writes).toHaveLength(1);
            expect(harness.snapshot().audits.size).toBe(1);
        });

        test("replays a post-auth malformed result after payload correction", { tags: "p0" }, async () => {
            const harness = create();
            const raw = harness.envelope({ key: "corrected", amount: 5 });
            const ref = CommandEnvelopeCodec.decode(raw).payload.value;
            harness.removePayload(ref);

            const rejected = await harness.dispatch(raw);
            harness.installPayload(ref, harness.payloadBytes(5));
            const corrected = await harness.dispatch(raw);

            expect(rejected.outcome).toBe("rejectedMalformed");
            expect(corrected.outcome).toBe("duplicate");
            expect(corrected.reply).toEqual(rejected.reply);
            expect(corrected.write.duplicateOf?.equals(rejected.write.id)).toBe(true);
            expect(harness.snapshot()).toMatchObject({ value: 0, identityCount: 1 });
        });

        test("rolls back an asynchronous gate instead of treating its Promise as approval", { tags: "p0" }, async () => {
            const harness = create({ asynchronousGate: true });

            const result = await harness.accept(harness.envelope());

            expect(requirePreDispatchFailure(result)).toMatchObject({
                phase: "dispatch",
                commit: "rolledBack"
            });
            expect(harness.snapshot().value).toBe(0);
            expect(harness.snapshot().writes).toHaveLength(0);
        });

        test("rolls back an asynchronous payload decoder as a programmer fault", { tags: "p1" }, async () => {
            const harness = create({ asynchronousPayload: true });

            const result = await harness.accept(harness.envelope({ key: "asynchronous-payload" }));

            expect(requirePreDispatchFailure(result)).toMatchObject({
                phase: "dispatch",
                commit: "rolledBack"
            });
            expect(harness.snapshot()).toMatchObject({ value: 0, identityCount: 0, writes: [] });
        });

        test("records only the explicit malformed payload decoder result", { tags: "p1" }, async () => {
            const harness = create();

            const result = await harness.accept(
                harness.envelope({ key: "decoder-malformed", amount: forgedAmount("bad") })
            );

            expect(result).toMatchObject({ kind: "commandOutcome", outcome: "rejectedMalformed" });
            expect(harness.snapshot()).toMatchObject({ value: 0, identityCount: 1 });
            expect(harness.snapshot().writes).toHaveLength(1);
        });

        test.each(["type", "agentCore", "programmer"] as const)(
            "rolls back arbitrary %s payload decoder faults without evidence",
            { tags: "p1" },
            async (payloadFailure) => {
                const harness = create({ payloadFailure });

                const result = await harness.accept(
                    harness.envelope({
                        key: `payload-fault-${payloadFailure}`
                    })
                );

                expect(requirePreDispatchFailure(result)).toMatchObject({
                    phase: "dispatch",
                    commit: "rolledBack"
                });
                expect(harness.snapshot()).toMatchObject({
                    value: 0,
                    identityCount: 0,
                    writes: []
                });
                expect(harness.snapshot().audits.size).toBe(0);
            }
        );

        test("registration callbacks cannot mutate authenticated envelope state", { tags: "p0" }, async () => {
            const harness = create({ mutateEnvelope: true, lease: "required" });
            const lease = harness.setLease();

            const result = await harness.dispatch(
                harness.envelope({
                    key: "immutable-envelope",
                    lease
                })
            );

            expect(result.outcome).toBe("committed");
            expect(result.write.command).toBe("counter.increment");
            expect(result.write.caller).toEqual(harness.caller);
            expect(harness.snapshot().value).toBe(1);
        });

        test.each<FaultBoundary>(["mutation", "invocationAudit", "writeAudit", "writeRecord"])(
            "reports guaranteed rollback when %s fails",
            { tags: "p0" },
            async (boundary) => {
                const harness = create();
                const raw = harness.envelope();
                harness.setFault(boundary);

                const result = await harness.accept(raw);

                expect(requirePreDispatchFailure(result)).toMatchObject({
                    phase: "dispatch",
                    commit: "rolledBack",
                    retry: "mayRetry"
                });
                const snapshot = harness.snapshot();
                expect(snapshot.value).toBe(0);
                expect(snapshot.revision.value).toBe(0);
                expect(snapshot.audits.size).toBe(0);
                expect(snapshot.writes).toHaveLength(0);
                expect(snapshot.identityCount).toBe(0);

                const expectedHarness = create();
                const expected = await expectedHarness.dispatch(expectedHarness.envelope());
                harness.setFault(undefined);
                const retry = await harness.dispatch(raw);
                expect(retry.write.id.equals(expected.write.id)).toBe(true);
                expect(retry.write.audit.equals(expected.write.audit)).toBe(true);
                expect([...harness.snapshot().audits.keys()]).toEqual([
                    ...expectedHarness.snapshot().audits.keys()
                ]);
            }
        );

        test("requires a same-key retry after an unknown commit acknowledgement", { tags: "p0" }, async () => {
            const harness = create();
            const raw = harness.envelope({ key: "unknown-ack", amount: 2 });
            harness.setFault("unknownAck");

            const unknown = await harness.accept(raw);
            expect(requirePreDispatchFailure(unknown)).toMatchObject({
                phase: "dispatch",
                commit: "unknown",
                retry: "retrySameKey"
            });
            expect(harness.snapshot().value).toBe(2);
            expect(harness.snapshot().writes).toHaveLength(1);

            harness.setFault(undefined);
            const poisoned = await harness.accept(raw);
            expect(requirePreDispatchFailure(poisoned)).toMatchObject({
                phase: "admissionPreflight",
                commit: "rolledBack"
            });
            if (poisoned.kind !== "preDispatchFailure") {
                throw new TypeError("Expected poisoned Actor failure");
            }
            expect(poisoned.cause).toMatchObject({ code: "actor.closed" });

            const restarted = harness.restart();
            restarted.setFault(undefined);
            const retry = await restarted.dispatch(raw);
            expect(retry.outcome).toBe("duplicate");
            expect(restarted.snapshot().value).toBe(2);
        });

        test("does not promise same-key reconciliation for an unindexed unknown commit", { tags: "p0" }, async () => {
            const harness = create();
            harness.setFault("unknownUnindexed");

            const unknown = await harness.accept(Uint8Array.of(0xff));

            expect(requirePreDispatchFailure(unknown)).toMatchObject({
                phase: "admissionPreflight",
                commit: "unknown",
                retry: "mayRetry"
            });
            expect(harness.snapshot()).toMatchObject({ identityCount: 0 });
            expect(harness.snapshot().writes).toHaveLength(1);
        });

        test("rolls back invalid-cause rejection persistence faults and rejects after restart", { tags: "p0" }, async () => {
            const harness = create();
            const raw = harness.envelope({
                key: "invalid-cause-restart",
                callerCause: new AuditRecordId("missing-cause-before-restart")
            });
            harness.setFault("writeRecord");

            const failed = await harness.accept(raw);

            expect(requirePreDispatchFailure(failed)).toMatchObject({
                phase: "admissionPreflight",
                commit: "rolledBack",
                retry: "mayRetry"
            });
            expect(harness.snapshot()).toMatchObject({
                value: 0,
                identityCount: 0,
                contentGets: 0,
                contentPuts: 0,
                writes: []
            });

            const restarted = harness.restart();
            restarted.setFault(undefined);
            const rejected = await restarted.dispatch(raw);

            expect(rejected.outcome).toBe("rejectedMalformed");
            expect(restarted.snapshot()).toMatchObject({
                value: 0,
                identityCount: 1,
                contentGets: 0,
                contentPuts: 0
            });
            expect(restarted.snapshot().writes.map((write) => write.outcome)).toEqual([
                "rejectedMalformed"
            ]);
        });

        test.each(["forgedUnknown", "forgedActorUnknown"] as const)(
            "does not trust %s errors thrown inside the transaction or poison the Actor",
            { tags: "p0" },
            async (fault) => {
                const harness = create();
                harness.setFault(fault);

                const result = await harness.accept(harness.envelope({ key: `forged-${fault}` }));

                expect(requirePreDispatchFailure(result)).toMatchObject({
                    phase: "dispatch",
                    commit: "rolledBack",
                    retry: "mayRetry"
                });
                expect(harness.snapshot()).toMatchObject({ value: 0, identityCount: 0 });
                harness.setFault(undefined);
                expect(
                    (await harness.dispatch(harness.envelope({ key: `after-${fault}` }))).outcome
                ).toBe("committed");
            }
        );

        test("restarts with its fence and replays committed work without payload access", { tags: "p0" }, async () => {
            const harness = create();
            const raw = harness.envelope({ key: "restart-replay", amount: 3 });
            const committed = await harness.dispatch(raw);
            const before = harness.recovery();
            const restarted = harness.restart();

            const duplicate = await restarted.dispatch(raw);

            expect(before?.epoch).toBe(0);
            expect(restarted.recovery()?.epoch).toBe(1);
            expect(duplicate.outcome).toBe("duplicate");
            expect(duplicate.reply).toEqual(committed.reply);
            expect(restarted.snapshot()).toMatchObject({
                value: 3,
                identityCount: 1,
                contentGets: 0
            });
            expect(restarted.snapshot().writes.map((write) => write.outcome)).toEqual([
                "committed",
                "duplicate"
            ]);
        });

        test("rolls back transient lease verification faults", { tags: "p0" }, async () => {
            const harness = create();
            harness.setFault("payloadValidation");

            const result = await harness.accept(harness.envelope());

            expect(requirePreDispatchFailure(result)).toMatchObject({
                phase: "dispatch",
                commit: "rolledBack"
            });
            expect(harness.snapshot()).toMatchObject({
                value: 0,
                identityCount: 0,
                writes: []
            });
        });

        test("rolls back read failures instead of recording false denial", { tags: "p0" }, async () => {
            const harness = create();
            harness.setFault("readSnapshot");

            const result = await harness.accept(harness.envelope());

            expect(requirePreDispatchFailure(result)).toMatchObject({
                phase: "dispatch",
                commit: "rolledBack"
            });
            expect(harness.snapshot().value).toBe(0);
            expect(harness.snapshot().writes).toHaveLength(0);
        });

        test("rolls back attempted gate read mutation", { tags: "p0" }, async () => {
            const harness = create();
            harness.setFault("gateMutation");

            const result = await harness.accept(harness.envelope());

            expect(requirePreDispatchFailure(result)).toMatchObject({
                phase: "dispatch",
                commit: "rolledBack"
            });
            expect(harness.snapshot().value).toBe(0);
            expect(harness.snapshot().revision.value).toBe(0);
            expect(harness.snapshot().writes).toHaveLength(0);
        });

        test("records malformed and oversized raw envelopes with exact digest", { tags: "p1" }, async () => {
            const harness = create();
            const malformed = Uint8Array.from([0xff, 0x00, 0x7b]);
            const oversized = new Uint8Array(4097);

            for (const raw of [malformed, oversized]) {
                const result = await harness.dispatch(raw);
                expect(result.outcome).toBe("rejectedMalformed");
                expect(result.write.caller).toBeUndefined();
                expect(result.write.command).toBeUndefined();
                expect(result.write.envelopeDigest.equals(Digest.sha256(raw))).toBe(true);
            }
            expect(harness.snapshot().value).toBe(0);
            expect(harness.snapshot().identityCount).toBe(0);
        });

        test("does not trust a caller cause before exact caller authentication", { tags: "p0" }, async () => {
            const harness = create();
            const cause = harness.seedInvocationCause();

            const result = await harness.dispatch(
                harness.envelope({
                    key: "unauthenticated-cause",
                    callerCause: cause.id
                }),
                {
                    kind: "principal",
                    principal: new PrincipalRef(harness.tenant, new PrincipalId("forged-principal"))
                }
            );
            const audit = harness.snapshot().audits.get(result.write.audit.value);

            expect(result.outcome).toBe("rejectedAuthentication");
            expect(audit?.cause).toBeUndefined();
            expect(audit?.correlation.equals(cause.correlation)).toBe(false);
            expect(harness.snapshot().identityCount).toBe(0);
        });

        test("retains and replays authenticated decoded shape rejection", { tags: "p0" }, async () => {
            const harness = create();
            const payload = encodeCanonicalJson({ amount: 1 });
            const ref = testContentRef("counter:missing-revision:1");
            const malformed = encodeCanonicalJson({
                kind: "command-envelope",
                version: { major: 1, minor: 0 },
                payload: {
                    command: "counter.increment",
                    caller: {
                        kind: "principal",
                        principal: {
                            id: harness.principal.value,
                            tenant: harness.tenant.value
                        }
                    },
                    idempotencyKey: "missing-revision",
                    payload: ref.value,
                    payloadDigest: Digest.sha256(payload).value
                }
            });

            const result = await harness.dispatch(malformed);
            const duplicate = await harness.dispatch(malformed);

            expect(result.outcome).toBe("rejectedMalformed");
            expect(result.write.caller).toEqual(harness.caller);
            expect(result.write.command).toBe("counter.increment");
            expect(result.write.idempotencyKey).toBe("missing-revision");
            expect(duplicate.outcome).toBe("duplicate");
            expect(duplicate.reply).toEqual(result.reply);
            expect(harness.snapshot().contentGets).toBe(0);
        });

        test("evaluates post-payload gates in deterministic order", { tags: "p1" }, async () => {
            const harness = create({ lease: "required" });
            const token = harness.setLease();
            harness.setAuthorized(false);
            harness.setLifecycle(false);

            expect(
                (
                    await harness.dispatch(
                        harness.envelope({
                            key: "ordering-auth",
                            expectedRevision: new Revision(99),
                            lease: token
                        }),
                        {
                            kind: "actor",
                            actor: new ActorRef("run", new ActorId("not-the-caller"))
                        }
                    )
                ).outcome
            ).toBe("rejectedAuthentication");

            expect(
                (
                    await harness.dispatch(
                        harness.envelope({
                            key: "ordering-authority",
                            expectedRevision: new Revision(99),
                            lease: token
                        })
                    )
                ).outcome
            ).toBe("rejectedAuthority");
            harness.setAuthorized(true);
            expect(
                (
                    await harness.dispatch(
                        harness.envelope({
                            key: "ordering-lifecycle",
                            expectedRevision: new Revision(99),
                            lease: token
                        })
                    )
                ).outcome
            ).toBe("rejectedLifecycle");
            harness.setLifecycle(true);
            expect(
                (
                    await harness.dispatch(
                        harness.envelope({
                            key: "ordering-revision",
                            expectedRevision: new Revision(99),
                            lease: token
                        })
                    )
                ).outcome
            ).toBe("rejectedRevision");

            const wrongLease = { ...token, epoch: token.epoch + 1 };
            expect(
                (
                    await harness.dispatch(
                        harness.envelope({
                            key: "wrong-lease",
                            lease: wrongLease
                        })
                    )
                ).outcome
            ).toBe("rejectedLease");
        });

        test(
            "[C13-PROTOCOL-FAMILY-ENVELOPE-POLICY] enforces every revision and lease field policy",
            { tags: "p0" },
            async () => {
                const revisionCases = [
                    {
                        policy: "required",
                        absent: "rejectedMalformed",
                        present: "committed"
                    },
                    { policy: "optional", absent: "committed", present: "committed" },
                    {
                        policy: "forbidden",
                        absent: "committed",
                        present: "rejectedMalformed"
                    }
                ] as const;
                for (const expectation of revisionCases) {
                    const absent = create({ expectedRevision: expectation.policy });
                    const present = create({ expectedRevision: expectation.policy });
                    expect(
                        (
                            await absent.dispatch(
                                absent.envelope({
                                    key: `revision-${expectation.policy}-absent`,
                                    omitRevision: true
                                })
                            )
                        ).outcome
                    ).toBe(expectation.absent);
                    expect(
                        (
                            await present.dispatch(
                                present.envelope({ key: `revision-${expectation.policy}-present` })
                            )
                        ).outcome
                    ).toBe(expectation.present);
                }

                const leaseCases = [
                    { policy: "required", absent: "rejectedLease", present: "committed" },
                    { policy: "optional", absent: "committed", present: "committed" },
                    { policy: "forbidden", absent: "committed", present: "rejectedLease" }
                ] as const;
                for (const expectation of leaseCases) {
                    const absent = create({ lease: expectation.policy });
                    const present = create({ lease: expectation.policy });
                    const token = present.setLease();
                    expect(
                        (
                            await absent.dispatch(
                                absent.envelope({ key: `lease-${expectation.policy}-absent` })
                            )
                        ).outcome
                    ).toBe(expectation.absent);
                    expect(
                        (
                            await present.dispatch(
                                present.envelope({
                                    key: `lease-${expectation.policy}-present`,
                                    lease: token
                                })
                            )
                        ).outcome
                    ).toBe(expectation.present);
                }
            }
        );

        test.each<readonly [string, (token: LeaseToken) => LeaseToken | undefined]>([
            ["missing", () => undefined],
            ["wrong turn", (token) => ({ ...token, turn: new TurnId("other-turn") })],
            [
                "wrong holder",
                (token) => ({
                    ...token,
                    holder: new PrincipalRef(token.holder.tenantId, new PrincipalId("other-holder"))
                })
            ],
            ["wrong epoch", (token) => ({ ...token, epoch: token.epoch + 1 })]
        ])("rejects %s required lease tokens", { tags: "p0" }, async (_case, alter) => {
            const harness = create({ lease: "required" });
            const token = harness.setLease();
            const supplied = alter(token);

            expect(
                (
                    await harness.dispatch(
                        harness.envelope(
                            supplied === undefined
                                ? { key: `lease-${_case}` }
                                : { key: `lease-${_case}`, lease: supplied }
                        )
                    )
                ).outcome
            ).toBe("rejectedLease");
            expect(harness.snapshot().value).toBe(0);
        });

        test(
            "[C13-PROTOCOL-EXACT-ENVELOPE] preserves the qualified current lease across restart and rejects its PrincipalId from another Tenant",
            { tags: "p0" },
            async () => {
                const harness = create({ lease: "required" });
                const token = harness.setLease();
                const substituted: LeaseToken = {
                    ...token,
                    holder: new PrincipalRef(
                        new TenantId("counter-other-tenant"),
                        token.holder.principalId
                    )
                };
                const restarted = harness.restart();

                expect(
                    (
                        await restarted.dispatch(
                            restarted.envelope({
                                key: "lease-cross-tenant-holder",
                                lease: substituted
                            })
                        )
                    ).outcome
                ).toBe("rejectedLease");
                expect(restarted.snapshot().value).toBe(0);
                expect(
                    (
                        await restarted.dispatch(
                            restarted.envelope({ key: "lease-qualified-holder", lease: token })
                        )
                    ).outcome
                ).toBe("committed");
                expect(restarted.snapshot().value).toBe(1);
            }
        );

        test("[C13-ADV-COMMAND-REJECTIONS] rejects expired required lease tokens", { tags: "p0" }, async () => {
            const required = create({ lease: "required" });
            const expired = required.setLease({ expiresAt: new Date("2026-07-07T11:59:59.000Z") });
            expect((await required.dispatch(required.envelope({ lease: expired }))).outcome).toBe(
                "rejectedLease"
            );
        });
    });
}

type InvalidCallerCauseFactory = (
    harness: CounterFixture
) => AuditRecordId | Promise<AuditRecordId>;

function requirePreDispatchFailure(result: CommandIngressResult): PreDispatchFailure {
    if (result.kind !== "preDispatchFailure") {
        throw new TypeError("Expected a pre-dispatch failure");
    }
    return result;
}

/** One deterministic payload rejection: run it against a fixture and report the outcome. */
type PayloadRejectionRun = (
    harness: ReturnType<CounterFixtureFactory>,
    raw: Uint8Array
) => Promise<CommandDispatchResult>;

/**
 * The counter payload codec decodes an amount from canonical JSON. Proving it rejects a
 * non-numeric amount means encoding one, which CounterEnvelopeInit's type forbids.
 */
function forgedAmount<TActual>(value: TActual): number {
    // SAFETY: not a number. The payload decoder must reject the encoded envelope as malformed
    // rather than admit a command whose amount it never validated.
    return value as TActual & number;
}
