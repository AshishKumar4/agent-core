// @ts-nocheck
import { TextId } from "../core";

export class EventId extends TextId {
    public constructor(value: string) {
        super(value, "Event ID");
        Object.freeze(this);
    }
}

export class SubscriptionId extends TextId {
    public constructor(value: string) {
        super(value, "Subscription ID");
        Object.freeze(this);
    }
}

export class InvocationId extends TextId {
    public constructor(value: string) {
        super(value, "Invocation ID");
        Object.freeze(this);
    }
}

export class CorrelationId extends TextId {
    public constructor(value: string) {
        super(value, "Correlation ID");
        Object.freeze(this);
    }
}

export class RouteReservationId extends TextId {
    public constructor(value: string) {
        super(value, "Route reservation ID");
        Object.freeze(this);
    }
}

export class RouteProjectionId extends TextId {
    public constructor(value: string) {
        super(value, "Route projection ID");
        Object.freeze(this);
    }
}

export class AuditRecordId extends TextId {
    public constructor(value: string) {
        super(value, "Audit record ID");
        Object.freeze(this);
    }
}
