import type { ContentRef } from "../record";
import type { SlateApplication } from "./application";
import type { SlateDocumentId, SlateId } from "./id";
import { requireSlateSchemaVersion } from "./schema";

export class SlateDocument {
    public constructor(
        public readonly id: SlateDocumentId,
        public readonly slateId: SlateId,
        public readonly sourceRef: ContentRef,
        public readonly schemaVersion: string,
        public readonly application: SlateApplication
    ) {
        requireSlateSchemaVersion(schemaVersion, "Slate document schema version");
    }
}
