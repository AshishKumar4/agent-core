import { describe, expect, test } from "vitest";
import { AgentCoreError, type JsonValue } from "@agent-core/core";
import {
    decodeViewStreamFrame,
    type ViewSocketAttachment,
    type ViewStreamFrame
} from "../src/index.js";

/**
 * The `view.stream` service contract.
 *
 * The peer on the other side of this seam is an untrusted network client: it opens a
 * WebSocket against a Durable Object, the object hibernates between messages, and every
 * acknowledgement it sends is a number the runtime did not choose. That makes this the one
 * genuinely inbound protocol in `src/` — `durable-object.ts` exposes it as
 * `AgentCoreDurableRuntime.webSockets`, and `test/cloudflare/worker.ts#webSocketMessage`
 * feeds it straight from the peer's frame.
 *
 * The seam is `websocket.ts#HibernatingViewSocketAdapter`: `accept` attaches the session's
 * cursor and replays, `replay` re-sends everything after that cursor, `acknowledge` moves
 * the cursor, and `attachment` reads it back. The frames it emits are the published
 * grammar, decodable by `websocket.ts#decodeViewStreamFrame`, which both implementations
 * in the runner decode through: the grammar belongs to the protocol rather than to either
 * side of it, so a frame that violates it fails the contract for whoever produced it.
 *
 * `websocket.ts` is byte-frozen by the live-evidence manifest. Nothing here edits it;
 * where the contract finds something the protocol does not constrain, that is recorded as
 * a finding rather than repaired.
 */

/**
 * The closed operation vocabulary: the peer's one inbound verb plus the two outbound frame
 * kinds. `accept`, `replay` and `attachment` are the host-side entries that drive the
 * protocol — a peer never names them — so they are the contract's calls rather than its
 * operations.
 */
export const VIEW_STREAM_OPERATIONS = Object.freeze(["acknowledge", "snapshot", "delta"] as const);

export type ViewStreamOperation = (typeof VIEW_STREAM_OPERATIONS)[number];

/** The outbound half of the vocabulary, which is exactly `ViewStreamFrame["kind"]`. */
export const VIEW_STREAM_FRAME_KINDS = Object.freeze(["snapshot", "delta"] as const);

/**
 * The frame grammar as a closed vocabulary: `version` is 1, `kind` is one of
 * `VIEW_STREAM_FRAME_KINDS`, `channel` is a non-empty string, `revision` is a safe
 * integer, and `payload` is a string. Every one of those is a field
 * `decodeViewStreamFrame` reads and refuses.
 */
export const VIEW_STREAM_FRAME_FIELDS = Object.freeze([
    "version",
    "kind",
    "channel",
    "revision",
    "payload"
] as const);

/** The only frame and attachment version this protocol speaks. */
export const VIEW_STREAM_VERSION = 1;

/**
 * The ceiling `websocket.ts#requireAttachmentSize` measures against: the documented
 * `WebSocket.serializeAttachment` limit. The module keeps its own constant private, so the
 * contract names the same number here rather than putting a bare literal at a decision
 * site, and every oversize fixture below is derived from it.
 */
export const VIEW_STREAM_ATTACHMENT_LIMIT_BYTES = 16_384;

/**
 * The closed refusal vocabulary: the seam was reached and its answer is a failure. Every
 * code is a `CloudflareOperationalErrorCode` (`error.ts`).
 */
export const VIEW_STREAM_REFUSALS = Object.freeze([
    "codec.invalid",
    "operation.invalid-input",
    "protocol.invalid-state",
    "protocol.revision-conflict"
] as const);

export type ViewStreamRefusalCode = (typeof VIEW_STREAM_REFUSALS)[number];

/**
 * The closed failure vocabulary: one member per distinct way this protocol refuses. Four
 * codes carry twenty-one mechanisms, so naming the mechanisms is what lets the totality
 * case claim that every declared way of failing reaches a code rather than merely that
 * four codes are reachable.
 */
export const VIEW_STREAM_FAILURES = Object.freeze([
    "frame-not-json",
    "frame-not-json-data",
    "frame-not-object",
    "frame-field-unreadable",
    "frame-wrong-version",
    "frame-unknown-kind",
    "attachment-not-object",
    "attachment-field-unreadable",
    "attachment-wrong-version",
    "attachment-oversized-persisted",
    "empty-channel",
    "negative-revision",
    "unsafe-revision",
    "attachment-oversized-new",
    "acknowledgement-below-attached",
    "acknowledgement-above-current",
    "accept-failed",
    "send-failed",
    "serialize-failed",
    "deserialize-failed",
    "attachment-oversized-write"
] as const);

