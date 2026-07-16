import { env } from "cloudflare:workers";
import {
    createExecutionContext,
    createMessageBatch,
    evictDurableObject,
    getQueueResult,
    runDurableObjectAlarm,
    runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentCoreError } from "@agent-core/core";
import { ActorId, ActorRef } from "@agent-core/core/actors";
import {
    MemoryPlacementRegistry,
    PlacementResolver,
    decodeViewStreamFrame,
    type AuthoritativeQueueDelivery,
    type CloudflareErrorPort
} from "../../src/index.js";
import worker, { type TestActorDurableObject } from "./worker.js";

const probeErrors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};

describe("Cloudflare runtime integration", () => {
    it("applies SQLite application migrations in the Durable Object", async () => {
        const stub = env.ACTORS.getByName("migration");
        await stub.fetch("https://test/");
        await runInDurableObject(stub, (_instance, state) => {
            const markers = [
                ...state.storage.sql.exec(
                    "SELECT version, name FROM agent_core_migrations ORDER BY version"
                )
            ];
            expect(markers).toEqual([
                {
                    version: 1,
                    name: "cloudflare-runtime-views-and-outbox"
                }
            ]);
        });
        expect(await runDurableObjectAlarm(stub)).toBe(false);
    });

    it("uses the R2 binding through the actor repository", async () => {
        const response = await env.ACTORS.getByName("r2").fetch("https://test/content");
        expect((await response.json<{ digest: string }>()).digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it("rolls back synchronous SQLite writes when an effect fails", async () => {
        const response = await env.ACTORS.getByName("rollback").fetch("https://test/rollback");
        expect(await response.json()).toEqual({ count: 0 });
    });

    it("runs core SQLite stores against Durable Object storage without adapter casts", async () => {
        const response = await env.ACTORS.getByName("core-store").fetch("https://test/core-store");
        expect(await response.json()).toEqual({ epoch: 0, bytes: [4, 5, 6] });
    });

    it("acknowledges queue messages individually after target delivery", async () => {
        const batch = createMessageBatch<AuthoritativeQueueDelivery<string, unknown>>(
            "agent-core-cloudflare-test-deliveries",
            [
                {
                    id: "platform-id",
                    timestamp: new Date(0),
                    attempts: 1,
                    body: { deliveryId: "authoritative-id", payload: null }
                }
            ]
        );
        const context = createExecutionContext();
        await worker.queue(batch, env, context);
        expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["platform-id"]);
    });

    it("retries one queue message only after the target retry disposition", async () => {
        const batch = createMessageBatch<AuthoritativeQueueDelivery<string, unknown>>(
            "agent-core-cloudflare-test-deliveries",
            [
                {
                    id: "retry-platform-id",
                    timestamp: new Date(0),
                    attempts: 1,
                    body: { deliveryId: "retry-authoritative-id", payload: { retry: true } }
                }
            ]
        );
        const context = createExecutionContext();
        await worker.queue(batch, env, context);
        const result = await getQueueResult(batch, context);
        expect(result.explicitAcks).toEqual([]);
        expect(result.retryMessages).toHaveLength(1);
    });

    it("redelivers by authoritative ID without duplicating an idempotent target effect", async () => {
        for (const platformId of ["first-platform-id", "second-platform-id"]) {
            const batch = createMessageBatch<AuthoritativeQueueDelivery<string, unknown>>(
                "agent-core-cloudflare-test-deliveries",
                [
                    {
                        id: platformId,
                        timestamp: new Date(0),
                        attempts: 1,
                        body: { deliveryId: "stable-authoritative-id", payload: null }
                    }
                ]
            );
            const context = createExecutionContext();
            await worker.queue(batch, env, context);
            expect((await getQueueResult(batch, context)).explicitAcks).toEqual([platformId]);
        }
        const context = createExecutionContext();
        const response = await worker.fetch(
            new Request("https://test/delivery-count?id=stable-authoritative-id"),
            env,
            context
        );
        expect(await response.json()).toEqual({ count: 1 });
    });

    it("repairs an alarm from the durable ID-only outbox and drains it", async () => {
        const stub = env.ACTORS.getByName("alarm-repair");
        await (await stub.fetch("https://test/enqueue-without-alarm?id=repair-id")).text();
        await runInDurableObject(stub, async (_instance, state) => {
            expect(await state.storage.getAlarm()).toBeNull();
            const rows = [
                ...state.storage.sql.exec(
                    "SELECT id FROM agent_core_reconciliation_outbox ORDER BY id"
                )
            ];
            expect(rows).toEqual([{ id: "repair-id" }]);
        });

        await evictDurableObject(stub);
        await (await stub.fetch("https://test/")).text();
        await runInDurableObject(stub, async (_instance, state) => {
            expect(await state.storage.getAlarm()).not.toBeNull();
        });
        expect(await runDurableObjectAlarm(stub)).toBe(true);
        await runInDurableObject(stub, async (_instance, state) => {
            expect(await state.storage.getAlarm()).toBeNull();
            const rows = [
                ...state.storage.sql.exec(
                    "SELECT id FROM agent_core_reconciliation_outbox ORDER BY id"
                )
            ];
            expect(rows).toEqual([]);
            const migrations = [
                ...state.storage.sql.exec(
                    "SELECT version FROM agent_core_migrations ORDER BY version"
                )
            ];
            expect(migrations).toEqual([{ version: 1 }]);
        });
    });

    it("resolves one ActorRef to a single authoritative store through the pin", async () => {
        const registry = new MemoryPlacementRegistry();
        const resolver = new PlacementResolver<
            DurableObjectId,
            DurableObjectStub<TestActorDurableObject>
        >(registry, probeErrors);
        const actor = new ActorRef("workspace", new ActorId("ledger-probe"));

        const first = await resolver.resolve(env.ACTORS, actor);
        expect(await (await first.fetch("https://test/probe-store?nonce=n1")).json()).toEqual({
            count: 1
        });

        // A second resolution of the same ActorRef must reach the same private SQLite store,
        // so its nonce ledger already holds the first nonce.
        const second = await resolver.resolve(env.ACTORS, actor);
        expect(await (await second.fetch("https://test/probe-store?nonce=n2")).json()).toEqual({
            count: 2
        });

        // A conflicting jurisdiction for the pinned Actor is refused, never a second object.
        await expect(
            resolver.resolve(env.ACTORS, actor, { namespaceJurisdiction: "eu" })
        ).rejects.toMatchObject({ code: "protocol.invalid-state" });
    });

    it("hibernates a WebSocket with replay attachment state", async () => {
        const stub = env.ACTORS.getByName("socket");
        const response = await stub.fetch(
            new Request("https://test/socket", {
                headers: { Upgrade: "websocket" }
            })
        );
        const socket = response.webSocket;
        if (socket === null) throw new TypeError("Expected WebSocket response");
        const initialMessage = nextMessage(socket);
        socket.accept();
        expect(decodeViewStreamFrame(await initialMessage)).toMatchObject({
            kind: "delta",
            revision: 1,
            payload: "AQ=="
        });
        await evictDurableObject(stub);
        const replayedMessage = nextMessage(socket);
        socket.send(JSON.stringify({ ackedRevision: 1 }));
        expect(decodeViewStreamFrame(await replayedMessage)).toMatchObject({
            kind: "delta",
            revision: 2,
            payload: "Ag=="
        });
        socket.close(1000, "done");
    });

    it("passes an allowlisted capability through Dynamic Worker env", async () => {
        const context = createExecutionContext();
        const response = await worker.fetch(new Request("https://test/loader"), env, context);
        expect(await response.json()).toEqual({
            capability: "allowed",
            keys: ["CAPABILITY"]
        });
    });

    it("blocks ambient outbound access in a Dynamic Worker", async () => {
        const context = createExecutionContext();
        const response = await worker.fetch(
            new Request("https://test/loader-outbound"),
            env,
            context
        );
        expect(await response.json()).toEqual({ blocked: true });
    });
});

function nextMessage(socket: WebSocket): Promise<string> {
    return new Promise((resolve) => {
        socket.addEventListener(
            "message",
            (event) => {
                if (typeof event.data !== "string") {
                    throw new TypeError("Expected text WebSocket message");
                }
                resolve(event.data);
            },
            {
                once: true
            }
        );
    });
}
