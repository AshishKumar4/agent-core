import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeCanonicalJson } from "@agent-core/core";
import { decodeViewStreamFrame } from "../../src/index.js";
import { SQL_BLOB_LIMIT_BYTES } from "../../src/sqlite.js";
import {
    abortInstance,
    awaitEvent,
    call,
    events,
    openSocket,
    poll,
    resultOf,
    saveState,
    sleep,
    type LiveAlarmState,
    type LiveOutboxState
} from "./harness";

const PREVIEW_HOST = "preview.agent-core-live.test";
const publicationMaterialization = `sha256:${"1".repeat(64)}`;

function pin(environment: string, revision = 0, generation = 0): Record<string, string | number> {
    return { environmentId: environment, environmentRevision: revision, generation };
}

function deployment(
    id: string,
    init: { readonly target?: string; readonly invocation?: string; readonly key?: string } = {}
): Record<string, string | number> {
    return {
        workspaceId: "ws-live",
        slateId: "slate-live",
        deploymentId: id,
        publicationId: "pub-live",
        publicationMaterialization,
        target: init.target ?? "production",
        invocationId: init.invocation ?? `inv-${id}`,
        idempotencyKey: init.key ?? `deploy-${id}`,
        itemIndex: 0,
        attemptOrdinal: 0
    };
}

