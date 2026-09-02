import {
    ByteRange,
    ContentRef,
    ContentStat,
    ContentStore,
    Digest,
    MediaHint,
    TenantId,
    type ContentPutResult
} from "@agent-core/core";
import type { CloudflareCapturedCause, CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import { isFiniteNumber } from "./platform-value.js";
import { isWellFormedUnicode } from "./unicode.js";

const FORMAT_VERSION = "1";
const KEY_PREFIX = "agent-core-content/v1";
const BODY_DIGEST_METADATA = "agent-core-body-sha256";
const TENANT_DIGEST_METADATA = "agent-core-tenant-sha256";
const FORMAT_METADATA = "agent-core-format";
const MEDIA_TYPE_METADATA = "agent-core-media-type";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * How large one content object may be for this repository to carry it whole. R2 itself
 * stores far more (https://developers.cloudflare.com/r2/platform/limits/), but this path
 * buffers the object in the isolate on both sides, and an isolate has 128 MB for the
 * whole request (https://developers.cloudflare.com/workers/platform/limits/#memory). So
 * the binding constraint here is memory rather than storage, and 32 MiB is the figure the
 * platform itself uses for one in-memory value crossing a boundary — the serialized RPC
 * ceiling and the received WebSocket message ceiling are both 32 MiB. Past it the seam
 * refuses as invalid input rather than letting the isolate die with no diagnosis.
 */
export const R2_BUFFERED_OBJECT_LIMIT_BYTES = 33_554_432;

/**
 * R2 bounds an object key at 1,024 bytes and its custom metadata at 8,192 bytes
 * (https://developers.cloudflare.com/r2/platform/limits/). Both are satisfied by
 * construction rather than by a guard: a key is `KEY_PREFIX` plus two fixed-width
 * SHA-256 hexadecimal digests, and the metadata is three entries whose values are one
 * digest each and one format version, plus at most one media type. The media type is the
 * only entry a caller supplies, and `MediaHint` already bounds it at 255 characters, so
 * the widest metadata this path can write is under 600 bytes and still does not grow with
 * the payload. The constants below carry the measurement so a future key or metadata
 * change is caught.
 */
export const R2_KEY_LIMIT_BYTES = 1_024;
export const R2_METADATA_LIMIT_BYTES = 8_192;

export interface R2ChecksumsLike {
    readonly sha256?: ArrayBuffer;
}

export interface R2ObjectLike {
    readonly key: string;
    readonly size: number;
    readonly etag: string;
    readonly customMetadata?: Readonly<Record<string, string>>;
    readonly checksums: R2ChecksumsLike;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
    arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2PutOptionsLike {
    readonly onlyIf: { readonly etagDoesNotMatch: "*" };
    readonly customMetadata: Readonly<Record<string, string>>;
    readonly sha256: ArrayBuffer;
}

/**
 * The byte window of one ranged R2 read. R2 accepts a suffix form too, which this path
 * never sends: a `ByteRange` always resolves to an explicit offset and length against the
 * size R2 itself reported, so the request is never relative to an object's end.
 */
export interface R2RangeLike {
    readonly offset: number;
    readonly length: number;
}

export interface R2GetOptionsLike {
    readonly range: R2RangeLike;
}

export interface R2BucketLike {
    put(
        key: string,
        value: ArrayBuffer | ArrayBufferView,
        options: R2PutOptionsLike
    ): Promise<R2ObjectLike | null>;
    get(key: string, options?: R2GetOptionsLike): Promise<R2ObjectBodyLike | null>;
    head(key: string): Promise<R2ObjectLike | null>;
}

export interface ContentObjectAddress {
    readonly key: string;
    readonly digest: string;
    readonly tenantDigest: string;
}

export interface ContentObject extends ContentObjectAddress {
    readonly bytes: Uint8Array;
}

export interface ContentObjectPutResult extends ContentObject {
    readonly created: boolean;
}

/** What one stored object reports about itself without its body crossing the boundary. */
export interface ContentObjectStat extends ContentObjectAddress {
    readonly size: number;
    readonly hint: MediaHint | undefined;
}

/**
 * Stores immutable bytes only. Domain holds, authority, and Receipts remain outside
 * this repository and are intentionally absent from its API and metadata.
 */
export class R2ContentObjectRepository {
    public constructor(
        private readonly bucket: R2BucketLike,
        private readonly errors: CloudflareErrorPort
    ) {}

    public async put(
        tenantId: TenantId,
        bytes: Uint8Array,
        hint?: MediaHint
    ): Promise<ContentObjectPutResult> {
        this.requireBufferable("write", bytes.byteLength);
        requireMediaHint(hint, this.errors);
        // The one copy this path needs: the address is computed across an await, and a
        // caller mutating its own array afterwards must not change what R2 stores.
        const detached = bytes.slice();
        const address = await contentObjectAddress(tenantId, detached, this.errors);
        const metadata = objectMetadata(address, hint);
        const written = await this.callR2("R2 content write failed", () =>
            this.bucket.put(address.key, detached, {
                onlyIf: { etagDoesNotMatch: "*" },
                customMetadata: metadata,
                sha256: digestBytes(address.digest)
            })
        );
        if (written !== null) this.validateObject(written, address, detached.byteLength);

        const stored = await this.read(address);
        if (stored === undefined) {
            this.corrupt("R2 conditional write resolved without a stored content object");
        }
        return Object.freeze({ ...stored, created: written !== null });
    }

    public async get(tenantId: TenantId, digest: string): Promise<ContentObject | undefined> {
        return this.read(await this.locate(tenantId, digest));
    }

    /**
     * What R2's own `head` reports, which is the whole of `stat` for a content-addressed
     * object: the size, the media type the writer declared, and the address the metadata
     * and R2's stored checksum agree on. No body crosses the boundary, so this answers for
     * an object too large for this path to carry whole — the size is exactly what a caller
     * needs to decide it must read the object in windows instead.
     */
    public async head(tenantId: TenantId, digest: string): Promise<ContentObjectStat | undefined> {
        return this.stat(await this.locate(tenantId, digest));
    }

    /**
     * One window of a stored object, read as an R2 ranged `get` rather than sliced out of a
     * buffered whole. The window is resolved against the size `head` reported before any
     * body is requested, so a range reaching past the object is refused with
     * `content.invalid-range` exactly where the memory and SQLite stores refuse it, and R2
     * is never given the chance to clamp it to a shorter answer. The buffering bound then
     * applies to the window rather than the object, because the window is what enters the
     * isolate.
     */
    public async readRange(
        tenantId: TenantId,
        digest: string,
        range: ByteRange
    ): Promise<Uint8Array | undefined> {
        const address = await this.locate(tenantId, digest);
        const stored = await this.stat(address);
        if (stored === undefined) return undefined;
        const window = range.resolve(stored.size);
        this.requireBufferable("read", window.length);
        // R2 has no zero-length range, and it needs none: an empty window is already
        // proved inside the object, so its answer is known without asking.
        if (window.length === 0) return new Uint8Array();
        const object = await this.callR2("R2 content range read failed", () =>
            this.bucket.get(address.key, { range: window })
        );
        if (object === null) return undefined;
        this.validateObject(object, address, stored.size);
        const body = new Uint8Array(
            await this.callR2("R2 content body read failed", () => object.arrayBuffer())
        );
        if (body.byteLength !== window.length) {
            operationalFailure(
                this.errors,
                "operation.invalid-output",
                `R2 served ${body.byteLength} bytes for a ${window.length}-byte range`
            );
        }
        // The address is a digest of the whole object, so a window is verifiable against it
        // only when the window is the whole. A proper window rests on the metadata and on
        // the SHA-256 R2 itself computed at write, both checked above; the bytes it returns
        // are not independently addressable and this path does not pretend otherwise.
        if (window.length === stored.size && (await sha256(body, this.errors)) !== address.digest) {
            this.corrupt("R2 content body digest does not match its address");
        }
        return body;
    }

    private async locate(tenantId: TenantId, digest: string): Promise<ContentObjectAddress> {
        requireTenantId(tenantId, this.errors);
        requireDigest(digest, this.errors);
        const tenantDigest = await sha256(new TextEncoder().encode(tenantId.value), this.errors);
        return Object.freeze({
            key: contentObjectKey(tenantDigest, digest),
            digest,
            tenantDigest
        });
    }

    private async stat(address: ContentObjectAddress): Promise<ContentObjectStat | undefined> {
        const object = await this.callR2("R2 content stat failed", () =>
            this.bucket.head(address.key)
        );
        if (object === null) return undefined;
        this.validateAddress(object, address);
        return Object.freeze({
            ...address,
            size: this.requireStoredSize(object.size),
            hint: this.storedHint(object)
        });
    }

    private async read(address: ContentObjectAddress): Promise<ContentObject | undefined> {
        const object = await this.callR2("R2 content read failed", () =>
            this.bucket.get(address.key)
        );
        if (object === null) return undefined;
        // R2 reports the stored size before the body is fetched, so the refusal happens
        // while the object is still on the far side of the boundary.
        this.requireBufferable("read", object.size);
        const body = new Uint8Array(
            await this.callR2("R2 content body read failed", () => object.arrayBuffer())
        );
        this.validateObject(object, address, body.byteLength);
        if ((await sha256(body, this.errors)) !== address.digest) {
            this.corrupt("R2 content body digest does not match its address");
        }
        return Object.freeze({ ...address, bytes: body });
    }

    private async callR2<Result>(
        message: string,
        operation: () => Promise<Result>
    ): Promise<Result> {
        try {
            return await operation();
        } catch (cause) {
            operationalFailure(this.errors, "protocol.invalid-state", message, { value: cause });
        }
    }

    /**
     * Refuses an object this repository cannot carry whole. Large content belongs behind a
     * stream, and refusing is what keeps that a decision rather than an isolate that died
     * without saying why.
     */
    private requireBufferable(direction: string, length: number): void {
        if (length > R2_BUFFERED_OBJECT_LIMIT_BYTES) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                `A content object ${direction} of ${length} bytes exceeds the ` +
                    `${R2_BUFFERED_OBJECT_LIMIT_BYTES}-byte buffered object limit`
            );
        }
    }

    private corrupt(message: string, cause?: CloudflareCapturedCause): never {
        return operationalFailure(this.errors, "codec.invalid", message, cause);
    }

    private validateObject(
        object: R2ObjectLike,
        address: ContentObjectAddress,
        size: number
    ): void {
        this.validateAddress(object, address);
        if (object.size !== size) {
            this.corrupt("R2 content object size does not match the body it stores");
        }
    }

    /**
     * What agreement with an address means for an object whose body may not be present:
     * the key it was fetched under, the metadata this path wrote, and the SHA-256 R2
     * computed for itself at write. A ranged read has nothing else to check it against.
     */
    private validateAddress(object: R2ObjectLike, address: ContentObjectAddress): void {
        const metadata = object.customMetadata ?? {};
        if (
            object.key !== address.key ||
            metadata[FORMAT_METADATA] !== FORMAT_VERSION ||
            metadata[BODY_DIGEST_METADATA] !== address.digest ||
            metadata[TENANT_DIGEST_METADATA] !== address.tenantDigest
        ) {
            this.corrupt("R2 content metadata does not match its address");
        }
        const checksum = object.checksums.sha256;
        if (checksum === undefined || hex(checksum) !== address.digest) {
            this.corrupt("R2 SHA-256 checksum does not match its address");
        }
    }

    private requireStoredSize(size: number): number {
        if (!isFiniteNumber(size) || !Number.isSafeInteger(size) || size < 0) {
            operationalFailure(
                this.errors,
                "operation.invalid-output",
                `R2 reported an unusable content object size: ${String(size)}`
            );
        }
        return size;
    }

    /**
     * The writer's media type, read back through the same `MediaHint` that bounded it on
     * the way in. Constructing it here is what keeps one validator for the value: a stored
     * media type this path could not have written is corruption of the object's metadata,
     * not a hint a caller has to defend against.
     */
    private storedHint(object: R2ObjectLike): MediaHint | undefined {
        const declared = (object.customMetadata ?? {})[MEDIA_TYPE_METADATA];
        if (declared === undefined) return undefined;
        try {
            return new MediaHint(declared);
        } catch (cause) {
            return this.corrupt("R2 content media type is not a media hint", { value: cause });
        }
    }
}

/**
 * §8.2's ContentStore over one Tenant's R2 objects. The Tenant is fixed at construction
 * because §8.4 rule 1 gives a store exactly one, so a `ContentRef` resolves here only
 * inside the Tenant this store was built for and no argument can move it to another.
 *
 * Every operation is one or two R2 calls and nothing else: `put` is the conditional write
 * the repository already performed, `stat` is `head`, and `get` is a whole-object read
 * when the caller names no window and `head` followed by a ranged read when it does. That
 * asymmetry is deliberate. A whole read is digest-verified against the address it was
 * fetched by, which is worth one call; a window has to know the object's size before it
 * can be refused definitively rather than clamped, which costs the extra `head`.
 */
export class R2ContentStore extends ContentStore {
    public constructor(
        private readonly objects: R2ContentObjectRepository,
        private readonly tenantId: TenantId,
        private readonly errors: CloudflareErrorPort
    ) {
        super();
        requireTenantId(tenantId, errors);
    }

    public async put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult> {
        const stored = await this.objects.put(this.tenantId, bytes, hint);
        const digest = new Digest(stored.digest);
        return Object.freeze({ ref: ContentRef.fromDigest(digest), digest });
    }

    public async get(ref: ContentRef, range?: ByteRange): Promise<Uint8Array> {
        const digest = this.requireContentRef(ref);
        if (range === undefined) {
            const stored = await this.objects.get(this.tenantId, digest);
            if (stored === undefined) this.unresolved(ref);
            return stored.bytes;
        }
        const window = await this.objects.readRange(this.tenantId, digest, range);
        if (window === undefined) this.unresolved(ref);
        return window;
    }

    public async stat(ref: ContentRef): Promise<ContentStat | undefined> {
        const stored = await this.objects.head(this.tenantId, this.requireContentRef(ref));
        if (stored === undefined) return undefined;
        return new ContentStat(ref, new Digest(stored.digest), stored.size, stored.hint);
    }

    private requireContentRef(ref: ContentRef): string {
        if (!(ref instanceof ContentRef)) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Content reference must be a ContentRef"
            );
        }
        return ref.digest.value;
    }

    private unresolved(ref: ContentRef): never {
        return operationalFailure(
            this.errors,
            "content.not-found",
            `Content not found: ${ref.value}`
        );
    }
}

