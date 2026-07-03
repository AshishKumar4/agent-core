import { describe, expect, test } from "vitest";
import { RunId, TurnLeaseCommit, type TurnLeaseVerifier } from "../../src/agents";
import { AgentCoreError } from "../../src/errors";
import { BindingName, FacetDataSchemas, FacetOperationName, OperationAddress, OperationDescriptor, ProtectionDomain, type FacetData } from "../../src/facets";
import { Principal, PrincipalId } from "../../src/identity";
import {
    Approval,
    ApprovalId,
    ApprovalResolution,
    AuditRecord,
    AuditRecordId,
    Invocation,
    InvocationId,
    InvocationMetadata,
    InvocationPipeline,
    InvocationReceipt,
    ReceiptId,
    digestFacetData,
    type InvokableOperation,
    type InvocationDecision,
    type InvocationEventKind,
    type InvocationIdFactory,
    type InvocationMediator,
    type InvocationOperationResolver,
    type InvocationRecorder,
    type ReceiptStatus
} from "../../src/invocations";
import { OperationContext, OperationId } from "../../src/operations";
import { NoopObservability, ObservationContext } from "../../src/observability";
import { ContentRef, Digest, Revision } from "../../src/record";
import { EventId, EventRecord, WorkspaceId } from "../../src/workspaces";

const workspaceId = new WorkspaceId("workspace-invocation-test");
const readDescriptor = new OperationDescriptor(
    new FacetOperationName("read"),
    "Read test operation.",
    "observe",
    FacetDataSchemas.any(),
    FacetDataSchemas.any()
);

const operationContext = new OperationContext({
    id: new OperationId("operation-invocation-test"),
    principal: new Principal(new PrincipalId("principal-invocation-test"), "user", "active"),
    domain: new ProtectionDomain("backend", "invocation-test", "no-secrets"),
    binding: new BindingName("fs"),
    lease: undefined,
    observability: new NoopObservability(ObservationContext.root("trace-invocation", "span-invocation"))
});

class DeniedLeaseVerifier implements TurnLeaseVerifier {
    public permits(_commit: TurnLeaseCommit): boolean {
        return false;
    }
}

const staleLeaseContext = new OperationContext({
    id: new OperationId("operation-stale-lease"),
    principal: new Principal(new PrincipalId("principal-stale-lease"), "user", "active"),
    domain: new ProtectionDomain("backend", "invocation-test", "no-secrets"),
    binding: new BindingName("fs"),
    lease: new TurnLeaseCommit(new PrincipalId("principal-stale-lease"), 1),
    leaseVerifier: new DeniedLeaseVerifier(),
    observability: new NoopObservability(ObservationContext.root("trace-stale-lease", "span-stale-lease"))
});

class EchoOperation implements InvokableOperation {
    public readonly descriptor = readDescriptor;
    public calls = 0;

    public execute(_context: OperationContext, input: FacetData): Promise<FacetData> {
        this.calls += 1;
        return Promise.resolve(input);
    }
}

class ThrowingOperation implements InvokableOperation {
    public readonly descriptor = readDescriptor;

    public constructor(private readonly error: Error) {
    }

    public execute(): Promise<FacetData> {
        return Promise.reject(this.error);
    }
}

class Resolver implements InvocationOperationResolver {
    public constructor(private readonly operation: InvokableOperation | undefined) {
    }

    public resolve(_address: OperationAddress): InvokableOperation | undefined {
        return this.operation;
    }
}

class Mediator implements InvocationMediator {
    public readonly recorded: InvocationReceipt[] = [];

    public constructor(private readonly decision: InvocationDecision) {
    }

    public decide(_invocation: Invocation): Promise<InvocationDecision> {
        return Promise.resolve(this.decision);
    }

    public readonly resolutions = new Map<string, Approval>();

    public resolve(approval: Approval, resolution: ApprovalResolution): Promise<Approval> {
        const resolved = (this.resolutions.get(approval.id.value) ?? approval).resolve(resolution);
        this.resolutions.set(approval.id.value, resolved);
        return Promise.resolve(resolved);
    }

    public record(invocation: Invocation, receipt: InvocationReceipt): Promise<Invocation> {
        this.recorded.push(receipt);
        return Promise.resolve(invocation.record(receipt));
    }
}

class Recorder implements InvocationRecorder {
    public readonly prepared: Invocation[] = [];
    public readonly approvals: Approval[] = [];
    public readonly receipts: InvocationReceipt[] = [];
    public readonly audits: AuditRecord[] = [];
    public readonly events: EventRecord[] = [];