describe("live Cloudflare substrate evidence", () => {
    it("[P11-ENVIRONMENT-EPHEMERAL-DURABILITY] persists session state across a real Durable Object instance kill", async () => {
        const session = { ...pin("env-durable"), sessionId: "sess-durable" };
        expect(await call("env", "durability", "open", session)).toMatchObject({
            ok: true,
            result: { name: "ready" }
        });
        expect(
            await call("env", "durability", "write-file", {
                ...session,
                path: "state.txt",
                contentBase64: Buffer.from([1, 2, 3]).toString("base64")
            })
        ).toMatchObject({ ok: true });

        await abortInstance("env", "durability");

        expect(await call("env", "durability", "inspect", session)).toMatchObject({
            ok: true,
            result: { name: "ready" }
        });
        const read = await call("env", "durability", "read-file", {
            ...session,
            path: "state.txt"
        });
        expect(read.ok).toBe(true);
        expect(Buffer.from(String(read.result), "base64")).toEqual(Buffer.from([1, 2, 3]));
    });

    it("[P11-ENVIRONMENT-EPHEMERAL-DURABILITY] rejects stale generations after rotation, across a real instance kill", async () => {
        expect(
            await call("env", "rotation", "open", {
                ...pin("env-rotation", 1, 1),
                sessionId: "sess-gen1"
            })
        ).toMatchObject({ ok: true, result: { name: "ready" } });
        expect(
            await call("env", "rotation", "open", {
                ...pin("env-rotation", 2, 2),
                sessionId: "sess-gen2"
            })
        ).toMatchObject({ ok: true, result: { name: "ready" } });

        await abortInstance("env", "rotation");

        expect(
            await call("env", "rotation", "open", {
                ...pin("env-rotation", 1, 1),
                sessionId: "sess-stale"
            })
        ).toMatchObject({ ok: true, result: { name: "failed" } });
    });

    it("[P11-ENVIRONMENT-SNAPSHOT] snapshots through real R2 and restores exactly on a different instance", async () => {
        const session = { ...pin("env-snap"), sessionId: "sess-source" };
        await call("env", "snap-a", "open", session);
        await call("env", "snap-a", "write-file", {
            ...session,
            path: "a.json",
            contentBase64: Buffer.from("live-evidence").toString("base64")
        });
        const snapshot = await call("env", "snap-a", "snapshot", {
            ...session,
            sessionEpoch: 0,
            snapshotId: "snap-1"
        });
        expect(snapshot).toMatchObject({ ok: true, result: { name: "ready" } });
        const reference = snapshot.result?.value;
        if (typeof reference !== "string") throw new TypeError("Expected a snapshot ContentRef");

        await abortInstance("env", "snap-a");

        // A different Durable Object instance shares nothing but the R2 bucket:
        // an exact restore proves the snapshot's real round trip through R2.
        const restored = { ...pin("env-restore"), sessionId: "sess-restored", restore: reference };
        expect(await call("env", "snap-b", "open", restored)).toMatchObject({
            ok: true,
            result: { name: "ready" }
        });
        const read = await call("env", "snap-b", "read-file", { ...restored, path: "a.json" });
        expect(Buffer.from(String(read.result), "base64").toString("utf8")).toBe("live-evidence");

        expect(
            await call("env", "snap-b", "open", {
                ...pin("env-missing"),
                sessionId: "sess-missing",
                restore: `sha256:${"9".repeat(64)}`
            })
        ).toMatchObject({ ok: true, result: { name: "failed" } });
    });

    it("[P11-ENVIRONMENT-PREVIEW] derives the deterministic preview URL, keeps it across an instance kill, and revokes fail-closed", async () => {
        const session = { ...pin("env-preview"), sessionId: "sess-preview" };
        await call("env", "preview", "open", session);
        const exposure = {
            ...session,
            sessionEpoch: 0,
            exposureId: "exp-1",
            port: 8080
        };
        const exposed = await call("env", "preview", "expose", exposure);
        expect(exposed).toMatchObject({ ok: true, result: { name: "ready" } });

        const token = createHash("sha256")
            .update(
                encodeCanonicalJson({
                    environmentId: "env-preview",
                    environmentRevision: 0,
                    exposureId: "exp-1",
                    generation: 0,
                    port: 8080,
                    sessionEpoch: 0,
                    sessionId: "sess-preview"
                })
            )
            .digest("hex");
        expect(exposed.result?.value).toBe(
            `https://${token.slice(0, 32)}.${token.slice(32)}.${PREVIEW_HOST}/`
        );

        await abortInstance("env", "preview");

        expect(await call("env", "preview", "inspect-exposure", exposure)).toMatchObject({
            ok: true,
            result: { name: "ready", value: exposed.result?.value }
        });
        expect(await call("env", "preview", "revoke", exposure)).toMatchObject({
            ok: true,
            result: { name: "succeeded" }
        });
        expect(await call("env", "preview", "inspect-exposure", exposure)).toMatchObject({
            ok: true,
            result: { name: "absent" }
        });
        expect(await call("env", "preview", "expose", exposure)).toMatchObject({
            ok: true,
            result: { name: "failed" }
        });
    });

    it("[P11-SLATE-DEPLOY] deploys once against the real substrate and rejects identity reuse across an instance kill", async () => {
        const request = deployment("dep-live");
        const first = await call("slate", "deploy", "deploy", request);
        expect(first.ok).toBe(true);
        const materialization = first.result?.materialization;
        if (typeof materialization !== "string") throw new TypeError("Expected a materialization");
        expect(materialization.startsWith("sha256:")).toBe(true);

        await abortInstance("slate", "deploy");

        expect(await call("slate", "deploy", "deploy", request)).toMatchObject({
            ok: true,
            result: { materialization }
        });
        expect(
            await call("slate", "deploy", "deploy", deployment("dep-live", { target: "staging" }))
        ).toMatchObject({ ok: false, code: "protocol.invalid-state" });

        saveState("slate", {
            deployment: request,
            materialization,
            resource: {
                workspaceId: "ws-live",
                slateId: "slate-live",
                resourceId: "res-live",
                deploymentId: "dep-live",
                deploymentMaterialization: materialization,
                resourceName: "database",
                resourceSource: publicationMaterialization,
                invocationId: "inv-res-live",
                idempotencyKey: "resource-res-live",
                itemIndex: 0,
                attemptOrdinal: 0
            }
        });
    });

    it("[P11-SLATE-MEDIATED-DEPLOY] settles an indeterminate mediated attempt by reconciling the frozen intent across an instance kill", async () => {
        // The caller's view of an indeterminate attempt: the effect was requested but
        // the outcome never observed. Reconciliation with the identical frozen intent
        // must settle to the exact recorded materialization, not repeat the effect.
        const request = deployment("dep-mediated");
        const attempted = await call("slate", "mediated", "deploy", request);
        expect(attempted.ok).toBe(true);

        await abortInstance("slate", "mediated");

        const settled = await call("slate", "mediated", "reconcile-deploy", request);
        expect(settled).toMatchObject({
            ok: true,
            result: { materialization: attempted.result?.materialization }
        });
        expect(
            await call("slate", "mediated", "reconcile-deploy", {
                ...request,
                attemptOrdinal: 1
            })
        ).toMatchObject({
            ok: true,
            result: { materialization: attempted.result?.materialization }
        });
        expect(
            await call("slate", "mediated", "reconcile-deploy", {
                ...request,
                invocationId: "inv-foreign"
            })
        ).toMatchObject({ ok: false, code: "protocol.invalid-state" });

        const resource = {
            workspaceId: "ws-live",
            slateId: "slate-live",
            resourceId: "res-mediated",
            deploymentId: "dep-mediated",
            deploymentMaterialization: String(attempted.result?.materialization),
            resourceName: "database",
            resourceSource: publicationMaterialization,
            invocationId: "inv-res-mediated",
            idempotencyKey: "resource-res-mediated",
            itemIndex: 0,
            attemptOrdinal: 0
        };
        const materialized = await call("slate", "mediated", "materialize-resource", resource);
        expect(materialized.ok).toBe(true);
        await abortInstance("slate", "mediated");
        expect(await call("slate", "mediated", "reconcile-resource", resource)).toMatchObject({
            ok: true,
            result: { materialization: materialized.result?.materialization }
        });
    });
});

