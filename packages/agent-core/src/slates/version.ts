import type { ContentRef } from "../record";
import type { SlateApplication } from "./application";
import type { SlateDocumentId, SlateId, SlateVersionId } from "./id";
import { requireSlateSchemaVersion } from "./schema";

export class SlateVersion {
    public constructor(
        public readonly id: SlateVersionId,
        public readonly slateId: SlateId,
        public readonly documentId: SlateDocumentId,
        public readonly sourceRef: ContentRef,
        public readonly schemaVersion: string,
        public readonly application: SlateApplication
    ) {
        requireSlateSchemaVersion(schemaVersion, "Slate version schema version");
    }
}
