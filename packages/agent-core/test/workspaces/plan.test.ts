import { expect, test } from "vitest";
import { callableRecord, malformed } from "../helpers/malformed";
import { Revision, type JsonValue } from "../../src/core";
import { SurfaceId, TaskId } from "../../src/facets";
import { TurnId } from "../../src/execution-references";
import {
    EventCursor,
    PlanChange,
    PlanFact,
    TaskPlan,
    View,
    criticalPath,
    planView,
    planViewBody,
    requireDeclaringTurn
} from "../../src/workspaces";
import type { PlanEntry } from "../../src/workspaces";

const discoverer = new TurnId("turn-discoverer");
const other = new TurnId("turn-other");
const board = new SurfaceId("task.board");
const origin = new EventCursor("plan-cursor-0");

const task = (name: string): TaskId => new TaskId(name);
const cursor = (position: number): EventCursor => new EventCursor(`plan-cursor-${position}`);

function declare(name: string, turn = discoverer): PlanFact {
    return new PlanFact(PlanChange.declaredTask(task(name)), turn);
}

function block(blocked: string, blockedBy: string, turn = discoverer): PlanFact {
    return new PlanFact(PlanChange.declaredDependency(task(blocked), task(blockedBy)), turn);
}

function unblock(blocked: string, blockedBy: string, turn = discoverer): PlanFact {
    return new PlanFact(PlanChange.retractedDependency(task(blocked), task(blockedBy)), turn);
}

/** Facts numbered from 1 so a plan's cursor names the position after its last fact. */
function log(...facts: readonly PlanFact[]): readonly PlanEntry[] {
    return facts.map((fact, index) => ({ fact, cursor: cursor(index + 1) }));
}

function names(tasks: readonly TaskId[]): readonly string[] {
    return tasks.map((entry) => entry.value);
}

function snapshot(plan: TaskPlan): Uint8Array {
    return View.encode(planView(board, new Revision(4), plan));
}

/** An a → b → c chain plus an unrelated d, so the longest chain is a strict subset. */
const chainLog = log(
    declare("a"),
    declare("b"),
    declare("c"),
    declare("d"),
    block("b", "a"),
    block("c", "b")
);

test(
    "[C13-PLAN-APPEND-ONLY] a task discovered mid-Turn appends without touching the plan it grew from",
    { tags: "p0" },
    () => {
        const before = TaskPlan.replay(origin, log(declare("a"), declare("b"), block("b", "a")));
        const after = before.advance(declare("discovered"), cursor(9));

        expect(names(before.tasks)).toEqual(["a", "b"]);
        expect(names(after.tasks)).toEqual(["a", "b", "discovered"]);
        expect(before.cursor.value).toBe("plan-cursor-3");
        expect(after.cursor.value).toBe("plan-cursor-9");
        expect(Object.isFrozen(before.tasks)).toBe(true);
    }
);

test(
    "[C13-PLAN-APPEND-ONLY] reordering retracts and re-declares rather than editing an edge",
    { tags: "p0" },
    () => {
        const reordered = TaskPlan.replay(
            origin,
            log(declare("a"), declare("b"), block("b", "a"), unblock("b", "a"), block("a", "b"))
        );

        expect(
            reordered.dependencies.map((edge) => [edge.blocked.value, edge.blockedBy.value])
        ).toEqual([["a", "b"]]);
        expect(names(criticalPath(reordered))).toEqual(["b", "a"]);
    }
);

