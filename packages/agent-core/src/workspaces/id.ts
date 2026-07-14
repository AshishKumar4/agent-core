import { TextId } from "../core";

export class ActionId extends TextId {
    public constructor(value: string) {
        if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
            throw new TypeError("Action ID must be a nonblank canonical string");
        }
        super(value, "Action ID");
        Object.freeze(this);
    }
}

export class ContentRetentionId extends TextId {
    public constructor(value: string) {
        super(value, "Content retention ID");
        Object.freeze(this);
    }
}

export class EventCursor extends TextId {
    public constructor(value: string) {
        super(value, "Event cursor");
        Object.freeze(this);
    }
}

export class InboxReferenceId extends TextId {
    public constructor(value: string) {
        super(value, "Inbox reference ID");
        Object.freeze(this);
    }
}

export class RetainedRecordRef extends TextId {
    public constructor(value: string) {
        super(value, "Retained record reference");
        Object.freeze(this);
    }
}