export type ViewStreamFailure = (typeof VIEW_STREAM_FAILURES)[number];

/**
 * Failure to stable code, with the site that decides it.
 *
 * `codec.invalid` — `websocket.ts#decodeViewStreamFrame` for the six frame mechanisms (the
 * `JSON.parse` catch, its `isJsonValue` guard inside that try, its `isJsonObject` guard,
 * the `persistedData` field readers, and the combined version/kind guard); and
 * `websocket.ts#decodePersistedAttachment` for the four attachment mechanisms (its
 * `isJsonObject` guard, its field-reader catch, its version guard, and the
 * `requireAttachmentSize` call it makes with `codec.invalid`).
 *
 * `operation.invalid-input` — `websocket.ts#createAttachment` for an empty channel,
 * `websocket.ts#requireInputRevision` for a revision that is not a non-negative safe
 * integer (reached from both `accept` and `acknowledge`), and the
 * `requireAttachmentSize` call `HibernatingViewSocketAdapter.accept` makes with
 * `operation.invalid-input`.
 *
 * `protocol.revision-conflict` — the range guard in
 * `HibernatingViewSocketAdapter.acknowledge`, in both directions.
 *
 * `protocol.invalid-state` — the `acceptWebSocket` catch in
 * `HibernatingViewSocketAdapter.accept`, the `socket.send` catch in its private `send`,
 * the `serializeAttachment` catch and the `requireAttachmentSize` call in its private
 * `storeAttachment`, and the `deserializeAttachment` catch in its private
 * `readAttachment`.
 */
export const VIEW_STREAM_TAXONOMY: Readonly<Record<ViewStreamFailure, ViewStreamRefusalCode>> =
    Object.freeze({
        "frame-not-json": "codec.invalid",
        "frame-not-json-data": "codec.invalid",
        "frame-not-object": "codec.invalid",
        "frame-field-unreadable": "codec.invalid",
        "frame-wrong-version": "codec.invalid",
        "frame-unknown-kind": "codec.invalid",
        "attachment-not-object": "codec.invalid",
        "attachment-field-unreadable": "codec.invalid",
        "attachment-wrong-version": "codec.invalid",
        "attachment-oversized-persisted": "codec.invalid",
        "empty-channel": "operation.invalid-input",
        "negative-revision": "operation.invalid-input",
        "unsafe-revision": "operation.invalid-input",
        "attachment-oversized-new": "operation.invalid-input",
        "acknowledgement-below-attached": "protocol.revision-conflict",
        "acknowledgement-above-current": "protocol.revision-conflict",
        "accept-failed": "protocol.invalid-state",
        "send-failed": "protocol.invalid-state",
        "serialize-failed": "protocol.invalid-state",
        "deserialize-failed": "protocol.invalid-state",
        "attachment-oversized-write": "protocol.invalid-state"
    });

/**
 * The closed reply vocabulary. `served` is what a host-side entry produces: the frames
 * that entry pushed to the peer, decoded through the published grammar, plus the running
 * count of attachment writes. `attached` is the cursor read back, `decoded` is a peer
 * parsing one frame.
 *
 * `indeterminate` is load-bearing and is never collapsed into a refusal: an undeclared
 * throw means the runtime does not know what happened, which is a different claim from
 * "the stream refused". The cause travels whole.
 */
export type ViewStreamReply =
    | {
          readonly kind: "served";
          readonly frames: readonly ViewStreamFrame[];
          readonly writes: number;
      }
    | { readonly kind: "attached"; readonly attachment: ViewSocketAttachment }
    | { readonly kind: "decoded"; readonly frame: ViewStreamFrame }
    | { readonly kind: "refused"; readonly code: ViewStreamRefusalCode }
    | { readonly kind: "indeterminate"; readonly cause: unknown };

/**
 * Membership over a closed literal set, so a code the union does not carry cannot be
 * classified. A record rather than a Set because the table is static and string-keyed;
 * `provider-capability.ts#DISCLOSED_CODES` states its disclosed set the same way.
 */
const REFUSAL_CODES: Readonly<Record<string, ViewStreamRefusalCode | undefined>> = Object.freeze(
    Object.fromEntries(VIEW_STREAM_REFUSALS.map((code) => [code, code]))
);

