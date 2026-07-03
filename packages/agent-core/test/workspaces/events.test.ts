import { describe, expect, test } from "vitest";
import { BindingName, FacetOperationName, OperationAddress } from "../../src/facets";
import { OperationId } from "../../src/operations";
import { Revision } from "../../src/record";
import {
    DedupePolicy,
    EventCausation,
    EventId,
    EventKind,
    EventPattern,
    EventRecord,
    EventSource,
    PayloadMapping,
    Subscription,
    SubscriptionId,
    WorkspaceId,
    type SubscriptionStatus
} from "../../src/workspaces";

const workspaceId = new WorkspaceId("workspace-events");
const eventSource = new EventSource("task-service");
const occurredAt = new Date("2026-06-30T12:00:00.000Z");

function operationAddress(name: string): OperationAddress {
    return new OperationAddress(new BindingName("tasks"), new FacetOperationName(name));
}

function eventRecord(kind: string = "task.created", source: EventSource = eventSource): EventRecord {
    return new EventRecord(
        new EventId(`event-${kind.replaceAll(".", "-")}`),
        workspaceId,
        new EventKind(kind),
        source,
        "workspace",
        { taskId: "task-1" },
        undefined,
        occurredAt,
        Revision.initial()
    );
}

function subscription(
    operation: OperationAddress,
    status: SubscriptionStatus = "enabled"
): Subscription {
    return new Subscription(
        new SubscriptionId("subscription-task-created"),
        workspaceId,
        new EventPattern("task.*", undefined, "workspace"),
        operation,
        status,
        DedupePolicy.event(),
        [new PayloadMapping("taskId", "input.taskId")],
        Revision.initial()
    );
}

describe("Workspace events", () => {
    test("validates event records and related value objects", () => {
        const causation = new EventCausation(new EventId("event-parent"), new OperationId("operation-parent"));
        const record = new EventRecord(
            new EventId("event-created"),
            workspaceId,
            new EventKind("task.created"),
            eventSource,
            "workspace",
            { taskId: "task-1", labels: ["urgent"] },
            causation,
            occurredAt,
            Revision.initial()
        );

        expect(record.kind.value).toBe("task.created");
        expect(record.source.equals(eventSource)).toBe(true);
        expect(record.causation).toBe(causation);
        expect(() => new EventKind("task..created")).toThrow(TypeError);
        expect(() => new EventKind("task.*")).toThrow(TypeError);
        expect(() => new EventCausation(undefined, undefined)).toThrow(TypeError);
        expect(() => new EventRecord(
            new EventId("event-invalid-date"),
            workspaceId,
            new EventKind("task.created"),
            eventSource,
            "workspace",
            {},
            undefined,
            new Date("invalid"),
            Revision.initial()
        )).toThrow(TypeError);
    });

    test("matches and misses event patterns deterministically", () => {
        const record = eventRecord();

        expect(new EventPattern("task.*", eventSource, "workspace").matches(record)).toBe(true);
        expect(EventPattern.forKind(new EventKind("task.created")).matches(record)).toBe(true);
        expect(EventPattern.all().matches(record)).toBe(true);
        expect(new EventPattern("conversation.*", eventSource, "workspace").matches(record)).toBe(false);
        expect(new EventPattern("task.*", new EventSource("other-service"), "workspace").matches(record)).toBe(false);
        expect(new EventPattern("task.*", eventSource, "private").matches(record)).toBe(false);
    });

    test("preserves the target operation across subscription transitions", () => {
        const targetOperation = operationAddress("target");
        const active = subscription(targetOperation);
        const disabled = active.disable();
        const reenabled = disabled.enable();

        expect(active.operation).toBe(targetOperation);
        expect(disabled.operation).toBe(targetOperation);
        expect(reenabled.operation).toBe(targetOperation);
        expect(active.matches(eventRecord())).toBe(true);
        expect(disabled.matches(eventRecord())).toBe(false);
        expect(active.matches(new EventRecord(
            new EventId("event-foreign-workspace"),
            new WorkspaceId("workspace-foreign"),
            new EventKind("task.created"),
            eventSource,
            "workspace",
            { taskId: "task-1" },
            undefined,
            occurredAt,
            Revision.initial()
        ))).toBe(false);
    });

    test("supports enable, disable, and remove lifecycle transitions", () => {
        const active = subscription(operationAddress("lifecycle"));
        const disabled = active.disable();
        const reenabled = disabled.enable();
        const removed = reenabled.remove();

        expect(disabled.status).toBe("disabled");
        expect(disabled.enabled).toBe(false);
        expect(disabled.revision.value).toBe(1);
        expect(reenabled.status).toBe("enabled");
        expect(reenabled.revision.value).toBe(2);
        expect(removed.status).toBe("removed");
        expect(removed.enabled).toBe(false);
        expect(removed.revision.value).toBe(3);
        expect(removed.remove()).toBe(removed);
        expect(() => removed.enable()).toThrow(TypeError);
    });

    test("models supported dedupe policy values", () => {
        const none = DedupePolicy.none();
        const event = DedupePolicy.event();
        const causation = DedupePolicy.causation();
        const payload = DedupePolicy.payload("taskId");

        expect(none.value).toBe("none");
        expect(none.enabled).toBe(false);
        expect(event.value).toBe("event");
        expect(event.enabled).toBe(true);
        expect(causation.value).toBe("causation");
        expect(causation.enabled).toBe(true);
        expect(payload.value).toBe("payload");
        expect(payload.payloadPath).toBe("taskId");
        expect(() => DedupePolicy.payload("")).toThrow(TypeError);
        expect(() => new DedupePolicy("event", "taskId")).toThrow(TypeError);
    });

    test("builds type-preserving payload dedupe keys", () => {
        const deduped = new Subscription(
            new SubscriptionId("subscription-payload-dedupe"),
            workspaceId,
            EventPattern.all(),
            operationAddress("dedupe"),
            "enabled",
            DedupePolicy.payload("items"),
            [],
            Revision.initial()
        );
        const stringWithDelimiter = new EventRecord(
            new EventId("event-string-with-delimiter"),
            workspaceId,
            new EventKind("task.updated"),
            eventSource,
            "workspace",
            { items: ["a,b"] },
            undefined,
            occurredAt,
            Revision.initial()
        );
        const separateStrings = new EventRecord(
            new EventId("event-separate-strings"),
            workspaceId,
            new EventKind("task.updated"),
            eventSource,
            "workspace",
            { items: ["a", "b"] },
            undefined,
            occurredAt,
            Revision.initial()
        );

        expect(deduped.dedupeKey(stringWithDelimiter))
            .not.toBe(deduped.dedupeKey(separateStrings));
    });
});