    public recordPrepared(_context: OperationContext, invocation: Invocation): Promise<void> {
        this.prepared.push(invocation);
        return Promise.resolve();
    }

    public recordApproval(_context: OperationContext, approval: Approval): Promise<void> {
        this.approvals.push(approval);
        return Promise.resolve();
    }

    public recordReceipt(_context: OperationContext, receipt: InvocationReceipt): Promise<void> {
        this.receipts.push(receipt);
        return Promise.resolve();
    }

    public recordAudit(_context: OperationContext, record: AuditRecord): Promise<void> {
        this.audits.push(record);
        return Promise.resolve();
    }

    public emit(_context: OperationContext, event: EventRecord): Promise<void> {
        this.events.push(event);
        return Promise.resolve();
    }
}

class IdFactory implements InvocationIdFactory {
    public receiptId(invocation: Invocation, status: ReceiptStatus): ReceiptId {
        return new ReceiptId(`receipt-${invocation.id.value}-${status}`);
    }

    public auditRecordId(invocation: Invocation, kind: AuditRecord["kind"]): AuditRecordId {
        return new AuditRecordId(`audit-${invocation.id.value}-${kind}`);
    }

    public eventId(invocation: Invocation, kind: InvocationEventKind): EventId {
        return new EventId(`event-${invocation.id.value}-${kind}`);
    }

    public approvalId(invocation: Invocation): ApprovalId {
        return new ApprovalId(`approval-${invocation.id.value}`);
    }
}

function invocation(input: FacetData = "payload"): Invocation {
    return new Invocation(
        new InvocationId("invocation-test"),
        new RunId("run-test"),
        0,
        new OperationAddress(new BindingName("fs"), new FacetOperationName("read")),
        "observe",
        digestFacetData(input),
        new ContentRef("content:argument"),
        "idempotency-key",
        "prepared",
        undefined,
        new InvocationMetadata(undefined, workspaceId, undefined, undefined, undefined, undefined)
    );
}

function pipeline(
    operation: InvokableOperation | undefined,
    decision: InvocationDecision,
    recorder: Recorder,
    mediator = new Mediator(decision)
): InvocationPipeline {
    return new InvocationPipeline(
        new Resolver(operation),
        mediator,
        recorder,
        new IdFactory()
    );
}