/** One act of the protocol, named by the entry the host reaches it through. */
export type ViewStreamCall =
    | { readonly entry: "open"; readonly channel: string; readonly ackedRevision: number }
    | { readonly entry: "replay" }
    | { readonly entry: "acknowledge"; readonly revision: number }
    | { readonly entry: "attachment" }
    | { readonly entry: "decode"; readonly frame: string };

/**
 * One peer session, plus the three facts about it that are not in any reply: what the
 * transport could see on the socket at the instant it accepted it, the raw text the peer
 * received, and how many attachments have been written.
 *
 * `sent` answers text rather than frames on purpose. The view stream is a text protocol,
 * and handing the contract the text is what lets `decodeViewStreamFrame` — the grammar the
 * runtime publishes to peers — be the thing that judges the runtime's own output.
 */
export interface ViewStreamSession {
    open(channel: string, ackedRevision: number): void;
    replay(): void;
    acknowledge(revision: number): void;
    attachment(): ViewSocketAttachment;
    acceptedWith(): readonly JsonValue[];
    sent(): readonly string[];
    writes(): number;
}

/**
 * One call, one reply value. This is the whole correspondence between what the adapter
 * throws and what the contract says the stream answered, and it is the only place in these
 * files that inspects a thrown value.
 */
export function viewStreamReply(session: ViewStreamSession, call: ViewStreamCall): ViewStreamReply {
    const before = session.sent().length;
    try {
        if (call.entry === "decode") {
            return { kind: "decoded", frame: decodeViewStreamFrame(call.frame) };
        }
        if (call.entry === "attachment") {
            return { kind: "attached", attachment: session.attachment() };
        }
        if (call.entry === "open") session.open(call.channel, call.ackedRevision);
        else if (call.entry === "replay") session.replay();
        else session.acknowledge(call.revision);
        return {
            kind: "served",
            // Decoded, not trusted: a frame the runtime emits that its own published
            // grammar rejects refuses right here.
            frames: session
                .sent()
                .slice(before)
                .map((text) => decodeViewStreamFrame(text)),
            writes: session.writes()
        };
    } catch (cause) {
        const refused = cause instanceof AgentCoreError ? REFUSAL_CODES[cause.code] : undefined;
        // Classification, not a membership test followed by an assertion repeating it: the
        // table answers the vocabulary member itself, so nothing has to be asserted.
        if (refused !== undefined) return { kind: "refused", code: refused };
        return { kind: "indeterminate", cause };
    }
}

/**
 * What an implementation must be able to be put into. One member per reply the vocabulary
 * declares, so a suite that iterates the taxonomy cannot skip a case.
 */
export type ViewStreamScenario =
    | { readonly kind: "streams" }
    | { readonly kind: "refuses"; readonly failure: ViewStreamFailure }
    | { readonly kind: "faults" };

/** One implementation of the view-stream protocol, built for one scenario. */
export interface ViewStreamImplementation {
    session(scenario: ViewStreamScenario): ViewStreamSession;
}

/** The channel every session in this contract serves. */
export const CONTRACT_CHANNEL = "view-channel";

/** The revision the contract's log carries a snapshot at. */
export const CONTRACT_SNAPSHOT_REVISION = 2;

/**
 * The highest revision in the contract's log. Two decimal digits so that acknowledging it
 * grows a stored attachment, which is the only way the `protocol.invalid-state` size
 * refusal in `storeAttachment` is reachable.
 */
export const CONTRACT_CURRENT_REVISION = 10;

/** What a peer receives from a log whose cursor is at zero: one snapshot, then the tail. */
export const CONTRACT_FULL_REPLAY_LENGTH =
    1 + (CONTRACT_CURRENT_REVISION - CONTRACT_SNAPSHOT_REVISION);

/**
 * How the adapter measures an attachment against the platform ceiling: the UTF-8 length of
 * its JSON form (`websocket.ts#requireAttachmentSize`). The platform actually measures the
 * structured clone of the value, so this is an approximation the adapter's own comment
 * admits to — recorded as a premise rather than asserted as equality.
 */
export function attachmentBytes(value: JsonValue): number {
    const text = JSON.stringify(value);
    return new TextEncoder().encode(text).byteLength;
}

/**
 * The bytes one revision carries in the contract's log, and the text those bytes arrive
 * as. The grammar declares `payload` as a string and declares nothing about its encoding;
 * the adapter base64s it, so the contract states that encoding here and reports the gap.
 */
export function contractPayload(revision: number) {
    const bytes = new Uint8Array([revision]);
    return { bytes, text: btoa(String.fromCharCode(revision)) };
}

