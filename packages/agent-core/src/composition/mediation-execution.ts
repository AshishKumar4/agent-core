import type { ContentStore } from "../content";
import type { OperationContext } from "../facets";
import type { OperationPayloadShape, OperationRequestKey } from "../operations";
import type { DirectOperationContextPort } from "../invocations";
import type { DerivedMediationIdentities } from "./mediation-identity";

export interface OperationExecutionResources {
    readonly signal: AbortSignal;
    readonly content: ContentStore;
}

/**
 * The direct tier's OperationContext (§7.2). A direct Invocation creates no durable
 * Invocation, Receipt, or replay record, so it carries no EffectAttempt and no target
 * admission — asserting that here is what keeps a direct dispatch from presenting itself
 * as mediated evidence. Its Invocation and item identities are derived from the request
 * key so a repeated direct dispatch names the same call.
 */
export class DerivedDirectOperationContext<Authorization> implements DirectOperationContextPort<
    Authorization
> {
    public constructor(
        private readonly identities: DerivedMediationIdentities,
        private readonly resources: (
            authorization: Authorization,
            itemIndex: number
        ) => OperationExecutionResources
    ) {}

    public context(
        requestKey: OperationRequestKey,
        itemIndex: number,
        shape: OperationPayloadShape,
        authorization: Authorization
    ): OperationContext {
        requireItemIndex(shape, itemIndex);
        const invocation = this.identities.directInvocation(requestKey.value);
        const execution = this.resources(authorization, itemIndex);
        return Object.freeze({
            invocation,
            itemIndex,
            idempotencyKey: this.identities.directItemKey(invocation, itemIndex),
            signal: execution.signal,
            content: execution.content
        });
    }
}

function requireItemIndex(shape: OperationPayloadShape, itemIndex: number): void {
    const itemCount = shape.kind === "single" ? 1 : shape.itemCount;
    if (!Number.isSafeInteger(itemIndex) || itemIndex < 0 || itemIndex >= itemCount) {
        throw new TypeError("Operation item index is outside its payload shape");
    }
}
