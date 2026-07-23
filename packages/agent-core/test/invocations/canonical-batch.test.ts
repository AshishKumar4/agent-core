import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { ContentStore } from "../../src/content";
import { ContentRef, Digest, SemVer, encodeCanonicalJson } from "../../src/core";
import { PackageId } from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import { FacetRef, OperationRef, type FacetData } from "../../src/facets";
import { PrincipalId } from "../../src/identity";
import {
    Approval,
    ApprovalId,
    AttemptReceipt,
    AuditRecord,
    AuditRecordId,
    CanonicalBatchInvocationPort,
    EffectAttemptId,
    InvocationPlacementPin,
    OperationPin,
    PreEffectReceipt,
    PreparedInvocation,
    ReceiptCodec,
    type CanonicalBatchInvocationRequest,
    type CanonicalBatchInvocationResult,
    type Receipt
} from "../../src/invocations";
import { InvocationId } from "../../src/interaction-references";
import { ConfirmedOperationFailure, OperationRequestKey } from "../../src/operations";
import {
    CanonicalBatchHarness as Harness,
    CanonicalBatchPreparation,
    canonicalBatchDescriptor as descriptor,
    canonicalBatchFacet as facet,
    type CanonicalBatchHarnessState
} from "../integration/canonical-batch-harness";
import { preparedReferenceCodecs } from "./fixture";

