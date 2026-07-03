import type { OperationContext } from "../operations";
import { SubscriptionInvocation } from "../workspaces/events";
import type { EventRecord, EventPayload, Subscription, SubscriptionInvoker } from "../workspaces/events";
import type { Invocation } from "./invocation";
import { InvocationPipeline } from "./pipeline";

export interface SubscriptionInvocationFactory {
    create(
        context: OperationContext,
        subscription: Subscription,
        event: EventRecord,
        input: EventPayload
    ): Invocation;
}

export class PipelineSubscriptionInvoker implements SubscriptionInvoker {
    public constructor(
        private readonly pipeline: InvocationPipeline,
        private readonly factory: SubscriptionInvocationFactory
    ) {
    }

    public async invoke(
        context: OperationContext,
        subscription: Subscription,
        event: EventRecord,
        input: EventPayload
    ): Promise<SubscriptionInvocation> {
        const result = await this.pipeline.invoke(
            context,
            this.factory.create(context, subscription, event, input),
            input
        );

        switch (result.kind) {
            case "completed":
                return new SubscriptionInvocation(subscription, event, result.invocation, result.receipt, result.output);
            case "denied":
            case "cancelled":
            case "failed":
                return new SubscriptionInvocation(subscription, event, result.invocation, result.receipt, undefined);
            case "approval-required":
                return new SubscriptionInvocation(subscription, event, result.invocation, undefined, undefined);
        }
    }
}
