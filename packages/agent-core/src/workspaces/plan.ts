import {
    RecordCodec,
    Revision,
    TextId,
    compareCanonicalText,
    type JsonValue,
    type RecordVersion
} from "../core";
import { AgentCoreError } from "../errors";
import { TurnId } from "../execution-references";
import { SurfaceId, TaskId } from "../facets";
import { requireFields, requireObject, requireString, type JsonObject } from "./codec";
import { EventCursor } from "./id";
import { ActionDescriptor, View } from "./view";

/**
 * SPEC §6.4. A plan is not a fourth kind of state: it is a left fold over Workspace Events
 * (§6.1) whose result renders as an ordinary §6.3 View. Three changes and no fourth — a task
 * enters the plan, a dependency is declared, a declared dependency is retracted — and each
 * change owns its own fold step, so admission and replay are one function rather than two
 * predicates that can disagree (C13-PLAN-ACYCLIC).
 */
export type PlanFactKind =
    | "plan.taskDeclared"
    | "plan.dependencyDeclared"
    | "plan.dependencyRetracted";

export interface PlanEdge {
    readonly blocked: TaskId;
    readonly blockedBy: TaskId;
}

/** One folded fact together with the Event-log position it was read at. */
export interface PlanEntry {
    readonly fact: PlanFact;
    readonly cursor: EventCursor;
}

export abstract class PlanChange {
    public static declaredTask(task: TaskId): PlanChange {
        return new TaskDeclaration(task);
    }

    public static declaredDependency(blocked: TaskId, blockedBy: TaskId): PlanChange {
        return new DependencyDeclaration({ blocked, blockedBy });
    }

    public static retractedDependency(blocked: TaskId, blockedBy: TaskId): PlanChange {
        return new DependencyRetraction({ blocked, blockedBy });
    }

    public static fromData(object: JsonObject): PlanChange {
        const kind = requireString(object["kind"], "Plan fact kind");
        if (!isPlanFactKind(kind)) {
            throw new AgentCoreError("codec.invalid", `Plan fact kind ${kind} is unknown`);
        }
        return PLAN_CHANGE_DECODERS[kind](object);
    }

    public abstract readonly kind: PlanFactKind;

    /** The one fold step: an admission that would refuse is a replay that would refuse. */
    public abstract fold(plan: TaskPlan): TaskPlan;

    public abstract toData(): JsonObject;
}

class TaskDeclaration extends PlanChange {
    public readonly kind: PlanFactKind = "plan.taskDeclared";

    public constructor(public readonly task: TaskId) {
        super();
        Object.freeze(this);
    }

    public fold(plan: TaskPlan): TaskPlan {
        if (plan.declares(this.task)) {
            throw new AgentCoreError(
                "plan.duplicate-task",
                `Task ${this.task.value} is already in the plan`
            );
        }
        return plan.withTasks([...plan.tasks, this.task]);
    }

    public toData(): JsonObject {
        return { kind: this.kind, task: this.task.value };
    }
}

class DependencyDeclaration extends PlanChange {
    public readonly kind: PlanFactKind = "plan.dependencyDeclared";

    public constructor(public readonly edge: PlanEdge) {
        super();
        Object.freeze(this);
    }

    public fold(plan: TaskPlan): TaskPlan {
        for (const endpoint of [this.edge.blocked, this.edge.blockedBy]) {
            if (!plan.declares(endpoint)) {
                throw new AgentCoreError(
                    "plan.unknown-task",
                    `Task ${endpoint.value} is not in the plan`
                );
            }
        }
        if (plan.dependsDirectly(this.edge)) {
            throw new AgentCoreError(
                "plan.duplicate-dependency",
                `Task ${this.edge.blocked.value} is already blocked by ${this.edge.blockedBy.value}`
            );
        }
        if (
            this.edge.blocked.equals(this.edge.blockedBy) ||
            plan.precedes(this.edge.blocked, this.edge.blockedBy)
        ) {
            throw new AgentCoreError(
                "plan.cycle",
                `Blocking ${this.edge.blocked.value} by ${this.edge.blockedBy.value} closes a cycle`
            );
        }
        return plan.withDependencies([...plan.dependencies, this.edge]);
    }

    public toData(): JsonObject {
        return edgeData(this.kind, this.edge);
    }
}

class DependencyRetraction extends PlanChange {
    public readonly kind: PlanFactKind = "plan.dependencyRetracted";

    public constructor(public readonly edge: PlanEdge) {
        super();
        Object.freeze(this);
    }

    public fold(plan: TaskPlan): TaskPlan {
        if (!plan.dependsDirectly(this.edge)) {
            throw new AgentCoreError(
                "plan.unknown-dependency",
                `Task ${this.edge.blocked.value} is not blocked by ${this.edge.blockedBy.value}`
            );
        }
        return plan.withDependencies(
            plan.dependencies.filter((standing) => !sameEdge(standing, this.edge))
        );
    }

