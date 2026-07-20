import { MemoryContentStore } from "../../src/content";
import { encodeCanonicalJson, type JsonValue } from "../../src/core";
import { ApprovalGatewayReconciliationPort } from "../../src/composition";
import {
    APPROVAL_GATEWAY_OPERATION_CONTRACTS,
    FILESYSTEM_OPERATION_CONTRACTS,
    ApprovalGatewayAction,
    ApprovalGatewayBackend,
    ApprovalGatewayFacet,
    BindingName,
    FacetRef,
    FilesystemFacet,
    MemoryFilesystemBackend,
    ProfileRuntimeHostBinding,
    ProtectedProfileRuntimePort,
    type EffectDispatch,
    type ProtectedOperationRequest
} from "../../src/facets";
import {
    AttemptReceipt,
    InvocationProtectedOperationPort,
    InvocationReconciler
} from "../../src/invocations";
import { InvocationId } from "../../src/interaction-references";
import { describe, expect, test } from "vitest";
import { recordingRuntime } from "../profiles/facets/harness";
import { CanonicalBatchHarness, type CanonicalBatchHarnessState } from "./canonical-batch-harness";

const target = new FacetRef("profile:approval");
const input = { resource: "account" } as const;

describe("Canonical profile Receipt mediation", () => {
    test("[P11-FILESYSTEM-RECEIPT] returns and replays the canonical persisted W6 Receipt for mutation", async () => {
        const target = new FacetRef("profile:filesystem");
        const invocation = new InvocationId("filesystem-write-receipt");
        const harness = new CanonicalBatchHarness<ProtectedOperationRequest>(
            false,
            target,
            FILESYSTEM_OPERATION_CONTRACTS.write.descriptor
        );
        const runtime = new ProtectedProfileRuntimePort(
            new ProfileRuntimeHostBinding(target, new BindingName("filesystem")),
            new InvocationProtectedOperationPort({ invocation: () => invocation }, harness.port),
            recordingRuntime("filesystem-effects").effects
        );
        runtime.activate();
        const backend = new MemoryFilesystemBackend();
        const filesystem = new FilesystemFacet(runtime, backend);
        const request = { path: "/file", content: new Uint8Array([1]) };

        const first = await filesystem.write(request);
        expect(first).toBeInstanceOf(AttemptReceipt);
        expect(first).toMatchObject({ outcome: "succeeded" });
        expect(
            harness.transactions.transact((transaction) =>
                harness.ledger.currentReceipt(transaction, invocation, 0)?.id.equals(first.id)
            )
        ).toBe(true);

        harness.transactions.restart();
        const replayed = await filesystem.write(request);
        expect(replayed.id.equals(first.id)).toBe(true);
        expect(
            harness.transactions.transact((transaction) =>
                harness.persistence.attemptsForItem(transaction, invocation, 0)
            )
        ).toHaveLength(1);
        expect(backend.read("/file")).toEqual(new Uint8Array([1]));
    });

    test("[P11-APPROVAL-GATEWAY-RECEIPTS] persists and replays the canonical W6 Receipt across restart", async () => {
        const fixture = approvalFixture("approval-receipt");

        await expect(fixture.facet.applyAction(input)).resolves.toEqual({ applied: true });
        const first = fixture.harness.transactions.transact((transaction) =>
            fixture.harness.ledger.currentReceipt(transaction, fixture.invocation, 0)
        );
        expect(first).toBeInstanceOf(AttemptReceipt);
        expect(first).toMatchObject({ outcome: "succeeded" });
        expect((first as AttemptReceipt).result).toBeDefined();

        fixture.harness.transactions.restart();
        await expect(fixture.facet.applyAction(input)).resolves.toEqual({ applied: true });
        const replayed = fixture.harness.transactions.transact((transaction) =>
            fixture.harness.ledger.currentReceipt(transaction, fixture.invocation, 0)
        );
        expect(replayed?.id.equals(first!.id)).toBe(true);
        expect(fixture.backend.effects).toHaveLength(1);
    });

    test(
        "[P11-APPROVAL-GATEWAY-RECONCILIATION] reconciles one indeterminate W6 attempt after restart without repeating the effect",
        { tags: "p0" },
        async () => {
            const fixture = approvalFixture("approval-reconciliation", true);

            await expect(fixture.facet.applyAction(input)).rejects.toMatchObject({
                code: "invocation.invalid"
            });
            const indeterminate = fixture.harness.transactions.transact((transaction) =>
                fixture.harness.ledger.currentReceipt(transaction, fixture.invocation, 0)
            );
            const attempt = fixture.harness.transactions.transact(
                (transaction) =>
                    fixture.harness.persistence.attemptsForItem(
                        transaction,
                        fixture.invocation,
                        0
                    )[0]
            );
            expect(indeterminate).toMatchObject({ outcome: "indeterminate" });
            expect(attempt).toBeDefined();

            fixture.harness.transactions.restart();
            const reconciler = new InvocationReconciler<
                CanonicalBatchHarnessState,
                string,
                string,
                string,
                string,
                string
            >(
                fixture.harness.transactions,
                fixture.harness.persistence,
                fixture.harness.ledger,
                new ApprovalGatewayReconciliationPort(fixture.backend, fixture.harness.content),
                fixture.harness.records,
                fixture.harness.evidence,
                fixture.harness.now
            );
            const final = await reconciler.reconcile(attempt!.id);
            const redelivered = await reconciler.reconcile(attempt!.id);
            expect(redelivered?.id.equals(final!.id)).toBe(true);
            expect(fixture.backend.queries).toBe(1);
            expect(final).toMatchObject({ outcome: "succeeded", previous: indeterminate!.id });
            const prepared = fixture.harness.preparation.create(
                fixture.invocation,
                [input],
                "single"
            );
            const evidence = fixture.harness.transactions.transact((transaction) => ({
                finalAudit: fixture.harness.evidence.findAuditByEvidence(
                    transaction,
                    prepared.header.actor,
                    { kind: "receipt", id: final!.id, outcome: final!.outcome }
                ),
                supersessionAudit: fixture.harness.evidence.findAuditByEvidence(
                    transaction,
                    prepared.header.actor,
                    {
                        kind: "receiptSuperseded",
                        previous: (indeterminate as AttemptReceipt).id,
                        next: final!.id
                    }
                ),
                publications: fixture.harness.evidence.pendingPublications(transaction)
            }));
            expect(evidence.finalAudit?.kind).toMatchObject({
                kind: "receipt",
                id: final?.id,
                outcome: "succeeded"
            });
            expect(evidence.supersessionAudit?.kind).toMatchObject({
                kind: "receiptSuperseded",
                previous: indeterminate?.id,
                next: final?.id
            });
            expect(evidence.publications).toHaveLength(2);
            expect(attempt!.idempotencyKey).toBe(prepared.item(0).idempotencyKey);
            expect(fixture.backend.appliedDispatch?.idempotencyKey).toBe(attempt!.idempotencyKey);
            expect(fixture.backend.appliedDispatch?.attempt).toMatchObject({
                id: attempt!.id,
                ordinal: attempt!.ordinal,
                intentDigest: prepared.intentDigest
            });
            expect(fixture.backend.reconciledDispatch).toEqual(fixture.backend.appliedDispatch);
            expect(
                final?.result === undefined
                    ? undefined
                    : await fixture.harness.content.get(final.result)
            ).toEqual(encodeCanonicalJson({ applied: true }));

            fixture.harness.transactions.restart();
            await expect(fixture.facet.applyAction(input)).resolves.toEqual({ applied: true });
            expect(fixture.backend.effects).toHaveLength(1);
        }
    );

    test(
        "unknown and content persistence failure leave the Receipt indeterminate",
        { tags: "p0" },
        async () => {
            for (const mode of ["unknown", "contentFailure"] as const) {
                const fixture = approvalFixture(`approval-${mode}`, true, mode);
                await expect(fixture.facet.applyAction(input)).rejects.toMatchObject({
                    code: "invocation.invalid"
                });
                const attempt = fixture.harness.transactions.transact(
                    (transaction) =>
                        fixture.harness.persistence.attemptsForItem(
                            transaction,
                            fixture.invocation,
                            0
                        )[0]!
                );
                const content =
                    mode === "contentFailure"
                        ? new (class extends MemoryContentStore {
                              public override async put(): Promise<never> {
                                  throw new TypeError("content persistence failed");
                              }
                          })()
                        : fixture.harness.content;
                const reconciler = new InvocationReconciler<
                    CanonicalBatchHarnessState,
                    string,
                    string,
                    string,
                    string,
                    string
                >(
                    fixture.harness.transactions,
                    fixture.harness.persistence,
                    fixture.harness.ledger,
                    new ApprovalGatewayReconciliationPort(fixture.backend, content),
                    fixture.harness.records,
                    fixture.harness.evidence,
                    fixture.harness.now
                );

                if (mode === "unknown") {
                    await expect(reconciler.reconcile(attempt.id)).resolves.toBeUndefined();
                } else {
                    await expect(reconciler.reconcile(attempt.id)).rejects.toThrow(
                        "content persistence failed"
                    );
                }
                expect(
                    fixture.harness.transactions.transact((transaction) =>
                        fixture.harness.ledger.currentReceipt(transaction, fixture.invocation, 0)
                    )
                ).toMatchObject({ outcome: "indeterminate" });
            }
        }
    );

    test(
        "failed reconciliation preserves optional canonical provider evidence",
        { tags: "p0" },
        async () => {
            for (const mode of ["failedWithResult", "failedWithoutResult"] as const) {
                const fixture = approvalFixture(`approval-${mode}`, true, mode);
                await expect(fixture.facet.applyAction(input)).rejects.toMatchObject({
                    code: "invocation.invalid"
                });
                const attempt = fixture.harness.transactions.transact(
                    (transaction) =>
                        fixture.harness.persistence.attemptsForItem(
                            transaction,
                            fixture.invocation,
                            0
                        )[0]!
                );
                const final = await new InvocationReconciler<
                    CanonicalBatchHarnessState,
                    string,
                    string,
                    string,
                    string,
                    string
                >(
                    fixture.harness.transactions,
                    fixture.harness.persistence,
                    fixture.harness.ledger,
                    new ApprovalGatewayReconciliationPort(fixture.backend, fixture.harness.content),
                    fixture.harness.records,
                    fixture.harness.evidence,
                    fixture.harness.now
                ).reconcile(attempt.id);

                expect(final).toMatchObject({ outcome: "failed" });
                if (mode === "failedWithResult") {
                    expect(
                        final?.result === undefined
                            ? undefined
                            : await fixture.harness.content.get(final.result)
                    ).toEqual(encodeCanonicalJson({ providerError: "declined" }));
                } else {
                    expect(final?.result).toBeUndefined();
                }
            }
        }
    );
});

