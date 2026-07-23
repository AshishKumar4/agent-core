import { RunId } from "../../../src/agents";
import { MemoryContentStore } from "../../../src/content";
import { CompatRange, JsonSchema, SemVer, type JsonValue } from "../../../src/core";
import {
    FacetPackageId,
    OperationName,
    TASK_ACTION_CONTROL,
    TASK_ACTION_EVENT,
    TASK_ACTION_EVENT_CONTRACT,
    TASK_ACTION_SUBSCRIPTION,
    TASK_BOARD_SURFACE,
    TASK_CONTRIBUTIONS,
    TASK_OPERATIONS,
    TASK_OPERATION_CONTRACTS,
    TaskBackend,
    TaskEntry,
    TaskFacet,
    TaskId,
    createTaskManifest,
    type FacetManifest,
    type InternalProfileFacetRuntime,
    type OperationContext
} from "../../../src/facets";
import { InvocationId } from "../../../src/invocations";
import { describe, expect, test } from "vitest";
import { denyingRuntime, operationDeclarationEvidence, recordingRuntime } from "./harness";

operationDeclarationEvidence("Task", TASK_OPERATIONS, {
    create: "mutate",
    update: "mutate",
    list: "observe"
});

describe("Task protected facade", () => {
    test("[P11-TASK-COMPOSITION] routes three Operations through invoke and task actions only through emit", async () => {
        const { runtime, admission } = recordingRuntime("task");
        const task = new TaskFacet(runtime, new TaskBackend());
        await task.create({
            task: new TaskEntry(taskId("parent"), undefined, undefined, { title: "Parent" })
        });
        await task.create({
            task: new TaskEntry(taskId("child"), taskId("parent"), new RunId("run-1"), {
                title: "Child"
            })
        });
        await task.update({ id: taskId("child"), update: { attributes: { title: "Revised" } } });
        await expect(task.list()).resolves.toHaveLength(2);
        await task.submitAction({ taskId: taskId("child"), action: { action: "complete" } });

        expect(admission.calls.map((call) => [call.kind, call.name])).toEqual([
            ["invoke", "create"],
            ["invoke", "create"],
            ["invoke", "update"],
            ["invoke", "list"],
            ["control", "task.submitAction"],
            ["invoke", "task.submitAction"],
            ["emit", "task.actionSubmitted"]
        ]);
        expect(admission.calls.at(-1)?.input).toEqual({
            taskId: "child",
            action: { action: "complete" }
        });
    });

    test("submitAction verifies the task exists before any Event is emitted", { tags: "p1" }, async () => {
        const { runtime, admission } = recordingRuntime("task-missing-action");
        const task = new TaskFacet(runtime, new TaskBackend());
        await expect(
            task.submitAction({ taskId: taskId("missing"), action: {} })
        ).rejects.toMatchObject({ detailCode: "task.not-found" });
        expect(admission.calls.some((call) => call.kind === "emit")).toBe(false);
    });

    test("internal runtime routes create, update, and list to the backend", { tags: "p1" }, async () => {
        const { runtime } = recordingRuntime("task");
        const backend = new TaskBackend();
        const internal = new TaskFacet(runtime, backend).asInternalRuntime(taskManifest());
        await internal.start({ signal: new AbortController().signal });
        expect(internal.active).toBe(true);

        const context = internalContext();
        await expect(
            execute(internal, "create", {
                task: { id: "task", parentId: null, runId: null, attributes: {} }
            }, context)
        ).resolves.toBeNull();
        await expect(
            execute(internal, "update", {
                id: "task",
                update: { attributes: { done: true } }
            }, context)
        ).resolves.toEqual({ id: "task", parentId: null, runId: null, attributes: { done: true } });
        await expect(execute(internal, "list", {}, context)).resolves.toEqual([
            { id: "task", parentId: null, runId: null, attributes: { done: true } }
        ]);
        expect(backend.list()).toHaveLength(1);
    });

    test("denial prevents task mutation and Event delivery", async () => {
        const backend = new TaskBackend();
        const task = new TaskFacet(denyingRuntime("task").runtime, backend);
        await expect(
            task.create({ task: new TaskEntry(taskId("denied"), undefined, undefined, {}) })
        ).rejects.toMatchObject({ code: "authority.denied" });
        expect(backend.list()).toEqual([]);

        backend.create(new TaskEntry(taskId("existing"), undefined, undefined, {}));
        await expect(
            task.submitAction({ taskId: taskId("existing"), action: {} })
        ).rejects.toMatchObject({ code: "authority.denied" });
    });
});

