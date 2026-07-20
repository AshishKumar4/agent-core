import { readFileSync, writeFileSync } from "node:fs";
import type { JsonValue } from "@agent-core/core";

const url = process.env["LIVE_HARNESS_URL"];
if (url === undefined || url.length === 0) {
    throw new TypeError("LIVE_HARNESS_URL must point at the deployed live harness");
}
export const harnessUrl: string = url.replace(/\/$/u, "");

export const phase: 1 | 2 = process.env["LIVE_PHASE"] === "2" ? 2 : 1;

const stateFile = process.env["LIVE_STATE_FILE"];

export interface LiveOutcome {
    readonly ok: boolean;
    readonly result?: { readonly name?: string; readonly value?: string; readonly materialization?: string } | null;
    readonly code?: string;
    readonly message?: string;
}

export async function call(
    lane: "env" | "slate",
    instance: string,
    operation: string,
    body: Record<string, JsonValue> = {}
): Promise<LiveOutcome> {
    const response = await fetch(`${harnessUrl}/${lane}/${instance}/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
    if (response.status === 204) return { ok: true, result: null };
    if (!response.ok && response.status !== 409) {
        throw new TypeError(`Live harness ${operation} failed with HTTP ${response.status}`);
    }
    return (await response.json()) as LiveOutcome;
}

export async function abortInstance(lane: "env" | "slate", instance: string): Promise<void> {
    try {
        const response = await fetch(`${harnessUrl}/${lane}/${instance}/abort`, {
            method: "POST"
        });
        if (response.status !== 204 && response.status < 500) {
            throw new TypeError(`Live harness abort failed with HTTP ${response.status}`);
        }
    } catch {
        // The runtime may sever the connection while killing the instance. The next
        // request in the test proves the instance came back; a dead harness fails there.
    }
}

/** Cross-phase state: written by phase 1, replayed against the redeployed worker by phase 2. */
export function saveState(state: Record<string, JsonValue>): void {
    if (stateFile === undefined) throw new TypeError("LIVE_STATE_FILE is required in phase 1");
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

export function loadState(): Record<string, JsonValue> {
    if (stateFile === undefined) throw new TypeError("LIVE_STATE_FILE is required in phase 2");
    return JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, JsonValue>;
}
