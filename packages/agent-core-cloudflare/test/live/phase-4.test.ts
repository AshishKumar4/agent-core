import { describe, expect, it } from "vitest";
import { isJsonObject, jsonDataParser, type JsonObject, type JsonValue } from "@agent-core/core";
import {
    awaitEvent,
    call,
    decodeLiveOutboxState,
    harnessUrl,
    resultOf,
    type LiveOutboxState
} from "./harness";

/** Matches phase 2: short enough to settle inside this phase, long enough to observe. */
const ARM_DELAY_MS = 500;
const stateData = jsonDataParser((message) => new TypeError(message));

interface EnqueueResult extends LiveOutboxState {
    readonly scheduledAt: number;
}

interface BlobReadResult {
    readonly currentRevision: number;
    readonly lastByteLength: number | null;
}

/**
 * Phase 4 rolls forward to the release phase 3 refused for. Recovery is the whole claim:
 * the rollback left the durable state alone, so the object serves again with no repair
 * step, and the schema the rolled-back release could not read applies to objects it never
 * reached.
 */
describe("live Cloudflare substrate evidence after rolling forward again", () => {
    it("runs against the rolled-forward release", async () => {
        // Same reason as phase 3: one commit spans every deployment in this walk, so the
        // release is the only thing that says which of them answered. Asserting it here is
        // what makes the rest of this phase's evidence self-describing.
        const meta = await fetch(`${harnessUrl}/meta`);
        expect(meta.ok).toBe(true);
        expect(await meta.json()).toMatchObject({ release: "next" });
    });

    it("[C13-CLOUDFLARE-DEPLOYMENT-CONTINUITY] keeps the view revision log across a rollback and roll-forward", async () => {
        expect(
            resultOf(
                await call("runtime", "blob", "blob-read", { channel: "limits" }, decodeBlobRead)
            )
        ).toEqual({ currentRevision: 2, lastByteLength: 1_000 });
    });

    it("[C13-CLOUDFLARE-ROLLBACK-WINDOW] serves the refused object again with no repair step", async () => {
        const armed = resultOf(
            await call(
                "runtime",
                "blob",
                "enqueue",
                { id: "recovered", delayMs: ARM_DELAY_MS },
                decodeEnqueueResult
            )
        );
        expect(armed.entries).toEqual([{ id: "recovered", scheduledAt: armed.scheduledAt }]);
        expect(armed.physicalAlarm).toBe(armed.scheduledAt);
        await awaitEvent("blob", "reconcile.finished", "recovered");

        expect(
            resultOf(await call("runtime", "blob", "outbox", {}, decodeLiveOutboxState))
        ).toEqual({ entries: [], nextDueAt: null, physicalAlarm: null, claims: [] });
    });

    it("[C13-CLOUDFLARE-ADDITIVE-MIGRATION] applies this release's own migration to an object the previous release created", async () => {
        // Phase 3 created this object under the rolled-back release, so its schema stops at
        // that release; serving it here applies the newer migration to durable state that
        // already exists, which is the forward half of the same window.
        expect(await call("runtime", "rollback-fresh", "outbox")).toMatchObject({ ok: true });
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
