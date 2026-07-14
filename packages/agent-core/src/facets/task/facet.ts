import type { JsonValue } from "../../core";
import { RunId } from "../../execution-references";
import {
    Contributions,
    Contribution,
    OperationDescriptor,
    SurfaceDescriptor
} from "../contribution";
import { canonicalFacetData } from "../data";
import type { FacetData } from "../data";
import { requireArray, requireDataObject, requireString } from "../data";
import { EventDeclaration, EventPattern } from "../event";
import { EventKind, OperationName, SlotName, SurfaceId } from "../id";
import type { FacetManifest } from "../manifest";
import {
    DetailedProfileError,
    InternalProfileFacetRuntime,
    ProfileControlContract,
    ProfileEventContract,
    ProfileOperationContract,
    profileWireCodec,
    type ProtectedProfileRuntimePort,
    type PublicProfileInput,
    schema,
    strictObjectSchema,
    voidProfileWireCodec
} from "../profile-runtime";
import { TaskId } from "./id";

export interface TaskActionSubmitted extends PublicProfileInput {
    readonly kind: "task.actionSubmitted";
    readonly taskId: TaskId;
    readonly action: JsonValue;
}

export interface TaskUpdate {
    readonly parentId?: TaskId | null;
    readonly runId?: RunId | null;
    readonly attributes?: JsonValue;
}

export interface TaskCreateInput extends PublicProfileInput {
    readonly task: TaskEntry;
}

export interface TaskUpdateInput extends PublicProfileInput {
    readonly id: TaskId;
    readonly update: TaskUpdate;
}

export interface TaskListInput extends PublicProfileInput {}

export interface TaskActionInput extends PublicProfileInput {
    readonly taskId: TaskId;
    readonly action: JsonValue;
}

export class TaskEntry {
    public readonly attributes: JsonValue;

    public constructor(
        public readonly id: TaskId,
        public readonly parentId: TaskId | undefined,
        public readonly runId: RunId | undefined,
        attributes: JsonValue
    ) {
        if (!(id instanceof TaskId) || (parentId !== undefined && !(parentId instanceof TaskId))) {
            throw new TypeError("Task identifiers must use their context-owned classes");
        }
        if (id.value.trim().length === 0 || id.value !== id.value.trim()) {
            throw new TypeError("Task ID must be canonical");
        }
        if (parentId?.equals(id)) throw new TypeError("A task cannot be its own parent");
        this.attributes = canonicalFacetData(attributes);
        Object.freeze(this);
    }

    public revise(update: TaskUpdate): TaskEntry {
        return new TaskEntry(
            this.id,
            update.parentId === undefined ? this.parentId : (update.parentId ?? undefined),
            update.runId === undefined ? this.runId : (update.runId ?? undefined),
            update.attributes === undefined ? this.attributes : update.attributes
        );
    }
}

const idProperty = { type: "string", minLength: 1 } as const;
const taskSchema = schema({
    type: "object",
    properties: {
        id: idProperty,
        parentId: { type: ["string", "null"] },
        runId: { type: ["string", "null"] },
        attributes: {}
    },
    required: ["id", "attributes"],
    additionalProperties: false
});
const updateSchema = {
    type: "object",
    properties: {
        parentId: { type: ["string", "null"] },
        runId: { type: ["string", "null"] },
        attributes: {}
    },
    additionalProperties: false
} as const;
const taskEntryCodec = profileWireCodec<TaskEntry>(
    (task) => ({
        id: task.id.value,
        parentId: task.parentId?.value ?? null,
        runId: task.runId?.value ?? null,
        attributes: task.attributes
    }),
    decodeTaskEntry
);

export const TASK_OPERATION_CONTRACTS = Object.freeze({
    create: new ProfileOperationContract<"create", TaskCreateInput, void>(
        "create",
        new OperationDescriptor(
            new OperationName("create"),
            "mutate",
            strictObjectSchema({ task: taskSchema.document }, ["task"]),
            schema({ type: "null" })
        ),
        profileWireCodec(
            (input) => ({ task: taskEntryCodec.encode(input.task) }),
            (data) => ({
                task: decodeTaskEntry(requireDataObject(data, "Task create input")["task"]!)
            })
        ),
        voidProfileWireCodec,
        "output"
    ),
    update: new ProfileOperationContract<"update", TaskUpdateInput, TaskEntry>(
        "update",
        new OperationDescriptor(
            new OperationName("update"),
            "mutate",
            strictObjectSchema({ id: idProperty, update: updateSchema }, ["id", "update"]),
            taskSchema
        ),
        profileWireCodec(
            (input) => ({ id: input.id.value, update: encodeTaskUpdate(input.update) }),
            (data) => {
                const object = requireDataObject(data, "Task update input");
                return {
                    id: new TaskId(requireString(object["id"], "Task ID")),
                    update: decodeTaskUpdate(object["update"]!)
                };
            }
        ),
        taskEntryCodec,
        "output"
    ),
    list: new ProfileOperationContract<"list", TaskListInput, readonly TaskEntry[]>(
        "list",
        new OperationDescriptor(
            new OperationName("list"),
            "observe",
            strictObjectSchema({}),
            schema({ type: "array", items: taskSchema.document })
        ),
        profileWireCodec(
            () => ({}),
            (data) => {
                requireDataObject(data, "Task list input");
                return {};
            }
        ),
        profileWireCodec(
            (tasks) => tasks.map((task) => taskEntryCodec.encode(task)),
            (data) => Object.freeze(requireArray(data, "Task list output").map(decodeTaskEntry))
        ),
        "output"
    )
});

