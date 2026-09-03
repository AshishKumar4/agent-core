import { Revision, isJsonObject, isJsonString, type JsonValue } from "../core";
import { SurfaceId, type SlotCatalog, type SlotName } from "../facets";
import {
    View,
    ViewDelta,
    type EventCursor,
    type JsonPatchEngine,
    type WorkspacePersistence
} from "../workspaces";
import type { ControlTransaction } from "./facet-withdrawal";

export interface SurfaceAggregationInit<Transaction> {
    readonly persistence: WorkspacePersistence<Transaction>;
    readonly transaction: ControlTransaction<Transaction>;
    readonly patches: JsonPatchEngine;
    /** The §4.2 read path the parent composes its children through. */
    readonly catalog: SlotCatalog;
}

/** One child View an aggregating Surface composes, at the revision it is composing. */
export interface AggregatedChild {
    readonly surface: SurfaceId;
    readonly epoch: number;
    readonly revision: number;
    readonly body: JsonValue;
}

/**
 * SPEC §6.3 and §4.2: an aggregating Surface — a dashboard — composes the child Views its
 * slot-contributed entries name, and **drops the retired child's entry at its next
 * revision rather than composing a stale snapshot**.
 *
 * Dropping needs no liveness flag and no retirement notice. A child contributes exactly
 * what its stream currently answers: `currentSurfaceEpoch` returns the epoch a View
 * written now would belong to, so a retired child's last stream is behind that epoch and
 * a child that never rendered has not reached it. Either way the current View of that
 * epoch is absent, which is the same answer for both and the right one for the parent —
 * the terminal View stays exactly as readable as before for anyone asking about the child
 * itself.
 */
export class SurfaceAggregation<Transaction> {
    public constructor(private readonly init: SurfaceAggregationInit<Transaction>) {}

    /**
     * The parent's next revision: exactly its live children, in canonical child order.
     * The slot query is awaited before the transaction opens, so the reads the composition
     * depends on and the write it produces stay one synchronous span (§8.5, §10.3).
     */
    public async advance(request: {
        readonly parent: SurfaceId;
        readonly slot: SlotName;
        readonly cursor: EventCursor;
    }): Promise<View> {
        const contributed = await this.init.catalog.query(request.slot);
        const children = contributed
            .map((entry) => requireChildSurface(entry.value))
            .sort((left, right) => (left.value < right.value ? -1 : 1));
        const published: View = this.init.transaction((transaction) => {
            const persistence = this.init.persistence;
            const composed = children.flatMap((child) => {
                const epoch = persistence.currentSurfaceEpoch(transaction, child.value);
                const view = persistence.currentView(transaction, child.value, epoch);
                return view === undefined
                    ? []
                    : [
                          {
                              surface: child,
                              epoch: epoch.value,
                              revision: view.revision.value,
                              body: view.body
                          }
                      ];
            });
            const body = aggregatedBody(composed);
            const epoch = persistence.currentSurfaceEpoch(transaction, request.parent.value);
            const current = persistence.currentView(transaction, request.parent.value, epoch);
            if (current === undefined) {
                const opened = new View({
                    surface: request.parent,
                    epoch,
                    revision: Revision.initial(),
                    body,
                    actions: [],
                    cursor: request.cursor
                });
                persistence.saveView(transaction, opened, undefined, []);
                return opened;
            }
            return persistence.appendViewDelta(
                transaction,
                new ViewDelta({
                    surface: request.parent,
                    epoch,
                    revision: current.revision.next(),
                    baseRevision: current.revision,
                    patch: [{ op: "replace", path: "/body", value: body }],
                    cursor: request.cursor
                }),
                this.init.patches,
                [],
                []
            );
        });
        return published;
    }
}

function aggregatedBody(children: readonly AggregatedChild[]): JsonValue {
    return {
        children: children.map((child) => ({
            body: child.body,
            epoch: child.epoch,
            revision: child.revision,
            surface: child.surface.value
        }))
    };
}

/**
 * A surface-backed slot entry (§4.2) names the child Surface it contributes, and nothing
 * else about that child: the stream, the epoch, and the revision are the child's own
 * facts, read where they live rather than copied into the entry where they would go
 * stale.
 */
function requireChildSurface(value: JsonValue): SurfaceId {
    const surface = isJsonObject(value) ? value["surface"] : undefined;
    if (!isJsonString(surface)) {
        throw new TypeError("A surface-backed slot entry names its child Surface");
    }
    return new SurfaceId(surface);
}