describe("CanonicalBatchInvocationPort", () => {
    test(
        "keeps the decoded issuer admission witness-free and authenticates in the target runtime",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("target-local-permit-authentication");

            const result = await harness.port.invoke(
                request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
            );

            expect(result.items[0]).toMatchObject({ kind: "succeeded" });
            expect(harness.permits.issuedAdmissions).toHaveLength(1);
            expect(Reflect.ownKeys(harness.permits.issuedAdmissions[0]!).sort()).toEqual([
                "digest",
                "reference"
            ]);
            expect("authentication" in harness.permits.issuedAdmissions[0]!).toBe(false);
            expect(harness.authentication.authenticatedItems).toEqual([0]);
            expect(harness.authentication.authenticatedInsideTargetTransaction).toBe(false);
        }
    );

    test(
        "records target-local authentication denial before any target admission or attempt",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("target-local-authentication-denied");
            harness.authentication.deniedItems.add(0);

            const result = await harness.port.invoke(
                request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
            );

            expect(result.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "deniedPreEffect" }
            });
            expect(harness.authentication.authenticatedItems).toEqual([0]);
            expect(harness.finalAdmissions.calls).toBe(0);
            expect(harness.executions).toEqual([]);
            expect(
                harness.transactions.transact((transaction) =>
                    harness.persistence.attemptsForItem(transaction, invocation, 0)
                )
            ).toEqual([]);
        }
    );

    test(
        "reconstructs the target runtime and retries authentication without duplicating its claim",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("target-authentication-restart");
            harness.authentication.crashOnce = true;
            const interruptedAuthentication = harness.authentication;
            const value = request(invocation, [{ value: 1 }], (index) =>
                harness.executions.push(index)
            );

            await expect(harness.port.invoke(value)).rejects.toThrow(
                "permit authentication transport crash"
            );
            expect(harness.records.createdClaims).toBe(1);
            expect(
                harness.transactions.transact((transaction) =>
                    harness.persistence.attemptsForItem(transaction, invocation, 0)
                )
            ).toEqual([]);

            harness.restartRuntime();
            expect(harness.authentication).not.toBe(interruptedAuthentication);
            const retried = await harness.port.invoke(value);

            expect(retried.items[0]).toMatchObject({ kind: "succeeded" });
            expect(harness.records.createdClaims).toBe(1);
            expect(interruptedAuthentication.authenticatedItems).toEqual([0]);
            expect(harness.authentication.authenticatedItems).toEqual([0]);
            expect(harness.executions).toEqual([0]);
        }
    );

    test("[C13-CLAIM-INITIAL-ATOMIC] claims before async permit issuance and returns one output only for success", async () => {
        const harness = new Harness(true);
        const invocation = new InvocationId("canonical-batch");
        const prepared = harness.preparation.create(invocation, [{ item: 0 }, { item: 1 }]);
        const pending = Approval.pending(
            new ApprovalId("canonical-batch-approval"),
            invocation,
            prepared.intentDigest,
            time(1),
            time(20)
        );
        harness.transactions.transact((transaction) => {
            harness.ledger.prepareWithAudit(
                transaction,
                prepared,
                harness.records.invocationAudit(prepared),
                harness.evidence
            );
            harness.ledger.requestApproval(transaction, pending);
            harness.ledger.appendApprovalRevision(
                transaction,
                pending.approve(new PrincipalId("approver"), time(2))
            );
        });
        harness.permits.invalidItems.add(0);

        const result = await harness.port.invoke(
            request(invocation, [{ item: 0 }, { item: 1 }], (index) =>
                harness.executions.push(index)
            )
        );

        expect(result.items).toHaveLength(2);
        expect(result.items[0]).toMatchObject({ kind: "terminal", itemIndex: 0 });
        expect(result.items[0]!.receipt).toBeInstanceOf(PreEffectReceipt);
        expect(result.items[1]).toMatchObject({
            kind: "succeeded",
            itemIndex: 1,
            output: { item: 1 }
        });
        expect(harness.permits.claimedBeforeIssue).toEqual([0, 1]);
        expect(harness.permits.issuedInsideTargetTransaction).toBe(false);
        expect(harness.executions).toEqual([1]);

        const evidence = harness.transactions.transact((transaction) => ({
            approval: harness.persistence.approval(transaction, pending.id),
            continuation: harness.persistence.continuation(transaction, invocation),
            attempts0: harness.persistence.attemptsForItem(transaction, invocation, 0),
            attempts1: harness.persistence.attemptsForItem(transaction, invocation, 1),
            audits: transaction.audits.size,
            publications: harness.evidence.pendingPublications(transaction)
        }));
        expect(evidence.approval?.state).toMatchObject({
            kind: "consumed",
            firstAttempt: new EffectAttemptId("attempt:canonical-batch:1:0")
        });
        expect(evidence.continuation?.firstItemIndex).toBe(1);
        expect(evidence.attempts0).toEqual([]);
        expect(evidence.attempts1).toHaveLength(1);
        expect(evidence.audits).toBe(4);
        expect(evidence.publications).toHaveLength(2);
    });

    test("[C13-EFFECT-IDEMPOTENCY] reuses a durable claim after permit-call crash and never repeats the effect", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("canonical-crash");
        harness.permits.crashOnce = true;

        await expect(
            harness.port.invoke(
                request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
            )
        ).rejects.toThrow("permit transport crash");
        expect(harness.records.createdClaims).toBe(1);
        expect(harness.executions).toEqual([]);

        harness.transactions.restart();
        const first = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );
        harness.transactions.restart();
        const replay = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );

        expect(first.items[0]).toMatchObject({ kind: "succeeded", output: { value: 1 } });
        expect(replay.items[0]).toMatchObject({ kind: "succeeded", output: { value: 1 } });
        expect(harness.records.createdClaims).toBe(1);
        expect(harness.executions).toEqual([0]);
    });

    test("concurrent duplicates converge without terminalizing a live attempt", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("concurrent-after-permit");
        const issued = deferred<void>();
        const release = deferred<void>();
        harness.permits.onIssue = async () => {
            issued.resolve(undefined);
            await release.promise;
        };
        const value = request(invocation, [{ value: 1 }], (index) =>
            harness.executions.push(index)
        );

        const first = harness.port.invoke(value);
        await issued.promise;
        const duplicate = harness.port.invoke(value);
        release.resolve(undefined);
        const [winner, replay] = await Promise.all([first, duplicate]);

        expect(winner.items[0]).toMatchObject({ kind: "succeeded" });
        expect(replay.items[0]).toMatchObject({ kind: "succeeded" });
        expect(harness.permits.claimedBeforeIssue).toEqual([0]);
        expect(harness.executions).toEqual([0]);
        expect(
            harness.transactions.transact((transaction) =>
                harness.persistence.attemptsForItem(transaction, invocation, 0)
            )
        ).toHaveLength(1);
    });

    test(
        "independent invocation runtimes never share in-flight item results",
        { tags: "p0" },
        async () => {
            const firstHarness = new Harness(false);
            const secondHarness = new Harness(false);
            const invocation = new InvocationId("same-id-in-independent-runtimes");
            const issued = deferred<void>();
            const release = deferred<void>();
            firstHarness.permits.onIssue = async () => {
                issued.resolve(undefined);
                await release.promise;
            };

            const first = firstHarness.port.invoke(
                request(invocation, [{ value: 1 }], (index) => firstHarness.executions.push(index))
            );
            await issued.promise;
            const second = secondHarness.port.invoke(
                request(invocation, [{ value: 2 }], (index) => secondHarness.executions.push(index))
            );
            release.resolve(undefined);

            const [firstResult, secondResult] = await Promise.all([first, second]);
            expect(firstResult.items[0]).toMatchObject({ kind: "succeeded", output: { value: 1 } });
            expect(secondResult.items[0]).toMatchObject({
                kind: "succeeded",
                output: { value: 2 }
            });
            expect(firstHarness.executions).toEqual([0]);
            expect(secondHarness.executions).toEqual([0]);
        }
    );

    test("[C13-CLAIM-RECOVERY-NEW-OWNER] rejects empty, inexact, and substituted canonical batch preparation before claiming", async () => {
        const empty = new Harness(false);
        await expect(
            empty.port.invoke(request(new InvocationId("empty-batch"), [], () => undefined))
        ).rejects.toThrow(/nonempty exact payload shape/);
        expect(empty.records.createdClaims).toBe(0);

        const inexact = new Harness(false);
        const one = request(new InvocationId("inexact-batch"), [{ value: 1 }], () => undefined);
        await expect(
            inexact.port.invoke({
                ...one,
                request: { ...one.request, shape: { kind: "batch", itemCount: 2 } }
            })
        ).rejects.toThrow(/nonempty exact payload shape/);

        const substituted = new Harness(false);
        substituted.preparation.override = (_request, prepared) =>
            substituted.preparation.create(
                new InvocationId("substituted-prepared-identity"),
                prepared.payload.kind === "batch"
                    ? prepared.payload.items.map((item) => item.arguments)
                    : [prepared.payload.item.arguments]
            );
        await expect(
            substituted.port.invoke(
                request(
                    new InvocationId("expected-prepared-identity"),
                    [{ value: 1 }],
                    () => undefined
                )
            )
        ).rejects.toThrow(/does not bind the exact canonical batch request/);
        expect(substituted.records.createdClaims).toBe(0);
    });

    test("[C13-RECEIPT-PRE-EFFECT] persists the exact Invocation-to-deniedPreEffect Receipt edge", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("permit-denied");
        harness.permits.deniedItems.add(0);
        const first = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );
        harness.transactions.restart();
        const replayed = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );

        expect(first.items[0]).toMatchObject({ kind: "terminal", itemIndex: 0 });
        expect(first.items[0]!.receipt).toBeInstanceOf(PreEffectReceipt);
        expect(replayed.items[0]!.receipt.id.equals(first.items[0]!.receipt.id)).toBe(true);
        const audits = harness.transactions.transact((transaction) =>
            [...transaction.audits.values()].map((bytes) => AuditRecord.decode(bytes))
        );
        expect(audits.map((audit) => audit.kind.kind)).toEqual(["invocation", "receipt"]);
        expect(audits[1]?.cause?.equals(audits[0]!.id)).toBe(true);
        expect(audits[1]).toMatchObject({
            actor: audits[0]?.actor,
            tenant: audits[0]?.tenant,
            correlation: audits[0]?.correlation,
            kind: { kind: "receipt", outcome: "deniedPreEffect" }
        });
        expect(harness.executions).toEqual([]);
    });

    test("rejects an existing PreparedInvocation without its exact Invocation audit root", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("prepared-without-root");
        const prepared = harness.preparation.create(invocation, [{ value: 1 }]);
        harness.transactions.transact((transaction) =>
            harness.persistence.insertPrepared(transaction, prepared)
        );

        await expect(
            harness.port.invoke(request(invocation, [{ value: 1 }], () => undefined))
        ).rejects.toThrow(/does not have its exact preparation AuditRecord/);
        expect(harness.records.createdClaims).toBe(0);
    });

    test("atomically rejects an EffectAttempt whose Invocation audit cause is substituted", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("attempt-cause-substitution");
        harness.records.substituteAttemptCause = true;

        await expect(
            harness.port.invoke(request(invocation, [{ value: 1 }], () => undefined))
        ).rejects.toThrow(/Audit cause must exist before append/);
        const evidence = harness.transactions.transact((transaction) => ({
            attempts: harness.persistence.attemptsForItem(transaction, invocation, 0),
            receipt: harness.ledger.currentReceipt(transaction, invocation, 0),
            audits: [...transaction.audits.values()].map((bytes) => AuditRecord.decode(bytes)),
            publications: harness.evidence.pendingPublications(transaction)
        }));
        expect(evidence.attempts).toEqual([]);
        expect(evidence.receipt).toBeUndefined();
        expect(evidence.audits.map((audit) => audit.kind.kind)).toEqual(["invocation"]);
        expect(evidence.publications).toEqual([]);
    });

    test("[P11-DEVICE-CONSENT-ABSENT] records final target-admission denial with no EffectAttempt", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("target-admission-denied");
        harness.finalAdmissions.result = {
            kind: "denied",
            reason: "Live device consent is absent"
        };

        const result = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );
        const evidence = harness.transactions.transact((transaction) => ({
            attempts: harness.persistence.attemptsForItem(transaction, invocation, 0),
            receipt: harness.ledger.currentReceipt(transaction, invocation, 0)
        }));

        expect(result.items[0]).toMatchObject({
            kind: "terminal",
            receipt: { outcome: "deniedPreEffect", reason: "Live device consent is absent" }
        });
        expect(evidence.attempts).toEqual([]);
        expect(evidence.receipt).toBeInstanceOf(PreEffectReceipt);
        expect(harness.executions).toEqual([]);
    });

    test("[P11-DEVICE-CONSENT-REVOCATION] linearizes a revocation after permit issue but before final target admission", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("target-admission-race");
        const issued = deferred<void>();
        const release = deferred<void>();
        harness.permits.onIssue = async () => {
            issued.resolve(undefined);
            await release.promise;
        };

        const running = harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );
        await issued.promise;
        harness.finalAdmissions.result = { kind: "denied", reason: "Consent revoked" };
        release.resolve(undefined);
        const result = await running;

        expect(result.items[0]).toMatchObject({ kind: "terminal" });
        expect(
            harness.transactions.transact((transaction) =>
                harness.persistence.attemptsForItem(transaction, invocation, 0)
            )
        ).toEqual([]);
        expect(harness.executions).toEqual([]);
    });

    test("[P11-DEVICE-CONSENT-ADMITTED] does not let post-admission revocation cancel an admitted effect", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("target-admission-committed");
        const admission = Object.freeze({ pair: "device:agent" });
        const started = deferred<void>();
        const completion = deferred<void>();
        harness.finalAdmissions.result = { kind: "admitted", evidence: admission };
        const value = request(invocation, [{ value: 1 }], () => undefined);
        const running = harness.port.invoke({
            ...value,
            request: {
                ...value.request,
                execute: async (_itemIndex, context) => {
                    expect(context.targetAdmission).toBe(admission);
                    started.resolve(undefined);
                    await completion.promise;
                    return { value: 1 };
                }
            }
        });

        await started.promise;
        harness.finalAdmissions.result = { kind: "denied", reason: "Consent revoked" };
        completion.resolve(undefined);

        await expect(running).resolves.toMatchObject({
            items: [{ kind: "succeeded", output: { value: 1 } }]
        });
        expect(
            harness.transactions.transact((transaction) =>
                harness.persistence.attemptsForItem(transaction, invocation, 0)
            )
        ).toHaveLength(1);
    });

    test("[C13-CLAIM-RECOVERY-SAME-ORDINAL] recovers an expired permit-stage claim under a new worker at the same ordinal", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("expired-claim");
        harness.permits.crashOnce = true;
        await expect(
            harness.port.invoke(request(invocation, [{ value: 1 }], () => undefined))
        ).rejects.toThrow("permit transport crash");

        harness.setTime(4_000);
        const recovered = await harness.port.invoke(
            request(invocation, [{ value: 1 }], () => undefined)
        );
        expect(recovered.items[0]).toMatchObject({ kind: "succeeded" });
        expect(harness.records.createdClaims).toBe(2);
        expect(
            harness.transactions.transact((transaction) =>
                harness.persistence
                    .claimsForItem(transaction, invocation, 0)
                    .map((claim) => claim.attemptOrdinal)
            )
        ).toEqual([0, 0]);
    });

    test("[C13-EFFECT-RECONCILIATION] terminalizes a crash-recovered admitted attempt without repeating the effect", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("admitted-crash");
        harness.failResourcesOnce = true;
        await expect(
            harness.port.invoke(
                request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
            )
        ).rejects.toThrow("resource crash");
        const recovered = await harness.port.invoke(
            request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
        );
        expect(recovered.items[0]).toMatchObject({
            kind: "terminal",
            receipt: { outcome: "indeterminate" }
        });
        expect(harness.executions).toEqual([]);
    });

    test("[C13-RECEIPT-ID-NAMESPACE] turns an operation failure into one final failed Receipt", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("effect-failed");
        const result = await harness.port.invoke(
            request(invocation, [{ value: 1 }], () => {
                throw new ConfirmedOperationFailure(
                    "effect failed",
                    ContentRef.fromDigest(digest("effect failed"))
                );
            })
        );
        expect(result.items[0]).toMatchObject({
            kind: "terminal",
            receipt: {
                outcome: "failed",
                result: ContentRef.fromDigest(digest("effect failed"))
            }
        });
    });

    test(
        "a final failed attempt advances the ordinal and permits one new execution",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("retry-after-final-failure");
            let executions = 0;
            const value = request(invocation, [{ value: 1 }], () => {
                executions += 1;
                if (executions === 1) {
                    throw new ConfirmedOperationFailure(
                        "first attempt failed",
                        ContentRef.fromDigest(digest("first attempt failed"))
                    );
                }
            });

            const failed = await harness.port.invoke(value);
            const retried = await harness.port.invoke(value);

            expect(failed.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "failed" }
            });
            expect(retried.items[0]).toMatchObject({
                kind: "succeeded",
                output: { value: 1 }
            });
            expect(executions).toBe(2);
            expect(
                harness.transactions
                    .transact((transaction) =>
                        harness.persistence.attemptsForItem(transaction, invocation, 0)
                    )
                    .map((attempt) => attempt.ordinal)
            ).toEqual([0, 1]);
        }
    );

    test("post-admission untyped throws are indeterminate", async () => {
        const harness = new Harness(false);
        const result = await harness.port.invoke(
            request(new InvocationId("effect-indeterminate"), [{ value: 1 }], () => {
                throw new TypeError("effect may already have happened");
            })
        );
        expect(result.items[0]).toMatchObject({
            kind: "terminal",
            receipt: { outcome: "indeterminate" }
        });
    });

    test("rejects a Receipt audit whose cause is not the exact attempt audit", async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("receipt-cause-substitution");
        harness.records.substituteReceiptCause = true;
        await expect(
            harness.port.invoke(request(invocation, [{ value: 1 }], () => undefined))
        ).rejects.toThrow(/Audit cause must exist before append/);
        expect(
            harness.transactions.transact((transaction) =>
                harness.ledger.currentReceipt(transaction, invocation, 0)
            )
        ).toBeUndefined();
    });

    test(
        "rejects a canonical identity whose replay carries a different intent",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("canonical-identity-drift");

            const first = await harness.port.invoke(
                request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
            );
            expect(first.items[0]).toMatchObject({ kind: "succeeded", output: { value: 1 } });

            await expect(
                harness.port.invoke(
                    request(invocation, [{ value: 2 }], (index) => harness.executions.push(index))
                )
            ).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Prepared Invocation changed under its canonical identity"
            });
            expect(harness.executions).toEqual([0]);
        }
    );

    test(
        "rethrows a non-denial permit failure without recording any receipt",
        { tags: "p1" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("permit-infrastructure-fault");
            harness.permits.onIssue = async () => {
                throw new AgentCoreError("lease.invalid", "permit infrastructure fault");
            };

            await expect(
                harness.port.invoke(
                    request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
                )
            ).rejects.toMatchObject({
                code: "lease.invalid",
                message: "permit infrastructure fault"
            });
            expect(harness.executions).toEqual([]);
            expect(
                harness.transactions.transact((transaction) =>
                    harness.ledger.currentReceipt(transaction, invocation, 0)
                )
            ).toBeUndefined();
        }
    );

    test(
        "rethrows a non-denial authentication failure without recording any receipt",
        { tags: "p1" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("authentication-infrastructure-fault");
            harness.authentication.onAuthenticate = async () => {
                throw new AgentCoreError("lease.invalid", "authentication infrastructure fault");
            };

            await expect(
                harness.port.invoke(
                    request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
                )
            ).rejects.toMatchObject({
                code: "lease.invalid",
                message: "authentication infrastructure fault"
            });
            expect(harness.executions).toEqual([]);
            expect(
                harness.transactions.transact((transaction) =>
                    harness.ledger.currentReceipt(transaction, invocation, 0)
                )
            ).toBeUndefined();
        }
    );

    test(
        "reports the exact permit denial reason and its blank-message fallback",
        { tags: "p2" },
        async () => {
            const denied = new Harness(false);
            denied.permits.deniedItems.add(0);
            const deniedResult = await denied.port.invoke(
                request(new InvocationId("permit-denied-reason"), [{ value: 1 }], () => undefined)
            );
            expect(deniedResult.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "deniedPreEffect", reason: "permit denied" }
            });

            const blank = new Harness(false);
            blank.permits.onIssue = async () => {
                throw new AgentCoreError("authority.denied", "");
            };
            const blankResult = await blank.port.invoke(
                request(new InvocationId("permit-denied-blank"), [{ value: 1 }], () => undefined)
            );
            expect(blankResult.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "deniedPreEffect", reason: "Authority permit denied" }
            });
        }
    );

    test(
        "reports the exact authentication denial reason and its blank-message fallback",
        { tags: "p2" },
        async () => {
            const denied = new Harness(false);
            denied.authentication.deniedItems.add(0);
            const deniedResult = await denied.port.invoke(
                request(
                    new InvocationId("authentication-denied-reason"),
                    [{ value: 1 }],
                    () => undefined
                )
            );
            expect(deniedResult.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "deniedPreEffect", reason: "permit authentication denied" }
            });

            const blank = new Harness(false);
            blank.authentication.onAuthenticate = async () => {
                throw new AgentCoreError("authority.denied", "");
            };
            const blankResult = await blank.port.invoke(
                request(
                    new InvocationId("authentication-denied-blank"),
                    [{ value: 1 }],
                    () => undefined
                )
            );
            expect(blankResult.items[0]).toMatchObject({
                kind: "terminal",
                receipt: {
                    outcome: "deniedPreEffect",
                    reason: "Authority permit authentication denied"
                }
            });
        }
    );

    test(
        "retries admission after its claim was recovered during permit issuance",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("claim-recovered-mid-issue");
            const issued = deferred<void>();
            const releaseFirst = deferred<void>();
            const held = deferred<void>();
            const releaseSecond = deferred<void>();
            let issueCalls = 0;
            harness.permits.onIssue = async () => {
                issueCalls += 1;
                if (issueCalls === 1) {
                    issued.resolve(undefined);
                    await releaseFirst.promise;
                } else if (issueCalls === 2) {
                    held.resolve(undefined);
                    await releaseSecond.promise;
                }
            };
            const value = request(invocation, [{ value: 1 }], (index) =>
                harness.executions.push(index)
            );

            const stale = harness.port.invoke(value);
            await issued.promise;
            harness.setTime(10_000);
            harness.restartRuntime();
            const recovered = harness.port.invoke(value);
            await held.promise;

            releaseFirst.resolve(undefined);
            await expect(stale).resolves.toMatchObject({
                items: [{ kind: "succeeded", output: { value: 1 } }]
            });
            releaseSecond.resolve(undefined);
            await expect(recovered).resolves.toMatchObject({
                items: [{ kind: "succeeded", output: { value: 1 } }]
            });

            expect(harness.executions).toEqual([0]);
            const durable = harness.transactions.transact((transaction) => ({
                claims: harness.persistence.claimsForItem(transaction, invocation, 0),
                attempts: harness.persistence.attemptsForItem(transaction, invocation, 0)
            }));
            expect(durable.claims.map((claim) => claim.id.value)).toEqual([
                `claim:${invocation.value}:0:0`,
                `claim:${invocation.value}:0:recovered`
            ]);
            expect(durable.attempts).toHaveLength(1);
            expect(durable.attempts[0]?.claim.value).toBe(
                `claim:${invocation.value}:0:recovered`
            );
        }
    );

    test(
        "returns the racing pre-effect denial instead of admitting a stale permit",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("denial-raced-admission");
            const issued = deferred<void>();
            const release = deferred<void>();
            let issueCalls = 0;
            harness.permits.onIssue = async () => {
                issueCalls += 1;
                if (issueCalls === 1) {
                    issued.resolve(undefined);
                    await release.promise;
                } else {
                    throw new AgentCoreError("authority.denied", "concurrent permit denial");
                }
            };
            const value = request(invocation, [{ value: 1 }], (index) =>
                harness.executions.push(index)
            );

            const admitted = harness.port.invoke(value);
            await issued.promise;
            harness.restartRuntime();
            const denied = await harness.port.invoke(value);
            release.resolve(undefined);
            const raced = await admitted;

            expect(denied.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "deniedPreEffect", reason: "concurrent permit denial" }
            });
            expect(raced.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "deniedPreEffect" }
            });
            expect(itemReceipt(raced, 0).id.equals(itemReceipt(denied, 0).id)).toBe(true);
            expect(harness.executions).toEqual([]);
            expect(
                harness.transactions.transact((transaction) =>
                    harness.persistence.attemptsForItem(transaction, invocation, 0)
                )
            ).toEqual([]);
        }
    );

    test(
        "replays a concurrent final failed receipt without duplicating the failed effect",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("failed-receipt-raced-admission");
            const issued = deferred<void>();
            const release = deferred<void>();
            let issueCalls = 0;
            harness.permits.onIssue = async () => {
                issueCalls += 1;
                if (issueCalls === 1) {
                    issued.resolve(undefined);
                    await release.promise;
                }
            };
            let executions = 0;
            const value = request(invocation, [{ value: 1 }], () => {
                executions += 1;
                throw new ConfirmedOperationFailure(
                    "confirmed remote failure",
                    ContentRef.fromDigest(digest("confirmed remote failure"))
                );
            });

            const raced = harness.port.invoke(value);
            await issued.promise;
            harness.restartRuntime();
            const failed = await harness.port.invoke(value);
            release.resolve(undefined);
            const replayed = await raced;

            expect(failed.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "failed" }
            });
            expect(replayed.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "failed" }
            });
            expect(itemReceipt(replayed, 0).id.equals(itemReceipt(failed, 0).id)).toBe(true);
            expect(executions).toBe(1);
            expect(
                harness.transactions.transact((transaction) =>
                    harness.persistence.attemptsForItem(transaction, invocation, 0)
                )
            ).toHaveLength(1);
        }
    );

    test(
        "reports a live concurrent attempt as lost target admission without repeating the effect",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("attempt-raced-admission");
            const issued = deferred<void>();
            const release = deferred<void>();
            const started = deferred<void>();
            const complete = deferred<void>();
            let issueCalls = 0;
            harness.permits.onIssue = async () => {
                issueCalls += 1;
                if (issueCalls === 1) {
                    issued.resolve(undefined);
                    await release.promise;
                }
            };
            const value = request(invocation, [{ value: 1 }], (index) =>
                harness.executions.push(index)
            );

            const loser = harness.port.invoke(value);
            await issued.promise;
            harness.restartRuntime();
            const winner = harness.port.invoke({
                ...value,
                request: {
                    ...value.request,
                    execute: async () => {
                        started.resolve(undefined);
                        await complete.promise;
                        return { value: 1 };
                    }
                }
            });
            await started.promise;
            release.resolve(undefined);

            await expect(loser).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "A concurrent EffectAttempt won target admission"
            });
            complete.resolve(undefined);
            await expect(winner).resolves.toMatchObject({
                items: [{ kind: "succeeded", output: { value: 1 } }]
            });
            expect(harness.executions).toEqual([]);
            expect(
                harness.transactions.transact((transaction) =>
                    harness.persistence.attemptsForItem(transaction, invocation, 0)
                )
            ).toHaveLength(1);
        }
    );

    test(
        "rejects an authority denial that raced an attempted item receipt",
        { tags: "p0" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("denial-after-attempt-receipt");
            const issued = deferred<void>();
            const release = deferred<void>();
            let issueCalls = 0;
            harness.permits.onIssue = async () => {
                issueCalls += 1;
                if (issueCalls === 1) {
                    issued.resolve(undefined);
                    await release.promise;
                    throw new AgentCoreError("authority.denied", "raced permit denial");
                }
            };
            const value = request(invocation, [{ value: 1 }], (index) =>
                harness.executions.push(index)
            );

            const denied = harness.port.invoke(value);
            await issued.promise;
            harness.restartRuntime();
            const completed = await harness.port.invoke(value);

            release.resolve(undefined);
            await expect(denied).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Authority denial raced an attempted item Receipt"
            });
            expect(completed.items[0]).toMatchObject({ kind: "succeeded", output: { value: 1 } });
            expect(harness.executions).toEqual([0]);
        }
    );

    test(
        "terminalizes as indeterminate when result content persistence fails after the effect",
        { tags: "p1" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("result-content-crash");
            const port = new CanonicalBatchInvocationPort<
                string,
                CanonicalBatchHarnessState,
                string,
                string,
                string,
                string,
                string
            >(
                harness.transactions,
                harness.persistence,
                harness.ledger,
                harness.preparation,
                harness.permits,
                harness.authentication,
                harness.records,
                harness.finalAdmissions,
                harness.evidence,
                {
                    resources: () => ({
                        signal: new AbortController().signal,
                        content: new FailingPutContentStore(harness.content)
                    })
                },
                harness.now
            );

            const result = await port.invoke(
                request(invocation, [{ value: 1 }], (index) => harness.executions.push(index))
            );

            expect(result.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "indeterminate" }
            });
            expect(harness.executions).toEqual([0]);
        }
    );

    test("recovers a claim exactly at its expiry instant", { tags: "p1" }, async () => {
        const harness = new Harness(false);
        const invocation = new InvocationId("claim-expiry-boundary");
        harness.permits.crashOnce = true;
        const value = request(invocation, [{ value: 1 }], () => undefined);
        await expect(harness.port.invoke(value)).rejects.toThrow("permit transport crash");

        const claim = harness.transactions.transact((transaction) =>
            harness.persistence.claimsForItem(transaction, invocation, 0).at(0)
        );
        if (claim === undefined) throw new TypeError("Initial claim is missing");
        harness.setTime(claim.expiresAt.getTime());
        const recovered = await harness.port.invoke(value);

        expect(recovered.items[0]).toMatchObject({ kind: "succeeded", output: { value: 1 } });
        expect(harness.records.createdClaims).toBe(2);
        expect(
            harness.transactions.transact((transaction) =>
                harness.persistence.claimsForItem(transaction, invocation, 0)
            )
        ).toHaveLength(2);
    });

    test(
        "rejects replaying a succeeded receipt that lost its canonical result content",
        { tags: "p1" },
        async () => {
            const harness = new Harness(false);
            const invocation = new InvocationId("succeeded-receipt-without-result");
            const value = request(invocation, [{ value: 1 }], () => {
                throw new TypeError("provider response was lost");
            });
            const indeterminate = await harness.port.invoke(value);
            expect(indeterminate.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "indeterminate" }
            });

            harness.transactions.transact((transaction) => {
                const attempt = harness.persistence
                    .attemptsForItem(transaction, invocation, 0)
                    .at(0);
                if (attempt === undefined) throw new TypeError("EffectAttempt is missing");
                const receipt = harness.persistence
                    .receiptsForAttempt(transaction, attempt.id)
                    .at(0);
                if (!(receipt instanceof AttemptReceipt)) {
                    throw new TypeError("AttemptReceipt is missing");
                }
                transaction.receipts.set(
                    receipt.id.value,
                    ReceiptCodec.encode(
                        new AttemptReceipt(
                            receipt.id,
                            receipt.attempt,
                            "succeeded",
                            undefined,
                            receipt.recordedAt,
                            undefined
                        )
                    )
                );
            });

            await expect(harness.port.invoke(value)).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Successful Operation Receipt has no canonical result content"
            });
        }
    );

    test("rejects inexact input and interception counts independently", { tags: "p1" }, async () => {
        const inputs = new Harness(false);
        const value = request(new InvocationId("inexact-inputs"), [{ value: 1 }], () => undefined);
        await expect(
            inputs.port.invoke({
                ...value,
                request: {
                    ...value.request,
                    shape: { kind: "batch", itemCount: 2 },
                    interceptions: [[], []]
                }
            })
        ).rejects.toThrow(/nonempty exact payload shape/);

        const interceptions = new Harness(false);
        const exact = request(
            new InvocationId("inexact-interceptions"),
            [{ value: 1 }],
            () => undefined
        );
        await expect(
            interceptions.port.invoke({
                ...exact,
                request: { ...exact.request, interceptions: [] }
            })
        ).rejects.toThrow(/nonempty exact payload shape/);
    });

    test("rejects a prepared invocation whose operation binding drifts", { tags: "p1" }, async () => {
        const kind = new Harness(false);
        kind.preparation.override = (bound) =>
            kind.preparation.create(bound.invocation, bound.request.inputs, "single");
        await expect(
            kind.port.invoke(
                request(new InvocationId("prepared-kind-drift"), [{ value: 1 }], () => undefined)
            )
        ).rejects.toThrow(/does not bind the exact canonical batch request/);

        const target = new Harness(false);
        const other = new CanonicalBatchPreparation<string>(false, new FacetRef("workspace:other"));
        target.preparation.override = (bound) =>
            other.create(bound.invocation, bound.request.inputs);
        await expect(
            target.port.invoke(
                request(new InvocationId("prepared-target-drift"), [{ value: 1 }], () => undefined)
            )
        ).rejects.toThrow(/does not bind the exact canonical batch request/);

        const impact = new Harness(false);
        const impactInvocation = new InvocationId("prepared-impact-drift");
        impact.preparation.override = () => impactDriftedPrepared(impactInvocation, [{ value: 1 }]);
        await expect(
            impact.port.invoke(request(impactInvocation, [{ value: 1 }], () => undefined))
        ).rejects.toThrow(/does not bind the exact canonical batch request/);
    });

    test("rejects prepared items that drift from the canonical inputs", { tags: "p1" }, async () => {
        const count = new Harness(false);
        count.preparation.override = (bound) =>
            count.preparation.create(bound.invocation, [...bound.request.inputs, { value: 2 }]);
        await expect(
            count.port.invoke(
                request(new InvocationId("prepared-count-drift"), [{ value: 1 }], () => undefined)
            )
        ).rejects.toThrow(/does not bind the exact canonical batch request/);

        const single = new Harness(false);
        single.preparation.override = (bound) =>
            single.preparation.create(bound.invocation, [{ value: 999 }]);
        await expect(
            single.port.invoke(
                request(new InvocationId("prepared-item-drift"), [{ value: 1 }], () => undefined)
            )
        ).rejects.toThrow(/does not bind the exact canonical batch request/);

        const partial = new Harness(false);
        partial.preparation.override = (bound) =>
            partial.preparation.create(bound.invocation, [bound.request.inputs[0], { value: 999 }]);
        await expect(
            partial.port.invoke(
                request(
                    new InvocationId("prepared-partial-drift"),
                    [{ value: 1 }, { value: 2 }],
                    () => undefined
                )
            )
        ).rejects.toThrow(/does not bind the exact canonical batch request/);
    });
});