    public toData(): JsonObject {
        return edgeData(this.kind, this.edge);
    }
}

class PlanFactCodecV1 extends RecordCodec<PlanFact> {
    public constructor() {
        super(
            [
                PlanFact,
                PlanChange,
                TaskDeclaration,
                DependencyDeclaration,
                DependencyRetraction,
                TextId,
                TaskId,
                TurnId
            ],
            "workspace.plan-fact",
            {
                major: 1,
                minor: 0
            }
        );
    }

    protected encodePayload(fact: PlanFact): JsonValue {
        return fact.toData();
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): PlanFact {
        return PlanFact.fromData(payload);
    }
}

/**
 * The decoded payload of one plan Event: what changed, and the Turn that appended it under
 * its own lease (§6.1 `self` tier). Identifiers only — no capability, BindingName,
 * ResourceCeiling, SecretRef, or Run reference is representable here, which is what keeps a
 * discovery from handing its successor more than the discoverer held.
 */
export class PlanFact {
    public static get codec(): RecordCodec<PlanFact> {
        return planFactCodecInstance;
    }

    public static encode(fact: PlanFact): Uint8Array {
        return PlanFact.codec.encode(fact);
    }

    public static decode(bytes: Uint8Array): PlanFact {
        return PlanFact.codec.decode(bytes);
    }

    public static fromData(value: JsonValue): PlanFact {
        const object = requireObject(value, "Plan fact");
        return new PlanFact(
            PlanChange.fromData(object),
            new TurnId(requireString(object["origin"], "Plan origin Turn ID"))
        );
    }

    public constructor(
        public readonly change: PlanChange,
        public readonly origin: TurnId
    ) {
        Object.freeze(this);
    }

    public get kind(): PlanFactKind {
        return this.change.kind;
    }

    public fold(plan: TaskPlan): TaskPlan {
        return this.change.fold(plan);
    }

    public toData(): JsonObject {
        return { ...this.change.toData(), origin: this.origin.value };
    }
}

const planFactCodecInstance = new PlanFactCodecV1();

/**
 * The projection. Derived, rebuildable, and disposable (§8.4 rule 3): it holds identifiers
 * and edges, never a copy of the Task or Run state those identifiers name, and it has no
 * codec because nothing persists it — the Events it folds are the durable record
 * (C13-PLAN-PROJECTION).
 */
export class TaskPlan {
    public static empty(cursor: EventCursor): TaskPlan {
        return new TaskPlan([], [], cursor);
    }

    /** Rebuild from Events. One fold, so a rebuilt plan cannot differ from a grown one. */
    public static replay(start: EventCursor, entries: readonly PlanEntry[]): TaskPlan {
        return entries.reduce(
            (plan, entry) => plan.advance(entry.fact, entry.cursor),
            TaskPlan.empty(start)
        );
    }

    public readonly tasks: readonly TaskId[];
    public readonly dependencies: readonly PlanEdge[];
    public readonly cursor: EventCursor;

    private constructor(
        tasks: readonly TaskId[],
        dependencies: readonly PlanEdge[],
        cursor: EventCursor
    ) {
        this.tasks = Object.freeze([...tasks]);
        this.dependencies = Object.freeze(
            dependencies.map((edge) =>
                Object.freeze({ blocked: edge.blocked, blockedBy: edge.blockedBy })
            )
        );
        this.cursor = cursor;
        Object.freeze(this);
    }

    /** One appended Event: the fact's own fold step, then the cursor it was read at. */
    public advance(fact: PlanFact, cursor: EventCursor): TaskPlan {
        const folded = fact.fold(this);
        return new TaskPlan(folded.tasks, folded.dependencies, cursor);
    }

    public declares(task: TaskId): boolean {
        return this.tasks.some((declared) => declared.equals(task));
    }

    public dependsDirectly(edge: PlanEdge): boolean {
        return this.dependencies.some((standing) => sameEdge(standing, edge));
    }

    /** Whether `earlier` must happen before `later` under the standing edges. */
    public precedes(earlier: TaskId, later: TaskId): boolean {
        const reached = new Set<string>([earlier.value]);
        const frontier = [earlier];
        for (const current of frontier) {
            for (const next of this.blocking(current)) {
                if (next.equals(later)) return true;
                if (reached.has(next.value)) continue;
                reached.add(next.value);
                frontier.push(next);
            }
        }
        return false;
    }

    /** The tasks this task directly blocks. */
    public blocking(task: TaskId): readonly TaskId[] {
        return this.dependencies
            .filter((edge) => edge.blockedBy.equals(task))
            .map((edge) => edge.blocked);
    }

    /** The tasks that directly block this task. */
    public blockers(task: TaskId): readonly TaskId[] {
        return this.dependencies
            .filter((edge) => edge.blocked.equals(task))
            .map((edge) => edge.blockedBy);
    }

    public withTasks(tasks: readonly TaskId[]): TaskPlan {
        return new TaskPlan(tasks, this.dependencies, this.cursor);
    }

