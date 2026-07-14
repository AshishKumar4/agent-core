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
