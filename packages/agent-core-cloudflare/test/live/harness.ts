import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
    isJsonObject,
    isJsonValue,
    jsonDataParser,
    type JsonObject,
    type JsonValue
} from "@agent-core/core";

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

export interface LiveOutcome<Result = JsonValue> {
    readonly ok: boolean;
    readonly result?: Result | null;
    readonly code?: string;
    readonly message?: string;
}

export interface LiveResult {
    readonly name: string | undefined;
    readonly value: string | undefined;
    readonly materialization: string | undefined;
}

interface DecodedLiveOutcome {
    ok: boolean;
    result?: JsonValue;
    code?: string;
    message?: string;
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

export type LiveResultDecoder<Result> = (value: JsonValue) => Result;

const liveData = jsonDataParser((message) => new TypeError(message));

// Durable Object instances persist across evidence runs; suffixing every instance
// with the run ID keeps each run's scenarios on fresh substrate state.
export function instanceName(instance: string): string {
    return `${instance}-${runId}`;
}

export function call(
    lane: LiveLane,
    instance: string,
    operation: string,
    body?: Record<string, JsonValue>
): Promise<LiveOutcome>;
export function call<Result>(
    lane: LiveLane,
    instance: string,
    operation: string,
    body: Record<string, JsonValue>,
    decodeResult: LiveResultDecoder<Result>
): Promise<LiveOutcome<Result>>;
export async function call<Result>(
    lane: LiveLane,
    instance: string,
    operation: string,
    body: Record<string, JsonValue> = {},
    decodeResult?: LiveResultDecoder<Result>
): Promise<LiveOutcome | LiveOutcome<Result>> {
    const response = await fetch(`${harnessUrl}/${lane}/${instanceName(instance)}/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
    if (response.status === 204) return { ok: true, result: null };
    if (!response.ok && response.status !== 409 && response.status !== 500) {
        throw new TypeError(`Live harness ${operation} failed with HTTP ${response.status}`);
    }
    // A 500 from the worker carries a structured outcome; a 500 from Cloudflare's edge
    // carries an HTML error page, and the two are the same status code. Parsing the second
    // as the first is what turned a mid-swap redeployment window into
    // `Unexpected token '<'`. The content type is the only thing that separates them, so
    // an answer that is not JSON is a platform-level transient and says so.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
        // Carry a prefix of the page. Cloudflare names its own failure in it — 1101 for a
        // worker exception, 1102 for exceeded resources, a plain 5xx for an unavailable or
        // mid-swap worker — and that string is the only thing that tells a deployment
        // window apart from the worker having actually died. Without it this costs a
        // second deploy to learn.
        throw new PlatformTransient(operation, response.status, contentType, await response.text());
    }
    const decoded: unknown = await response.json();
    if (!isJsonValue(decoded) || !isJsonObject(decoded)) {
        throw new TypeError(`Live harness ${operation} returned an invalid outcome`);
    }
    const outcome = decodeOutcome(decoded, operation);
    if (response.status === 500) {
        throw new TypeError(
            `Live harness ${operation} raised an unhandled failure: ${outcome.message ?? "no cause reported"}`
        );
    }
    if (decodeResult === undefined || outcome.result === undefined || outcome.result === null) {
        return outcome;
    }
    return Object.freeze({ ...outcome, result: decodeResult(outcome.result) });
}

function decodeOutcome(value: JsonObject, operation: string): LiveOutcome {
    const ok = liveData.boolean(value["ok"], `Live harness ${operation} outcome`);
    const result = value["result"];
    const code = optionalText(value["code"], `Live harness ${operation} code`);
    const message = optionalText(value["message"], `Live harness ${operation} message`);
    const outcome: DecodedLiveOutcome = { ok };
    if (result !== undefined) outcome.result = result;
    if (code !== undefined) outcome.code = code;
    if (message !== undefined) outcome.message = message;
    return Object.freeze(outcome);
}

function optionalText(value: JsonValue | undefined, subject: string): string | undefined {
    return value === undefined ? undefined : liveData.string(value, subject);
}

export function decodeLiveResult(value: JsonValue): LiveResult {
    const result = liveData.object(value, "Live result");
    return {
        name: optionalText(result["name"], "Live result name"),
        value: optionalText(result["value"], "Live result value"),
        materialization: optionalText(result["materialization"], "Live result materialization")
    };
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

export function decodeLiveAlarmState(value: JsonValue): LiveAlarmState {
    const state = liveData.object(value, "Live alarm state");
    return {
        physicalAlarm: nullableInteger(state["physicalAlarm"], "Live physical alarm"),
        claims: liveData.array(state["claims"], "Live alarm claims").map((claimValue) => {
            const claim = liveData.object(claimValue, "Live alarm claim");
            return {
                owner: liveData.nonemptyString(claim["owner"], "Live alarm claim owner"),
                dueAt: liveData.safeInteger(claim["dueAt"], "Live alarm claim due time")
            };
        })
    };
}

export function decodeLiveOutboxState(value: JsonValue): LiveOutboxState {
    const state = liveData.object(value, "Live outbox state");
    const alarm = decodeLiveAlarmState(value);
    return {
        ...alarm,
        entries: liveData.array(state["entries"], "Live outbox entries").map((entryValue) => {
            const entry = liveData.object(entryValue, "Live outbox entry");
            return {
                id: liveData.nonemptyString(entry["id"], "Live outbox entry ID"),
                scheduledAt: liveData.safeInteger(
                    entry["scheduledAt"],
                    "Live outbox entry schedule"
                )
            };
        }),
        nextDueAt: nullableInteger(state["nextDueAt"], "Live outbox next due time")
    };
}

function nullableInteger(value: JsonValue | undefined, subject: string): number | null {
    return value === null ? null : liveData.safeInteger(value, subject);
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

/**
 * Cloudflare answered instead of the worker: an HTML error page, a 5xx from the edge
 * while the worker is unavailable, or the window during a redeployment when the new
 * version has not taken over. It is not a worker outcome and MUST NOT be read as one.
 */
export class PlatformTransient extends Error {
    public constructor(
        public readonly operation: string,
        public readonly status: number,
        public readonly contentType: string,
        public readonly page: string
    ) {
        super(
            `Live harness ${operation} was answered by the platform, not the worker: ` +
                `HTTP ${status} with content-type ${contentType.length === 0 ? "(absent)" : contentType}` +
                ` — ${collapse(page)}`
        );
    }
}

/** The page's own words, on one line and bounded: enough to read Cloudflare's error code. */
function collapse(page: string): string {
    const text = page
        .replace(/<[^>]*>/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    return text.length === 0
        ? "(empty body)"
        : text.length <= 400
          ? text
          : `${text.slice(0, 400)}…`;
}

/**
 * Retries `attempt` only while the platform is answering instead of the worker, and only
 * inside a stated window. A worker-authored failure is never retried — it is the evidence
 * the scenario exists to collect, and swallowing it would make this a decoder that shrugs.
 * Use it exactly where a scenario deliberately spans a deployment.
 */
export async function throughDeploymentWindow<Value>(
    label: string,
    attempt: () => Promise<Value>,
    windowMs: number,
    intervalMs = 1_000
): Promise<Value> {
    const deadline = Date.now() + windowMs;
    for (;;) {
        try {
            return await attempt();
        } catch (cause) {
            if (!(cause instanceof PlatformTransient)) throw cause;
            if (Date.now() >= deadline) {
                throw new TypeError(
                    `Live harness saw only the platform for ${windowMs} ms at ${label}: ${cause.message}`
                );
            }
            await sleep(intervalMs);
        }
    }
}

export async function events(instance: string): Promise<readonly LiveEvent[]> {
    return resultOf(await call("runtime", instance, "events", {}, decodeEventList)).events;
}

interface LiveEventList {
    readonly events: readonly LiveEvent[];
}

function decodeEventList(value: JsonValue): LiveEventList {
    const result = liveData.object(value, "Live event result");
    return {
        events: liveData.array(result["events"], "Live events").map((eventValue) => {
            const event = liveData.object(eventValue, "Live event");
            // Every rejection here names the row it rejected. The lane costs a deploy per
            // attempt, so a decoder that reports its constraint without its input turns
            // one bad field into a second live run.
            return withOffendingValue(event, () => ({
                ordinal: liveData.safeInteger(event["ordinal"], "Live event ordinal"),
                kind: liveData.nonemptyString(event["kind"], "Live event kind"),
                // An object-wide event has no subject: the worker records alarm.fired with
                // an empty one on purpose. Demanding nonempty here rejected every alarm
                // scenario the moment the decoder was tightened.
                subject: liveData.string(event["subject"], "Live event subject"),
                at: liveData.safeInteger(event["at"], "Live event time"),
                // Non-negative on purpose. A worker that needs to say more than a
                // magnitude here owes a distinct event kind, not a sign bit: this
                // rejected a resumption event that had encoded "was interrupted" as a
                // negated attempt number, and the worker was the thing that was wrong.
                detail: liveData.safeInteger(event["detail"], "Live event detail")
            }));
        })
    };
}

/** Re-raises a decoding refusal with the exact row that caused it. */
function withOffendingValue<Decoded>(offending: JsonValue, decode: () => Decoded): Decoded {
    try {
        return decode();
    } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new TypeError(`${reason} — rejected ${JSON.stringify(offending)}`);
    }
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
    const decoded: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonValue(decoded) || !isJsonObject(decoded)) {
        throw new TypeError("Live state file must contain a JSON object");
    }
    return decoded;
}