export const TASK_OPERATIONS: readonly OperationDescriptor[] = Object.freeze(
    Object.values(TASK_OPERATION_CONTRACTS).map((contract) => contract.descriptor)
);

export const TASK_BOARD_SURFACE = new SurfaceDescriptor(
    new SurfaceId("task.board"),
    "Tasks",
    "Renders the task hierarchy and submits task actions."
);

export const TASK_ACTION_EVENT = new EventDeclaration(
    new EventKind("task.actionSubmitted"),
    "A task-board action was submitted.",
    strictObjectSchema({ taskId: idProperty, action: {} }, ["taskId", "action"]),
    "workspace"
);

export const TASK_ACTION_EVENT_CONTRACT = new ProfileEventContract<
    "task.actionSubmitted",
    TaskActionSubmitted
>(
    "task.actionSubmitted",
    TASK_ACTION_EVENT,
    profileWireCodec(
        (event) => ({ taskId: event.taskId.value, action: event.action }),
        (data) => {
            const object = requireDataObject(data, "Task action Event");
            return {
                kind: "task.actionSubmitted",
                taskId: new TaskId(requireString(object["taskId"], "Task action ID")),
                action: object["action"]!
            };
        }
    )
);
export const TASK_ACTION_CONTROL = new ProfileControlContract<
    "task.submitAction",
    TaskActionInput,
    void
>(
    "task.submitAction",
    TASK_ACTION_EVENT.payload,
    schema({ type: "null" }),
    profileWireCodec(
        (input) => ({ taskId: input.taskId.value, action: input.action }),
        (data) => {
            const object = requireDataObject(data, "Task action input");
            return {
                taskId: new TaskId(requireString(object["taskId"], "Task action ID")),
                action: object["action"]!
            };
        }
    ),
    voidProfileWireCodec
);

export const TASK_ACTION_SOURCE_OPERATION = new ProfileOperationContract<
    "task.submitAction",
    TaskActionInput,
    void
>(
    "task.submitAction",
    new OperationDescriptor(
        new OperationName("task.submitAction"),
        "mutate",
        TASK_ACTION_EVENT.payload,
        schema({ type: "null" })
    ),
    TASK_ACTION_CONTROL.inputCodec,
    voidProfileWireCodec,
    "output"
);

export const TASK_ACTION_SUBSCRIPTION = Object.freeze({
    source: new EventPattern("task.actionSubmitted", ["owner", "authenticated", "self"]),
    target: new OperationName("update")
});

export const TASK_CONTRIBUTIONS = new Contributions([
    new Contribution(
        new SlotName("operations"),
        TASK_OPERATIONS.map((operation) => operation.toData())
    ),
    new Contribution(new SlotName("surfaces"), [TASK_BOARD_SURFACE.toData()]),
    new Contribution(new SlotName("events"), [TASK_ACTION_EVENT.toData()])
]);

export class TaskBackend {
    readonly #tasks = new Map<string, TaskEntry>();