describe("Task declarations and backend", () => {
    test("[P11-TASK-PRODUCT-LIFECYCLE] exercises a product-defined status lifecycle in its Task schema", () => {
        const productTask = new JsonSchema({
            type: "object",
            properties: {
                id: { type: "string", minLength: 1 },
                attributes: {
                    type: "object",
                    properties: { status: { enum: ["planned", "active", "done"] } },
                    required: ["status"],
                    additionalProperties: false
                }
            },
            required: ["id", "attributes"],
            additionalProperties: false
        });
        const backend = new TaskBackend();
        const task = new TaskEntry(taskId("product"), undefined, undefined, { status: "planned" });
        expect(productTask.accepts({ id: task.id.value, attributes: task.attributes })).toBe(true);
        backend.create(task);
        const active = backend.update(task.id, { attributes: { status: "active" } });
        const done = backend.update(task.id, { attributes: { status: "done" } });
        expect(
            [active, done].every((entry) =>
                productTask.accepts({ id: entry.id.value, attributes: entry.attributes })
            )
        ).toBe(true);
        expect(productTask.accepts({ id: task.id.value, attributes: { status: "unknown" } })).toBe(
            false
        );
    });

    test("declares the board, Event, subscription, and manifest contributions", () => {
        expect(TASK_BOARD_SURFACE.id.value).toBe("task.board");
        expect(TASK_ACTION_EVENT.kind.value).toBe("task.actionSubmitted");
        expect(TASK_ACTION_SUBSCRIPTION.target.value).toBe("update");
        expect(TASK_CONTRIBUTIONS.entries.map((entry) => entry.slot.value)).toEqual([
            "events",
            "operations",
            "surfaces"
        ]);
    });

    test("[P11-TASK-CYCLE-REJECTION] rejects hierarchy cycles without changing the task", () => {
        const backend = new TaskBackend();
        backend.create(new TaskEntry(taskId("parent"), undefined, undefined, {}));
        backend.create(new TaskEntry(taskId("child"), taskId("parent"), undefined, {}));
        expect(() => backend.update(taskId("parent"), { parentId: taskId("child") })).toThrow(
            expect.objectContaining({ detailCode: "task.cycle" })
        );
        expect(
            backend.list().find((task) => task.id.equals(taskId("parent")))?.parentId
        ).toBeUndefined();
    });

    test("[P11-TASK-HIERARCHY] validates task identity, parents, duplicates, and missing targets", () => {
        expect(() => new TaskEntry(new TaskId(" "), undefined, undefined, {})).toThrow(TypeError);
        expect(() => new TaskEntry(taskId("self"), taskId("self"), undefined, {})).toThrow(
            TypeError
        );

        const backend = new TaskBackend();
        const root = new TaskEntry(taskId("root"), undefined, new RunId("run-root"), {});
        backend.create(root);
        expect(() => backend.create(root)).toThrow(
            expect.objectContaining({ detailCode: "task.exists" })
        );
        expect(() =>
            backend.create(new TaskEntry(taskId("orphan"), taskId("missing"), undefined, {}))
        ).toThrow(expect.objectContaining({ detailCode: "task.parent" }));
        expect(() => backend.update(taskId("missing"), {})).toThrow(
            expect.objectContaining({ detailCode: "task.not-found" })
        );
        expect(() => backend.assertExists(taskId("missing"))).toThrow(
            expect.objectContaining({ detailCode: "task.not-found" })
        );

        const cleared = backend.update(taskId("root"), {
            parentId: null,
            runId: null,
            attributes: { done: true }
        });
        expect(cleared).toMatchObject({
            parentId: undefined,
            runId: undefined,
            attributes: { done: true }
        });
    });

    test("enforces context-owned task identifier classes", { tags: "p1" }, () => {
        const alienId: TaskId = new RunId("alien");
        expect(() => new TaskEntry(alienId, undefined, undefined, {})).toThrow(
            "Task identifiers must use their context-owned classes"
        );
        const alienParent: TaskId = new RunId("parent");
        expect(() => new TaskEntry(taskId("child"), alienParent, undefined, {})).toThrow(
            "Task identifiers must use their context-owned classes"
        );
        expect(() => new TaskEntry(new TaskId(" x"), undefined, undefined, {})).toThrow(
            "Task ID must be canonical"
        );
    });

    test("preserves parent and Run links when an update omits them", { tags: "p1" }, () => {
        const backend = new TaskBackend();
        backend.create(new TaskEntry(taskId("parent"), undefined, undefined, {}));
        backend.create(new TaskEntry(taskId("child"), taskId("parent"), new RunId("run-1"), {}));
        const revised = backend.update(taskId("child"), { attributes: { touched: true } });
        expect(revised.parentId?.equals(taskId("parent"))).toBe(true);
        expect(revised.runId?.equals(new RunId("run-1"))).toBe(true);
        expect(revised.attributes).toEqual({ touched: true });
    });

    test("lists tasks sorted by ID regardless of creation order", { tags: "p1" }, () => {
        const backend = new TaskBackend();
        backend.create(new TaskEntry(taskId("b"), undefined, undefined, {}));
        backend.create(new TaskEntry(taskId("a"), undefined, undefined, {}));
        backend.create(new TaskEntry(taskId("c"), undefined, undefined, {}));
        expect(backend.list().map((task) => task.id.value)).toEqual(["a", "b", "c"]);
    });

    test("raises typed TaskErrors with exact codes and messages", { tags: "p1" }, () => {
        const backend = new TaskBackend();
        backend.create(new TaskEntry(taskId("only"), undefined, undefined, {}));
        expectTaskError(
            () => backend.create(new TaskEntry(taskId("only"), undefined, undefined, {})),
            "task.exists",
            "Task ID already exists"
        );
        expectTaskError(
            () => backend.update(taskId("missing"), {}),
            "task.not-found",
            "Task does not exist"
        );
        expectTaskError(
            () => backend.assertExists(taskId("missing")),
            "task.not-found",
            "Task does not exist"
        );
        expectTaskError(
            () => backend.create(new TaskEntry(taskId("orphan"), taskId("missing"), undefined, {})),
            "task.parent",
            "Task parent must exist"
        );
        backend.create(new TaskEntry(taskId("child"), taskId("only"), undefined, {}));
        expectTaskError(
            () => backend.update(taskId("only"), { parentId: taskId("child") }),
            "task.cycle",
            "Task hierarchy must be acyclic"
        );
    });

    test("decodes wire task payloads to context-owned identifiers", { tags: "p1" }, () => {
        const created = TASK_OPERATION_CONTRACTS.create.decodeInput({
            task: { id: "child", parentId: "parent", runId: "run-1", attributes: { a: 1 } }
        });
        expect(created.task.id.value).toBe("child");
        expect(created.task.parentId?.value).toBe("parent");
        expect(created.task.runId?.value).toBe("run-1");
        expect(created.task.attributes).toEqual({ a: 1 });

        const updated = TASK_OPERATION_CONTRACTS.update.decodeInput({ id: "task", update: {} });
        expect(updated.id.value).toBe("task");
        expect(Object.keys(updated.update)).toEqual([]);

        expect(TASK_OPERATION_CONTRACTS.list.decodeInput({})).toEqual({});

        const action = TASK_ACTION_EVENT_CONTRACT.decodePayload({
            taskId: "task",
            action: { move: "done" }
        });
        expect(action.kind).toBe("task.actionSubmitted");
        expect(action.taskId.value).toBe("task");
        expect(action.action).toEqual({ move: "done" });

        const control = TASK_ACTION_CONTROL.decodeInput({ taskId: "task", action: 1 });
        expect(control.taskId.value).toBe("task");
        expect(control.action).toBe(1);
    });

    test("names the offending field when task wire data is malformed", { tags: "p2" }, () => {
        expect(() =>
            TASK_OPERATION_CONTRACTS.update.decodeInput({ id: 5, update: {} })
        ).toThrow("Task ID must be a string");
        expect(() =>
            TASK_OPERATION_CONTRACTS.create.decodeInput({
                task: { id: 5, parentId: null, runId: null, attributes: {} }
            })
        ).toThrow("Task ID must be a string");
        expect(() => TASK_ACTION_EVENT_CONTRACT.decodePayload(null)).toThrow(
            "Task action Event must be an object"
        );
        expect(() =>
            TASK_ACTION_EVENT_CONTRACT.decodePayload({ taskId: 5, action: null })
        ).toThrow("Task action ID must be a string");
        expect(() => TASK_ACTION_CONTROL.decodeInput({ taskId: 5, action: null })).toThrow(
            "Task action ID must be a string"
        );
        expect(() => new TaskId("")).toThrow("Task ID must contain between 1 and 256 characters");
    });

    test("round-trips absent, concrete, and cleared optional task updates", () => {
        const contract = TASK_OPERATION_CONTRACTS.update;
        expect(
            contract.decodeInput(contract.encodeInput({ id: taskId("task"), update: {} }))
        ).toEqual({ id: taskId("task"), update: {} });
        expect(
            contract.decodeInput(
                contract.encodeInput({
                    id: taskId("task"),
                    update: {
                        parentId: taskId("parent"),
                        runId: new RunId("run-updated"),
                        attributes: { status: "active" }
                    }
                })
            )
        ).toEqual({
            id: taskId("task"),
            update: {
                parentId: taskId("parent"),
                runId: new RunId("run-updated"),
                attributes: { status: "active" }
            }
        });
        expect(
            contract.decodeInput(
                contract.encodeInput({
                    id: taskId("task"),
                    update: { parentId: null, runId: null }
                })
            )
        ).toEqual({ id: taskId("task"), update: { parentId: null, runId: null } });
    });
});

function taskId(value: string): TaskId {
    return new TaskId(value);
}

function expectTaskError(
    action: () => unknown,
    detailCode: string,
    message: string
): void {
    expect(action).toThrow(
        expect.objectContaining({
            name: "TaskError",
            code: "operation.invalid-input",
            detailCode,
            message
        })
    );
}

function taskManifest(): FacetManifest {
    return createTaskManifest({
        id: new FacetPackageId("profile.task"),
        version: new SemVer("1.0.0"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        bindings: []
    });
}

function internalContext(): OperationContext {
    return Object.freeze({
        invocation: new InvocationId("internal-invocation"),
        itemIndex: 0,
        idempotencyKey: "internal-idempotency",
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    });
}

function execute(
    internal: InternalProfileFacetRuntime,
    name: string,
    input: JsonValue,
    context: OperationContext
): Promise<JsonValue> {
    const operation = internal.operation(new OperationName(name));
    if (operation === undefined) throw new TypeError(`Missing internal Operation ${name}`);
    return operation.execute(context, input);
}
