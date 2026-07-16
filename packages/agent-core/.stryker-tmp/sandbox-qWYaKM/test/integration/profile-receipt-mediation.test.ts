// @ts-nocheck
import { encodeCanonicalJson, type JsonValue } from "../../src/core";
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
    type ProfileEffectContext,
    type ProtectedOperationRequest
} from "../../src/facets";
import {
    AttemptReceipt,
    InvocationProtectedOperationPort,
    InvocationReconciler,
    ReceiptId
} from "../../src/invocations";
import { InvocationId } from "../../src/interaction-references";
import { describe, expect, test } from "vitest";
import { recordingRuntime } from "../profiles/facets/harness";
import { CanonicalBatchHarness } from "./canonical-batch-harness";

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

    test("[P11-APPROVAL-GATEWAY-RECONCILIATION] reconciles one indeterminate W6 attempt after restart without repeating the effect", async () => {
        const fixture = approvalFixture("approval-reconciliation", true);

        await expect(fixture.facet.applyAction(input)).rejects.toMatchObject({
            code: "invocation.invalid"
        });
        const indeterminate = fixture.harness.transactions.transact((transaction) =>
            fixture.harness.ledger.currentReceipt(transaction, fixture.invocation, 0)
        );
        const attempt = fixture.harness.transactions.transact(
            (transaction) =>
                fixture.harness.persistence.attemptsForItem(transaction, fixture.invocation, 0)[0]
        );
        expect(indeterminate).toMatchObject({ outcome: "indeterminate" });
        expect(attempt).toBeDefined();

        fixture.harness.transactions.restart();
        const result = await fixture.harness.content.put(encodeCanonicalJson({ applied: true }));
        const reconciler = new InvocationReconciler<string, string>({
            async query(candidate) {
                expect(candidate.id.equals(attempt!.id)).toBe(true);
                return { kind: "succeeded", result: result.ref };
            }
        });
        const final = await reconciler.reconcile(attempt!, {
            async finalize(_attempt, outcome) {
                return fixture.harness.transactions.transact((transaction) =>
                    fixture.harness.ledger.reconcile(
                        transaction,
                        indeterminate!.id,
                        new ReceiptId("approval-reconciled"),
                        new Date(10_000),
                        outcome
                    )
                );
            }
        });
        expect(final).toMatchObject({ outcome: "succeeded", previous: indeterminate!.id });

        fixture.harness.transactions.restart();
        await expect(fixture.facet.applyAction(input)).resolves.toEqual({ applied: true });
        expect(fixture.backend.effects).toHaveLength(1);
    });
});

function approvalFixture(id: string, failAfterEffect = false) {
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
    const backend = new ReconciledApprovalBackend(failAfterEffect);
    const facet = new ApprovalGatewayFacet(
        runtime,
        new ApprovalGatewayAction(invocation, intent, input.resource, { approved: true }),
        backend
    );
    return { invocation, harness, backend, facet };
}

class ReconciledApprovalBackend extends ApprovalGatewayBackend {
    public readonly effects: JsonValue[] = [];

    public constructor(private readonly failAfterEffect: boolean) {
        super();
    }

    public async observe(resource: string): Promise<JsonValue> {
        return { resource };
    }

    public async apply(
        _context: ProfileEffectContext,
        _resource: string,
        action: JsonValue
    ): Promise<JsonValue> {
        this.effects.push(action);
        if (this.failAfterEffect) throw new TypeError("provider outcome was lost");
        return { applied: true };
    }
}
