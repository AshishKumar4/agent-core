import type { ContentRef } from "../record";
import type { SlateBlueprintId, SlateVersionId } from "./id";

export type SlateBlueprintExportRequirement =
    | "source-document"
    | "surface-contract"
    | "app-data-schema"
    | "protection-domains";

export class SlateBlueprintExport {
    public readonly requirements: readonly SlateBlueprintExportRequirement[];

    public constructor(requirements: readonly SlateBlueprintExportRequirement[]) {
        this.requirements = Object.freeze([...requirements]);

        if (requirements.length === 0) {
            throw new TypeError("Slate blueprint export must require at least one artifact");
        }

        if (new Set(requirements).size !== requirements.length) {
            throw new TypeError("Slate blueprint export requirements must be unique");
        }
    }

    public static template(): SlateBlueprintExport {
        return new SlateBlueprintExport([
            "source-document",
            "surface-contract",
            "app-data-schema",
            "protection-domains"
        ]);
    }

    public requires(requirement: SlateBlueprintExportRequirement): boolean {
        return this.requirements.includes(requirement);
    }

    public get includesRuntimeAppData(): boolean {
        return false;
    }
}

export class SlateBlueprint {
    public constructor(
        public readonly id: SlateBlueprintId,
        public readonly sourceVersionId: SlateVersionId,
        public readonly manifestRef: ContentRef,
        public readonly exportRequirements: SlateBlueprintExport
    ) {
    }
}
