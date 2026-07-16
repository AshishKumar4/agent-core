// @ts-nocheck
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

export class SlatePublicationId extends TextId {
    public constructor(value: string) {
        super(value, "Slate publication ID");
    }
}

export class SlateDeploymentId extends TextId {
    public constructor(value: string) {
        super(value, "Slate deployment ID");
    }
}

export class SlateResourceId extends TextId {
    public constructor(value: string) {
        super(value, "Slate resource ID");
    }
}

export class SlatePreviewId extends TextId {
    public constructor(value: string) {
        super(value, "Slate preview ID");
    }
}