function approvalFixture(
    id: string,
    failAfterEffect = false,
    reconciliation:
        | "succeeded"
        | "unknown"
        | "contentFailure"
        | "failedWithResult"
        | "failedWithoutResult" = "succeeded"
) {
    const invocation = new InvocationId(id);
    const descriptor = APPROVAL_GATEWAY_OPERATION_CONTRACTS.applyAction.descriptor;
    const harness = new CanonicalBatchHarness<ProtectedOperationRequest>(false, target, descriptor);
    const intent = harness.preparation.create(invocation, [input], "single").intentDigest;
    const operationPort = new InvocationProtectedOperationPort(
        { invocation: () => invocation },
        harness.port
    );
    const runtime = new ProtectedProfileRuntimePort(
        new ProfileRuntimeHostBinding(target, new BindingName("approval")),
        operationPort,
        recordingRuntime("approval-effects").effects
    );
    runtime.activate();
    const backend = new ReconciledApprovalBackend(failAfterEffect, reconciliation);
    const facet = new ApprovalGatewayFacet(
        runtime,
        new ApprovalGatewayAction(invocation, intent, input.resource, { approved: true }),
        backend
    );
    return { invocation, harness, backend, facet };
}

class ReconciledApprovalBackend extends ApprovalGatewayBackend {
    public readonly effects: JsonValue[] = [];
    public appliedDispatch: EffectDispatch | undefined;
    public reconciledDispatch: EffectDispatch | undefined;
    public queries = 0;

    public constructor(
        private readonly failAfterEffect: boolean,
        private readonly reconciliation:
            "succeeded" | "unknown" | "contentFailure" | "failedWithResult" | "failedWithoutResult"
    ) {
        super();
    }

    public async observe(resource: string): Promise<JsonValue> {
        return { resource };
    }

    public async apply(
        dispatch: EffectDispatch,
        _resource: string,
        action: JsonValue
    ): Promise<JsonValue> {
        this.appliedDispatch = dispatch;
        this.effects.push(action);
        if (this.failAfterEffect) throw new TypeError("provider outcome was lost");
        return { applied: true };
    }

    public async reconcile(dispatch: EffectDispatch) {
        this.queries += 1;
        this.reconciledDispatch = dispatch;
        if (this.reconciliation === "unknown") return { kind: "unknown" } as const;
        if (this.reconciliation === "failedWithResult") {
            return { kind: "failed", result: { providerError: "declined" } } as const;
        }
        if (this.reconciliation === "failedWithoutResult") return { kind: "failed" } as const;
        return { kind: "succeeded", result: { applied: true } } as const;
    }
}
