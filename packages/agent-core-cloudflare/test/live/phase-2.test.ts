import { describe, expect, it } from "vitest";
import { isJsonObject, jsonDataParser, type JsonObject, type JsonValue } from "@agent-core/core";
import {
    awaitEvent,
    call,
    decodeLiveAlarmState,
    decodeLiveOutboxState,
    decodeLiveResult,
    loadState,
    resultOf,
    type LiveOutboxState
} from "./harness";

/** Matches phase 1: the arming response must still describe an unswept outbox. */
const ARM_DELAY_MS = 500;
const stateData = jsonDataParser((message) => new TypeError(message));

interface EnqueueResult extends LiveOutboxState {
    readonly scheduledAt: number;
}

interface BlobReadResult {
    readonly currentRevision: number;
    readonly lastByteLength: number | null;
}

function pin(environment: string, revision = 0, generation = 0) {
    return { environmentId: environment, environmentRevision: revision, generation };
}

describe("live Cloudflare substrate evidence after redeployment", () => {
    it("[P11-ENVIRONMENT-EPHEMERAL-DURABILITY] keeps session state across a full worker redeployment", async () => {
        const session = { ...pin("env-durable"), sessionId: "sess-durable" };
        expect(await call("env", "durability", "inspect", session)).toMatchObject({
            ok: true,
            result: { name: "ready" }
        });
        const read = await call("env", "durability", "read-file", {
            ...session,
            path: "state.txt"
        });
        expect(Buffer.from(String(read.result), "base64")).toEqual(Buffer.from([1, 2, 3]));
    });

    it("[P11-SLATE-DEPLOY] settles a deployment recorded before the redeployment to its exact materialization", async () => {
        const state = stateObject(loadState("slate"), "slate state");
        const deployment = stateObject(state["deployment"], "slate deployment");
        const materialization = stateData.nonemptyString(
            state["materialization"],
            "slate materialization"
        );
        const resource = stateObject(state["resource"], "slate resource");
        expect(await call("slate", "deploy", "reconcile-deploy", deployment)).toMatchObject({
            ok: true,
            result: { materialization }
        });
        const materialized = await call(
            "slate",
            "deploy",
            "materialize-resource",
            resource,
            decodeLiveResult
        );
        expect(materialized.ok).toBe(true);
        expect(await call("slate", "deploy", "reconcile-resource", resource)).toMatchObject({
            ok: true,
            result: { materialization: materialized.result?.materialization }
        });
    });

    it("[C13-CLOUDFLARE-ALARM-CLAIMS] keeps an alarm claim and its physical alarm across a full worker redeployment", async () => {
        const claim = stateObject(loadState("alarmClaim"), "alarm claim");
        const owner = stateData.nonemptyString(claim["owner"], "alarm claim owner");
        const dueAt = stateData.safeInteger(claim["dueAt"], "alarm claim time");
        expect(
            resultOf(await call("runtime", "alarm-claims", "alarms", {}, decodeLiveAlarmState))
        ).toEqual({ physicalAlarm: dueAt, claims: [{ owner, dueAt }] });

        // Releasing the last claim under the new code version tears the slot down.
        expect(
            resultOf(
                await call(
                    "runtime",
                    "alarm-claims",
                    "unclaim",
                    { owner: "late" },
                    decodeLiveAlarmState
                )
            )
        ).toEqual({ physicalAlarm: null, claims: [] });
    });

    it("[C13-CLOUDFLARE-DEPLOYMENT-CONTINUITY] finishes reconciliation work armed before the redeployment", async () => {
        const armed = stateObject(loadState("redeploy"), "redeployment state");
        const id = stateData.nonemptyString(armed["id"], "redeployment ID");
        const scheduledAt = stateData.safeInteger(armed["scheduledAt"], "redeployment schedule");
        const survived = resultOf(
            await call("runtime", "redeploy", "outbox", {}, decodeLiveOutboxState)
        );
        expect(survived.entries).toEqual([{ id, scheduledAt }]);
        expect(survived.physicalAlarm).toBe(scheduledAt);

        // Pulling the schedule into the present makes the redeployed worker's alarm fire it.
        const due = resultOf(
            await call(
                "runtime",
                "redeploy",
                "enqueue",
                { id, delayMs: ARM_DELAY_MS },
                decodeEnqueueResult
            )
        );
        expect(due.physicalAlarm).toBe(due.scheduledAt);
        await awaitEvent("redeploy", "reconcile.finished", id);

        expect(
            resultOf(await call("runtime", "redeploy", "outbox", {}, decodeLiveOutboxState))
        ).toEqual({ entries: [], nextDueAt: null, physicalAlarm: null, claims: [] });
    });

    it("[C13-CLOUDFLARE-DEPLOYMENT-CONTINUITY] keeps the view revision log across a full worker redeployment", async () => {
        expect(
            resultOf(
                await call("runtime", "blob", "blob-read", { channel: "limits" }, decodeBlobRead)
            )
        ).toEqual({ currentRevision: 2, lastByteLength: 1_000 });
    });
});

function stateObject(value: JsonValue | undefined, subject: string): JsonObject {
    if (!isJsonObject(value)) throw new TypeError(`${subject} must be a JSON object`);
    return value;
}

function decodeEnqueueResult(value: JsonValue): EnqueueResult {
    const state = stateObject(value, "Live enqueue result");
    return {
        ...decodeLiveOutboxState(value),
        scheduledAt: stateData.safeInteger(state["scheduledAt"], "Live enqueue schedule")
    };
}

function decodeBlobRead(value: JsonValue): BlobReadResult {
    const result = stateObject(value, "Live blob read result");
    const lastByteLength = result["lastByteLength"];
    return {
        currentRevision: stateData.safeInteger(
            result["currentRevision"],
            "Live blob current revision"
        ),
        lastByteLength:
            lastByteLength === null
                ? null
                : stateData.safeInteger(lastByteLength, "Live blob byte length")
    };
}
