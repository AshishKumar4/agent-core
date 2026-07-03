import type { ProtectionDomain, Surface } from "../facets";
import type { ContentRef } from "../record";

export type SlateAppDataMode = "none" | "isolated" | "workspace";

export type SlateAppDataExportMode = "none" | "schema" | "snapshot";

export class SlateAppDataBoundary {
    public constructor(
        public readonly mode: SlateAppDataMode,
        public readonly schemaRef: ContentRef | undefined,
        public readonly exportMode: SlateAppDataExportMode
    ) {
        if (mode === "none") {
            if (schemaRef !== undefined || exportMode !== "none") {
                throw new TypeError("Slate app data without persistence cannot declare schema or export data");
            }
        } else if (schemaRef === undefined) {
            throw new TypeError("Persistent Slate app data must declare a schema reference");
        }
    }

    public get persistsRuntimeData(): boolean {
        return this.mode !== "none";
    }

    public get exportsRuntimeData(): boolean {
        return this.exportMode === "snapshot";
    }
}

export class SlateProtectionDomains {
    public constructor(
        public readonly frontend: ProtectionDomain,
        public readonly backend: ProtectionDomain
    ) {
        if (frontend.kind !== "frontend") {
            throw new TypeError("Slate frontend domain must use a frontend protection domain");
        }

        if (backend.kind !== "backend") {
            throw new TypeError("Slate backend domain must use a backend protection domain");
        }
    }
}

export class SlateApplication {
    public constructor(
        public readonly surface: Surface,
        public readonly appDataBoundary: SlateAppDataBoundary,
        public readonly protectionDomains: SlateProtectionDomains
    ) {
    }
}
