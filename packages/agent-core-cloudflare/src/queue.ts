import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";

export interface QueueRetryOptionsLike {
    readonly delaySeconds?: number;
}

export interface QueueMessageLike<Body = unknown> {
    readonly id: string;
    readonly body: Body;
    ack(): void;
    retry(options?: QueueRetryOptionsLike): void;
}

export interface QueueMessageBatchLike<Body = unknown> {
    readonly messages: readonly QueueMessageLike<Body>[];
}

export interface AuthoritativeQueueDelivery<DeliveryId, Payload = unknown> {
    readonly deliveryId: DeliveryId;
    readonly payload: Payload;
}

export interface QueueValueCodec<Value> {
    decode(value: unknown): Value;
}

export interface QueueDeliveryCodecs<DeliveryId, Payload> {
    readonly deliveryId: QueueValueCodec<DeliveryId>;
    readonly payload: QueueValueCodec<Payload>;
}

export interface QueueTargetResult {
    readonly disposition: "ack" | "retry";
    readonly retryDelaySeconds?: number;
}

export interface AuthoritativeQueueTarget<DeliveryId, Payload = unknown> {
    deliver(deliveryId: DeliveryId, payload: Payload): Promise<QueueTargetResult>;
}

export interface QueueBatchResult<DeliveryId> {
    readonly acknowledgedDeliveryIds: readonly DeliveryId[];
    readonly retriedDeliveryIds: readonly DeliveryId[];
}

export class AtLeastOnceQueueAdapter<DeliveryId, Payload = unknown> {
    public constructor(
        private readonly target: AuthoritativeQueueTarget<DeliveryId, Payload>,
        private readonly codecs: QueueDeliveryCodecs<DeliveryId, Payload>,
        private readonly errors: CloudflareErrorPort
    ) {}

    public async handle(batch: QueueMessageBatchLike): Promise<QueueBatchResult<DeliveryId>> {
        const acknowledgedDeliveryIds: DeliveryId[] = [];
        const retriedDeliveryIds: DeliveryId[] = [];
        for (const message of batch.messages) {
            const delivery = decodeDelivery(message.body, this.codecs, this.errors);
            let result: QueueTargetResult;
            try {
                result = await this.target.deliver(delivery.deliveryId, delivery.payload);
            } catch (cause) {
                operationalFailure(
                    this.errors,
                    "protocol.invalid-state",
                    `Authoritative queue target failed for delivery ${String(delivery.deliveryId)}`,
                    cause
                );
            }
            const disposition = decodeResult(result, this.errors);
            try {
                if (disposition.disposition === "ack") {
                    message.ack();
                    acknowledgedDeliveryIds.push(delivery.deliveryId);
                } else {
                    const options =
                        disposition.retryDelaySeconds === undefined
                            ? undefined
                            : { delaySeconds: disposition.retryDelaySeconds };
                    message.retry(options);
                    retriedDeliveryIds.push(delivery.deliveryId);
                }
            } catch (cause) {
                operationalFailure(
                    this.errors,
                    "protocol.invalid-state",
                    `Cloudflare queue disposition failed for delivery ${String(delivery.deliveryId)}`,
                    cause
                );
            }
        }
        return Object.freeze({
            acknowledgedDeliveryIds: Object.freeze(acknowledgedDeliveryIds),
            retriedDeliveryIds: Object.freeze(retriedDeliveryIds)
        });
    }
}

function decodeDelivery<DeliveryId, Payload>(
    value: unknown,
    codecs: QueueDeliveryCodecs<DeliveryId, Payload>,
    errors: CloudflareErrorPort
): AuthoritativeQueueDelivery<DeliveryId, Payload> {
    const fields = readDeliveryFields(value);
    if (fields === undefined) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "Queue body must contain an authoritative delivery ID and payload"
        );
    }
    try {
        return Object.freeze({
            deliveryId: codecs.deliveryId.decode(fields.deliveryId),
            payload: codecs.payload.decode(fields.payload)
        });
    } catch (cause) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "Queue body contains an invalid authoritative delivery identity or payload",
            cause
        );
    }
}

function decodeResult(value: unknown, errors: CloudflareErrorPort): QueueTargetResult {
    if (!isRecord(value) || (value.disposition !== "ack" && value.disposition !== "retry")) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "Queue target returned an invalid disposition"
        );
    }
    const retryDelaySeconds = requireRetryDelay(value.retryDelaySeconds, errors);
    if (value.disposition === "ack" && retryDelaySeconds !== undefined) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "Acknowledged queue deliveries cannot specify a retry delay"
        );
    }
    return Object.freeze({
        disposition: value.disposition,
        ...(retryDelaySeconds === undefined ? {} : { retryDelaySeconds })
    });
}

function requireRetryDelay(value: unknown, errors: CloudflareErrorPort): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "Queue retry delay must be a positive safe integer"
        );
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    try {
        const actual = Reflect.ownKeys(value);
        return actual.length === keys.length && keys.every((key) => actual.includes(key));
    } catch {
        return false;
    }
}

function readDeliveryFields(
    value: unknown
): { readonly deliveryId: unknown; readonly payload: unknown } | undefined {
    if (!isRecord(value) || !hasExactKeys(value, ["deliveryId", "payload"])) return undefined;
    try {
        const deliveryId = Object.getOwnPropertyDescriptor(value, "deliveryId");
        const payload = Object.getOwnPropertyDescriptor(value, "payload");
        if (
            deliveryId === undefined ||
            payload === undefined ||
            !("value" in deliveryId) ||
            !("value" in payload)
        ) {
            return undefined;
        }
        return Object.freeze({ deliveryId: deliveryId.value, payload: payload.value });
    } catch {
        return undefined;
    }
}
