import { Revision } from "../core";
import type { OperationContext, Surface } from "../facets";
import type { PreparedInvocation } from "../invocations";
import {
    DecidedInput,
    DecisionRendering,
    composeDecisionView,
    decisionViewPatch,
    ViewDelta,
    type Event,
    type EventCursor,
    type JsonPatchEngine,
    type View,
    type WorkspacePersistence
} from "../workspaces";
import type { ControlTransaction } from "./facet-withdrawal";

export interface DecisionPresentationInit<Transaction> {
    readonly persistence: WorkspacePersistence<Transaction>;
    readonly transaction: ControlTransaction<Transaction>;
    readonly patches: JsonPatchEngine;
}

export interface DecisionPresentationRequest<Lease, Authority, Domain, PathEpochs> {
    /** The §4 Surface whose render answer this presentation constrains. */
    readonly surface: Surface;
    readonly context: OperationContext;
    /** The §7.3 prepared intent the decision authorizes, and the item being decided. */
    readonly prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
    readonly itemIndex: number;
    /**
     * The Event the decided arguments arrived on, when they arrived on one. Its
     * host-derived tier is what every mark carries. Absent means the Turn executor
     * assembled them under its own lease, which §6.1 tiers `self`.
     */
    readonly arrival?: Event | undefined;
    readonly cursor: EventCursor;
}

/**
 * SPEC §6.3 and §7.3: the one production path from a prepared intent to a decision View.
 *
 * It spans three planes and belongs to none of them, which is why it lives here. The
 * Surface (§4) renders, and its answer is generic `FacetData` that has to decode to a
 * `DecisionRendering` before it can mean anything. The prepared intent (§7.3) supplies
 * both the digest the decision authorizes and the values it is about, so a Surface can
 * only name positions in an intent it did not write. The Workspace plane (§6.3) composes
 * the marks from the arrival record's host-derived tier and publishes the revision.
 *
 * The render is awaited before the transaction opens, so the guarded read and write stay
 * one synchronous span (§8.5, §10.3).
 */
export class DecisionSurfacePresentation<Transaction> {
    public constructor(private readonly init: DecisionPresentationInit<Transaction>) {}

    public async present<Lease, Authority, Domain, PathEpochs>(
        request: DecisionPresentationRequest<Lease, Authority, Domain, PathEpochs>
    ): Promise<View> {
        const item = request.prepared.item(request.itemIndex);
        const decided =
            request.arrival === undefined
                ? DecidedInput.emitted(item.arguments)
                : DecidedInput.delivered(request.arrival, item.arguments);
        // What a Surface renders a decision from: the intent it authorizes, named by
        // digest, and the arguments the human is deciding about. The Surface answers
        // positions into these arguments rather than values of its own, so nothing it
        // returns can carry an input the intent does not hold.
        const answer = await request.surface.render(request.context, {
            decided: item.arguments,
            intentDigest: request.prepared.intentDigest.value
        });
        const surface = request.surface.descriptor.id;
        const published: View = this.init.transaction((transaction) => {
            const persistence = this.init.persistence;
            const epoch = persistence.currentSurfaceEpoch(transaction, surface.value);
            const current = persistence.currentView(transaction, surface.value, epoch);
            const rendering = DecisionRendering.fromData(answer);
            const composed = composeDecisionView({
                surface,
                epoch,
                revision: current === undefined ? Revision.initial() : current.revision.next(),
                cursor: request.cursor,
                intentDigest: request.prepared.intentDigest,
                decided,
                rendering
            });
            if (current === undefined) {
                persistence.saveView(transaction, composed, undefined, []);
                return composed;
            }
            return persistence.appendViewDelta(
                transaction,
                new ViewDelta({
                    surface,
                    epoch,
                    revision: composed.revision,
                    baseRevision: current.revision,
                    patch: decisionViewPatch(composed, current),
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