/**
 * The value already on the socket when a persisted-attachment failure is under test, or
 * `undefined` when the session is opened normally. Shared by both implementations so the
 * two rows cannot drift on the fixture that provokes the refusal.
 *
 * The oversize pair is measured rather than guessed: `decodePersistedAttachment` spreads
 * the persisted record, so an unknown key survives the decode, and an attachment padded to
 * exactly the ceiling is the one that a wider `ackedRevision` pushes over it.
 */
export function persistedAttachment(scenario: ViewStreamScenario): JsonValue | undefined {
    if (scenario.kind !== "refuses") return undefined;
    if (scenario.failure === "attachment-not-object") return CONTRACT_CURRENT_REVISION;
    if (scenario.failure === "attachment-field-unreadable") {
        return { version: VIEW_STREAM_VERSION, channel: "", ackedRevision: 0 };
    }
    if (scenario.failure === "attachment-wrong-version") {
        return { version: VIEW_STREAM_VERSION + 1, channel: CONTRACT_CHANNEL, ackedRevision: 0 };
    }
    if (scenario.failure === "attachment-oversized-persisted") {
        return {
            version: VIEW_STREAM_VERSION,
            channel: CONTRACT_CHANNEL,
            ackedRevision: 0,
            pad: "p".repeat(VIEW_STREAM_ATTACHMENT_LIMIT_BYTES)
        };
    }
    if (scenario.failure === "attachment-oversized-write") {
        const empty = {
            version: VIEW_STREAM_VERSION,
            channel: CONTRACT_CHANNEL,
            ackedRevision: 0,
            pad: ""
        };
        const room = VIEW_STREAM_ATTACHMENT_LIMIT_BYTES - attachmentBytes(empty);
        return { ...empty, pad: "p".repeat(room) };
    }
    return undefined;
}

/** A channel long enough that the attachment carrying it cannot be stored. */
const OVERSIZED_CHANNEL = "c".repeat(VIEW_STREAM_ATTACHMENT_LIMIT_BYTES);

/**
 * The cursor a failure needs its session opened at before it can be provoked. Only the two
 * acknowledgement conflicts are about a session that is already streaming.
 */
const OPENED_AT: Readonly<Record<string, number>> = Object.freeze({
    "acknowledgement-below-attached": CONTRACT_SNAPSHOT_REVISION,
    "acknowledgement-above-current": 0
});

/** The call that provokes one declared failure. */
function callFor(failure: ViewStreamFailure): ViewStreamCall {
    if (failure === "frame-not-json") return { entry: "decode", frame: "not-json" };
    if (failure === "frame-not-json-data") {
        // Well-formed JSON syntax carrying something that is not JSON data: an escaped
        // lone surrogate parses as a string but is not a Unicode scalar value.
        return {
            entry: "decode",
            frame: '{"version":1,"kind":"snapshot","channel":"c","revision":1,"payload":"\\ud800"}'
        };
    }
    if (failure === "frame-not-object") return { entry: "decode", frame: "[]" };
    if (failure === "frame-field-unreadable") {
        return {
            entry: "decode",
            frame: '{"version":1,"kind":"snapshot","channel":"c","revision":1}'
        };
    }
    if (failure === "frame-wrong-version") {
        return {
            entry: "decode",
            frame: '{"version":2,"kind":"snapshot","channel":"c","revision":1,"payload":""}'
        };
    }
    if (failure === "frame-unknown-kind") {
        return {
            entry: "decode",
            frame: '{"version":1,"kind":"patch","channel":"c","revision":1,"payload":""}'
        };
    }
    if (failure === "empty-channel") return { entry: "open", channel: "", ackedRevision: 0 };
    if (failure === "negative-revision") {
        return { entry: "open", channel: CONTRACT_CHANNEL, ackedRevision: -1 };
    }
    if (failure === "unsafe-revision") {
        return { entry: "acknowledge", revision: Number.MAX_SAFE_INTEGER + 1 };
    }
    if (failure === "attachment-oversized-new") {
        return { entry: "open", channel: OVERSIZED_CHANNEL, ackedRevision: 0 };
    }
    if (failure === "acknowledgement-below-attached") {
        return { entry: "acknowledge", revision: CONTRACT_SNAPSHOT_REVISION - 1 };
    }
    if (failure === "acknowledgement-above-current") {
        return { entry: "acknowledge", revision: CONTRACT_CURRENT_REVISION + 1 };
    }
    if (failure === "attachment-oversized-write") {
        return { entry: "acknowledge", revision: CONTRACT_CURRENT_REVISION };
    }
    if (
        failure === "accept-failed" ||
        failure === "send-failed" ||
        failure === "serialize-failed"
    ) {
        return { entry: "open", channel: CONTRACT_CHANNEL, ackedRevision: 0 };
    }
    // Every remaining failure is a persisted attachment the seam cannot read back.
    return { entry: "attachment" };
}

