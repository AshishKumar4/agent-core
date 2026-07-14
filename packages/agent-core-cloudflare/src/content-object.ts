import { TenantId } from "@agent-core/core";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import { isWellFormedUnicode } from "./unicode.js";

const FORMAT_VERSION = "1";
const KEY_PREFIX = "agent-core-content/v1";
const BODY_DIGEST_METADATA = "agent-core-body-sha256";
const TENANT_DIGEST_METADATA = "agent-core-tenant-sha256";
const FORMAT_METADATA = "agent-core-format";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

export interface R2BucketLike {
    put(
        key: string,
        value: ArrayBuffer | ArrayBufferView,
        options: R2PutOptionsLike
    ): Promise<R2ObjectLike | null>;
    get(key: string): Promise<R2ObjectBodyLike | null>;
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

/**
 * Stores immutable bytes only. Domain holds, authority, and Receipts remain outside
 * this repository and are intentionally absent from its API and metadata.
 */
export class R2ContentObjectRepository {
    public constructor(
        private readonly bucket: R2BucketLike,
        private readonly errors: CloudflareErrorPort
    ) {}

    public async put(tenantId: TenantId, bytes: Uint8Array): Promise<ContentObjectPutResult> {
        const detached = bytes.slice();
        const address = await contentObjectAddress(tenantId, detached, this.errors);
        const metadata = objectMetadata(address);
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
        return Object.freeze({ ...stored, bytes: stored.bytes.slice(), created: written !== null });
    }

    public async get(tenantId: TenantId, digest: string): Promise<ContentObject | undefined> {
        requireTenantId(tenantId, this.errors);
        requireDigest(digest, this.errors);
        const tenantDigest = await sha256(new TextEncoder().encode(tenantId.value), this.errors);
        return this.read(
            Object.freeze({
                key: contentObjectKey(tenantDigest, digest),
                digest,
                tenantDigest
            })
        );
    }

    private async read(address: ContentObjectAddress): Promise<ContentObject | undefined> {
        const object = await this.callR2("R2 content read failed", () =>
            this.bucket.get(address.key)
        );
        if (object === null) return undefined;
        const body = new Uint8Array(
            await this.callR2("R2 content body read failed", () => object.arrayBuffer())
        ).slice();
        this.validateObject(object, address, body.byteLength);
        if ((await sha256(body, this.errors)) !== address.digest) {
            this.corrupt("R2 content body digest does not match its address");
        }
        return Object.freeze({ ...address, bytes: body.slice() });
    }

    private async callR2<Result>(
        message: string,
        operation: () => Promise<Result>
    ): Promise<Result> {
        try {
            return await operation();
        } catch (cause) {
            operationalFailure(this.errors, "protocol.invalid-state", message, cause);
        }
    }

    private corrupt(message: string): never {
        return operationalFailure(this.errors, "codec.invalid", message);
    }

    private validateObject(
        object: R2ObjectLike,
        address: ContentObjectAddress,
        bodyLength: number
    ): void {
        const metadata = object.customMetadata ?? {};
        if (
            object.key !== address.key ||
            object.size !== bodyLength ||
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
}

export async function contentObjectAddress(
    tenantId: TenantId,
    bytes: Uint8Array,
    errors: CloudflareErrorPort
): Promise<ContentObjectAddress> {
    requireTenantId(tenantId, errors);
    const [tenantDigest, digest] = await Promise.all([
        sha256(new TextEncoder().encode(tenantId.value), errors),
        sha256(bytes.slice(), errors)
    ]);
    return Object.freeze({ key: contentObjectKey(tenantDigest, digest), digest, tenantDigest });
}

function contentObjectKey(tenantDigest: string, digest: string): string {
    return `${KEY_PREFIX}/tenant-sha256/${tenantDigest}/sha256/${digest}`;
}

function objectMetadata(address: ContentObjectAddress): Readonly<Record<string, string>> {
    return Object.freeze({
        [FORMAT_METADATA]: FORMAT_VERSION,
        [BODY_DIGEST_METADATA]: address.digest,
        [TENANT_DIGEST_METADATA]: address.tenantDigest
    });
}

async function sha256(bytes: Uint8Array, errors: CloudflareErrorPort): Promise<string> {
    const detached = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(detached).set(bytes);
    try {
        return hex(await crypto.subtle.digest("SHA-256", detached));
    } catch (cause) {
        operationalFailure(errors, "protocol.invalid-state", "SHA-256 digest failed", cause);
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
