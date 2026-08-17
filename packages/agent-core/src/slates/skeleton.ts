import { Digest, RecordCodec, type JsonValue } from "../core";
import type { BindingRequirement } from "../facets";
import {
    bindingRequirements,
    canonicalBindingRequirements,
    digest,
    requireExactObject
} from "./codec";

class SlateSkeletonCodecV1 extends RecordCodec<SlateSkeleton> {
    public constructor() {
        super("slate.skeleton", { major: 1, minor: 0 });
    }

    protected encodePayload(skeleton: SlateSkeleton): JsonValue {
        return skeleton.toData();
    }

    protected decodePayload(payload: JsonValue): SlateSkeleton {
        return SlateSkeleton.fromData(payload);
    }
}

/**
 * The credential-free export of a published Slate: the shape a forker receives and the
 * capabilities that shape needs, and nothing else (SPEC §4.6).
 *
 * The two admissible field types are what makes the absence structural rather than
 * reviewed. `sourceDigest` is a `Digest` and not a `ContentRef` on purpose: a record that
 * named a `ContentRef` would be a retainer of that content in whichever Tenant's
 * ContentStore read it (§8.2), so a skeleton admitted into a Scope that does not hold the
 * bytes would name content nothing there retains. A digest is inert identity — it lets an
 * importer prove the bytes they were handed are the ones the publisher declared, and
 * resolves to nothing on its own. `bindings` are `BindingRequirement`s, which are
 * declarations of a needed capability and never grants of one.
 */
export class SlateSkeleton {
    public static readonly codec: RecordCodec<SlateSkeleton> = new SlateSkeletonCodecV1();
    public readonly sourceDigest: Digest;
    public readonly bindings: readonly BindingRequirement[];

    public constructor(sourceDigest: Digest, bindings: readonly BindingRequirement[]) {
        if (!(sourceDigest instanceof Digest)) {
            throw new TypeError("Slate skeleton source digest must be a Digest");
        }
        this.sourceDigest = sourceDigest;
        this.bindings = canonicalBindingRequirements(bindings, "Slate skeleton bindings");
        Object.freeze(this);
    }

    public static encode(skeleton: SlateSkeleton): Uint8Array {
        return SlateSkeleton.codec.encode(skeleton);
    }

    public static decode(bytes: Uint8Array): SlateSkeleton {
        return SlateSkeleton.codec.decode(bytes);
    }

    public toData(): JsonValue {
        return {
            bindings: this.bindings.map((requirement) => requirement.toData()),
            sourceDigest: this.sourceDigest.value
        };
    }

    public static fromData(payload: JsonValue): SlateSkeleton {
        const object = requireExactObject(
            payload,
            ["bindings", "sourceDigest"],
            "Slate skeleton payload"
        );
        return new SlateSkeleton(
            digest(object["sourceDigest"], "Slate skeleton source digest"),
            bindingRequirements(object["bindings"], "Slate skeleton bindings")
        );
    }
}