export async function contentObjectAddress(
    tenantId: TenantId,
    bytes: Uint8Array,
    errors: CloudflareErrorPort
): Promise<ContentObjectAddress> {
    requireTenantId(tenantId, errors);
    const [tenantDigest, digest] = await Promise.all([
        sha256(new TextEncoder().encode(tenantId.value), errors),
        sha256(bytes, errors)
    ]);
    return Object.freeze({ key: contentObjectKey(tenantDigest, digest), digest, tenantDigest });
}

function contentObjectKey(tenantDigest: string, digest: string): string {
    return `${KEY_PREFIX}/tenant-sha256/${tenantDigest}/sha256/${digest}`;
}

function objectMetadata(
    address: ContentObjectAddress,
    hint: MediaHint | undefined
): Readonly<Record<string, string>> {
    const addressed = {
        [FORMAT_METADATA]: FORMAT_VERSION,
        [BODY_DIGEST_METADATA]: address.digest,
        [TENANT_DIGEST_METADATA]: address.tenantDigest
    };
    return Object.freeze(
        hint === undefined ? addressed : { ...addressed, [MEDIA_TYPE_METADATA]: hint.mediaType }
    );
}

async function sha256(bytes: Uint8Array, errors: CloudflareErrorPort): Promise<string> {
    // Digesting needs a buffer source this function owns: a `Uint8Array` may view a
    // `SharedArrayBuffer`, which `crypto.subtle.digest` does not accept.
    const detached = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(detached).set(bytes);
    try {
        return hex(await crypto.subtle.digest("SHA-256", detached));
    } catch (cause) {
        operationalFailure(errors, "protocol.invalid-state", "SHA-256 digest failed", {
            value: cause
        });
    }
}

function hex(buffer: ArrayBuffer): string {
    return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function digestBytes(digest: string): ArrayBuffer {
    const bytes = new Uint8Array(digest.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes.buffer;
}

function requireDigest(value: string, errors: CloudflareErrorPort): void {
    if (!SHA256_PATTERN.test(value)) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "Content object digest must be lowercase SHA-256 hexadecimal"
        );
    }
}

function requireTenantId(value: TenantId, errors: CloudflareErrorPort): void {
    if (!(value instanceof TenantId) || !isWellFormedUnicode(value.value)) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "Content object tenant ID must be non-empty well-formed Unicode"
        );
    }
}

function requireMediaHint(value: MediaHint | undefined, errors: CloudflareErrorPort): void {
    if (value !== undefined && !(value instanceof MediaHint)) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "Content object media type must be a MediaHint"
        );
    }
}