describe("InvocationPipeline", () => {
    test("records successful invocation lifecycle", async () => {
        const recorder = new Recorder();
        const result = await pipeline(new EchoOperation(), "invoke", recorder)
            .invoke(operationContext, invocation(), "payload");

        expect(result.kind).toBe("completed");
        if (result.kind !== "completed") {
            throw new Error("Expected completed invocation");
        }
        expect(result.output).toBe("payload");
        expect(result.invocation.status).toBe("succeeded");
        expect(recorder.prepared).toHaveLength(1);
        expect(recorder.receipts.map(receipt => receipt.status)).toEqual(["succeeded"]);
        expect(recorder.audits.map(record => record.kind)).toEqual(["prepared", "started", "succeeded"]);
        expect(recorder.events.map(event => event.kind.value)).toEqual(["invocation.prepared", "invocation.completed"]);
    });

    test("denies invocations whose declared digest does not match the input", async () => {
        const recorder = new Recorder();
        const result = await pipeline(new EchoOperation(), "invoke", recorder)
            .invoke(operationContext, invocation("different-payload"), "payload");

        expect(result.kind).toBe("denied");
        if (result.kind !== "denied") {
            throw new Error("Expected denied invocation");
        }
        expect(result.receipt.status).toBe("denied");
    });

    test("denies invocations whose declared impact does not match the operation", async () => {
        const recorder = new Recorder();
        const mismatched = new Invocation(
            new InvocationId("invocation-impact-mismatch"),
            new RunId("run-test"),
            0,
            new OperationAddress(new BindingName("fs"), new FacetOperationName("read")),
            "mutate",
            digestFacetData("payload"),
            new ContentRef("content:argument"),
            "idempotency-impact-mismatch",
            "prepared",
            undefined,
            new InvocationMetadata(undefined, workspaceId, undefined, undefined, undefined, undefined)
        );
        const result = await pipeline(new EchoOperation(), "invoke", recorder)
            .invoke(operationContext, mismatched, "payload");

        expect(result.kind).toBe("denied");
        if (result.kind !== "denied") {
            throw new Error("Expected denied invocation");
        }
        expect(result.receipt.status).toBe("denied");
    });

    test("rejects stale run leases before preparing invocation work", async () => {
        const recorder = new Recorder();

        await expect(pipeline(new EchoOperation(), "invoke", recorder)
            .invoke(staleLeaseContext, invocation(), "payload"))
            .rejects.toMatchObject(new AgentCoreError("lease.invalid", "Invocation requires the current Run lease"));

        expect(recorder.prepared).toEqual([]);
        expect(recorder.audits).toEqual([]);
        expect(recorder.receipts).toEqual([]);
        expect(recorder.events).toEqual([]);
    });

    test("returns approval-required before invoking operation", async () => {
        const recorder = new Recorder();
        const result = await pipeline(new EchoOperation(), "request-approval", recorder)
            .invoke(operationContext, invocation(), "payload");

        expect(result.kind).toBe("approval-required");
        if (result.kind !== "approval-required") {
            throw new Error("Expected approval-required invocation");
        }
        expect(result.invocation.status).toBe("approval-required");
        expect(recorder.receipts).toHaveLength(0);
        expect(recorder.audits.map(record => record.kind)).toEqual(["prepared", "approval-required"]);
        expect(recorder.events.map(event => event.kind.value)).toEqual(["invocation.prepared", "invocation.approval-required"]);
    });

    test("records denied receipt when mediator rejects", async () => {
        const recorder = new Recorder();
        const result = await pipeline(new EchoOperation(), "reject", recorder)
            .invoke(operationContext, invocation(), "payload");

        expect(result.kind).toBe("denied");
        if (result.kind !== "denied") {
            throw new Error("Expected denied invocation");
        }
        expect(result.receipt.status).toBe("denied");
        expect(result.invocation.status).toBe("denied");
    });

    test("records failed receipt when operation is missing", async () => {
        const recorder = new Recorder();
        const result = await pipeline(undefined, "invoke", recorder)
            .invoke(operationContext, invocation(), "payload");

        expect(result.kind).toBe("failed");
        if (result.kind !== "failed") {
            throw new Error("Expected failed invocation");
        }
        expect(result.receipt.status).toBe("failed");
        expect(result.invocation.status).toBe("failed");
    });

    test("records failed receipt and preserves handler error", async () => {
        const recorder = new Recorder();
        const expected = new Error("handler failed");

        await expect(pipeline(new ThrowingOperation(expected), "invoke", recorder)
            .invoke(operationContext, invocation(), "payload")).rejects.toBe(expected);

        expect(recorder.receipts.map(receipt => receipt.status)).toEqual(["failed"]);
        expect(recorder.audits.map(record => record.kind)).toEqual(["prepared", "started", "failed"]);
    });

    test("approval resolves once while preserving invocation identity", async () => {
        const approval = new Approval(
            new ApprovalId("approval-test"),
            new WorkspaceId("workspace-test"),
            new RunId("run-test"),
            new InvocationId("invocation-test"),
            new Digest("operation-digest"),
            "pending",
            undefined,
            Revision.initial()
        );
        const resolved = approval.resolve(new ApprovalResolution(
            "approved",
            new PrincipalId("principal-test")
        ));

        expect(resolved.status).toBe("approved");
        expect(resolved.invocationId.equals(approval.invocationId)).toBe(true);
        expect(() => resolved.resolve(new ApprovalResolution(
            "denied",
            new PrincipalId("principal-test")
        ))).toThrow(TypeError);
    });
});

