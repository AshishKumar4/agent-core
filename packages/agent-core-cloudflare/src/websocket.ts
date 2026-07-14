import { AgentCoreError } from "@agent-core/core";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { DurableViewEntry, DurableViewRevisionLog } from "./revision-log.js";

const ATTACHMENT_VERSION = 1;
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
        requireInputAttachmentSize(attachment, this.errors);
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
        this.storeAttachment(socket, attachment);
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
        requireRuntimeAttachmentSize(attachment, this.errors);
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

function requireInputAttachmentSize(
    attachment: ViewSocketAttachment,
    errors: CloudflareErrorPort
): void {
    const size = new TextEncoder().encode(JSON.stringify(attachment)).byteLength;
    if (size > ATTACHMENT_LIMIT_BYTES) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "Cloudflare WebSocket attachment exceeds 16384 bytes"
        );
    }
}

function requireRuntimeAttachmentSize(
    attachment: ViewSocketAttachment,
    errors: CloudflareErrorPort
): void {
    const size = new TextEncoder().encode(JSON.stringify(attachment)).byteLength;
    if (size > ATTACHMENT_LIMIT_BYTES) {
        operationalFailure(
            errors,
            "protocol.invalid-state",
            "Cloudflare WebSocket attachment exceeds 16384 bytes"
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
    if (
        !isRecord(decoded) ||
        decoded.version !== ATTACHMENT_VERSION ||
        (decoded.kind !== "snapshot" && decoded.kind !== "delta") ||
        typeof decoded.channel !== "string" ||
        decoded.channel.length === 0 ||
        !Number.isSafeInteger(decoded.revision) ||
        (decoded.revision as number) < 0 ||
        typeof decoded.payload !== "string"
    ) {
        throw new AgentCoreError("codec.invalid", "View stream frame has an invalid shape");
    }
    return Object.freeze(decoded as unknown as ViewStreamFrame);
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
    if (
        !isRecord(value) ||
        value.version !== ATTACHMENT_VERSION ||
        typeof value.channel !== "string" ||
        value.channel.length === 0 ||
        !Number.isSafeInteger(value.ackedRevision) ||
        (value.ackedRevision as number) < 0
    ) {
        operationalFailure(errors, "codec.invalid", "WebSocket attachment has an invalid shape");
    }
    const attachment = Object.freeze(value as unknown as ViewSocketAttachment);
    const size = new TextEncoder().encode(JSON.stringify(attachment)).byteLength;
    if (size > ATTACHMENT_LIMIT_BYTES) {
        operationalFailure(errors, "codec.invalid", "WebSocket attachment exceeds 16384 bytes");
    }
    return attachment;
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

function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
