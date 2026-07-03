import { describe, expect, test } from "vitest";
import { BindingSet, RunId } from "../../src/agents";
import {
    AuthoritySummary,
    BindingName,
    Facet,
    FacetContext,
    FacetDataSchemas,
    FacetDescription,
    FacetId,
    FacetOperation,
    FacetOperationHandler,
    FacetOperationName,
    FacetVersion,
    OperationAddress,
    OperationDescriptor,
    OperationSet,
    ProtectionDomain,
    type FacetData,
    type FacetDataMap
} from "../../src/facets";
import { Principal, PrincipalId } from "../../src/identity";
import {
    Approval,
    ApprovalId,
    AuditRecord,
    AuditRecordId,
    Invocation,
    InvocationId,
    InvocationMetadata,
    InvocationPipeline,
    InvocationReceipt,
    PipelineSubscriptionInvoker,
    ReceiptId,
    digestFacetData,
    type InvokableOperation,
    type InvocationDecision,
    type InvocationEventKind,
    type InvocationIdFactory,
    type InvocationMediator,
    type InvocationOperationResolver,
    type InvocationRecorder,
    type ReceiptStatus,
    type SubscriptionInvocationFactory
} from "../../src/invocations";
import { OperationContext, OperationId } from "../../src/operations";
import { NoopObservability, NoopTelemetry, ObservationContext } from "../../src/observability";
import { Revision } from "../../src/record";
import {
    DedupePolicy,
    EventId,
    EventKind,
    EventPattern,
    EventRecord,
    EventSource,
    MemoryWorkspaceEventStore,
    MemoryWorkspaceInvocationStore,
    MemoryWorkspaceSubscriptionStore,
    PayloadMapping,
    Subscription,
    SubscriptionId,
    WorkspaceId,
    WorkspaceRuntime
} from "../../src/workspaces";

type TaskInput = FacetDataMap & {
    readonly taskId: string;
    readonly status: string;
};

const workspaceId = new WorkspaceId("workspace-runtime");
const bindingName = new BindingName("tasks");
const operationName = new FacetOperationName("task.update");
const eventKind = new EventKind("tasks.task.updated");
const occurredAt = new Date("2026-06-30T12:00:00.000Z");

function context(
    authority = bindings().authorityFor(bindingName),
    authorityVerifier = bindings()
): OperationContext {
    const init = {
        id: new OperationId("operation-runtime"),
        principal: new Principal(new PrincipalId("principal-runtime"), "service", "active"),
        domain: new ProtectionDomain("backend", "runtime", "no-secrets"),
        binding: bindingName,
        lease: undefined,
        observability: new NoopObservability(ObservationContext.root("trace-runtime", "span-runtime"))
    };

    return new OperationContext(authority === undefined ? init : { ...init, authority, authorityVerifier });
}

class TaskHandler extends FacetOperationHandler<TaskInput, FacetData> {
    public readonly inputs: TaskInput[] = [];

    public execute(_context: OperationContext, input: TaskInput): Promise<FacetData> {
        this.inputs.push(input);
        return Promise.resolve({ handled: true, taskId: input.taskId, status: input.status });
    }
}

class TaskFacet extends Facet {
    public constructor(context: FacetContext, private readonly handler: TaskHandler) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "Tasks",
            "Task runtime test facet.",
            new FacetVersion("1"),
            AuthoritySummary.scoped("Mutates tasks")
        );
    }

    public operations(): OperationSet {
        return OperationSet.of([
            new FacetOperation(
                new OperationDescriptor(
                    operationName,
                    "Update a task.",
                    "mutate",
                    FacetDataSchemas.object(),
                    FacetDataSchemas.object()
                ),
                this.handler
            )
        ]);
    }
}

class Resolver implements InvocationOperationResolver {
    public constructor(private readonly catalog: { resolve(address: OperationAddress): InvokableOperation | undefined }) {
    }

    public resolve(address: OperationAddress): InvokableOperation | undefined {
        return this.catalog.resolve(address);
    }
}

class Mediator implements InvocationMediator {
    public decide(_invocation: Invocation): Promise<InvocationDecision> {
        return Promise.resolve("invoke");
    }

    public resolve(): never {
        throw new Error("Approval is not part of this runtime test");
    }

    public record(invocation: Invocation, receipt: InvocationReceipt): Promise<Invocation> {
        return Promise.resolve(invocation.record(receipt));
    }
}

class Recorder implements InvocationRecorder {
    public readonly receipts: InvocationReceipt[] = [];

    public recordApproval(_context: OperationContext, _approval: Approval): Promise<void> {
        return Promise.resolve();
    }