test(
    "[C13-PLAN-PROJECTION] a projection rebuilt from the same Events is byte-identical",
    { tags: "p0" },
    () => {
        const grown = chainLog.reduce(
            (plan, entry) => plan.advance(entry.fact, entry.cursor),
            TaskPlan.empty(origin)
        );
        const rebuilt = TaskPlan.replay(
            origin,
            chainLog.map((entry) => ({
                fact: PlanFact.decode(PlanFact.encode(entry.fact)),
                cursor: entry.cursor
            }))
        );

        expect(snapshot(rebuilt)).toEqual(snapshot(grown));

        // Negative control: the same facts in a different admissible order are a different
        // plan, so the equality above is evidence about the fold, not about the encoder.
        const reordered = TaskPlan.replay(
            origin,
            log(
                declare("b"),
                declare("a"),
                declare("c"),
                declare("d"),
                block("b", "a"),
                block("c", "b")
            )
        );
        expect(snapshot(reordered)).not.toEqual(snapshot(grown));
    }
);

test(
    "[C13-PLAN-PROJECTION] the projection carries no state beyond identifiers, edges, and its cursor",
    { tags: "p1" },
    () => {
        const plan = TaskPlan.replay(origin, chainLog);

        expect(Object.keys(plan).toSorted()).toEqual(["cursor", "dependencies", "tasks"]);
        expect(Object.isFrozen(plan)).toBe(true);
        expect("criticalPath" in plan).toBe(false);
    }
);

test(
    "[C13-PLAN-ACYCLIC] a dependency closing a cycle is refused at admission and at replay alike",
    { tags: "p0" },
    () => {
        const declared = log(
            declare("a"),
            declare("b"),
            declare("c"),
            block("b", "a"),
            block("c", "b")
        );
        const plan = TaskPlan.replay(origin, declared);
        const closing = block("a", "c");

        expect(() => plan.advance(closing, cursor(6))).toThrow(
            expect.objectContaining({ code: "plan.cycle" })
        );
        expect(() =>
            TaskPlan.replay(origin, [...declared, { fact: closing, cursor: cursor(6) }])
        ).toThrow(expect.objectContaining({ code: "plan.cycle" }));
        expect(() => plan.advance(block("a", "a"), cursor(6))).toThrow(
            expect.objectContaining({ code: "plan.cycle" })
        );
    }
);

test(
    "[C13-PLAN-ACYCLIC] an edge that only shares endpoints with a chain is admitted",
    { tags: "p1" },
    () => {
        const plan = TaskPlan.replay(origin, chainLog).advance(block("d", "c"), cursor(7));

        expect(plan.dependencies).toHaveLength(3);
        expect(names(criticalPath(plan))).toEqual(["a", "b", "c", "d"]);
    }
);

test(
    "[C13-PLAN-FOLD-CLOSED] the fold refuses undeclared, duplicated, and absent facts by name",
    { tags: "p0" },
    () => {
        const plan = TaskPlan.replay(origin, log(declare("a"), declare("b"), block("b", "a")));

        expect(() => plan.advance(block("b", "missing"), cursor(4))).toThrow(
            expect.objectContaining({ code: "plan.unknown-task" })
        );
        expect(() => plan.advance(block("missing", "a"), cursor(4))).toThrow(
            expect.objectContaining({ code: "plan.unknown-task" })
        );
        expect(() => plan.advance(declare("a"), cursor(4))).toThrow(
            expect.objectContaining({ code: "plan.duplicate-task" })
        );
        expect(() => plan.advance(block("b", "a"), cursor(4))).toThrow(
            expect.objectContaining({ code: "plan.duplicate-dependency" })
        );
        expect(() => plan.advance(unblock("a", "b"), cursor(4))).toThrow(
            expect.objectContaining({ code: "plan.unknown-dependency" })
        );
    }
);

test(
    "[C13-PLAN-DECLARER-BOUNDED] a fact declared by another Turn cannot be appended",
    { tags: "p0" },
    () => {
        expect(() => requireDeclaringTurn(declare("a", other), discoverer)).toThrow(
            expect.objectContaining({ code: "plan.foreign-declaration" })
        );
        expect(() => requireDeclaringTurn(block("b", "a", other), discoverer)).toThrow(
            expect.objectContaining({ code: "plan.foreign-declaration" })
        );
        expect(requireDeclaringTurn(declare("a", discoverer), discoverer)).toBeUndefined();
    }
);

