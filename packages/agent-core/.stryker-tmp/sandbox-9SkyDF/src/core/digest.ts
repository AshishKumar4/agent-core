// @ts-nocheck
import { createHash } from "node:crypto";
import { TextId } from "./id";

export type DigestAlgorithm = "sha256";

export class Digest extends TextId {
    public readonly algorithm: DigestAlgorithm;

    public constructor(value: string, algorithm: DigestAlgorithm = "sha256") {
        super(value, "Digest");
        if (algorithm !== "sha256") {
            throw new TypeError("Digest algorithm must be sha256");
        }
        if (!/^[a-f0-9]{64}$/.test(value)) {
            throw new TypeError("Digest must be a lowercase SHA-256 hexadecimal value");
        }
        this.algorithm = algorithm;
        Object.freeze(this);
    }

    public static sha256(bytes: Uint8Array): Digest {
        requireDigestBytes(bytes);
        return new Digest(createHash("sha256").update(new Uint8Array(bytes)).digest("hex"));
    }
}

function requireDigestBytes(bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array)) {
        throw new TypeError("Digest input must be a Uint8Array");
    }
}