/**
 * Far enough out that the arming response still describes an unswept outbox, near
 * enough that the alarm fires immediately afterwards.
 */
const ARM_DELAY_MS = 500;

interface EnqueueResult extends LiveOutboxState {
    readonly scheduledAt: number;
}

interface ClaimResult extends LiveAlarmState {
    readonly dueAt: number;
}

interface ThrowingResult extends ClaimResult {
    readonly until: number;
}

interface BlobResult {
    readonly revision: number;
    readonly byteLength: number;
}

interface BlobRead {
    readonly currentRevision: number;
    readonly lastByteLength: number | null;
}

interface DeliveryList {
    readonly deliveries: readonly { readonly deliveryId: string; readonly attempts: number }[];
}

interface SocketList {
    readonly count: number;
    readonly attachments: readonly {
        readonly channel: string;
        readonly ackedRevision: number;
    }[];
}

interface AttachmentProbe {
    readonly isolate: string;
    readonly before: { readonly channel: string; readonly ackedRevision: number };
    readonly after: { readonly channel: string; readonly ackedRevision: number };
    readonly currentRevision: number;
}

async function attempts(instance: string, deliveryId: string): Promise<number | undefined> {
    const list = resultOf(await call<DeliveryList>("runtime", instance, "deliveries"));
    return list.deliveries.find((delivery) => delivery.deliveryId === deliveryId)?.attempts;
}