    public recordPrepared(_context: OperationContext, _invocation: Invocation): Promise<void> {
        return Promise.resolve();
    }

    public recordReceipt(_context: OperationContext, receipt: InvocationReceipt): Promise<void> {
        this.receipts.push(receipt);
        return Promise.resolve();
    }

    public recordAudit(_context: OperationContext, _record: AuditRecord): Promise<void> {
        return Promise.resolve();
    }

    public emit(_context: OperationContext, _event: EventRecord): Promise<void> {
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

class EventInvocationFactory implements SubscriptionInvocationFactory {
    public create(
        _context: OperationContext,
        subscription: Subscription,
        event: EventRecord,
        input: FacetDataMap
    ): Invocation {
        return new Invocation(
            new InvocationId(`invocation-${event.id.value}`),
            new RunId(`run-${event.id.value}`),
            0,
            subscription.operation,
            "mutate",
            digestFacetData(input),
            undefined,
            `${subscription.id.value}-${event.id.value}`,
            "prepared",
            undefined,
            new InvocationMetadata(undefined, event.workspaceId, undefined, undefined, event.id, undefined)
        );
    }
}

function bindings(handler = new TaskHandler()): BindingSet {
    return BindingSet.of([
        new TaskFacet(
            new FacetContext(
                new FacetId("facet-tasks"),
                bindingName,
                new OperationContext({
                    id: new OperationId("operation-facet"),
                    principal: new Principal(new PrincipalId("principal-facet"), "service", "active"),
                    domain: new ProtectionDomain("backend", "runtime", "no-secrets"),
                    binding: bindingName,
                    lease: undefined,
                    observability: new NoopObservability(ObservationContext.root("trace-facet", "span-facet"))
                }),
                new NoopTelemetry()
            ),
            handler
        )
    ]);
}

describe("WorkspaceRuntime", () => {
    test("accepts events and routes matching subscriptions through invocations", async () => {
        const handler = new TaskHandler();
        const bindingSet = bindings(handler);
        await bindingSet.facets.start(context(bindingSet.authorityFor(bindingName), bindingSet));
        const events = new MemoryWorkspaceEventStore();
        const invocations = new MemoryWorkspaceInvocationStore();
        const recorder = new Recorder();
        const runtime = new WorkspaceRuntime(
            workspaceId,
            events,
            new MemoryWorkspaceSubscriptionStore([
                new Subscription(
                    new SubscriptionId("subscription-runtime"),
                    workspaceId,
                    new EventPattern("tasks.task.*", undefined, "workspace"),
                    new OperationAddress(bindingName, operationName),
                    "enabled",
                    DedupePolicy.payload("taskId"),
                    [new PayloadMapping("taskId", "taskId"), new PayloadMapping("status", "status")],
                    Revision.initial()
                )
            ]),
            invocations,
            new PipelineSubscriptionInvoker(
                new InvocationPipeline(new Resolver(bindingSet.operations()), new Mediator(), recorder, new IdFactory()),
                new EventInvocationFactory()
            )
        );

        const result = await runtime.acceptEvent(
            context(bindingSet.authorityFor(bindingName), bindingSet),
            new EventRecord(
                new EventId("event-runtime"),
                workspaceId,
                eventKind,
                new EventSource("test.runtime"),
                "workspace",
                { taskId: "task-1", status: "done" },
                undefined,
                occurredAt,
                Revision.initial()
            )
        );

        expect((await events.list()).map(event => event.id.value)).toEqual(["event-runtime"]);
        expect((await invocations.list()).map(record => record.receipt?.status)).toEqual(["succeeded"]);
        expect(result.route.invocations).toHaveLength(1);
        expect(recorder.receipts.map(receipt => receipt.status)).toEqual(["succeeded"]);
        expect(handler.inputs).toEqual([{ taskId: "task-1", status: "done" }]);

        const duplicate = await runtime.acceptEvent(
            context(bindingSet.authorityFor(bindingName), bindingSet),
            new EventRecord(
                new EventId("event-runtime-duplicate"),
                workspaceId,
                eventKind,
                new EventSource("test.runtime"),
                "workspace",
                { taskId: "task-1", status: "done-again" },
                undefined,
                occurredAt,
                Revision.initial()
            )
        );

        expect(duplicate.route.invocations).toEqual([]);
        expect(duplicate.route.skipped.map(skip => skip.reason)).toEqual(["dedupe"]);
        expect(handler.inputs).toEqual([{ taskId: "task-1", status: "done" }]);
    });
});
