import { TextId } from "../core";

export class WorkspaceId extends TextId {
    public constructor(value: string) {
        super(value, "Workspace ID");
    }
}

export class TaskId extends TextId {
    public constructor(value: string) {
        super(value, "Task ID");
    }
}

export class EventId extends TextId {
    public constructor(value: string) {
        super(value, "Event ID");
    }
}

export class SubscriptionId extends TextId {
    public constructor(value: string) {
        super(value, "Subscription ID");
    }
}
