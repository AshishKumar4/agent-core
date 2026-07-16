// @ts-nocheck
import { Revision } from "../core";
import type { ActorRef } from "../actors";
import { AgentCoreError } from "../errors";
import type { SurfaceId } from "../facets";
import type { TenantId } from "../identity";
import { WorkspacePersistence } from "./persistence";
import { RetainedRecordKind, type ContentRetentionReference } from "./retention";
import { type JsonPatchEngine, View, ViewDelta, viewDocument, viewFromDocument } from "./view";

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
        requireRetentionOwner(retentions, this.actor, this.tenant, viewId(view));
        this.persistence.saveView(transaction, view, undefined, retentions);
    }

    public publish(
        transaction: Transaction,
        delta: ViewDelta,
        viewRetentions: readonly ContentRetentionReference[],
        deltaRetentions: readonly ContentRetentionReference[]
    ): View {
        requireRetentionOwner(
            viewRetentions,
            this.actor,
            this.tenant,
            `${delta.surface.value}@${delta.revision.value}`,
            RetainedRecordKind.view()
        );
        requireRetentionOwner(
            deltaRetentions,
            this.actor,
            this.tenant,
            `${delta.surface.value}@${delta.revision.value}`,
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

    public replay(transaction: Transaction, surface: SurfaceId, after: Revision): ViewReplayResult {
        const current = this.persistence.currentView(transaction, surface.value);
        if (current === undefined) {
            throw new AgentCoreError("protocol.invalid-state", "Surface has no durable View");
        }
        if (after.value > current.revision.value) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Replay revision is ahead of the current View"
            );
        }
        if (after.equals(current.revision)) {
            return Object.freeze({
                kind: "deltas" as const,
                base: after,
                deltas: Object.freeze([]),
                view: current
            });
        }
        const base = this.persistence.findView(transaction, surface.value, after);
        if (base === undefined) return Object.freeze({ kind: "snapshot" as const, view: current });
        const deltas = this.persistence.listViewDeltas(transaction, surface.value, after);
        let replayed = base;
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
            base: after,
            deltas,
            view: replayed
        });
    }

    public compact(transaction: Transaction, surface: SurfaceId, retainFrom: Revision): void {
        this.persistence.compactView(transaction, surface.value, retainFrom);
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

function viewId(view: View): string {
    return `${view.surface.value}@${view.revision.value}`;
}