describe("InvocationPipeline approval continuation", () => {
    const approver = new PrincipalId("principal-approver");

    async function pendingApproval(operation: EchoOperation, recorder: Recorder, mediator: Mediator) {
        const pipe = pipeline(operation, "request-approval", recorder, mediator);
        const result = await pipe.invoke(operationContext, invocation(), "payload");
        if (result.kind !== "approval-required") {
            throw new Error("Expected approval-required invocation");
        }
        return { pipe, result };
    }

    test("persists a digest-bound pending approval", async () => {
        const recorder = new Recorder();
        const { result } = await pendingApproval(new EchoOperation(), recorder, new Mediator("request-approval"));

        expect(result.approval.status).toBe("pending");
        expect(result.approval.invocationId.equals(result.invocation.id)).toBe(true);
        expect(result.approval.operationDigest.equals(digestFacetData("payload"))).toBe(true);
        expect(result.invocation.metadata.approvalId?.equals(result.approval.id)).toBe(true);
        expect(recorder.approvals).toHaveLength(1);
        expect(recorder.receipts).toHaveLength(0);
    });

    test("executes an approved invocation after revalidation", async () => {
        const recorder = new Recorder();
        const operation = new EchoOperation();
        const { pipe, result } = await pendingApproval(operation, recorder, new Mediator("request-approval"));

        const completed = await pipe.resolveApproval(
            operationContext,
            result.invocation,
            result.approval,
            new ApprovalResolution("approved", approver),
            "payload"
        );

        expect(completed.kind).toBe("completed");
        if (completed.kind !== "completed") {
            throw new Error("Expected completed invocation");
        }
        expect(completed.output).toBe("payload");
        expect(completed.invocation.status).toBe("succeeded");
        expect(operation.calls).toBe(1);
        expect(recorder.audits.map(record => record.kind))
            .toEqual(["prepared", "approval-required", "started", "succeeded"]);
        expect(recorder.events.map(event => event.kind.value))
            .toEqual(["invocation.prepared", "invocation.approval-required", "invocation.completed"]);
    });

    test("denied approvals record a denied receipt without executing", async () => {
        const recorder = new Recorder();
        const operation = new EchoOperation();
        const { pipe, result } = await pendingApproval(operation, recorder, new Mediator("request-approval"));

        const denied = await pipe.resolveApproval(
            operationContext,
            result.invocation,
            result.approval,
            new ApprovalResolution("denied", approver),
            "payload"
        );

        expect(denied.kind).toBe("denied");
        if (denied.kind !== "denied") {
            throw new Error("Expected denied invocation");
        }
        expect(denied.receipt.status).toBe("denied");
        expect(operation.calls).toBe(0);
    });

    test("expired approvals record a cancelled receipt", async () => {
        const recorder = new Recorder();
        const operation = new EchoOperation();
        const { pipe, result } = await pendingApproval(operation, recorder, new Mediator("request-approval"));

        const cancelled = await pipe.resolveApproval(
            operationContext,
            result.invocation,
            result.approval,
            new ApprovalResolution("expired", approver),
            "payload"
        );

        expect(cancelled.kind).toBe("cancelled");
        if (cancelled.kind !== "cancelled") {
            throw new Error("Expected cancelled invocation");
        }
        expect(cancelled.receipt.status).toBe("cancelled");
        expect(operation.calls).toBe(0);
    });

    test("denies resume when the input does not match the approved digest", async () => {
        const recorder = new Recorder();
        const operation = new EchoOperation();
        const { pipe, result } = await pendingApproval(operation, recorder, new Mediator("request-approval"));

        const denied = await pipe.resolveApproval(
            operationContext,
            result.invocation,
            result.approval,
            new ApprovalResolution("approved", approver),
            "tampered-payload"
        );

        expect(denied.kind).toBe("denied");
        if (denied.kind !== "denied") {
            throw new Error("Expected denied invocation");
        }
        expect(denied.receipt.status).toBe("denied");
        expect(operation.calls).toBe(0);
    });

    test("rejects resume under a stale lease before any mutation", async () => {
        const recorder = new Recorder();
        const operation = new EchoOperation();
        const { pipe, result } = await pendingApproval(operation, recorder, new Mediator("request-approval"));

        await expect(pipe.resolveApproval(
            staleLeaseContext,
            result.invocation,
            result.approval,
            new ApprovalResolution("approved", approver),
            "payload"
        )).rejects.toMatchObject(new AgentCoreError("lease.invalid", "Invocation requires the current Run lease"));
        expect(operation.calls).toBe(0);
    });

    test("approvals are single-use across the continuation", async () => {
        const recorder = new Recorder();
        const operation = new EchoOperation();
        const mediator = new Mediator("request-approval");
        const { pipe, result } = await pendingApproval(operation, recorder, mediator);

        const completed = await pipe.resolveApproval(
            operationContext,
            result.invocation,
            result.approval,
            new ApprovalResolution("approved", approver),
            "payload"
        );
        expect(completed.kind).toBe("completed");

        await expect(pipe.resolveApproval(
            operationContext,
            result.invocation,
            result.approval,
            new ApprovalResolution("approved", approver),
            "payload"
        )).rejects.toThrow(TypeError);
        expect(operation.calls).toBe(1);
    });

    test("rejects an approval that does not belong to the invocation", async () => {
        const recorder = new Recorder();
        const operation = new EchoOperation();
        const { pipe, result } = await pendingApproval(operation, recorder, new Mediator("request-approval"));

        await expect(pipe.resolveApproval(
            operationContext,
            invocation(),
            result.approval,
            new ApprovalResolution("approved", approver),
            "payload"
        )).rejects.toMatchObject(new AgentCoreError(
            "invocation.invalid",
            "Approval resolution requires the Invocation's pending Approval"
        ));
        expect(operation.calls).toBe(0);
    });
});
