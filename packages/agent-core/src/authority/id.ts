import { TextId } from "../core";

export class GrantId extends TextId {
    public constructor(value: string) {
        super(value, "Grant ID");
    }
}

export class BindingId extends TextId {
    public constructor(value: string) {
        super(value, "Binding ID");
    }
}
