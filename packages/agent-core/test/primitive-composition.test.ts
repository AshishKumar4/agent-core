import { describe, expect, test } from "vitest";
import { BindingSet, RunId } from "../src/agents";
import { BindingRecord, ResolvedBinding } from "../src/authority";
import type { AuthorityVerifier, BindingAuthority } from "../src/authority";
import { AgentCoreError } from "../src/errors";
import {
    AuthoritySummary,
    BindingName,
    EventAddress,
    Facet,
    FacetContext,
    FacetDescription,
    FacetEventName,
    FacetDataSchemas,
    FacetId,
    FacetOperation,
    FacetOperationHandler,
    FacetOperationName,
    FacetVersion,
    OperationAddress,
    OperationDescriptor,
    OperationSet,
    ProtectionDomain,
    Surface,
    SurfaceAction,
    SurfaceActionSet,
    SurfaceId,
    SurfaceSet,
    View,
    ViewRequest,
    type FacetData,
    type FacetDataMap
} from "../src/facets";
import { Principal, PrincipalId } from "../src/identity";
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
} from "../src/invocations";
import { OperationContext, OperationId } from "../src/operations";
import { NoopObservability, NoopTelemetry, ObservationContext } from "../src/observability";
import { ContentRef, Revision } from "../src/record";
import {
    DedupePolicy,
    EventId,
    EventKind,
    EventPattern,
    EventRecord,
    EventSource,
    MemorySubscriptionDedupeStore,
    PayloadMapping,
    Subscription,
    SubscriptionId,
    SubscriptionRouter,
    WorkspaceId
} from "../src/workspaces";

type TaskUpdateInput = FacetDataMap & {
    readonly taskId: string;
    readonly status: string;
};

const workspaceId = new WorkspaceId("workspace-primitive-composition");
const principalId = new PrincipalId("principal-primitive-composition");
const operationName = new FacetOperationName("task.updateStatus");
const eventName = new FacetEventName("task.statusChanged");
const eventKind = new EventKind(`tasks.${eventName.value}`);
const eventSource = new EventSource("surface.task-board");
const occurredAt = new Date("2026-06-30T12:00:00.000Z");

function operationContext(
    name: string,
    binding = new BindingName("tasks"),
    authority: BindingAuthority | undefined = undefined,
    authorityVerifier: AuthorityVerifier | undefined = undefined
): OperationContext {
    const init = {
        id: new OperationId(`operation-${name}`),
        principal: new Principal(principalId, "user", "active"),
        domain: new ProtectionDomain("backend", "primitive-composition", "no-secrets"),
        binding,
        lease: undefined,
        observability: new NoopObservability(ObservationContext.root(`trace-${name}`, `span-${name}`))
    };

    if (authority === undefined) {
        return new OperationContext(init);
    }

    return new OperationContext(authorityVerifier === undefined
        ? { ...init, authority }
        : { ...init, authority, authorityVerifier });
}

function facetContext(name: string): FacetContext {
    const binding = new BindingName(name);

    return new FacetContext(
        new FacetId(`facet-${name}`),
        binding,
        operationContext(`facet-${name}`, binding),
        new NoopTelemetry()
    );
}

class RecordingTaskHandler extends FacetOperationHandler<TaskUpdateInput, FacetData> {
    public readonly inputs: TaskUpdateInput[] = [];

    public constructor(private readonly handledBy: string) {
        super();
    }

    public execute(_context: OperationContext, input: TaskUpdateInput): Promise<FacetData> {
        this.inputs.push(input);
        return Promise.resolve({ handledBy: this.handledBy, taskId: input.taskId, status: input.status });
    }
}