describe("live Cloudflare platform-semantics evidence", () => {
    it("[P11-ALARM-SCHEDULE] arms a real alarm from the outbox, fires it, and tears the alarm down", async () => {
        const enqueued = resultOf(
            await call<EnqueueResult>("runtime", "alarm-sweep", "enqueue", {
                id: "due-now",
                delayMs: ARM_DELAY_MS
            })
        );
        expect(enqueued.entries).toEqual([{ id: "due-now", scheduledAt: enqueued.scheduledAt }]);
        // The physical alarm is the earliest live claim, and the reconciler holds one.
        expect(enqueued.physicalAlarm).toBe(enqueued.scheduledAt);
        expect(enqueued.claims).toEqual([
            { owner: "agent-core.runtime", dueAt: enqueued.scheduledAt }
        ]);

        const finished = await awaitEvent("alarm-sweep", "reconcile.finished", "due-now");
        expect(finished.at).toBeGreaterThanOrEqual(enqueued.scheduledAt);

        const settled = resultOf(await call<LiveOutboxState>("runtime", "alarm-sweep", "outbox"));
        expect(settled).toEqual({
            entries: [],
            nextDueAt: null,
            physicalAlarm: null,
            claims: []
        });
    });

    it("[P11-ALARM-DURABILITY] fires an alarm scheduled before a real instance kill, with nothing outside the object waking it", async () => {
        const enqueued = resultOf(
            await call<EnqueueResult>("runtime", "alarm-kill", "enqueue", {
                id: "after-kill",
                delayMs: 5_000
            })
        );
        expect(enqueued.physicalAlarm).toBe(enqueued.scheduledAt);

        await abortInstance("runtime", "alarm-kill");
        // No request touches the instance across the whole window: whatever runs the
        // reconciliation can only be the platform re-instantiating it for the alarm.
        await sleep(15_000);

        const finished = await awaitEvent("alarm-kill", "reconcile.finished", "after-kill", 5_000);
        // Both timestamps come from the deployed object's own clock, so the gap carries
        // no client skew: the alarm fired on its schedule, not when this test looked.
        expect(finished.at - enqueued.scheduledAt).toBeLessThan(8_000);

        const settled = resultOf(await call<LiveOutboxState>("runtime", "alarm-kill", "outbox"));
        expect(settled.entries).toEqual([]);
        expect(settled.physicalAlarm).toBeNull();
    });

    it("[P11-ALARM-RETRY] reschedules a failed reconciliation onto a real alarm and settles it", async () => {
        const enqueued = resultOf(
            await call<EnqueueResult>("runtime", "alarm-retry", "enqueue", {
                id: "faulty",
                delayMs: ARM_DELAY_MS,
                faults: 1
            })
        );
        expect(enqueued.entries).toEqual([{ id: "faulty", scheduledAt: enqueued.scheduledAt }]);

        const failed = await awaitEvent("alarm-retry", "reconcile.failed", "faulty");
        const finished = await awaitEvent("alarm-retry", "reconcile.finished", "faulty");
        // The retry is the outbox's own reschedule, one configured delay after the failure.
        // The reschedule is measured from the sweep's start, a few milliseconds earlier.
        expect(finished.at - failed.at).toBeGreaterThanOrEqual(1_900);
        expect(
            (await events("alarm-retry")).filter(
                (event) => event.kind === "reconcile.started" && event.subject === "faulty"
            ).length
        ).toBeGreaterThanOrEqual(2);

        const settled = resultOf(await call<LiveOutboxState>("runtime", "alarm-retry", "outbox"));
        expect(settled).toEqual({ entries: [], nextDueAt: null, physicalAlarm: null, claims: [] });
    });

    it("[P11-ALARM-ARBITRATION] shares one physical alarm between two claims across a real instance kill", async () => {
        const early = resultOf(
            await call<ClaimResult>("runtime", "alarm-claims", "claim", {
                owner: "early",
                delayMs: 3_600_000
            })
        );
        const late = resultOf(
            await call<ClaimResult>("runtime", "alarm-claims", "claim", {
                owner: "late",
                delayMs: 7_200_000
            })
        );
        expect(late.physicalAlarm).toBe(early.dueAt);
        expect(late.claims).toEqual([
            { owner: "probe.early", dueAt: early.dueAt },
            { owner: "probe.late", dueAt: late.dueAt }
        ]);

        // Releasing the earliest claim must leave the other one armed, not delete the slot.
        const released = resultOf(
            await call<LiveAlarmState>("runtime", "alarm-claims", "unclaim", { owner: "early" })
        );
        expect(released).toEqual({
            physicalAlarm: late.dueAt,
            claims: [{ owner: "probe.late", dueAt: late.dueAt }]
        });

        await abortInstance("runtime", "alarm-claims");

        expect(resultOf(await call<LiveAlarmState>("runtime", "alarm-claims", "alarms"))).toEqual({
            physicalAlarm: late.dueAt,
            claims: [{ owner: "probe.late", dueAt: late.dueAt }]
        });

        const soon = resultOf(
            await call<ClaimResult>("runtime", "alarm-claims", "claim", {
                owner: "soon",
                delayMs: 1_500
            })
        );
        expect(soon.physicalAlarm).toBe(soon.dueAt);
        const fired = await awaitEvent("alarm-claims", "claim.fired", "probe.soon");
        expect(fired.detail).toBe(soon.dueAt);

        // The fired claim released itself and the slot fell back to the surviving claim.
        expect(resultOf(await call<LiveAlarmState>("runtime", "alarm-claims", "alarms"))).toEqual({
            physicalAlarm: late.dueAt,
            claims: [{ owner: "probe.late", dueAt: late.dueAt }]
        });
        saveState("alarmClaim", { owner: "probe.late", dueAt: late.dueAt });
    });

    it("[P11-ALARM-FAULT-RECOVERY] re-fires an alarm whose handler threw, with no external re-arming", async () => {
        const armed = resultOf(
            await call<ThrowingResult>("runtime", "alarm-throw", "arm-throwing", {
                delayMs: 1_000,
                throwForMs: 5_000
            })
        );
        expect(armed.physicalAlarm).toBe(armed.dueAt);
        expect(armed.dueAt).toBeLessThan(armed.until);

        // A single observation after the throw window: any earlier request would itself
        // have re-armed the alarm through startup repair and muddied the evidence.
        await sleep(30_000);
        const fired = (await events("alarm-throw")).find(
            (event) => event.kind === "claim.fired" && event.subject === "probe.throwing"
        );
        expect(fired).toBeDefined();
        // The first fire fell inside the throw window, so the successful one is a re-fire.
        expect(fired?.at).toBeGreaterThanOrEqual(armed.until);

        expect(resultOf(await call<LiveAlarmState>("runtime", "alarm-throw", "alarms"))).toEqual({
            physicalAlarm: null,
            claims: []
        });
    });

    it("[P11-RECONCILIATION-FENCE] keeps a schedule written while reconciliation was in flight", async () => {
        const enqueued = resultOf(
            await call<EnqueueResult>("runtime", "fence", "enqueue", {
                id: "fenced",
                delayMs: ARM_DELAY_MS,
                hold: true
            })
        );
        expect(enqueued.physicalAlarm).toBe(enqueued.scheduledAt);

        // The sweep is now awaiting inside reconcile with the object's input gate open.
        const started = await awaitEvent("fence", "reconcile.started", "fenced");
        const rescheduled = resultOf(
            await call<EnqueueResult>("runtime", "fence", "enqueue", {
                id: "fenced",
                delayMs: 3_600_000,
                release: true
            })
        );
        const finished = await awaitEvent("fence", "reconcile.finished", "fenced");

        // The reschedule landed strictly inside the sweep, which is the only ordering
        // that puts the acknowledgement fence under test at all.
        const midflight = (await events("fence")).find(
            (event) =>
                event.kind === "outbox.enqueued" &&
                event.subject === "fenced" &&
                event.detail === rescheduled.scheduledAt
        );
        expect(midflight).toBeDefined();
        expect(midflight?.ordinal).toBeGreaterThan(started.ordinal);
        expect(midflight?.ordinal).toBeLessThan(finished.ordinal);

        // The acknowledgement fenced on the schedule the sweep observed, so the newer
        // schedule survived and the alarm still points at it.
        const settled = resultOf(await call<LiveOutboxState>("runtime", "fence", "outbox"));
        expect(settled.entries).toEqual([{ id: "fenced", scheduledAt: rescheduled.scheduledAt }]);
        expect(settled.physicalAlarm).toBe(rescheduled.scheduledAt);

        // The fence is not merely permissive: the matching schedule does clear the entry.
        expect(
            resultOf(
                await call<LiveOutboxState>("runtime", "fence", "acknowledge", {
                    id: "fenced",
                    scheduledAt: rescheduled.scheduledAt
                })
            )
        ).toEqual({ entries: [], nextDueAt: null, physicalAlarm: null, claims: [] });
    });

    it("[P11-VIEW-HIBERNATION] replays a hibernating WebSocket and keeps its attachment across an idle eviction window", async () => {
        const socket = await openSocket("socket", { channel: "live", acked: "0" });
        try {
            const replayed = await socket.take(2);
            expect(replayed.map((frame) => decodeViewStreamFrame(frame))).toMatchObject([
                { kind: "delta", channel: "live", revision: 1 },
                { kind: "delta", channel: "live", revision: 2 }
            ]);

            socket.send({ ack: 2 });
            const acknowledged = JSON.parse(String((await socket.take(1))[0])) as AttachmentProbe;
            expect(acknowledged.before.ackedRevision).toBe(0);
            expect(acknowledged.after).toEqual({
                version: 1,
                channel: "live",
                ackedRevision: 2
            });
            // Nothing is left to replay once every revision is acknowledged.
            await sleep(1_000);
            expect(socket.pending()).toBe(0);

            expect(resultOf(await call<SocketList>("runtime", "socket", "sockets"))).toEqual({
                count: 1,
                attachments: [{ channel: "live", ackedRevision: 2 }]
            });

            // Long enough for the platform to evict the object while the socket stays open.
            await sleep(15_000);

            socket.send({ append: true });
            const woken = await socket.take(2);
            const probe = JSON.parse(String(woken[0])) as AttachmentProbe;
            // The persisted envelope keeps its version across the eviction, which is what
            // makes the attachment decodable at all in the isolate that resumed it.
            expect(probe.before).toEqual({ version: 1, channel: "live", ackedRevision: 2 });
            expect(probe.currentRevision).toBe(3);
            expect(typeof probe.isolate).toBe("string");
            expect(decodeViewStreamFrame(String(woken[1]))).toMatchObject({
                kind: "delta",
                channel: "live",
                revision: 3
            });

            expect(resultOf(await call<SocketList>("runtime", "socket", "sockets"))).toEqual({
                count: 1,
                attachments: [{ channel: "live", ackedRevision: 2 }]
            });
        } finally {
            socket.close();
        }
    });

    it("[P11-QUEUE-DELIVERY] acknowledges, redelivers, and dead-letters through a real queue", async () => {
        expect(
            resultOf(
                await call<{ readonly deliveryId: string; readonly poison: boolean }>(
                    "queue",
                    "queue-live",
                    "publish",
                    { deliveryId: "q-ack", mode: "ack" }
                )
            )
        ).toEqual({ deliveryId: "q-ack", poison: false });
        expect((await awaitEvent("queue-live", "queue.delivered", "q-ack", 90_000)).detail).toBe(1);

        await call("queue", "queue-live", "publish", { deliveryId: "q-retry", mode: "retry-once" });
        // A second attempt can only come from the queue itself redelivering a retried message.
        await poll(
            "redelivery of q-retry",
            async () => {
                const count = await attempts("queue-live", "q-retry");
                return count !== undefined && count >= 2 ? count : undefined;
            },
            90_000
        );
        // The acknowledged delivery was never handed back.
        expect(await attempts("queue-live", "q-ack")).toBe(1);

        await call("queue", "queue-live", "publish", {
            deliveryId: "q-poison",
            mode: "ack",
            poison: true
        });
        await awaitEvent("queue-live", "queue.poison", "q-poison", 120_000);
        // An undecodable body never reached the target, and was not destroyed either.
        expect(await attempts("queue-live", "q-poison")).toBeUndefined();
    });

    it("[P11-STORAGE-LIMIT] stores a row at the declared blob limit and refuses one past it", async () => {
        // The seam's limit is only correct if production actually accepts a row that
        // large, row overhead included — the one thing workerd cannot answer for it.
        const nearLimit = SQL_BLOB_LIMIT_BYTES - 1_000;
        expect(
            resultOf(
                await call<BlobResult>("runtime", "blob", "blob", {
                    channel: "limits",
                    bytes: nearLimit
                })
            )
        ).toEqual({ revision: 1, byteLength: nearLimit });

        const oversized = await call<BlobResult>("runtime", "blob", "blob", {
            channel: "limits",
            bytes: SQL_BLOB_LIMIT_BYTES + 1
        });
        expect(oversized.ok).toBe(false);
        // Refused as invalid input at the seam, before any transaction opens.
        expect(oversized.code).toBe("operation.invalid-input");

        // The rejection is contained: the object still serves and the log is intact.
        expect(
            resultOf(
                await call<BlobResult>("runtime", "blob", "blob", {
                    channel: "limits",
                    bytes: 1_000
                })
            )
        ).toEqual({ revision: 2, byteLength: 1_000 });
        expect(
            resultOf(await call<BlobRead>("runtime", "blob", "blob-read", { channel: "limits" }))
        ).toEqual({ currentRevision: 2, lastByteLength: 1_000 });
    });

    it("[P11-ALARM-REDEPLOY] arms durable reconciliation work for the redeployed worker to finish", async () => {
        const enqueued = resultOf(
            await call<EnqueueResult>("runtime", "redeploy", "enqueue", {
                id: "survivor",
                delayMs: 3_600_000
            })
        );
        expect(enqueued.entries).toEqual([{ id: "survivor", scheduledAt: enqueued.scheduledAt }]);
        expect(enqueued.physicalAlarm).toBe(enqueued.scheduledAt);
        saveState("redeploy", { id: "survivor", scheduledAt: enqueued.scheduledAt });
    });
});
