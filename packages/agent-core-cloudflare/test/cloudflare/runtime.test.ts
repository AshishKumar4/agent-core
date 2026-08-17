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
import { AgentCoreError, isJsonValue } from "@agent-core/core";
import type { JsonValue } from "@agent-core/core";
import { ActorId, ActorRef } from "@agent-core/core/actors";
import {
    CloudflareSqlite,
    DurableViewRevisionLog,
    PlacementResolver,
    cloudflareRuntimeMigrations,
    decodeViewStreamFrame,
    type ActorNamespaceLocation,
    type AuthoritativeQueueDelivery,
    type CloudflareErrorPort
} from "../../src/index.js";
import { SQL_BLOB_LIMIT_BYTES } from "../../src/sqlite.js";
import { isText } from "../../src/platform-value.js";
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
            expect(markers).toEqual(
                cloudflareRuntimeMigrations.map((migration) => ({
                    version: migration.version,
                    name: migration.name
                }))
            );
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
            expect(migrations).toEqual(
                cloudflareRuntimeMigrations.map((migration) => ({ version: migration.version }))
            );
        });
    });

    it("resolves one ActorRef to a single authoritative store through the pin", async () => {
        const registryStub = env.PLACEMENTS.getByName("registry");
        const actor = new ActorRef("workspace", new ActorId("ledger-probe"));
        // The ledger is one object's own SQLite, so a resolution runs inside that object.
        const probe = async (
            nonce: string,
            location?: ActorNamespaceLocation
        ): Promise<JsonValue> =>
            runInDurableObject(registryStub, async (instance) => {
                const resolver = new PlacementResolver<
                    DurableObjectId,
                    DurableObjectStub<TestActorDurableObject>
                >(instance.placements, probeErrors);
                const stub = await resolver.resolve(env.ACTORS, actor, location);
                const body: unknown = await (
                    await stub.fetch(`https://test/probe-store?nonce=${nonce}`)
                ).json();
                if (!isJsonValue(body)) throw new TypeError("Probe store returned no JSON");
                return body;
            });

        expect(await probe("n1")).toEqual({ count: 1 });

        // The pin outlives the object that installed it: a resolution after eviction must
        // reach the same private SQLite store, whose nonce ledger already holds the first.
        await evictDurableObject(registryStub);
        expect(await probe("n2")).toEqual({ count: 2 });

        // A conflicting jurisdiction for the pinned Actor is refused, never a second object.
        await expect(probe("n3", { namespaceJurisdiction: "eu" })).rejects.toMatchObject({
            code: "protocol.invalid-state"
        });
    });

    it("refuses a view payload past the SQLite blob limit", { tags: "p1" }, async () => {
        await runInDurableObject(env.ACTORS.getByName("blob-limit"), (_instance, state) => {
            const log = new DurableViewRevisionLog(
                new CloudflareSqlite(state.storage, probeErrors),
                probeErrors
            );
            let refusal: unknown;
            try {
                log.append("limits", 1, new Uint8Array(SQL_BLOB_LIMIT_BYTES + 1));
            } catch (error) {
                refusal = error;
            }
            // Without the seam check the runtime reports SQLITE_TOOBIG from the INSERT,
            // after the revision check has already run inside the transaction.
            expect(refusal).toMatchObject({ code: "operation.invalid-input" });
            expect(log.currentRevision("limits")).toBe(0);

            // The documented limit is genuinely storable, so the seam refuses nothing real.
            log.append("limits", 1, new Uint8Array(SQL_BLOB_LIMIT_BYTES));
            expect(log.currentRevision("limits")).toBe(1);
        });
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

    it("passes a callable capability as a Dynamic Worker env binding and nothing else", async () => {
        const context = createExecutionContext();
        const response = await worker.fetch(new Request("https://test/loader"), env, context);
        expect(await response.json()).toEqual({
            names: ["capability"],
            result: {
                binding: "capability",
                operation: "read",
                input: { path: "/a" }
            }
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
                if (!isText(event.data)) {
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
