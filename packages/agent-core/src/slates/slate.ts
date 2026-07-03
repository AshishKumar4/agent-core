import type { TenantId } from "../identity";
import type { Revision } from "../record";
import type { WorkspaceId } from "../workspaces";
import type { SlateDocumentId, SlateId, SlateVersionId } from "./id";
import type { SlateVersion } from "./version";

export type SlateStatus = "active" | "archived" | "deleted";

export type SlateForkAppDataMode = "empty" | "copy" | "share";

export class SlateFork {
    public constructor(
        public readonly sourceSlateId: SlateId,
        public readonly sourceVersionId: SlateVersionId,
        public readonly appDataMode: SlateForkAppDataMode,
        public readonly sourceRevision: Revision
    ) {
    }
}

export class Slate {
    public constructor(
        public readonly id: SlateId,
        public readonly workspaceId: WorkspaceId,
        public readonly tenantId: TenantId,
        public readonly status: SlateStatus,
        public readonly workingDocumentId: SlateDocumentId,
        public readonly workingRevision: Revision,
        public readonly activeVersionId: SlateVersionId | undefined,
        public readonly forkedFrom: SlateFork | undefined,
        public readonly revision: Revision
    ) {
    }

    public get canPublish(): boolean {
        return this.status === "active";
    }

    public get canFork(): boolean {
        return this.status === "active" && this.activeVersionId !== undefined;
    }

    public publish(version: SlateVersion): Slate {
        if (!this.canPublish) {
            throw new TypeError("Only active Slates can be published");
        }

        if (!version.slateId.equals(this.id)) {
            throw new TypeError("Slate cannot publish a version from another Slate");
        }

        return new Slate(
            this.id,
            this.workspaceId,
            this.tenantId,
            this.status,
            this.workingDocumentId,
            this.workingRevision,
            version.id,
            this.forkedFrom,
            this.revision.next()
        );
    }

    public fork(
        id: SlateId,
        workspaceId: WorkspaceId,
        workingDocumentId: SlateDocumentId,
        workingRevision: Revision,
        revision: Revision,
        appDataMode: SlateForkAppDataMode
    ): Slate {
        const sourceVersionId = this.activeVersionId;

        if (this.status !== "active" || sourceVersionId === undefined) {
            throw new TypeError("Only active Slates with a published version can be forked");
        }

        return new Slate(
            id,
            workspaceId,
            this.tenantId,
            "active",
            workingDocumentId,
            workingRevision,
            undefined,
            new SlateFork(this.id, sourceVersionId, appDataMode, this.revision),
            revision
        );
    }
}