    public create(task: TaskEntry): void {
        if (this.#tasks.has(task.id.value))
            throw new TaskError("task.exists", "Task ID already exists");
        const candidate = new Map(this.#tasks).set(task.id.value, task);
        validateTaskHierarchy(candidate);
        this.#tasks.set(task.id.value, task);
    }

    public update(id: TaskId, update: TaskUpdate): TaskEntry {
        const current = this.#tasks.get(id.value);
        if (current === undefined) throw new TaskError("task.not-found", "Task does not exist");
        const revised = current.revise(update);
        const candidate = new Map(this.#tasks).set(id.value, revised);
        validateTaskHierarchy(candidate);
        this.#tasks.set(id.value, revised);
        return revised;
    }

    public list(): readonly TaskEntry[] {
        return Object.freeze(
            [...this.#tasks.values()].sort((left, right) =>
                left.id.value.localeCompare(right.id.value)
            )
        );
    }

    public assertExists(id: TaskId): void {
        if (!this.#tasks.has(id.value))
            throw new TaskError("task.not-found", "Task does not exist");
    }
}

export class TaskFacet<Receipt> {
    public static readonly operations = TASK_OPERATIONS;
    public static readonly surface = TASK_BOARD_SURFACE;
    public static readonly events = Object.freeze([TASK_ACTION_EVENT]);
    public static readonly subscriptions = Object.freeze([TASK_ACTION_SUBSCRIPTION]);

    public constructor(
        private readonly runtime: ProtectedProfileRuntimePort<Receipt>,
        private readonly backend: TaskBackend
    ) {}

    public asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime {
        return new InternalProfileFacetRuntime({
            manifest,
            runtime: this.runtime,
            operations: [
                this.runtime.operation(TASK_OPERATION_CONTRACTS.create, (input) =>
                    this.backend.create(input.task)
                ),
                this.runtime.operation(TASK_OPERATION_CONTRACTS.update, (input) =>
                    this.backend.update(input.id, input.update)
                ),
                this.runtime.operation(TASK_OPERATION_CONTRACTS.list, () => this.backend.list())
            ],
            surfaces: [this.runtime.surface(TASK_BOARD_SURFACE)]
        });
    }

    public create(input: TaskCreateInput): Promise<void> {
        return this.runtime.invoke(TASK_OPERATION_CONTRACTS.create, input, (admitted) =>
            this.backend.create(admitted.task)
        );
    }

    public update(input: TaskUpdateInput): Promise<TaskEntry> {
        return this.runtime.invoke(TASK_OPERATION_CONTRACTS.update, input, (admitted) =>
            this.backend.update(admitted.id, admitted.update)
        );
    }

    public list(input: TaskListInput = {}): Promise<readonly TaskEntry[]> {
        return this.runtime.invoke(TASK_OPERATION_CONTRACTS.list, input, () => this.backend.list());
    }

    public submitAction(input: TaskActionInput): Promise<void> {
        return this.runtime.control(TASK_ACTION_CONTROL, input, async (admitted) => {
            const source = await this.runtime.invokeWithReceipt(
                TASK_ACTION_SOURCE_OPERATION,
                admitted,
                (sourceInput) => this.backend.assertExists(sourceInput.taskId)
            );
            await this.runtime.emit<"task.actionSubmitted", TaskActionSubmitted>(
                TASK_ACTION_EVENT_CONTRACT,
                Object.freeze({
                    kind: "task.actionSubmitted",
                    taskId: admitted.taskId,
                    action: canonicalFacetData(admitted.action)
                }),
                source.receipt
            );
        });
    }
}

export type TaskErrorCode = "task.exists" | "task.not-found" | "task.parent" | "task.cycle";

export class TaskError extends DetailedProfileError<TaskErrorCode> {
    public constructor(detailCode: TaskErrorCode, message: string) {
        super("operation.invalid-input", detailCode, message);
        this.name = "TaskError";
    }
}

export function validateTaskHierarchy(tasks: ReadonlyMap<string, TaskEntry>): void {
    for (const task of tasks.values()) {
        const visited = new Set<string>([task.id.value]);
        let parentId = task.parentId;
        while (parentId !== undefined) {
            if (visited.has(parentId.value))
                throw new TaskError("task.cycle", "Task hierarchy must be acyclic");
            visited.add(parentId.value);
            const parent = tasks.get(parentId.value);
            if (parent === undefined) throw new TaskError("task.parent", "Task parent must exist");
            parentId = parent.parentId;
        }
    }
}

function encodeTaskUpdate(update: TaskUpdate): FacetData {
    return {
        ...(update.parentId === undefined ? {} : { parentId: update.parentId?.value ?? null }),
        ...(update.runId === undefined ? {} : { runId: update.runId?.value ?? null }),
        ...(update.attributes === undefined ? {} : { attributes: update.attributes })
    };
}

function decodeTaskUpdate(data: FacetData): TaskUpdate {
    const object = requireDataObject(data, "Task update");
    const parentId = object["parentId"];
    const runId = object["runId"];
    return {
        ...(parentId === undefined
            ? {}
            : {
                  parentId:
                      parentId === null
                          ? null
                          : new TaskId(requireString(parentId, "Task parent ID"))
              }),
        ...(runId === undefined
            ? {}
            : {
                  runId: runId === null ? null : new RunId(requireString(runId, "Task Run ID"))
              }),
        ...(object["attributes"] === undefined ? {} : { attributes: object["attributes"] })
    };
}

function decodeTaskEntry(data: FacetData): TaskEntry {
    const object = requireDataObject(data, "Task entry");
    const parentId = object["parentId"];
    const runId = object["runId"];
    return new TaskEntry(
        new TaskId(requireString(object["id"], "Task ID")),
        parentId === null ? undefined : new TaskId(requireString(parentId, "Task parent ID")),
        runId === null ? undefined : new RunId(requireString(runId, "Task Run ID")),
        object["attributes"]!
    );
}
