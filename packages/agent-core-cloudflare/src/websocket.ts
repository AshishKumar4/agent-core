import { AgentCoreError } from "@agent-core/core";
import { encodeBase64 } from "./base64.js";
import type { CloudflareErrorPort, CloudflareOperationalErrorCode } from "./error.js";
import { operationalFailure } from "./error.js";
import type { DurableViewEntry, DurableViewRevisionLog } from "./revision-log.js";

const ATTACHMENT_VERSION = 1;
/**
 * `WebSocket.serializeAttachment` accepts at most 16,384 bytes. The platform measures the
 * structured clone of the value, which this JSON measurement only approximates, so
 * attachments are serialized before the socket is accepted and the platform's own limit
 * stays authoritative over an unaccepted socket.
 */
const ATTACHMENT_LIMIT_BYTES = 16_384;

export interface ViewSocketAttachment {
    readonly version: 1;
    readonly channel: string;
    readonly ackedRevision: number;
}

export interface HibernatingWebSocketLike {
    serializeAttachment(value: unknown): void;
    deserializeAttachment(): unknown;
    send(message: string | ArrayBuffer | ArrayBufferView): void;
}

export interface HibernatingWebSocketContextLike {
    acceptWebSocket(socket: HibernatingWebSocketLike): void;
}

export interface ViewStreamFrame {
    readonly version: 1;
    readonly kind: "snapshot" | "delta";
    readonly channel: string;
    readonly revision: number;
    readonly payload: string;
}

export class HibernatingViewSocketAdapter {
    public constructor(
        private readonly context: HibernatingWebSocketContextLike,
        private readonly revisions: DurableViewRevisionLog,
        private readonly errors: CloudflareErrorPort
    ) {}

    public accept(socket: HibernatingWebSocketLike, channel: string, ackedRevision: number): void {
        const attachment = createAttachment(channel, ackedRevision, this.errors);
        requireAttachmentSize(attachment, "operation.invalid-input", this.errors);
        // Attach before accepting: a socket accepted without its attachment hibernates and
        // then fails every later message, and nothing can repair it.
        this.storeAttachment(socket, attachment);
        try {
            this.context.acceptWebSocket(socket);
        } catch (cause) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Cloudflare failed to accept a hibernating WebSocket",
                cause
            );
        }
        this.replay(socket);
    }

    public replay(socket: HibernatingWebSocketLike): void {
        const attachment = this.readAttachment(socket);
        const replay = this.revisions.replay(attachment.channel, attachment.ackedRevision);
        if (replay.snapshot !== undefined) {
            this.send(socket, "snapshot", attachment.channel, replay.snapshot);
        }
        for (const delta of replay.deltas) this.send(socket, "delta", attachment.channel, delta);
    }

    public acknowledge(socket: HibernatingWebSocketLike, revision: number): void {
        requireInputRevision(revision, this.errors);
        const attachment = this.readAttachment(socket);
        const current = this.revisions.currentRevision(attachment.channel);
        if (revision < attachment.ackedRevision || revision > current) {
            operationalFailure(
                this.errors,
                "protocol.revision-conflict",
                `WebSocket acknowledgement ${revision} is outside ${attachment.ackedRevision}..${current}`
            );
        }
        if (revision !== attachment.ackedRevision) {
            this.storeAttachment(socket, Object.freeze({ ...attachment, ackedRevision: revision }));
        }
    }

    public attachment(socket: HibernatingWebSocketLike): ViewSocketAttachment {
        return this.readAttachment(socket);
    }

    private send(
        socket: HibernatingWebSocketLike,
        kind: ViewStreamFrame["kind"],
        channel: string,
        entry: DurableViewEntry
    ): void {
        const frame: ViewStreamFrame = Object.freeze({
            version: ATTACHMENT_VERSION,
            kind,
            channel,
            revision: entry.revision,
            payload: encodeBase64(entry.payload)
        });
        try {
            socket.send(JSON.stringify(frame));
        } catch (cause) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Cloudflare WebSocket replay send failed",
                cause
            );
        }
    }

    private storeAttachment(
        socket: HibernatingWebSocketLike,
        attachment: ViewSocketAttachment
    ): void {
        requireAttachmentSize(attachment, "protocol.invalid-state", this.errors);
        try {
            socket.serializeAttachment(attachment);
        } catch (cause) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Cloudflare WebSocket attachment serialization failed",
                cause
            );
        }
    }

    private readAttachment(socket: HibernatingWebSocketLike): ViewSocketAttachment {
        let value: unknown;
        try {
            value = socket.deserializeAttachment();
        } catch (cause) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Cloudflare WebSocket attachment deserialization failed",
                cause
            );
        }
        return decodePersistedAttachment(value, this.errors);
    }
}

function requireAttachmentSize(
    attachment: ViewSocketAttachment,
    code: CloudflareOperationalErrorCode,
    errors: CloudflareErrorPort
): void {
    const size = new TextEncoder().encode(JSON.stringify(attachment)).byteLength;
    if (size > ATTACHMENT_LIMIT_BYTES) {
        operationalFailure(
            errors,
            code,
            `Cloudflare WebSocket attachment exceeds ${ATTACHMENT_LIMIT_BYTES} bytes`
        );
    }
}

export function decodeViewStreamFrame(value: string): ViewStreamFrame {
    let decoded: unknown;
    try {
        decoded = JSON.parse(value);
    } catch (cause) {
        const error = new AgentCoreError("codec.invalid", "View stream frame must be JSON");
        Object.defineProperty(error, "cause", { value: cause });
        throw error;
    }
    if (!isViewStreamFrame(decoded)) {
        throw new AgentCoreError("codec.invalid", "View stream frame has an invalid shape");
    }
    return Object.freeze(decoded);
}

function isViewStreamFrame(value: unknown): value is ViewStreamFrame {
    return (
        isRecord(value) &&
        value.version === ATTACHMENT_VERSION &&
        (value.kind === "snapshot" || value.kind === "delta") &&
        typeof value.channel === "string" &&
        value.channel.length > 0 &&
        typeof value.revision === "number" &&
        Number.isSafeInteger(value.revision) &&
        value.revision >= 0 &&
        typeof value.payload === "string"
    );
}

function createAttachment(
    channel: string,
    ackedRevision: number,
    errors: CloudflareErrorPort
): ViewSocketAttachment {
    if (channel.length === 0) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "WebSocket view channel must be non-empty"
        );
    }
    requireInputRevision(ackedRevision, errors);
    return Object.freeze({ version: ATTACHMENT_VERSION, channel, ackedRevision });
}

function decodePersistedAttachment(
    value: unknown,
    errors: CloudflareErrorPort
): ViewSocketAttachment {
    if (!isViewSocketAttachment(value)) {
        operationalFailure(errors, "codec.invalid", "WebSocket attachment has an invalid shape");
    }
    const attachment = Object.freeze(value);
    requireAttachmentSize(attachment, "codec.invalid", errors);
    return attachment;
}

function isViewSocketAttachment(value: unknown): value is ViewSocketAttachment {
    return (
        isRecord(value) &&
        value.version === ATTACHMENT_VERSION &&
        typeof value.channel === "string" &&
        value.channel.length > 0 &&
        typeof value.ackedRevision === "number" &&
        Number.isSafeInteger(value.ackedRevision) &&
        value.ackedRevision >= 0
    );
}

function requireInputRevision(revision: number, errors: CloudflareErrorPort): void {
    if (!Number.isSafeInteger(revision) || revision < 0) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "WebSocket revision must be a non-negative safe integer"
        );
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
