import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    encodeCanonicalJson,
    isJsonObject,
    isJsonValue,
    jsonDataParser,
    type JsonObject,
    type JsonValue
} from "@agent-core/core";
import { isText } from "../../src/platform-value.js";
import { decodeViewStreamFrame } from "../../src/index.js";
import { SQL_BLOB_LIMIT_BYTES } from "../../src/sqlite.js";
import {
    abortInstance,
    awaitEvent,
    call,
    decodeLiveAlarmState,
    decodeLiveOutboxState,
    decodeLiveResult,
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

function pin(environment: string, revision = 0, generation = 0) {
    return { environmentId: environment, environmentRevision: revision, generation };
}

function deployment(
    id: string,
    init: { readonly target?: string; readonly invocation?: string; readonly key?: string } = {}
) {
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
        const snapshot = await call(
            "env",
            "snap-a",
            "snapshot",
            { ...session, sessionEpoch: 0, snapshotId: "snap-1" },
            decodeLiveResult
        );
        expect(snapshot).toMatchObject({ ok: true, result: { name: "ready" } });
        const reference = snapshot.result?.value;
        if (!isText(reference)) throw new TypeError("Expected a snapshot ContentRef");

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
        const exposed = await call("env", "preview", "expose", exposure, decodeLiveResult);
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
        const first = await call("slate", "deploy", "deploy", request, decodeLiveResult);
        expect(first.ok).toBe(true);
        const materialization = first.result?.materialization;
        if (!isText(materialization)) throw new TypeError("Expected a materialization");
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
        const attempted = await call("slate", "mediated", "deploy", request, decodeLiveResult);
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
        const materialized = await call(
            "slate",
            "mediated",
            "materialize-resource",
            resource,
            decodeLiveResult
        );
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

interface ResumableOperation {
    readonly work: string;
    readonly attempts: number;
    readonly claimed: boolean;
}

interface ResumableState extends LiveOutboxState {
    readonly isolate: string;
    /** Null once the operation has completed and the journal has cleared it. */
    readonly operation: ResumableOperation | null;
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

interface QueuePublishResult {
    readonly deliveryId: string;
    readonly poison: boolean;
}

interface AttachmentState {
    readonly version: number;
    readonly channel: string;
    readonly ackedRevision: number;
}

interface AttachmentProbe {
    readonly isolate: string;
    readonly before: AttachmentState;
    readonly after: AttachmentState;
    readonly currentRevision: number;
}

const probeData = jsonDataParser((message) => new TypeError(message));

function resultObject(value: JsonValue, subject: string): JsonObject {
    return probeData.object(value, subject);
}

function decodeEnqueueResult(value: JsonValue): EnqueueResult {
    const result = resultObject(value, "Live enqueue result");
    return {
        ...decodeLiveOutboxState(value),
        scheduledAt: probeData.safeInteger(result["scheduledAt"], "Live enqueue schedule")
    };
}

function decodeResumableState(value: JsonValue): ResumableState {
    const result = resultObject(value, "Live resumable operation state");
    const operation = result["operation"];
    return {
        ...decodeLiveOutboxState(value),
        isolate: probeData.nonemptyString(result["isolate"], "Live resumable isolate"),
        operation: operation === null ? null : decodeResumableOperation(operation)
    };
}

function decodeResumableOperation(value: JsonValue | undefined): ResumableOperation {
    const record = probeData.object(value, "Live resumable operation record");
    return {
        work: probeData.nonemptyString(record["work"], "Live resumable work name"),
        attempts: probeData.safeInteger(record["attempts"], "Live resumable attempt count"),
        claimed: probeData.boolean(record["claimed"], "Live resumable claim flag")
    };
}

function decodeClaimResult(value: JsonValue): ClaimResult {
    const result = resultObject(value, "Live claim result");
    return {
        ...decodeLiveAlarmState(value),
        dueAt: probeData.safeInteger(result["dueAt"], "Live claim due time")
    };
}

function decodeThrowingResult(value: JsonValue): ThrowingResult {
    const result = resultObject(value, "Live throwing alarm result");
    return {
        ...decodeClaimResult(value),
        until: probeData.safeInteger(result["until"], "Live throwing alarm deadline")
    };
}

function decodeBlobResult(value: JsonValue): BlobResult {
    const result = resultObject(value, "Live blob result");
    return {
        revision: probeData.safeInteger(result["revision"], "Live blob revision"),
        byteLength: probeData.safeInteger(result["byteLength"], "Live blob byte length")
    };
}

function decodeBlobRead(value: JsonValue): BlobRead {
    const result = resultObject(value, "Live blob read result");
    const lastByteLength = result["lastByteLength"];
    return {
        currentRevision: probeData.safeInteger(
            result["currentRevision"],
            "Live blob current revision"
        ),
        lastByteLength:
            lastByteLength === null
                ? null
                : probeData.safeInteger(lastByteLength, "Live blob byte length")
    };
}

function decodeDeliveryList(value: JsonValue): DeliveryList {
    const result = resultObject(value, "Live delivery list");
    return {
        deliveries: probeData.array(result["deliveries"], "Live deliveries").map((item) => {
            const delivery = resultObject(item, "Live delivery");
            return {
                deliveryId: probeData.nonemptyString(delivery["deliveryId"], "Live delivery ID"),
                attempts: probeData.safeInteger(delivery["attempts"], "Live delivery attempts")
            };
        })
    };
}

function decodeSocketList(value: JsonValue): SocketList {
    const result = resultObject(value, "Live socket list");
    return {
        count: probeData.safeInteger(result["count"], "Live socket count"),
        attachments: probeData
            .array(result["attachments"], "Live socket attachments")
            .map((item) => {
                const attachment = resultObject(item, "Live socket attachment");
                return {
                    channel: probeData.nonemptyString(attachment["channel"], "Live socket channel"),
                    ackedRevision: probeData.safeInteger(
                        attachment["ackedRevision"],
                        "Live socket acknowledged revision"
                    )
                };
            })
    };
}

function decodeQueuePublish(value: JsonValue): QueuePublishResult {
    const result = resultObject(value, "Live queue publication");
    return {
        deliveryId: probeData.nonemptyString(result["deliveryId"], "Live queue delivery ID"),
        poison: probeData.boolean(result["poison"], "Live queue poison flag")
    };
}

function attachmentProbe(encoded: string): AttachmentProbe {
    const decoded: unknown = JSON.parse(encoded);
    if (!isJsonValue(decoded) || !isJsonObject(decoded)) {
        throw new TypeError("Attachment probe must be a JSON object");
    }
    return {
        isolate: probeData.nonemptyString(decoded["isolate"], "Attachment probe isolate"),
        before: attachmentState(decoded["before"], "before"),
        after: attachmentState(decoded["after"], "after"),
        currentRevision: probeData.safeInteger(
            decoded["currentRevision"],
            "Attachment probe current revision"
        )
    };
}

function attachmentState(value: JsonObject[string] | undefined, label: string): AttachmentState {
    const state = probeData.object(value, `Attachment probe ${label}`);
    return {
        version: probeData.safeInteger(state["version"], `Attachment probe ${label} version`),
        channel: probeData.nonemptyString(state["channel"], `Attachment probe ${label} channel`),
        ackedRevision: probeData.safeInteger(
            state["ackedRevision"],
            `Attachment probe ${label} revision`
        )
    };
}

async function attempts(instance: string, deliveryId: string): Promise<number | undefined> {
    const list = resultOf(await call("runtime", instance, "deliveries", {}, decodeDeliveryList));
    return list.deliveries.find((delivery) => delivery.deliveryId === deliveryId)?.attempts;
}

describe("live Cloudflare platform-semantics evidence", () => {
    it("[C13-CLOUDFLARE-RECONCILIATION-DRIVER] arms a real alarm from the outbox, fires it, and tears the alarm down", async () => {
        const enqueued = resultOf(
            await call(
                "runtime",
                "alarm-sweep",
                "enqueue",
                { id: "due-now", delayMs: ARM_DELAY_MS },
                decodeEnqueueResult
            )
        );
        expect(enqueued.entries).toEqual([{ id: "due-now", scheduledAt: enqueued.scheduledAt }]);
        // The physical alarm is the earliest live claim, and the reconciler holds one.
        expect(enqueued.physicalAlarm).toBe(enqueued.scheduledAt);
        expect(enqueued.claims).toEqual([
            { owner: "agent-core.runtime", dueAt: enqueued.scheduledAt }
        ]);

        const finished = await awaitEvent("alarm-sweep", "reconcile.finished", "due-now");
        expect(finished.at).toBeGreaterThanOrEqual(enqueued.scheduledAt);

        // reconcile.finished is recorded inside the reconciliation callback, before the
        // sweep acknowledges the entry and repairs the alarm, and §10.4 has reconciliation
        // run with the object's input gate open. So this read can land mid-sweep, and the
        // property is that the sweep converges on a drained outbox with no claim held.
        const settled = await poll("drained outbox on alarm-sweep", async () => {
            const state = resultOf(
                await call("runtime", "alarm-sweep", "outbox", {}, decodeLiveOutboxState)
            );
            return state.entries.length === 0 && state.claims.length === 0 ? state : undefined;
        });
        expect(settled).toEqual({
            entries: [],
            nextDueAt: null,
            physicalAlarm: null,
            claims: []
        });
    });

    it("[C13-CLOUDFLARE-ALARM-DURABILITY] fires an alarm scheduled before a real instance kill, with nothing outside the object waking it", async () => {
        const enqueued = resultOf(
            await call(
                "runtime",
                "alarm-kill",
                "enqueue",
                { id: "after-kill", delayMs: 5_000 },
                decodeEnqueueResult
            )
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

        const settled = resultOf(
            await call("runtime", "alarm-kill", "outbox", {}, decodeLiveOutboxState)
        );
        expect(settled.entries).toEqual([]);
        expect(settled.physicalAlarm).toBeNull();
    });

    it("[C13-CLOUDFLARE-ALARM-DURABILITY] resumes an operation whose isolate was killed mid-step, repeating nothing", async () => {
        const begun = resultOf(
            await call(
                "runtime",
                "resume-kill",
                "resume-begin",
                { id: "resumable", delayMs: ARM_DELAY_MS, hold: true },
                decodeResumableState
            )
        );
        expect(begun.entries).toEqual([{ id: "resumable", scheduledAt: begun.nextDueAt }]);

        // The first attempt commits its first step and then holds, so the kill lands
        // between two checkpoints of one operation.
        const committed = await awaitEvent("resume-kill", "resume.step", "resumable#first");
        expect(committed.detail).toBe(1);
        await abortInstance("runtime", "resume-kill");

        // Nothing below touches the instance until the work has settled: the alarm the
        // killed handler never acknowledged is re-fired by the platform, the constructor
        // rebuilds the alarm from the outbox, and the second attempt is the object's own.
        const settled = await poll("resumed operation on resume-kill", async () => {
            const journalled = await events("resume-kill");
            const attempts = journalled.filter(
                (event) => event.kind === "resume.observed" || event.kind === "resume.resumed"
            );
            const finished = journalled.filter(
                (event) => event.kind === "resume.step" && event.subject === "resumable#second"
            );
            return attempts.length === 2 && finished.length === 1 ? attempts : undefined;
        });

        // The kind says whether an attempt followed a lost one and `detail` carries only
        // the attempt number: attempt 1 started clean, attempt 2 found the operation still
        // claimed by the isolate that went away.
        expect(settled.map((event) => [event.kind, event.detail])).toEqual([
            ["resume.observed", 1],
            ["resume.resumed", 2]
        ]);
        // A different instance ran the second attempt, so the reset was real. Instance and
        // not isolate: abort() guarantees a new instance and does not promise a new
        // isolate, so an isolate witness reads the same across a real reset.
        expect(settled[0]?.subject).not.toBe(settled[1]?.subject);

        const journal = await events("resume-kill");
        expect(
            journal.filter(
                (event) => event.kind === "resume.step" && event.subject === "resumable#first"
            )
        ).toHaveLength(1);
        const cleared = await poll("cleared operation on resume-kill", async () => {
            const state = resultOf(
                await call(
                    "runtime",
                    "resume-kill",
                    "resume-state",
                    { id: "resumable" },
                    decodeResumableState
                )
            );
            return state.operation === null && state.entries.length === 0 ? state : undefined;
        });
        expect(cleared.nextDueAt).toBeNull();
        expect(cleared.physicalAlarm).toBeNull();
    });

    it("[C13-CLOUDFLARE-RECONCILIATION-RETRY] reschedules a failed reconciliation onto a real alarm and settles it", async () => {
        const enqueued = resultOf(
            await call(
                "runtime",
                "alarm-retry",
                "enqueue",
                { id: "faulty", delayMs: ARM_DELAY_MS, faults: 1 },
                decodeEnqueueResult
            )
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

        const settled = resultOf(
            await call("runtime", "alarm-retry", "outbox", {}, decodeLiveOutboxState)
        );
        expect(settled).toEqual({ entries: [], nextDueAt: null, physicalAlarm: null, claims: [] });
    });

    it("[C13-CLOUDFLARE-ALARM-CLAIMS] shares one physical alarm between two claims across a real instance kill", async () => {
        const early = resultOf(
            await call(
                "runtime",
                "alarm-claims",
                "claim",
                { owner: "early", delayMs: 3_600_000 },
                decodeClaimResult
            )
        );
        const late = resultOf(
            await call(
                "runtime",
                "alarm-claims",
                "claim",
                { owner: "late", delayMs: 7_200_000 },
                decodeClaimResult
            )
        );
        expect(late.physicalAlarm).toBe(early.dueAt);
        expect(late.claims).toEqual([
            { owner: "probe.early", dueAt: early.dueAt },
            { owner: "probe.late", dueAt: late.dueAt }
        ]);

        // Releasing the earliest claim must leave the other one armed, not delete the slot.
        const released = resultOf(
            await call(
                "runtime",
                "alarm-claims",
                "unclaim",
                { owner: "early" },
                decodeLiveAlarmState
            )
        );
        expect(released).toEqual({
            physicalAlarm: late.dueAt,
            claims: [{ owner: "probe.late", dueAt: late.dueAt }]
        });

        await abortInstance("runtime", "alarm-claims");

        expect(
            resultOf(await call("runtime", "alarm-claims", "alarms", {}, decodeLiveAlarmState))
        ).toEqual({
            physicalAlarm: late.dueAt,
            claims: [{ owner: "probe.late", dueAt: late.dueAt }]
        });

        const soon = resultOf(
            await call(
                "runtime",
                "alarm-claims",
                "claim",
                { owner: "soon", delayMs: 1_500 },
                decodeClaimResult
            )
        );
        expect(soon.physicalAlarm).toBe(soon.dueAt);
        const fired = await awaitEvent("alarm-claims", "claim.fired", "probe.soon");
        expect(fired.detail).toBe(soon.dueAt);

        // The fired claim released itself and the slot fell back to the surviving claim.
        expect(
            resultOf(await call("runtime", "alarm-claims", "alarms", {}, decodeLiveAlarmState))
        ).toEqual({
            physicalAlarm: late.dueAt,
            claims: [{ owner: "probe.late", dueAt: late.dueAt }]
        });
        saveState("alarmClaim", { owner: "probe.late", dueAt: late.dueAt });
    });

    it("[C13-CLOUDFLARE-ALARM-DURABILITY] re-fires an alarm whose handler threw, with no external re-arming", async () => {
        const armed = resultOf(
            await call(
                "runtime",
                "alarm-throw",
                "arm-throwing",
                { delayMs: 1_000, throwForMs: 5_000 },
                decodeThrowingResult
            )
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

        expect(
            resultOf(await call("runtime", "alarm-throw", "alarms", {}, decodeLiveAlarmState))
        ).toEqual({ physicalAlarm: null, claims: [] });
    });

    it("[C13-CLOUDFLARE-RECONCILIATION-FENCE] keeps a schedule written while reconciliation was in flight", async () => {
        const enqueued = resultOf(
            await call(
                "runtime",
                "fence",
                "enqueue",
                { id: "fenced", delayMs: ARM_DELAY_MS, hold: true },
                decodeEnqueueResult
            )
        );
        expect(enqueued.physicalAlarm).toBe(enqueued.scheduledAt);

        // The sweep is now awaiting inside reconcile with the object's input gate open.
        const started = await awaitEvent("fence", "reconcile.started", "fenced");
        const rescheduled = resultOf(
            await call(
                "runtime",
                "fence",
                "enqueue",
                { id: "fenced", delayMs: 3_600_000, release: true },
                decodeEnqueueResult
            )
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
        const settled = resultOf(
            await call("runtime", "fence", "outbox", {}, decodeLiveOutboxState)
        );
        expect(settled.entries).toEqual([{ id: "fenced", scheduledAt: rescheduled.scheduledAt }]);
        expect(settled.physicalAlarm).toBe(rescheduled.scheduledAt);

        // The fence is not merely permissive: the matching schedule does clear the entry.
        expect(
            resultOf(
                await call(
                    "runtime",
                    "fence",
                    "acknowledge",
                    { id: "fenced", scheduledAt: rescheduled.scheduledAt },
                    decodeLiveOutboxState
                )
            )
        ).toEqual({ entries: [], nextDueAt: null, physicalAlarm: null, claims: [] });
    });

    it("[C13-CLOUDFLARE-VIEW-ATTACHMENT] replays a hibernating WebSocket and keeps its attachment across an idle eviction window", async () => {
        const socket = await openSocket("socket", { channel: "live", acked: "0" });
        try {
            const replayed = await socket.take(2);
            expect(replayed.map((frame) => decodeViewStreamFrame(frame))).toMatchObject([
                { kind: "delta", channel: "live", revision: 1 },
                { kind: "delta", channel: "live", revision: 2 }
            ]);

            socket.send({ ack: 2 });
            const acknowledged = attachmentProbe(String((await socket.take(1))[0]));
            expect(acknowledged.before.ackedRevision).toBe(0);
            expect(acknowledged.after).toEqual({
                version: 1,
                channel: "live",
                ackedRevision: 2
            });
            // Nothing is left to replay once every revision is acknowledged.
            await sleep(1_000);
            expect(socket.pending()).toBe(0);

            expect(
                resultOf(await call("runtime", "socket", "sockets", {}, decodeSocketList))
            ).toEqual({ count: 1, attachments: [{ channel: "live", ackedRevision: 2 }] });

            // Long enough for the platform to evict the object while the socket stays open.
            await sleep(15_000);

            socket.send({ append: true });
            const woken = await socket.take(2);
            const probe = attachmentProbe(String(woken[0]));
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

            expect(
                resultOf(await call("runtime", "socket", "sockets", {}, decodeSocketList))
            ).toEqual({ count: 1, attachments: [{ channel: "live", ackedRevision: 2 }] });
        } finally {
            socket.close();
        }
    });

    it("[C13-CLOUDFLARE-QUEUE-DISPOSITION] acknowledges, redelivers, and dead-letters through a real queue", async () => {
        expect(
            resultOf(
                await call(
                    "queue",
                    "queue-live",
                    "publish",
                    { deliveryId: "q-ack", mode: "ack" },
                    decodeQueuePublish
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

    it("[C13-CLOUDFLARE-STORAGE-LIMIT] stores a row at the declared blob limit and refuses one past it", async () => {
        // The seam's limit is only correct if production actually accepts a row that
        // large, row overhead included — the one thing workerd cannot answer for it. So
        // this writes AT the limit, not near it: the documented bound covers the row, the
        // seam checks only the payload, and the margin between them is workerd's
        // undocumented SQLITE_LIMIT_LENGTH headroom. Writing under the limit exercises
        // none of that.
        expect(
            resultOf(
                await call(
                    "runtime",
                    "blob",
                    "blob",
                    { channel: "limits", bytes: SQL_BLOB_LIMIT_BYTES },
                    decodeBlobResult
                )
            )
        ).toEqual({ revision: 1, byteLength: SQL_BLOB_LIMIT_BYTES });

        const oversized = await call(
            "runtime",
            "blob",
            "blob",
            { channel: "limits", bytes: SQL_BLOB_LIMIT_BYTES + 1 },
            decodeBlobResult
        );
        expect(oversized.ok).toBe(false);
        // Refused as invalid input at the seam, before any transaction opens.
        expect(oversized.code).toBe("operation.invalid-input");

        // The rejection is contained: the object still serves and the log is intact.
        expect(
            resultOf(
                await call(
                    "runtime",
                    "blob",
                    "blob",
                    { channel: "limits", bytes: 1_000 },
                    decodeBlobResult
                )
            )
        ).toEqual({ revision: 2, byteLength: 1_000 });
        expect(
            resultOf(
                await call("runtime", "blob", "blob-read", { channel: "limits" }, decodeBlobRead)
            )
        ).toEqual({ currentRevision: 2, lastByteLength: 1_000 });
    });

    it("[C13-CLOUDFLARE-DEPLOYMENT-CONTINUITY] arms durable reconciliation work for the redeployed worker to finish", async () => {
        const enqueued = resultOf(
            await call(
                "runtime",
                "redeploy",
                "enqueue",
                { id: "survivor", delayMs: 3_600_000 },
                decodeEnqueueResult
            )
        );
        expect(enqueued.entries).toEqual([{ id: "survivor", scheduledAt: enqueued.scheduledAt }]);
        expect(enqueued.physicalAlarm).toBe(enqueued.scheduledAt);
        saveState("redeploy", { id: "survivor", scheduledAt: enqueued.scheduledAt });
    });
});
