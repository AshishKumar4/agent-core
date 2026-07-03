import { TextId } from "../core";

export class TraceId extends TextId {
    public constructor(value: string) {
        super(value, "Trace ID");
    }

    protected get type(): "trace" {
        return "trace";
    }
}

export class SpanId extends TextId {
    public constructor(value: string) {
        super(value, "Span ID");
    }

    protected get type(): "span" {
        return "span";
    }
}

export class ObservationContext {
    public constructor(
        public readonly trace: TraceId,
        public readonly span: SpanId,
        public readonly parent: SpanId | null
    ) {
    }

    public static root(trace: string, span: string): ObservationContext {
        return new ObservationContext(
            new TraceId(trace),
            new SpanId(span),
            null
        );
    }

    public child(span: SpanId): ObservationContext {
        return new ObservationContext(this.trace, span, this.span);
    }
}
