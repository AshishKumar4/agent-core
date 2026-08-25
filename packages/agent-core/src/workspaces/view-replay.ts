import { Revision } from "../core";
import type { ActorRef } from "../actors";
import { AgentCoreError } from "../errors";
import type { SurfaceId } from "../facets";
import type { TenantId } from "../identity";
import type { EventCursor } from "./id";
import { WorkspacePersistence } from "./persistence";
import { RetainedRecordKind, type ContentRetentionReference } from "./retention";
import type { SurfaceEpoch } from "./surface-epoch";
import {
    type JsonPatchEngine,
    View,
    ViewDelta,
    viewDeltaRecordKey,
    viewDocument,
    viewFromDocument,
    viewRecordKey
} from "./view";

export type ViewReplayResult =
    | { readonly kind: "snapshot"; readonly view: View }
    | {
          readonly kind: "deltas";
          readonly base: Revision;
          readonly deltas: readonly ViewDelta[];
          readonly view: View;
      };

export class ViewReplayProtocol<Transaction> {
    public constructor(
        private readonly persistence: WorkspacePersistence<Transaction>,
        private readonly patches: JsonPatchEngine,
        private readonly actor: ActorRef,
        private readonly tenant: TenantId
    ) {}

    public publishSnapshot(
        transaction: Transaction,
        view: View,
        retentions: readonly ContentRetentionReference[]
    ): void {
        requireRetentionOwner(retentions, this.actor, this.tenant, viewRecordKey(view));
        this.persistence.saveView(transaction, view, undefined, retentions);
    }

    public publish(
        transaction: Transaction,
        delta: ViewDelta,
        viewRetentions: readonly ContentRetentionReference[],
        deltaRetentions: readonly ContentRetentionReference[]
    ): View {
        // A delta and the View it produces are one revision of one stream, so they share a key.
        const recordKey = viewDeltaRecordKey(delta);
        requireRetentionOwner(viewRetentions, this.actor, this.tenant, recordKey);
        requireRetentionOwner(
            deltaRetentions,
            this.actor,
            this.tenant,
            recordKey,
            RetainedRecordKind.viewDelta()
        );
        return this.persistence.appendViewDelta(
            transaction,
            delta,
            this.patches,
            viewRetentions,
            deltaRetentions
        );
    }

    /**
     * SPEC §6.3: resume from a client's cursor. The client presents the `cursor` of the last
     * View it holds, and this reader resolves that opaque position against the durable
     * records of the `(surface, epoch)` stream. A cursor this stream never carried is
     * refused, so a stale position and a foreign one are told rather than answered from the
     * beginning. A cursor presented for a retired epoch resolves against that epoch's own
     * records and returns its terminal revision through this one reader rather than an error
     * or another epoch's live View. The returned View carries `terminal`, so a client holding
     * no live handle can tell a stream that ended from one it may keep following.
     */
    public replay(
        transaction: Transaction,
        surface: SurfaceId,
        epoch: SurfaceEpoch,
        after: EventCursor
    ): ViewReplayResult {
        const current = this.persistence.currentView(transaction, surface.value, epoch);
        if (current === undefined) {
            throw new AgentCoreError("protocol.invalid-state", "Surface has no durable View");
        }
        const base = this.persistence.findCursorRevision(transaction, surface.value, epoch, after);
        if (base === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Event cursor ${after.value} is not a position in Surface ${surface.value} epoch ${epoch.text}`
            );
        }
        if (base.value > current.revision.value) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Resumed position is ahead of the current View"
            );
        }
        if (base.equals(current.revision)) {
            return Object.freeze({
                kind: "deltas" as const,
                base,
                deltas: Object.freeze([]),
                view: current
            });
        }
        const stored = this.persistence.findView(transaction, surface.value, epoch, base);
        if (stored === undefined)
            return Object.freeze({ kind: "snapshot" as const, view: current });
        const deltas = this.persistence.listViewDeltas(transaction, surface.value, epoch, base);
        let replayed = stored;
        for (const delta of deltas) {
            if (!replayed.revision.equals(delta.baseRevision)) {
                return Object.freeze({ kind: "snapshot" as const, view: current });
            }
            replayed = viewFromDocument(
                replayed,
                delta,
                this.patches.apply(viewDocument(replayed), delta.patch)
            );
        }
        if (
            !replayed.revision.equals(current.revision) ||
            !equalBytes(View.codec.encode(replayed), View.codec.encode(current))
        ) {
            return Object.freeze({ kind: "snapshot" as const, view: current });
        }
        return Object.freeze({
            kind: "deltas" as const,
            base,
            deltas,
            view: replayed
        });
    }

    /**
     * A compaction floor is the host's own administrative choice over its own storage, not a
     * client resume position, so it stays a `Revision` rather than an opaque cursor.
     */
    public compact(
        transaction: Transaction,
        surface: SurfaceId,
        epoch: SurfaceEpoch,
        retainFrom: Revision
    ): void {
        this.persistence.compactView(transaction, surface.value, epoch, retainFrom);
    }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
    );
}

function requireRetentionOwner(
    retentions: readonly ContentRetentionReference[],
    actor: ActorRef,
    tenant: TenantId,
    recordKey: string,
    recordKind: RetainedRecordKind = RetainedRecordKind.view()
): void {
    if (
        retentions.some(
            (reference) =>
                !reference.actor.equals(actor) ||
                !reference.tenant.equals(tenant) ||
                !reference.recordKind.equals(recordKind) ||
                reference.record.value !== recordKey
        )
    ) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "View retention belongs to another Actor, tenant, or View revision"
        );
    }
}
