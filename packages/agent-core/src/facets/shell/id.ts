import { TextId } from "../../core";

export class ShellExecutionId extends TextId {
    public constructor(value: string) {
        super(value, "Shell execution ID");
        if (value.trim() !== value) throw new TypeError("Shell execution ID must be canonical");
    }
}
