// @ts-nocheck
import type { ProfileRuntimeEffectsPort, ProfileRuntimeHostBinding } from "../facets";
import { ProtectedProfileRuntimePort } from "../facets";
import { InvocationProtectedOperationPort, type Receipt } from "../invocations";

export function createProtectedProfileRuntime(
    host: ProfileRuntimeHostBinding,
    operations: InvocationProtectedOperationPort,
    effects: ProfileRuntimeEffectsPort<Receipt>
): ProtectedProfileRuntimePort<Receipt> {
    return new ProtectedProfileRuntimePort(host, operations, effects);
}
