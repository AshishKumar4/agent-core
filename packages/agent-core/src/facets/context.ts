import type { OperationContext } from "../operations/context";
import type { Telemetry } from "../observability/telemetry";
import type { BindingName, FacetId } from "./id";

export class FacetContext {
    public constructor(
        public readonly id: FacetId,
        public readonly name: BindingName,
        public readonly operation: OperationContext,
        public readonly telemetry: Telemetry
    ) {
    }
}
