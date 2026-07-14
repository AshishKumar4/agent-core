import { RouteReservationId } from "@agent-core/core";
import type { QueueDeliveryCodecs } from "../src/index.js";

export const queueCodecs: QueueDeliveryCodecs<RouteReservationId, unknown> = Object.freeze({
    deliveryId: Object.freeze({
        decode(value: unknown): RouteReservationId {
            if (typeof value !== "string") throw new TypeError("Delivery ID must be a string");
            return new RouteReservationId(value);
        }
    }),
    payload: Object.freeze({ decode: (value: unknown): unknown => value })
});
