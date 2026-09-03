import { describe, expect, test } from "vitest";
import { MemoryActorStore, type SynchronousResultGuard } from "../../src/actors";
import { Revision, isJsonObject, type JsonValue } from "../../src/core";
import { SlotCatalog, SlotEntry, SlotName, SurfaceId } from "../../src/facets";
import { SurfaceAggregation } from "../../src/composition";
import { MemoryWorkspaceRecords, View, WorkspacePersistence } from "../../src/workspaces";
import { EventCursor } from "../../src/workspaces/id";
import { attribution } from "../w3/slot-store-contract";
import {
    DeterministicJsonPatchEngine,
    registerSurface,
    sourceActor,
    tenant
} from "../workspaces/fixtures";

/**
 * The Workspace Actor's own state. The records live behind one field because an Actor
 * transaction hands the callback a Proxy over the state, and a class instance reached
 * through that Proxy cannot read its own private fields.
 */
interface AggregateState {
    readonly records: MemoryWorkspaceRecords;
}

const dashboard = new SurfaceId("dashboard.overview");
const cards = new SlotName("dashboard.card");
const firstChild = new SurfaceId("dashboard.card.alerts");
const secondChild = new SurfaceId("dashboard.card.usage");

/** The §4.2 read path, answering the surface-backed entries one slot holds. */
class ContributedCards extends SlotCatalog {
    public constructor(private entries: readonly SlotEntry[]) {
        super();
    }

    public contribute(entries: readonly SlotEntry[]): void {
        this.entries = entries;
    }

    public override async query(slot: SlotName): Promise<readonly SlotEntry[]> {
        return slot.equals(cards) ? this.entries : [];
    }
}

function cardEntry(child: SurfaceId, ordinal: number): SlotEntry {
    return new SlotEntry(cards, attribution(`workspace:${child.value}`), ordinal, {
        surface: child.value
    });
}

interface Harness {
    readonly persistence: WorkspacePersistence<AggregateState>;
    readonly transaction: <Result>(
        operation: (state: AggregateState) => Result,
        ...guard: SynchronousResultGuard<Result>
    ) => Result;
    readonly catalog: ContributedCards;
    readonly aggregation: SurfaceAggregation<AggregateState>;
}

function harness(): Harness {
    const persistence = new WorkspacePersistence<AggregateState>(
        (state) => state.records,
        { verify: () => true, retain: () => {}, release: () => {}, discard: () => {} },
        sourceActor,
        tenant
    );
    const store = new MemoryActorStore<AggregateState>(
        { records: new MemoryWorkspaceRecords() },
        (state) => ({ records: state.records.clone() })
    );
    const transaction = <Result,>(
        operation: (state: AggregateState) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result => store.transaction(operation, ...guard);
    const catalog = new ContributedCards([cardEntry(firstChild, 0), cardEntry(secondChild, 1)]);
    return {
        persistence,
        transaction,
        catalog,
        aggregation: new SurfaceAggregation({
            persistence,
            transaction,
            patches: new DeterministicJsonPatchEngine(),
            catalog
        })
    };
}

/** Registers a Surface and renders its stream's first revision. */
function render(state: Harness, surface: SurfaceId, body: JsonValue, contributor: string): View {
    return state.transaction((workspace) => {
        registerSurface(state.persistence, workspace, surface, contributor);
        const view = new View({
            surface,
            epoch: state.persistence.currentSurfaceEpoch(workspace, surface.value),
            revision: Revision.initial(),
            body,
            actions: [],
            cursor: new EventCursor(`cursor-${surface.value}`)
        });
        state.persistence.saveView(workspace, view, undefined, []);
        return view;
    });
}

function composedChildren(view: View): readonly JsonValue[] {
    const children = isJsonObject(view.body) ? view.body["children"] : undefined;
    return Array.isArray(children) ? children : [];
}

describe("an aggregating Surface over slot-contributed child Views", () => {
    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] drops a retired child's entry at its next revision and keeps every live one",
        { tags: "p0" },
        async () => {
            const state = harness();
            render(state, dashboard, { children: [] }, "workspace:dashboard");
            render(state, firstChild, { alerts: 2 }, "workspace:alerts");
            const retiring = render(state, secondChild, { usage: "94%" }, "workspace:usage");

            const composed = await state.aggregation.advance({
                parent: dashboard,
                slot: cards,
                cursor: new EventCursor("aggregate-cursor-1")
            });
            expect(composed.revision.value).toBe(1);
            expect(composedChildren(composed)).toEqual([
                { body: { alerts: 2 }, epoch: 1, revision: 0, surface: firstChild.value },
                { body: { usage: "94%" }, epoch: 1, revision: 0, surface: secondChild.value }
            ]);

            // Withdrawing the second child's contribution retires its Surface, which
            // terminates that stream (§4.1, §6.3).
            state.transaction((workspace) =>
                state.persistence.retireSurfaceRegistration(workspace, secondChild)
            );

            const dropped = await state.aggregation.advance({
                parent: dashboard,
                slot: cards,
                cursor: new EventCursor("aggregate-cursor-2")
            });
            expect(dropped.revision.value).toBe(2);
            expect(composedChildren(dropped)).toEqual([
                { body: { alerts: 2 }, epoch: 1, revision: 0, surface: firstChild.value }
            ]);

            // The retired child's terminal View is not deleted and stays exactly as
            // readable as before — the parent stopped composing it, nothing erased it.
            const terminal = state.transaction((workspace) =>
                state.persistence.currentView(workspace, secondChild.value, retiring.epoch)
            );
            expect(terminal?.terminal).toBe(true);
            expect(terminal?.revision.value).toBe(1);
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] rejoins a re-registered child at its new epoch and composes nothing for one that never rendered",
        { tags: "p1" },
        async () => {
            const state = harness();
            render(state, dashboard, { children: [] }, "workspace:dashboard");
            render(state, firstChild, { alerts: 1 }, "workspace:alerts");
            state.transaction((workspace) =>
                state.persistence.retireSurfaceRegistration(workspace, firstChild)
            );

            // A registration that has not rendered consumes no epoch, so it contributes
            // nothing rather than a stale snapshot of the stream it replaced.
            state.transaction((workspace) =>
                registerSurface(state.persistence, workspace, firstChild, "workspace:alerts-again")
            );
            const empty = await state.aggregation.advance({
                parent: dashboard,
                slot: cards,
                cursor: new EventCursor("aggregate-cursor-empty")
            });
            expect(composedChildren(empty)).toEqual([]);

            // Once the new registration renders, the child rejoins at the next epoch and
            // never at the retired one.
            const reopened = state.transaction((workspace) => {
                const view = new View({
                    surface: firstChild,
                    epoch: state.persistence.currentSurfaceEpoch(workspace, firstChild.value),
                    revision: Revision.initial(),
                    body: { alerts: 7 },
                    actions: [],
                    cursor: new EventCursor("cursor-alerts-2")
                });
                state.persistence.saveView(workspace, view, undefined, []);
                return view;
            });
            expect(reopened.epoch.value).toBe(2);

            const rejoined = await state.aggregation.advance({
                parent: dashboard,
                slot: cards,
                cursor: new EventCursor("aggregate-cursor-rejoined")
            });
            expect(composedChildren(rejoined)).toEqual([
                { body: { alerts: 7 }, epoch: 2, revision: 0, surface: firstChild.value }
            ]);
        }
    );
});
