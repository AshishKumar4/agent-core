import { AtLeastOnceQueueAdapter, QueueMessageId } from "../src/index.js";
import { RouteReservationId } from "@agent-core/core";
import { FakeQueueMessage, fakeErrors } from "./fakes.js";
import { queueCodecs } from "./queue-codecs.js";

describe("AtLeastOnceQueueAdapter", () => {
    test("uses authoritative delivery IDs and applies per-message target results", async () => {
        const calls: RouteReservationId[] = [];
        const adapter = new AtLeastOnceQueueAdapter(
            {
                deliver: async (deliveryId: RouteReservationId) => {
                    calls.push(deliveryId);
                    return deliveryId.value === "delivery-1"
                        ? { disposition: "ack" as const }
                        : { disposition: "retry" as const, retryDelaySeconds: 7 };
                }
            },
            queueCodecs,
            fakeErrors
        );
        const first = new FakeQueueMessage("platform-a", {
            deliveryId: "delivery-1",
            payload: { value: 1 }
        });
        const second = new FakeQueueMessage("platform-b", {
            deliveryId: "delivery-2",
            payload: { value: 2 }
        });

        expect(await adapter.handle({ messages: [first, second] })).toEqual({
            acknowledgedDeliveryIds: [new RouteReservationId("delivery-1")],
            retriedDeliveryIds: [new RouteReservationId("delivery-2")],
            poisonMessages: []
        });
        expect(calls).toEqual([
            new RouteReservationId("delivery-1"),
            new RouteReservationId("delivery-2")
        ]);
        expect(first.acknowledgements).toBe(1);
        expect(second.retries).toEqual([{ delaySeconds: 7 }]);
    });

    test("does not ack or retry before an injected target result", async () => {
        const message = new FakeQueueMessage("platform", {
            deliveryId: "delivery",
            payload: null
        });
        const adapter = new AtLeastOnceQueueAdapter(
            {
                deliver: async () => {
                    throw new TypeError("target unavailable");
                }
            },
            queueCodecs,
            fakeErrors
        );
        await expect(adapter.handle({ messages: [message] })).rejects.toMatchObject({
            code: "protocol.invalid-state"
        });
        expect(message.acknowledgements).toBe(0);
        expect(message.retries).toEqual([]);
    });

    test(
        "retries only the undecodable message and delivers the rest of the batch",
        { tags: "p1" },
        async () => {
            const poison = new FakeQueueMessage("platform-poison", {
                deliveryId: "",
                payload: null
            });
            const healthy = new FakeQueueMessage("platform-ok", {
                deliveryId: "delivery",
                payload: null
            });
            const adapter = new AtLeastOnceQueueAdapter(
                { deliver: async () => ({ disposition: "ack" as const }) },
                queueCodecs,
                fakeErrors
            );

            const result = await adapter.handle({ messages: [poison, healthy] });
            expect(result.acknowledgedDeliveryIds).toEqual([new RouteReservationId("delivery")]);
            expect(result.poisonMessages.map((message) => message.messageId)).toEqual([
                new QueueMessageId("platform-poison")
            ]);
            expect(result.poisonMessages[0]?.cause).toMatchObject({
                code: "operation.invalid-input"
            });
            // The batch is never failed as a whole, so the healthy message keeps its ack.
            expect(poison.retries).toEqual([undefined]);
            expect(poison.acknowledgements).toBe(0);
            expect(healthy.acknowledgements).toBe(1);
        }
    );

    test("rejects a non-JSON platform body without invoking the target", async () => {
        let deliveries = 0;
        const poison = new FakeQueueMessage("platform-non-json", Symbol("non-json"));
        const adapter = new AtLeastOnceQueueAdapter(
            {
                deliver: async () => {
                    deliveries += 1;
                    return { disposition: "ack" as const };
                }
            },
            queueCodecs,
            fakeErrors
        );

        const result = await adapter.handle({ messages: [poison] });

        expect(deliveries).toBe(0);
        expect(result.acknowledgedDeliveryIds).toEqual([]);
        expect(result.poisonMessages).toMatchObject([
            {
                messageId: new QueueMessageId("platform-non-json"),
                cause: { code: "operation.invalid-input" }
            }
        ]);
        expect(poison.retries).toEqual([undefined]);
    });

    test("maps invalid target output to exact codes", async () => {
        const adapter = new AtLeastOnceQueueAdapter(
            {
                deliver: async () => ({ disposition: "ack" as const, retryDelaySeconds: 1 })
            },
            queueCodecs,
            fakeErrors
        );
        await expect(
            adapter.handle({
                messages: [new FakeQueueMessage("platform", { deliveryId: "valid", payload: null })]
            })
        ).rejects.toMatchObject({ code: "operation.invalid-output" });
    });
});
