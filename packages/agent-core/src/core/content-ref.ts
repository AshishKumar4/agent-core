import { Digest } from "./digest";
import { TextId } from "./id";

const CONTENT_REF_PATTERN = /^sha256:([a-f0-9]{64})$/;

export class ContentRef extends TextId {
    public readonly digest: Digest;

    public constructor(value: string) {
        super(value, "Content reference");
        const match = CONTENT_REF_PATTERN.exec(value);
        if (match === null) {
            throw new TypeError("Content reference must be a SHA-256 content address");
        }
        this.digest = new Digest(match[1]!);
        Object.freeze(this);
    }

    public static fromDigest(digest: Digest): ContentRef {
        requireDigest(digest);
        return new ContentRef(`${digest.algorithm}:${digest.value}`);
    }
}

function requireDigest(digest: Digest): void {
    if (!(digest instanceof Digest)) {
        throw new TypeError("Content reference digest must be a Digest");
    }
}

/**
 * One ContentRef a durable record names, under the exact field path the record registry
 * declares for its kind. A record projects itself onto these and never onto owner keys: the
 * key is the custody plane's to derive, so one record shape cannot name content under two
 * different keys. It lives beside ContentRef rather than in the content plane because a
 * record that names content must not take a runtime dependency on the plane that retains it.
 */
export interface ContentRetentionField {
    readonly field: string;
    readonly ref: ContentRef;
}

/**
 * The projection helper every record-adjacent retention function is written through. An
 * absent optional ContentRef contributes no field rather than an empty one, so a record that
 * names nothing yields no owner edge at all.
 */
export function contentRetentionFields(
    fields: readonly (readonly [field: string, ref: ContentRef | undefined])[]
): readonly ContentRetentionField[] {
    return Object.freeze(
        fields.flatMap(([field, ref]) => (ref === undefined ? [] : [Object.freeze({ field, ref })]))
    );
}
