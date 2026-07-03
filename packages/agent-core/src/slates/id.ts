import { TextId } from "../core";

export class SlateId extends TextId {
    public constructor(value: string) {
        super(value, "Slate ID");
    }
}

export class SlateVersionId extends TextId {
    public constructor(value: string) {
        super(value, "Slate version ID");
    }
}

export class SlateDocumentId extends TextId {
    public constructor(value: string) {
        super(value, "Slate document ID");
    }
}

export class SlateDeploymentId extends TextId {
    public constructor(value: string) {
        super(value, "Slate deployment ID");
    }
}

export class SlateBlueprintId extends TextId {
    public constructor(value: string) {
        super(value, "Slate blueprint ID");
    }
}
