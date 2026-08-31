import type { AtLeastOnceQueueAdapter, QueueBatchResult, QueueMessageBatchLike } from "./queue.js";

export interface CloudflareExecutionContextLike {
    waitUntil(promise: Promise<void>): void;
}

export interface AuthoritativeWorkerRouter<Environment> {
    fetch(
        request: Request,
        environment: Environment,
        context: CloudflareExecutionContextLike
    ): Response | Promise<Response>;
}

/**
 * Where one batch's non-acknowledged dispositions are reported. The adapter already maps a
 * cause per failed delivery and per poison message, and discarding them leaves a redelivery
 * loop diagnosable only from platform-side queue metrics. A sink is optional because the
 * disposition is decided before it runs and never by it: a sink that throws is swallowed,
 * because a failed report must not turn an acknowledged delivery into a retried one.
 */
export interface QueueBatchObserver<DeliveryId> {
    observe(result: QueueBatchResult<DeliveryId>): void;
}

export interface CloudflareWorkerOptions<Environment, DeliveryId, QueuePayload> {
    readonly router: AuthoritativeWorkerRouter<Environment>;
    readonly queue: AtLeastOnceQueueAdapter<DeliveryId, QueuePayload>;
    readonly observer?: QueueBatchObserver<DeliveryId>;
}

export interface CloudflareWorkerEntrypoint<Environment> {
    fetch(
        request: Request,
        environment: Environment,
        context: CloudflareExecutionContextLike
    ): Response | Promise<Response>;
    queue(
        batch: QueueMessageBatchLike,
        environment: Environment,
        context: CloudflareExecutionContextLike
    ): Promise<void>;
}

export function createCloudflareWorker<Environment, DeliveryId, QueuePayload>(
    options: CloudflareWorkerOptions<Environment, DeliveryId, QueuePayload>
): CloudflareWorkerEntrypoint<Environment> {
    return Object.freeze({
        fetch: (
            request: Request,
            environment: Environment,
            context: CloudflareExecutionContextLike
        ) => options.router.fetch(request, environment, context),
        queue: async (
            batch: QueueMessageBatchLike,
            _environment: Environment,
            _context: CloudflareExecutionContextLike
        ): Promise<void> => {
            const result = await options.queue.handle(batch);
            if (options.observer === undefined) return;
            if (result.failedDeliveries.length === 0 && result.poisonMessages.length === 0) {
                return;
            }
            try {
                options.observer.observe(result);
            } catch {
                // Every disposition was decided and applied before this call. Letting a
                // reporting failure escape would fail the batch handler and redeliver
                // messages the target already accepted.
            }
        }
    });
}
