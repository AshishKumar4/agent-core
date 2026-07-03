import type { ObservationContext } from "./context";

export abstract class FieldValue {
    protected constructor(public readonly value: string | number | boolean) {
    }
}

export class TextField extends FieldValue {
    public constructor(value: string) {
        super(value);
    }
}

export class NumberField extends FieldValue {
    public constructor(value: number) {
        if (!Number.isFinite(value)) {
            throw new TypeError("Observed numbers must be finite");
        }

        super(value);
    }
}

export class BooleanField extends FieldValue {
    public constructor(value: boolean) {
        super(value);
    }
}

export class Field {
    public constructor(
        public readonly name: string,
        public readonly value: FieldValue
    ) {
        if (name.length === 0) {
            throw new TypeError("Observed field names must not be empty");
        }
    }
}

export type SpanOutcomeKind = "succeeded" | "failed";

export class ObservedOperation {
    public readonly fields: readonly Field[];

    public constructor(
        public readonly name: string,
        fields: readonly Field[]
    ) {
        if (name.length === 0) {
            throw new TypeError("Observed operation names must not be empty");
        }

        this.fields = Object.freeze([...fields]);
    }
}

export abstract class SpanOutcome {
    public static succeeded(): SpanOutcome {
        return succeeded;
    }

    public static failed(code: string): SpanOutcome {
        return new FailedOutcome(code);
    }

    protected constructor(public readonly kind: SpanOutcomeKind) {
    }
}

class SucceededOutcome extends SpanOutcome {
    public constructor() {
        super("succeeded");
    }
}

class FailedOutcome extends SpanOutcome {
    public constructor(public readonly code: string) {
        super("failed");
    }
}

const succeeded = new SucceededOutcome();

export abstract class Span {
    public abstract event(event: ObservedOperation): void;

    public abstract end(outcome: SpanOutcome): void;
}

export abstract class Telemetry {
    public abstract start(
        context: ObservationContext,
        operation: ObservedOperation
    ): Span;
}
