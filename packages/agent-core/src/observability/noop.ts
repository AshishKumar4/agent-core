import type { ObservationContext } from "./context";
import type { OperationContext } from "../operations/context";
import { AuditLog } from "./audit";
import type { AuditRecord } from "./audit";
import { EventStream } from "./events";
import type { ObservedEvent } from "./events";
import { Observability } from "./observability";
import {
    ObservedOperation,
    Span,
    SpanOutcome,
    Telemetry
} from "./telemetry";

class NoopSpan extends Span {
    public event(_event: ObservedOperation): void {
    }

    public end(_outcome: SpanOutcome): void {
    }
}

const span = new NoopSpan();

export class NoopTelemetry extends Telemetry {
    public start(
        _context: ObservationContext,
        _operation: ObservedOperation
    ): Span {
        return span;
    }
}

export class NoopAuditLog extends AuditLog {
    public append(_context: OperationContext, _record: AuditRecord): void {
    }
}

export class NoopEventStream extends EventStream {
    public emit(_context: OperationContext, _event: ObservedEvent): void {
    }
}

const telemetry = new NoopTelemetry();
const auditLog = new NoopAuditLog();
const eventStream = new NoopEventStream();

export class NoopObservability extends Observability {
    public constructor(observation: ObservationContext) {
        super(observation, telemetry, auditLog, eventStream);
    }
}
