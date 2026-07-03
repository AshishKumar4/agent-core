import type { OperationContext } from "../operations/context";
import type { Field } from "./telemetry";

export type ObservedEventCategory =
    | "surface"
    | "message"
    | "schedule"
    | "webhook"
    | "platform"
    | "provider"
    | "sandbox"
    | "operation"
    | "state";

export class ObservedEvent {
    public readonly fields: readonly Field[];

    public constructor(
        public readonly category: ObservedEventCategory,
        fields: readonly Field[]
    ) {
        this.fields = Object.freeze([...fields]);
    }
}

export abstract class EventStream {
    public abstract emit(context: OperationContext, event: ObservedEvent): void;
}