class TaskFacet extends Facet {
    public constructor(context: FacetContext, private readonly handler: RecordingTaskHandler) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "Tasks",
            "Updates task status from routed events.",
            new FacetVersion("1"),
            AuthoritySummary.scoped("Mutates task records inside the resolved workspace.")
        );
    }

    public operations(): OperationSet {
        return OperationSet.of([
            new FacetOperation(
                new OperationDescriptor(
                    operationName,
                    "Update a task status.",
                    "mutate",
                    FacetDataSchemas.object(),
                    FacetDataSchemas.object()
                ),
                this.handler
            )
        ]);
    }

    public surfaces(): SurfaceSet {
        return SurfaceSet.of([new TaskSurface()]);
    }
}

class TaskSurface extends Surface {
    public constructor() {
        super(new SurfaceId("task-board"), "Task board");
    }

    public descriptor(): FacetDataMap {
        return { kind: "task-board" };
    }

    public render(_context: OperationContext, _request: ViewRequest): Promise<View> {
        return Promise.resolve(new View(
            this.id,
            Revision.initial(),
            { title: "Task board" },
            "application/vnd.agent-core.task-board",
            this.actions().actions
        ));
    }

    public actions(): SurfaceActionSet {
        return SurfaceActionSet.of([
            new SurfaceAction("Mark done", new EventAddress(new BindingName("tasks"), eventName), {
                taskId: "task-1",
                status: "done"
            })
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
    public constructor(private readonly decision: InvocationDecision = "invoke") {
    }

    public decide(_invocation: Invocation): Promise<InvocationDecision> {
        return Promise.resolve(this.decision);
    }

    public resolve(): never {
        throw new Error("No approval in primitive composition test");
    }

    public record(invocation: Invocation, receipt: InvocationReceipt): Promise<Invocation> {
        return Promise.resolve(invocation.record(receipt));
    }
}

class Recorder implements InvocationRecorder {
    public readonly audits: AuditRecord[] = [];
    public readonly events: EventRecord[] = [];
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

function eventRecord(id: string, payload: TaskUpdateInput): EventRecord {
    return new EventRecord(
        new EventId(id),
        workspaceId,
        eventKind,
        eventSource,
        "workspace",
        payload,
        undefined,
        occurredAt,
        Revision.initial()
    );
}

async function startBindings(bindings: BindingSet): Promise<void> {
    await bindings.facets.start(operationContext("start"));
}

describe("primitive composition", () => {
    test("resolves duplicate operation names through the scoped binding that owns them", async () => {
        const taskHandler = new RecordingTaskHandler("tasks");
        const alternateHandler = new RecordingTaskHandler("alternate-tasks");
        const bindings = BindingSet.of([
            new TaskFacet(facetContext("tasks"), taskHandler),
            new TaskFacet(facetContext("alternate-tasks"), alternateHandler)
        ]);
        await startBindings(bindings);

        const resolved = bindings.operations().resolve(new OperationAddress(new BindingName("tasks"), operationName));
        if (resolved === undefined) {
            throw new Error("Expected tasks operation to resolve");
        }

        const result = await resolved.execute(
            operationContext("resolve", new BindingName("tasks"), bindings.authorityFor(new BindingName("tasks")), bindings),
            { taskId: "task-1", status: "done" }
        );

        expect(result).toEqual({ handledBy: "tasks", taskId: "task-1", status: "done" });
        expect(alternateHandler.inputs).toEqual([]);
        expect(bindings.operations().resolve(new OperationAddress(new BindingName("missing"), operationName))).toBeUndefined();
    });

    test("rejects direct bound operation execution without matching authority", async () => {
        const taskHandler = new RecordingTaskHandler("tasks");
        const bindings = BindingSet.of([new TaskFacet(facetContext("tasks"), taskHandler)]);
        await startBindings(bindings);
        const resolved = bindings.operations().resolve(new OperationAddress(new BindingName("tasks"), operationName));
        if (resolved === undefined) {
            throw new Error("Expected tasks operation to resolve");
        }

        await expect(resolved.execute(operationContext("missing-authority"), {
            taskId: "task-1",
            status: "done"
        })).rejects.toMatchObject(new AgentCoreError("authority.denied", "Operation invocation requires matching Binding authority"));
        expect(taskHandler.inputs).toEqual([]);
    });

    test("rejects invalid operation input before invoking the handler", async () => {
        const taskHandler = new RecordingTaskHandler("tasks");
        const bindings = BindingSet.of([new TaskFacet(facetContext("tasks"), taskHandler)]);
        await startBindings(bindings);
        const resolved = bindings.operations().resolve(new OperationAddress(new BindingName("tasks"), operationName));
        if (resolved === undefined) {
            throw new Error("Expected tasks operation to resolve");
        }

        await expect(resolved.execute(
            operationContext("invalid-input", new BindingName("tasks"), bindings.authorityFor(new BindingName("tasks")), bindings),
            "not-an-object"
        )).rejects.toMatchObject({ code: "operation.invalid-input" });
        expect(taskHandler.inputs).toEqual([]);
    });

    test("rejects previously resolved operation authority after grant revocation", async () => {
        const taskHandler = new RecordingTaskHandler("tasks");
        const bindings = BindingSet.of([new TaskFacet(facetContext("tasks"), taskHandler)]);
        await startBindings(bindings);
        const binding = bindings.resolveBinding(new BindingName("tasks"));
        const resolved = bindings.operations().resolve(new OperationAddress(new BindingName("tasks"), operationName));
        if (binding === undefined || resolved === undefined) {
            throw new Error("Expected tasks binding and operation");
        }
        const revokedBindings = BindingSet.fromBindings([
            new ResolvedBinding(
                new BindingRecord(
                    binding.id,
                    binding.name,
                    binding.grant.id,
                    binding.revision.next()
                ),
                binding.grant.revoke(),
                binding.facet
            )
        ]);

        await expect(resolved.execute(
            operationContext("revoked", new BindingName("tasks"), binding.authority, revokedBindings),
            { taskId: "task-1", status: "done" }
        )).rejects.toMatchObject({ code: "authority.denied" });
        expect(taskHandler.inputs).toEqual([]);
    });

    test("emits a workspace event from a view action without carrying live facet state", async () => {
        const facet = new TaskFacet(facetContext("tasks"), new RecordingTaskHandler("tasks"));
        const surface = facet.surfaces().surfaces[0];
        if (surface === undefined) {
            throw new Error("Expected task surface");
        }

        const view = await surface.render(operationContext("surface"), new ViewRequest());
        const action = view.actions[0];
        if (action === undefined) {
            throw new Error("Expected view action");
        }

        expect(action.event.eventName.equals(eventName)).toBe(true);
        expect(action.payload).toEqual({ taskId: "task-1", status: "done" });
        expect(action.emit({
            id: new EventId("event-task-action"),
            workspaceId,
            source: eventSource,
            visibility: "workspace",
            occurredAt,
            revision: Revision.initial()
        }).kind.equals(eventKind)).toBe(true);
    });

    test("routes a matching subscription event to its target operation once", async () => {
        const taskHandler = new RecordingTaskHandler("tasks");
        const bindings = BindingSet.of([new TaskFacet(facetContext("tasks"), taskHandler)]);
        await startBindings(bindings);
        const recorder = new Recorder();
        const router = new SubscriptionRouter(
            [new Subscription(
                new SubscriptionId("subscription-task-status"),
                workspaceId,
                new EventPattern("tasks.task.*", undefined, "workspace"),
                new OperationAddress(new BindingName("tasks"), operationName),
                "enabled",
                DedupePolicy.event(),
                [new PayloadMapping("taskId", "taskId"), new PayloadMapping("status", "status")],
                Revision.initial()
            )],
            new PipelineSubscriptionInvoker(
                new InvocationPipeline(new Resolver(bindings.operations()), new Mediator(), recorder, new IdFactory()),
                new EventInvocationFactory()
            ),
            new MemorySubscriptionDedupeStore()
        );
        const subscription = new Subscription(
            new SubscriptionId("subscription-task-status"),
            workspaceId,
            new EventPattern("tasks.task.*", undefined, "workspace"),
            new OperationAddress(new BindingName("tasks"), operationName),
            "enabled",
            DedupePolicy.event(),
            [new PayloadMapping("taskId", "taskId"), new PayloadMapping("status", "status")],
            Revision.initial()
        );
        const payload: TaskUpdateInput = { taskId: "task-1", status: "done" };
        const event = eventRecord("event-task-done", payload);

        expect(subscription.matches(event)).toBe(true);
        const route = await router.route(
            operationContext("route", new BindingName("tasks"), bindings.authorityFor(new BindingName("tasks")), bindings),
            event
        );

        expect(route.invocations).toHaveLength(1);
        expect(recorder.receipts.map(receipt => receipt.status)).toEqual(["succeeded"]);
        expect(taskHandler.inputs).toEqual([{ taskId: "task-1", status: "done" }]);
    });

    test("keeps approval-pending subscription attempts as route invocations", async () => {
        const taskHandler = new RecordingTaskHandler("tasks");
        const bindings = BindingSet.of([new TaskFacet(facetContext("tasks"), taskHandler)]);
        await startBindings(bindings);
        const recorder = new Recorder();
        const router = new SubscriptionRouter(
            [new Subscription(
                new SubscriptionId("subscription-task-approval"),
                workspaceId,
                new EventPattern("tasks.task.*", undefined, "workspace"),
                new OperationAddress(new BindingName("tasks"), operationName),
                "enabled",
                DedupePolicy.event(),
                [new PayloadMapping("taskId", "taskId"), new PayloadMapping("status", "status")],
                Revision.initial()
            )],
            new PipelineSubscriptionInvoker(
                new InvocationPipeline(new Resolver(bindings.operations()), new Mediator("request-approval"), recorder, new IdFactory()),
                new EventInvocationFactory()
            ),
            new MemorySubscriptionDedupeStore()
        );

        const route = await router.route(
            operationContext("route-approval", new BindingName("tasks"), bindings.authorityFor(new BindingName("tasks")), bindings),
            eventRecord("event-task-approval", { taskId: "task-1", status: "blocked" })
        );

        expect(route.invocations).toHaveLength(1);
        expect(route.invocations[0]?.receipt).toBeUndefined();
        expect(route.skipped).toEqual([]);
        expect(taskHandler.inputs).toEqual([]);
        expect(recorder.audits.map(record => record.kind)).toEqual(["prepared", "approval-required"]);
    });

    test("runs protected invocations through receipt, audit, and event hooks", async () => {
        const taskHandler = new RecordingTaskHandler("tasks");
        const bindings = BindingSet.of([new TaskFacet(facetContext("tasks"), taskHandler)]);
        await startBindings(bindings);
        const recorder = new Recorder();
        const pipeline = new InvocationPipeline(new Resolver(bindings.operations()), new Mediator(), recorder, new IdFactory());
        const invocation = new Invocation(
            new InvocationId("invocation-task-update"),
            new RunId("run-task-update"),
            0,
            new OperationAddress(new BindingName("tasks"), operationName),
            "mutate",
            digestFacetData({ taskId: "task-approval", status: "blocked" }),
            new ContentRef("content:task-update"),
            "task-update:idempotency",
            "prepared",
            undefined,
            new InvocationMetadata(undefined, workspaceId, undefined, undefined, undefined, undefined)
        );

        const result = await pipeline.invoke(
            operationContext("invoke", new BindingName("tasks"), bindings.authorityFor(new BindingName("tasks")), bindings),
            invocation,
            {
                taskId: "task-approval",
                status: "blocked"
            }
        );

        expect(result.kind).toBe("completed");
        expect(recorder.receipts.map(receipt => receipt.status)).toEqual(["succeeded"]);
        expect(recorder.audits.map(record => record.kind)).toEqual(["prepared", "started", "succeeded"]);
        expect(recorder.events.map(event => event.kind.value)).toEqual(["invocation.prepared", "invocation.completed"]);
    });
});
