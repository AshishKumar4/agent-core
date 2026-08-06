import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { JsonValue } from "@agent-core/core";

const url = process.env["LIVE_HARNESS_URL"];
if (url === undefined || url.length === 0) {
    throw new TypeError("LIVE_HARNESS_URL must point at the deployed live harness");
}
export const harnessUrl: string = url.replace(/\/$/u, "");

const runId = process.env["LIVE_RUN_ID"];
if (runId === undefined || runId.length === 0) {
    throw new TypeError("LIVE_RUN_ID must identify this evidence run");
}

const stateFile = process.env["LIVE_STATE_FILE"];

export type LiveLane = "env" | "slate" | "runtime" | "queue";

export interface LiveResult {
    readonly name?: string;
    readonly value?: string;
    readonly materialization?: string;
}

export interface LiveOutcome<Result = LiveResult> {
    readonly ok: boolean;
    readonly result?: Result | null;
    readonly code?: string;
    readonly message?: string;
}

export interface LiveClaim {
    readonly owner: string;
    readonly dueAt: number;
}

export interface LiveAlarmState {
    readonly physicalAlarm: number | null;
    readonly claims: readonly LiveClaim[];
}

export interface LiveOutboxState extends LiveAlarmState {
    readonly entries: readonly { readonly id: string; readonly scheduledAt: number }[];
    readonly nextDueAt: number | null;
}

export interface LiveEvent {
    readonly ordinal: number;
    readonly kind: string;
    readonly subject: string;
    readonly at: number;
    readonly detail: number;
}

// Durable Object instances persist across evidence runs; suffixing every instance
// with the run ID keeps each run's scenarios on fresh substrate state.
export function instanceName(instance: string): string {
    return `${instance}-${runId}`;
}

export async function call<Result = LiveResult>(
    lane: LiveLane,
    instance: string,
    operation: string,
    body: Record<string, JsonValue> = {}
): Promise<LiveOutcome<Result>> {
    const response = await fetch(`${harnessUrl}/${lane}/${instanceName(instance)}/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
    if (response.status === 204) return { ok: true, result: null };
    if (!response.ok && response.status !== 409) {
        throw new TypeError(`Live harness ${operation} failed with HTTP ${response.status}`);
    }
    return (await response.json()) as LiveOutcome<Result>;
}

/** The successful result of a lane call, or a failure carrying the lane's own cause. */
export function resultOf<Result>(outcome: LiveOutcome<Result>): Result {
    if (outcome.ok !== true || outcome.result === undefined || outcome.result === null) {
        throw new TypeError(
            `Live lane failed: ${outcome.code ?? "unknown"} ${outcome.message ?? ""}`
        );
    }
    return outcome.result;
}

export async function abortInstance(lane: LiveLane, instance: string): Promise<void> {
    try {
        const response = await fetch(`${harnessUrl}/${lane}/${instanceName(instance)}/abort`, {
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

export function sleep(milliseconds: number): Promise<void> {
    return new Promise((settle) => setTimeout(settle, milliseconds));
}

/** Retries `probe` until it yields a value; live scenarios never assert on latency. */
export async function poll<Value>(
    label: string,
    probe: () => Promise<Value | undefined>,
    timeoutMs = 45_000,
    intervalMs = 500
): Promise<Value> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value !== undefined) return value;
        if (Date.now() >= deadline) throw new TypeError(`Live harness never reached: ${label}`);
        await sleep(intervalMs);
    }
}

export async function events(instance: string): Promise<readonly LiveEvent[]> {
    return resultOf(
        await call<{ readonly events: readonly LiveEvent[] }>("runtime", instance, "events")
    ).events;
}

export async function awaitEvent(
    instance: string,
    kind: string,
    subject: string,
    timeoutMs?: number
): Promise<LiveEvent> {
    return poll(
        `${kind} for ${subject} on ${instance}`,
        async () =>
            (await events(instance)).find(
                (event) => event.kind === kind && event.subject === subject
            ),
        timeoutMs
    );
}

export interface LiveSocket {
    send(message: Record<string, JsonValue>): void;
    /** Waits for `count` frames, then hands over their raw text in arrival order. */
    take(count: number, timeoutMs?: number): Promise<readonly string[]>;
    pending(): number;
    close(): void;
}

export async function openSocket(
    instance: string,
    query: Record<string, string>
): Promise<LiveSocket> {
    const target = new URL(`${harnessUrl}/runtime/${instanceName(instance)}/socket`);
    target.protocol = "wss:";
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    const socket = new WebSocket(target.toString());
    const received: string[] = [];
    socket.addEventListener("message", (event) => {
        received.push(String(event.data));
    });
    await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
            "error",
            () => reject(new TypeError(`Live WebSocket to ${instance} failed to open`)),
            { once: true }
        );
    });
    return {
        send(message): void {
            socket.send(JSON.stringify(message));
        },
        async take(count, timeoutMs = 30_000): Promise<readonly string[]> {
            await poll(
                `${count} socket frames from ${instance}`,
                async () => (received.length >= count ? true : undefined),
                timeoutMs,
                100
            );
            return received.splice(0, count);
        },
        pending: (): number => received.length,
        close(): void {
            socket.close();
        }
    };
}

/** Cross-phase state: written by phase 1, replayed against the redeployed worker by phase 2. */
export function saveState(key: string, value: JsonValue): void {
    if (stateFile === undefined) throw new TypeError("LIVE_STATE_FILE is required in phase 1");
    writeFileSync(stateFile, JSON.stringify({ ...readState(stateFile), [key]: value }, null, 2));
}

export function loadState(key: string): JsonValue {
    if (stateFile === undefined) throw new TypeError("LIVE_STATE_FILE is required in phase 2");
    const value = readState(stateFile)[key];
    if (value === undefined) throw new TypeError(`Phase 1 recorded no live state for ${key}`);
    return value;
}

function readState(path: string): Record<string, JsonValue> {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, JsonValue>;
}
