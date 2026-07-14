import { RunId } from "../../../src/agents";
import { JsonSchema } from "../../../src/core";
import {
    TASK_ACTION_EVENT,
    TASK_ACTION_SUBSCRIPTION,
    TASK_BOARD_SURFACE,
    TASK_CONTRIBUTIONS,
    TASK_OPERATIONS,
    TASK_OPERATION_CONTRACTS,
    TaskBackend,
    TaskEntry,
    TaskFacet,
    TaskId
} from "../../../src/facets";
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
