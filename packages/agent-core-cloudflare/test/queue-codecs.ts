import { RouteReservationId, jsonDataParser } from "@agent-core/core";
import type { JsonValue } from "@agent-core/core";
import type { QueueDeliveryCodecs } from "../src/index.js";

const queueData = jsonDataParser((message) => new TypeError(message));

/**
 * A queue body is JSON the platform delivered, so the payload codec decodes it to the
 * one type that says so rather than handing `unknown` on to the target. The tests put
 * different documents in it; what they share is that it is JSON at all.
 */
export const queueCodecs: QueueDeliveryCodecs<RouteReservationId, JsonValue> = Object.freeze({
    deliveryId: Object.freeze({
        decode(value: JsonValue): RouteReservationId {
            return new RouteReservationId(queueData.string(value, "Delivery ID"));
        }
    }),
    payload: Object.freeze({
        decode(value: JsonValue): JsonValue {
            return value;
        }
    })
});
