import {
    AgentCoreError,
    hasExactJsonKeys,
    isJsonObject,
    isJsonValue,
    type JsonFields,
    type JsonValue
} from "@agent-core/core";
import type { CloudflareErrorPort } from "./error.js";
import { operationalError, operationalFailure } from "./error.js";
import { QueueMessageId } from "./id.js";
import { isFiniteNumber } from "./platform-value.js";

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

export interface AuthoritativeQueueDelivery<DeliveryId, Payload = JsonValue> {
    readonly deliveryId: DeliveryId;
    readonly payload: Payload;
}

export interface QueueValueCodec<Value> {
    decode(value: JsonValue): Value;
}

export interface QueueDeliveryCodecs<DeliveryId, Payload> {
    readonly deliveryId: QueueValueCodec<DeliveryId>;
    readonly payload: QueueValueCodec<Payload>;
}

export interface QueueTargetResult {
    readonly disposition: "ack" | "retry";
    readonly retryDelaySeconds?: number;
}

export interface AuthoritativeQueueTarget<DeliveryId, Payload = JsonValue> {
    deliver(deliveryId: DeliveryId, payload: Payload): Promise<QueueTargetResult>;
}

/** A message whose body carries no decodable delivery, kept with the decoding cause. */
export interface PoisonQueueMessage {
    readonly messageId: QueueMessageId;
    readonly cause: AgentCoreError;
}

/** One delivery the target could not take, kept with the cause that retried it. */
export interface QueueDeliveryFailure<DeliveryId> {
    readonly deliveryId: DeliveryId;
    readonly cause: AgentCoreError;
}

export interface QueueBatchResult<DeliveryId> {
    readonly acknowledgedDeliveryIds: readonly DeliveryId[];
    readonly retriedDeliveryIds: readonly DeliveryId[];
    readonly poisonMessages: readonly PoisonQueueMessage[];
    readonly failedDeliveries: readonly QueueDeliveryFailure<DeliveryId>[];
}

export class AtLeastOnceQueueAdapter<DeliveryId, Payload = JsonValue> {
    public constructor(
        private readonly target: AuthoritativeQueueTarget<DeliveryId, Payload>,
        private readonly codecs: QueueDeliveryCodecs<DeliveryId, Payload>,
        private readonly errors: CloudflareErrorPort
    ) {}

    public async handle(batch: QueueMessageBatchLike): Promise<QueueBatchResult<DeliveryId>> {
        const acknowledgedDeliveryIds: DeliveryId[] = [];
        const retriedDeliveryIds: DeliveryId[] = [];
        const poisonMessages: PoisonQueueMessage[] = [];
        const failedDeliveries: QueueDeliveryFailure<DeliveryId>[] = [];
        for (const message of batch.messages) {
            const delivery = isJsonValue(message.body)
                ? decodeDelivery(message.body, this.codecs, this.errors)
                : invalidDelivery(this.errors);
            if (delivery instanceof AgentCoreError) {
                // An undecodable body never becomes deliverable, but acknowledging it here
                // would destroy it: retrying hands it to the queue's own dead-letter policy
                // while the rest of the batch keeps its own dispositions.
                const messageId = requireMessageId(message.id, this.errors);
                this.dispose(`message ${messageId}`, () => message.retry());
                poisonMessages.push(Object.freeze({ messageId, cause: delivery }));
                continue;
            }
            const label = `delivery ${String(delivery.deliveryId)}`;
            let result: QueueTargetResult;
            try {
                result = await this.target.deliver(delivery.deliveryId, delivery.payload);
            } catch (failure) {
                // A target that threw has not declined: it errored, and the delivery is
                // still owed. Retrying just this message and carrying its cause is what
                // leaves the rest of the batch its own dispositions, which failing the
                // whole handler here did not — every later message went undispositioned.
                this.dispose(label, () => message.retry());
                failedDeliveries.push(
                    Object.freeze({
                        deliveryId: delivery.deliveryId,
                        cause: operationalError(
                            this.errors,
                            "protocol.invalid-state",
                            `Authoritative queue target failed for ${label}`,
                            { value: failure }
                        )
                    })
                );
                continue;
            }
            const disposition = decodeResult(result, this.errors);
            if (disposition.disposition === "ack") {
                this.dispose(label, () => message.ack());
                acknowledgedDeliveryIds.push(delivery.deliveryId);
            } else {
                const options =
                    disposition.retryDelaySeconds === undefined
                        ? undefined
                        : { delaySeconds: disposition.retryDelaySeconds };
                this.dispose(label, () => message.retry(options));
                retriedDeliveryIds.push(delivery.deliveryId);
            }
        }
        return Object.freeze({
            acknowledgedDeliveryIds: Object.freeze(acknowledgedDeliveryIds),
            retriedDeliveryIds: Object.freeze(retriedDeliveryIds),
            poisonMessages: Object.freeze(poisonMessages),
            failedDeliveries: Object.freeze(failedDeliveries)
        });
    }

    private dispose(label: string, disposition: () => void): void {
        try {
            disposition();
        } catch (cause) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                `Cloudflare queue disposition failed for ${label}`,
                { value: cause }
            );
        }
    }
}

/** Returns the decoding failure rather than raising it: one poison body is not a batch failure. */
function decodeDelivery<DeliveryId, Payload>(
    value: JsonValue,
    codecs: QueueDeliveryCodecs<DeliveryId, Payload>,
    errors: CloudflareErrorPort
): AuthoritativeQueueDelivery<DeliveryId, Payload> | AgentCoreError {
    const fields = readDeliveryFields(value);
    if (fields === undefined) {
        return invalidDelivery(errors);
    }
    try {
        return Object.freeze({
            deliveryId: codecs.deliveryId.decode(fields.deliveryId),
            payload: codecs.payload.decode(fields.payload)
        });
    } catch (cause) {
        return operationalError(
            errors,
            "operation.invalid-input",
            "Queue body contains an invalid authoritative delivery identity or payload",
            { value: cause }
        );
    }
}

function invalidDelivery(errors: CloudflareErrorPort): AgentCoreError {
    return operationalError(
        errors,
        "operation.invalid-input",
        "Queue body must contain an authoritative delivery ID and payload"
    );
}

function requireMessageId(value: string, errors: CloudflareErrorPort): QueueMessageId {
    if (!isQueueMessageId(value)) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "Queue message carries no usable message ID"
        );
    }
    return new QueueMessageId(value);
}

function decodeResult(value: QueueTargetResult, errors: CloudflareErrorPort): QueueTargetResult {
    if (value.disposition !== "ack" && value.disposition !== "retry") {
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
    if (retryDelaySeconds === undefined) {
        return Object.freeze({ disposition: value.disposition });
    }
    return Object.freeze({ disposition: value.disposition, retryDelaySeconds });
}

function requireRetryDelay(
    value: number | undefined,
    errors: CloudflareErrorPort
): number | undefined {
    if (value === undefined) return undefined;
    if (!isFiniteNumber(value) || !Number.isSafeInteger(value) || value <= 0) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "Queue retry delay must be a positive safe integer"
        );
    }
    return value;
}

function isQueueMessageId(value: unknown): value is string {
    return typeof value === "string" && value.length !== 0;
}

function readDeliveryFields(value: JsonValue): JsonFields<"deliveryId" | "payload"> | undefined {
    if (!isJsonObject(value) || !hasExactJsonKeys(value, ["deliveryId", "payload"])) {
        return undefined;
    }
    return value;
}
