import type { AtLeastOnceQueueAdapter, QueueMessageBatchLike } from "./queue.js";

export interface CloudflareExecutionContextLike {
    waitUntil(promise: Promise<unknown>): void;
}

export interface AuthoritativeWorkerRouter<Environment> {
    fetch(
        request: Request,
        environment: Environment,
        context: CloudflareExecutionContextLike
    ): Response | Promise<Response>;
}

export interface CloudflareWorkerOptions<Environment, DeliveryId, QueuePayload> {
    readonly router: AuthoritativeWorkerRouter<Environment>;
    readonly queue: AtLeastOnceQueueAdapter<DeliveryId, QueuePayload>;
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
            await options.queue.handle(batch);
        }
    });
}
