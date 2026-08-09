import { describe, expect, it } from "vitest";
import {
    awaitEvent,
    call,
    loadState,
    resultOf,
    type LiveAlarmState,
    type LiveOutboxState
} from "./harness";

/** Matches phase 1: the arming response must still describe an unswept outbox. */
const ARM_DELAY_MS = 500;

interface EnqueueResult extends LiveOutboxState {
    readonly scheduledAt: number;
}

function pin(environment: string, revision = 0, generation = 0): Record<string, string | number> {
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
        const state = loadState("slate") as {
            readonly deployment: Record<string, string | number>;
            readonly materialization: string;
            readonly resource: Record<string, string | number>;
        };
        expect(await call("slate", "deploy", "reconcile-deploy", state.deployment)).toMatchObject({
            ok: true,
            result: { materialization: state.materialization }
        });
        const materialized = await call("slate", "deploy", "materialize-resource", state.resource);
        expect(materialized.ok).toBe(true);
        expect(await call("slate", "deploy", "reconcile-resource", state.resource)).toMatchObject({
            ok: true,
            result: { materialization: materialized.result?.materialization }
        });
    });

    it("[C13-CLOUDFLARE-ALARM-CLAIMS] keeps an alarm claim and its physical alarm across a full worker redeployment", async () => {
        const claim = loadState("alarmClaim") as { readonly owner: string; readonly dueAt: number };
        expect(resultOf(await call<LiveAlarmState>("runtime", "alarm-claims", "alarms"))).toEqual({
            physicalAlarm: claim.dueAt,
            claims: [{ owner: claim.owner, dueAt: claim.dueAt }]
        });

        // Releasing the last claim under the new code version tears the slot down.
        expect(
            resultOf(
                await call<LiveAlarmState>("runtime", "alarm-claims", "unclaim", { owner: "late" })
            )
        ).toEqual({ physicalAlarm: null, claims: [] });
    });

    it("[C13-CLOUDFLARE-DEPLOYMENT-CONTINUITY] finishes reconciliation work armed before the redeployment", async () => {
        const armed = loadState("redeploy") as {
            readonly id: string;
            readonly scheduledAt: number;
        };
        const survived = resultOf(await call<LiveOutboxState>("runtime", "redeploy", "outbox"));
        expect(survived.entries).toEqual([{ id: armed.id, scheduledAt: armed.scheduledAt }]);
        expect(survived.physicalAlarm).toBe(armed.scheduledAt);

        // Pulling the schedule into the present makes the redeployed worker's alarm fire it.
        const due = resultOf(
            await call<EnqueueResult>("runtime", "redeploy", "enqueue", {
                id: armed.id,
                delayMs: ARM_DELAY_MS
            })
        );
        expect(due.physicalAlarm).toBe(due.scheduledAt);
        await awaitEvent("redeploy", "reconcile.finished", armed.id);

        expect(resultOf(await call<LiveOutboxState>("runtime", "redeploy", "outbox"))).toEqual({
            entries: [],
            nextDueAt: null,
            physicalAlarm: null,
            claims: []
        });
    });

    it("[C13-CLOUDFLARE-DEPLOYMENT-CONTINUITY] keeps the view revision log across a full worker redeployment", async () => {
        expect(
            resultOf(
                await call<{
                    readonly currentRevision: number;
                    readonly lastByteLength: number | null;
                }>("runtime", "blob", "blob-read", { channel: "limits" })
            )
        ).toEqual({ currentRevision: 2, lastByteLength: 1_000 });
    });
});
