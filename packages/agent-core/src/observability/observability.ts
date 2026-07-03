import type { ObservationContext } from "./context";
import type { AuditLog } from "./audit";
import type { EventStream } from "./events";
import type { ObservedOperation, Span, Telemetry } from "./telemetry";

export class Observability {
    public constructor(
        public readonly observation: ObservationContext,
        public readonly telemetry: Telemetry,
        public readonly auditLog: AuditLog,
        public readonly eventStream: EventStream
    ) {
    }

    public start(operation: ObservedOperation): Span {
        return this.telemetry.start(this.observation, operation);
    }
}