function request(
    invocation: InvocationId,
    inputs: readonly Record<string, number>[],
    onExecute: (itemIndex: number) => void
): CanonicalBatchInvocationRequest<string> {
    return {
        invocation,
        request: {
            requestKey: new OperationRequestKey(`request:${invocation.value}`),
            facet,
            descriptor,
            shape: { kind: "batch", itemCount: inputs.length },
            inputs,
            authorization: "authorization",
            interceptions: inputs.map(() => []),
            execute: async (itemIndex, context) => {
                onExecute(itemIndex);
                return inputs[context.itemIndex]!;
            }
        }
    };
}

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}

function itemReceipt(result: CanonicalBatchInvocationResult, itemIndex: number): Receipt {
    const item = result.items[itemIndex];
    if (item === undefined) throw new TypeError("Canonical batch item result is missing");
    return item.receipt;
}

// Mirrors the harness operation pin while flipping only the impact, so the drift is
// invisible to the descriptor digest and must be caught by the impact binding check.
function impactDriftedPrepared(
    invocation: InvocationId,
    items: readonly [FacetData, ...FacetData[]]
): PreparedInvocation<string, string, string, string> {
    return PreparedInvocation.create(
        {
            id: invocation,
            operation: OperationPin.create({
                operation: new OperationRef(`canonical-package:${descriptor.name.value}`),
                target: facet.value,
                package: new PackageId("canonical-package"),
                version: new SemVer("1.0.0"),
                manifestDigest: digest("manifest"),
                descriptorDigest: Digest.sha256(encodeCanonicalJson(descriptor.toData())),
                configurationDigest: digest("configuration"),
                runtimeDigest: digest("runtime"),
                activationGeneration: "generation",
                registration: "registration",
                impact: "mutate",
                approvalRequired: false,
                placement: new InvocationPlacementPin({
                    manifest: ["provider"],
                    policy: ["provider"],
                    substrate: ["provider"],
                    trust: ["provider"],
                    selected: "provider"
                })
            }),
            domain: `domain:${invocation.value}`,
            actor: new ActorRef("run", new ActorId(`actor:${invocation.value}`)),
            authority: `authority:${invocation.value}`,
            pathEpochs: `epochs:${invocation.value}`,
            auditCause: new AuditRecordId(`audit:${invocation.value}`),
            idempotencySeed: `seed:${invocation.value}`
        },
        { kind: "batch", items },
        preparedReferenceCodecs
    );
}

class FailingPutContentStore extends ContentStore {
    public constructor(private readonly inner: ContentStore) {
        super();
    }

    public put(): ReturnType<ContentStore["put"]> {
        return Promise.reject(new TypeError("content persistence crash"));
    }

    public get(...parameters: Parameters<ContentStore["get"]>): ReturnType<ContentStore["get"]> {
        return this.inner.get(...parameters);
    }

    public stat(...parameters: Parameters<ContentStore["stat"]>): ReturnType<ContentStore["stat"]> {
        return this.inner.stat(...parameters);
    }
}

function time(second: number): Date {
    return new Date(second * 1_000);
}

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value | PromiseLike<Value>) => void;
} {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    const promise = new Promise<Value>((fulfill) => {
        resolve = fulfill;
    });
    return { promise, resolve };
}
