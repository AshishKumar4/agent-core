import { TextId } from "../../core";

export class TaskId extends TextId {
    public constructor(value: string) {
        super(value, "Task ID");
        Object.freeze(this);
    }
}