test(
    "[C13-PLAN-DECLARER-BOUNDED] a plan fact's wire form carries identifiers and nothing else",
    { tags: "p0" },
    () => {
        expect(declare("a").toData()).toEqual({
            kind: "plan.taskDeclared",
            origin: "turn-discoverer",
            task: "a"
        });
        expect(block("b", "a").toData()).toEqual({
            blocked: "b",
            blockedBy: "a",
            kind: "plan.dependencyDeclared",
            origin: "turn-discoverer"
        });
        expect(unblock("b", "a").toData()).toEqual({
            blocked: "b",
            blockedBy: "a",
            kind: "plan.dependencyRetracted",
            origin: "turn-discoverer"
        });
    }
);

test(
    "[C13-PLAN-CRITICAL-PATH] the critical path is recomputed after a discovery extends the chain",
    { tags: "p0" },
    () => {
        const before = TaskPlan.replay(origin, chainLog);
        expect(names(criticalPath(before))).toEqual(["a", "b", "c"]);

        const after = before.advance(declare("e"), cursor(7)).advance(block("e", "c"), cursor(8));
        expect(names(criticalPath(after))).toEqual(["a", "b", "c", "e"]);

        // Recomputation, not accumulation: retracting the new edge returns the earlier answer.
        expect(names(criticalPath(after.advance(unblock("e", "c"), cursor(9))))).toEqual([
            "a",
            "b",
            "c"
        ]);
    }
);

test(
    "[C13-PLAN-CRITICAL-PATH] equally long chains resolve to one path by canonical task order",
    { tags: "p1" },
    () => {
        const tied = TaskPlan.replay(
            origin,
            log(
                declare("z-late"),
                declare("m-mid"),
                declare("a-early"),
                declare("b-early"),
                block("z-late", "m-mid"),
                block("m-mid", "b-early"),
                block("m-mid", "a-early")
            )
        );

        expect(names(criticalPath(tied))).toEqual(["a-early", "m-mid", "z-late"]);
    }
);

test(
    "[C13-PLAN-CRITICAL-PATH] an empty plan and an edgeless plan each answer without a path to walk",
    { tags: "p1" },
    () => {
        expect(criticalPath(TaskPlan.empty(origin))).toEqual([]);
        expect(names(criticalPath(TaskPlan.replay(origin, log(declare("b"), declare("a")))))).toEqual(
            ["a"]
        );
    }
);

test("a plan View renders as data and refuses a body carrying live state", { tags: "p1" }, () => {
    const plan = TaskPlan.replay(origin, chainLog);
    const view = planView(board, new Revision(6), plan);

    expect(view.cursor.value).toBe(plan.cursor.value);
    expect(view.body).toEqual({
        criticalPath: ["a", "b", "c"],
        dependencies: [
            { blocked: "b", blockedBy: "a" },
            { blocked: "c", blockedBy: "b" }
        ],
        tasks: ["a", "b", "c", "d"]
    });
    expect(Object.isFrozen(view.body)).toBe(true);
    expect(planViewBody(plan)).toEqual(view.body);

    const smuggled = {
        ...malformed<Record<string, JsonValue>>(planViewBody(plan)),
        live: callableRecord<JsonValue>(() => undefined)
    };
    expect(
        () =>
            new View({
                surface: board,
                revision: new Revision(7),
                body: smuggled,
                actions: [],
                cursor: plan.cursor
            })
    ).toThrow();
});

test("an unknown plan fact kind is refused rather than decoded", { tags: "p1" }, () => {
    expect(() =>
        PlanFact.fromData({ kind: "plan.taskCompleted", task: "a", origin: "turn-discoverer" })
    ).toThrow(expect.objectContaining({ code: "codec.invalid" }));
    expect(() => PlanFact.fromData({ kind: "plan.taskDeclared", task: "a" })).toThrow(TypeError);
});
