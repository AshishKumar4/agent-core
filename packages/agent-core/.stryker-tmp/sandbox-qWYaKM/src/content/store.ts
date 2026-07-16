// @ts-nocheck
import type { ContentRef, Digest } from "../core";
import type { MediaHint } from "./media";
import type { ByteRange } from "./range";
import type { ContentStat } from "./stat";

export interface ContentPutResult {
    readonly ref: ContentRef;
    readonly digest: Digest;
}

export abstract class ContentStore {
    public abstract put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult>;

    public abstract get(ref: ContentRef, range?: ByteRange): Promise<Uint8Array>;

    public abstract stat(ref: ContentRef): Promise<ContentStat | undefined>;
}