export function viewStreamContract(name: string, implementation: ViewStreamImplementation): void {
    describe(`${name} view stream service contract`, () => {
        test(
            "sends the snapshot before any delta and the deltas in ascending revision order",
            { tags: "p1" },
            () => {
                const session = implementation.session({ kind: "streams" });
                const reply = viewStreamReply(session, {
                    entry: "open",
                    channel: CONTRACT_CHANNEL,
                    ackedRevision: 0
                });

                expect(reply.kind).toBe("served");
                if (reply.kind !== "served") return;
                expect(reply.frames).toHaveLength(CONTRACT_FULL_REPLAY_LENGTH);
                // The grammar invariant: exactly one snapshot, first, and every delta
                // after it strictly ascending.
                expect(reply.frames.map((frame) => frame.kind)).toEqual([
                    "snapshot",
                    ...reply.frames.slice(1).map(() => "delta" as const)
                ]);
                expect(reply.frames.map((frame) => frame.revision)).toEqual(
                    reply.frames.map((_frame, index) => CONTRACT_SNAPSHOT_REVISION + index)
                );
                // The outbound half of the operation vocabulary, in both directions: every
                // kind emitted is declared, and every declared kind is emitted.
                const kinds: Record<string, true> = {};
                for (const frame of reply.frames) {
                    expect(VIEW_STREAM_OPERATIONS).toContain(frame.kind);
                    expect(frame.channel).toBe(CONTRACT_CHANNEL);
                    expect(frame.version).toBe(VIEW_STREAM_VERSION);
                    expect(frame.payload).toBe(contractPayload(frame.revision).text);
                    kinds[frame.kind] = true;
                }
                expect(Object.keys(kinds).sort()).toEqual([...VIEW_STREAM_FRAME_KINDS].sort());
            }
        );

        test(
            "refuses every failure the taxonomy declares, and declares every refusal it answers",
            { tags: "p0" },
            () => {
                const produced: Record<string, true> = {};
                for (const failure of VIEW_STREAM_FAILURES) {
                    const session = implementation.session({ kind: "refuses", failure });
                    const opened = OPENED_AT[failure];
                    if (opened !== undefined) {
                        expect(
                            viewStreamReply(session, {
                                entry: "open",
                                channel: CONTRACT_CHANNEL,
                                ackedRevision: opened
                            }).kind
                        ).toBe("served");
                    }
                    const reply = viewStreamReply(session, callFor(failure));

                    expect(reply).toEqual({
                        kind: "refused",
                        code: VIEW_STREAM_TAXONOMY[failure]
                    });
                    if (reply.kind === "refused") produced[reply.code] = true;
                }

                // Both directions: the vocabulary has no code this implementation cannot
                // produce, and this implementation produced no code outside it.
                expect(Object.keys(produced).sort()).toEqual([...VIEW_STREAM_REFUSALS].sort());
                expect(Object.keys(produced).every((code) => REFUSAL_CODES[code] === code)).toBe(
                    true
                );
            }
        );

        test(
            "writes the attachment before the transport accepts the socket",
            { tags: "p0" },
            () => {
                const session = implementation.session({ kind: "streams" });
                viewStreamReply(session, {
                    entry: "open",
                    channel: CONTRACT_CHANNEL,
                    ackedRevision: CONTRACT_SNAPSHOT_REVISION
                });

                // A socket accepted without its cursor hibernates and then fails every
                // later message, and nothing can repair it: the ordering is the invariant,
                // not the eventual presence of the attachment.
                expect(session.acceptedWith()).toEqual([
                    {
                        version: VIEW_STREAM_VERSION,
                        channel: CONTRACT_CHANNEL,
                        ackedRevision: CONTRACT_SNAPSHOT_REVISION
                    }
                ]);
                expect(session.writes()).toBe(1);
            }
        );

        test(
            "refuses an oversized attachment before the socket is accepted",
            { tags: "p1" },
            () => {
                const session = implementation.session({
                    kind: "refuses",
                    failure: "attachment-oversized-new"
                });
                const reply = viewStreamReply(session, callFor("attachment-oversized-new"));

                expect(reply).toEqual({ kind: "refused", code: "operation.invalid-input" });
                // Nothing was admitted, so nothing hibernates in a state no message can fix.
                expect(session.acceptedWith()).toEqual([]);
                expect(session.writes()).toBe(0);
            }
        );

        test(
            "writes no attachment for an acknowledgement equal to the attached revision",
            { tags: "p1" },
            () => {
                const session = implementation.session({ kind: "streams" });
                viewStreamReply(session, {
                    entry: "open",
                    channel: CONTRACT_CHANNEL,
                    ackedRevision: CONTRACT_SNAPSHOT_REVISION
                });
                const settled = session.writes();
                const reply = viewStreamReply(session, {
                    entry: "acknowledge",
                    revision: CONTRACT_SNAPSHOT_REVISION
                });

                expect(reply.kind).toBe("served");
                if (reply.kind !== "served") return;
                // A repeated acknowledgement is idempotent at the storage seam too: the
                // guard exists so a chatty peer cannot make the object write per message.
                expect(reply.writes).toBe(settled);
                expect(reply.frames).toEqual([]);
            }
        );

        test(
            "advances the cursor monotonically and replays only what follows it",
            { tags: "p1" },
            () => {
                const session = implementation.session({ kind: "streams" });
                viewStreamReply(session, {
                    entry: "open",
                    channel: CONTRACT_CHANNEL,
                    ackedRevision: 0
                });
                const advanced = viewStreamReply(session, {
                    entry: "acknowledge",
                    revision: CONTRACT_CURRENT_REVISION
                });

                expect(advanced.kind).toBe("served");
                const cursor = viewStreamReply(session, { entry: "attachment" });
                expect(cursor).toEqual({
                    kind: "attached",
                    attachment: {
                        version: VIEW_STREAM_VERSION,
                        channel: CONTRACT_CHANNEL,
                        ackedRevision: CONTRACT_CURRENT_REVISION
                    }
                });

                // Everything before the cursor is gone from the stream: an
                // acknowledgement is the peer's promise it will not be re-sent.
                const replayed = viewStreamReply(session, { entry: "replay" });
                expect(replayed).toEqual({
                    kind: "served",
                    frames: [],
                    writes: session.writes()
                });
                // And it cannot go back: the peer does not get to un-acknowledge.
                expect(
                    viewStreamReply(session, {
                        entry: "acknowledge",
                        revision: CONTRACT_CURRENT_REVISION - 1
                    })
                ).toEqual({ kind: "refused", code: "protocol.revision-conflict" });
            }
        );

        test(
            "answers an undeclared storage failure as indeterminate rather than as a refusal",
            { tags: "p1" },
            () => {
                const session = implementation.session({ kind: "faults" });
                const reply = viewStreamReply(session, {
                    entry: "open",
                    channel: CONTRACT_CHANNEL,
                    ackedRevision: 0
                });

                expect(reply.kind).toBe("indeterminate");
                if (reply.kind !== "indeterminate") return;
                // The cause travels whole. A refusal code invented here would be the
                // runtime claiming to know an answer the stream never gave.
                expect(reply.cause).toBeDefined();
                expect(reply.cause instanceof AgentCoreError).toBe(false);
            }
        );

        test(
            "carries a field the grammar does not declare straight through",
            { tags: "p2" },
            () => {
                // FINDING, not a fix: `decodeViewStreamFrame` returns `{ ...decoded, ... }`, so
                // the grammar's five fields are required but not exhaustive. A peer — or a
                // future sender — can add a sixth and every reader keeps it.
                const reply = viewStreamReply(implementation.session({ kind: "streams" }), {
                    entry: "decode",
                    frame: JSON.stringify({
                        version: VIEW_STREAM_VERSION,
                        kind: "snapshot",
                        channel: CONTRACT_CHANNEL,
                        revision: CONTRACT_SNAPSHOT_REVISION,
                        payload: contractPayload(CONTRACT_SNAPSHOT_REVISION).text,
                        undeclared: "kept"
                    })
                });

                expect(reply.kind).toBe("decoded");
                if (reply.kind !== "decoded") return;
                expect(Object.keys(reply.frame).sort()).toEqual(
                    [...VIEW_STREAM_FRAME_FIELDS, "undeclared"].sort()
                );
                expect(reply.frame["undeclared"]).toBe("kept");
            }
        );
    });
}
