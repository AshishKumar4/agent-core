import { RouteReservationId, isJsonValue } from "@agent-core/core";
import type { JsonValue } from "@agent-core/core";
import type { QueueDeliveryCodecs } from "../src/index.js";

/**
 * A queue body is JSON the platform delivered, so the payload codec decodes it to the
 * one type that says so rather than handing `unknown` on to the target. The tests put
 * different documents in it; what they share is that it is JSON at all.
 */
export const queueCodecs: QueueDeliveryCodecs<RouteReservationId, JsonValue> = Object.freeze({
    deliveryId: Object.freeze({
        decode(value: unknown): RouteReservationId {
            if (typeof value !== "string") throw new TypeError("Delivery ID must be a string");
            return new RouteReservationId(value);
        }
    }),
    payload: Object.freeze({
        decode(value: unknown): JsonValue {
            if (!isJsonValue(value)) throw new TypeError("Queue payload must be JSON");
            return value;
        }
    })
});