    public withDependencies(dependencies: readonly PlanEdge[]): TaskPlan {
        return new TaskPlan(this.tasks, dependencies, this.cursor);
    }
}

/**
 * The longest chain of declared dependencies, in the order the work has to happen. Pure and
 * total over the projection and stored nowhere, so it can never disagree with the edges it
 * summarizes; ties break by canonical TaskId order so the answer is one path rather than a
 * set of equally long ones (C13-PLAN-CRITICAL-PATH).
 */
export function criticalPath(plan: TaskPlan): readonly TaskId[] {
    const longest = new Map<string, readonly TaskId[]>();
    const chainTo = (task: TaskId): readonly TaskId[] => {
        const memoized = longest.get(task.value);
        if (memoized !== undefined) return memoized;
        // Acyclicity is the fold's invariant, so this recursion terminates without a guard.
        const best = plan
            .blockers(task)
            .toSorted((left, right) => compareCanonicalText(left.value, right.value))
            .map((blocker) => [...chainTo(blocker), task])
            .reduce<readonly TaskId[]>(longerChain, [task]);
        longest.set(task.value, best);
        return best;
    };
    return plan.tasks
        .toSorted((left, right) => compareCanonicalText(left.value, right.value))
        .map(chainTo)
        .reduce<readonly TaskId[]>(longerChain, []);
}

/**
 * One rendered snapshot of the plan on a Surface. The body is identifiers, standing edges,
 * and the recomputed critical path — data the §6.3 no-live-state rule accepts unchanged —
 * and the projection's cursor is the View's resume position.
 */
export function planView(
    surface: SurfaceId,
    revision: Revision,
    plan: TaskPlan,
    actions: readonly ActionDescriptor[] = []
): View {
    return new View({
        surface,
        revision,
        body: planViewBody(plan),
        actions,
        cursor: plan.cursor
    });
}

export function planViewBody(plan: TaskPlan): JsonValue {
    return {
        criticalPath: criticalPath(plan).map((task) => task.value),
        dependencies: plan.dependencies.map((edge) => ({
            blocked: edge.blocked.value,
            blockedBy: edge.blockedBy.value
        })),
        tasks: plan.tasks.map((task) => task.value)
    };
}

/**
 * A discovery is attributable to exactly the Turn that appended it, and to no other. The fact
 * carries identifiers only, so there is no field in which a discoverer could widen what its
 * successor receives; that leaves only the origin to check (C13-PLAN-DECLARER-BOUNDED).
 */
export function requireDeclaringTurn(fact: PlanFact, turn: TurnId): void {
    if (!fact.origin.equals(turn)) {
        throw new AgentCoreError(
            "plan.foreign-declaration",
            `Turn ${turn.value} cannot append a plan fact declared by ${fact.origin.value}`
        );
    }
}

const PLAN_CHANGE_DECODERS = {
    "plan.dependencyDeclared": (object: JsonObject): PlanChange =>
        PlanChange.declaredDependency(...decodeEdge(object, "Plan dependency declaration")),
    "plan.dependencyRetracted": (object: JsonObject): PlanChange =>
        PlanChange.retractedDependency(...decodeEdge(object, "Plan dependency retraction")),
    "plan.taskDeclared": (object: JsonObject): PlanChange => {
        requireFields(object, ["kind", "origin", "task"], "Plan task declaration");
        return PlanChange.declaredTask(new TaskId(requireString(object["task"], "Plan Task ID")));
    }
} satisfies Record<PlanFactKind, (object: JsonObject) => PlanChange>;

function isPlanFactKind(value: string): value is PlanFactKind {
    return Object.hasOwn(PLAN_CHANGE_DECODERS, value);
}

/** Three call sites read edge identity in lockstep: declare, retract, and the standing check. */
function sameEdge(left: PlanEdge, right: PlanEdge): boolean {
    return left.blocked.equals(right.blocked) && left.blockedBy.equals(right.blockedBy);
}

function longerChain(left: readonly TaskId[], right: readonly TaskId[]): readonly TaskId[] {
    if (left.length !== right.length) return left.length > right.length ? left : right;
    for (const [index, task] of left.entries()) {
        const order = compareCanonicalText(task.value, right[index]?.value ?? "");
        if (order !== 0) return order < 0 ? left : right;
    }
    return left;
}

function edgeData(kind: PlanFactKind, edge: PlanEdge): JsonObject {
    return { blocked: edge.blocked.value, blockedBy: edge.blockedBy.value, kind };
}

function decodeEdge(object: JsonObject, subject: string): readonly [TaskId, TaskId] {
    requireFields(object, ["blocked", "blockedBy", "kind", "origin"], subject);
    return [
        new TaskId(requireString(object["blocked"], `${subject} blocked Task ID`)),
        new TaskId(requireString(object["blockedBy"], `${subject} blocking Task ID`))
    ];
}
