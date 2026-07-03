import { TextId } from "../core";

export class OperationId extends TextId {
    public constructor(value: string) {
        super(value, "Operation ID");
    }

    protected get type(): "operation" {
        return "operation";
    }
}
