// @ts-nocheck
import {
    ContentRef,
    Digest,
    RecordCodec,
    hasExactJsonKeys,
    type JsonValue,
    type RecordVersion
} from "../core";
import { AgentCoreError } from "../errors";
import { MediaHint } from "./media";

class ContentStatRecordCodec extends RecordCodec<ContentStat> {
    public constructor() {
        super("content.stat", { major: 1, minor: 0 });
    }

    protected encodePayload(stat: ContentStat): JsonValue {
        return {
            digest: stat.digest.value,
            mediaType: stat.hint?.mediaType ?? null,
            ref: stat.ref.value,
            size: stat.size
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): ContentStat {
        const size = isObject(payload) ? payload["size"] : undefined;
        if (
            !isObject(payload) ||
            !hasExactJsonKeys(payload, ["digest", "mediaType", "ref", "size"]) ||
            typeof payload["digest"] !== "string" ||
            (payload["mediaType"] !== null && typeof payload["mediaType"] !== "string") ||
            typeof payload["ref"] !== "string" ||
            typeof size !== "number" ||
            !Number.isSafeInteger(size)
        ) {
            throw new AgentCoreError("codec.invalid", "Content stat payload is malformed");
        }

        try {
            const mediaType = payload["mediaType"];
            return new ContentStat(
                new ContentRef(payload["ref"]),
                new Digest(payload["digest"]),
                size,
                typeof mediaType === "string" ? new MediaHint(mediaType) : undefined
            );
        } catch (error) {
            throw new AgentCoreError(
                "codec.invalid",
                `Content stat payload is invalid: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}

export class ContentStat {
    public static readonly codec: RecordCodec<ContentStat> = new ContentStatRecordCodec();
    public readonly hint: MediaHint | undefined;

    public constructor(
        public readonly ref: ContentRef,
        public readonly digest: Digest,
        public readonly size: number,
        hint?: MediaHint
    ) {
        if (!Number.isSafeInteger(size) || size < 0) {
            throw new TypeError("Content size must be a non-negative safe integer");
        }
        if (!ref.digest.equals(digest)) {
            throw new TypeError("Content reference and digest must match");
        }
        this.hint = hint === undefined ? undefined : new MediaHint(hint.mediaType);
        Object.freeze(this);
    }

    public static encode(stat: ContentStat): Uint8Array {
        return ContentStat.codec.encode(stat);
    }

    public static decode(bytes: Uint8Array): ContentStat {
        return ContentStat.codec.decode(bytes);
    }
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}
