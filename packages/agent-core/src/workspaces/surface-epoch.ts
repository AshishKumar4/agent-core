import { canonicalTupleKey, type JsonValue, type Revision } from "../core";
import { AgentCoreError } from "../errors";
import { requireInteger } from "./codec";

const exactEpochs = new WeakSet<object>();

/**
 * SPEC §6.3: one registration generation of a static `SurfaceId`. A Surface keeps its id
 * across releases, so the id alone cannot tell one registration's View stream from the
 * stream of a later registration that reuses the id. The epoch does. The first stream of a
 * Surface is epoch 1, and the stream that opens after a retirement is the next ordinal, so
 * a retired stream stays readable at its own key forever while a new stream starts empty.
 */
export class SurfaceEpoch {
    readonly #value: number;

    public constructor(value: number) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new TypeError("Surface epoch must be a positive safe integer");
        }
        this.#value = value;
        if (new.target === SurfaceEpoch) exactEpochs.add(this);
        Object.freeze(this);
    }

    public static isExact(value: unknown): value is SurfaceEpoch {
        return value !== null && typeof value === "object" && exactEpochs.has(value);
    }

    public static first(): SurfaceEpoch {
        return new SurfaceEpoch(1);
    }

    public get value(): number {
        return this.#value;
    }

    /** The canonical text form composite stream keys and error messages are built from. */
    public get text(): string {
        return String(this.#value);
    }

    public next(): SurfaceEpoch {
        if (this.#value === Number.MAX_SAFE_INTEGER) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Surface epoch cannot exceed the maximum safe integer"
            );
        }
        return new SurfaceEpoch(this.#value + 1);
    }

    public equals(other: SurfaceEpoch): boolean {
        return SurfaceEpoch.isExact(other) && this.#value === other.#value;
    }
}

export function decodeSurfaceEpoch(value: JsonValue | undefined, subject: string): SurfaceEpoch {
    return new SurfaceEpoch(requireInteger(value, subject));
}

/**
 * The key of one View stream. Every View and ViewDelta storage path is keyed on this pair,
 * so a revision of one epoch can never answer a read of another. Canonical JSON keeps the
 * two components apart even when a Surface ID contains the delimiter.
 */
export function surfaceStreamKey(surface: string, epoch: SurfaceEpoch): string {
    return canonicalTupleKey("view.stream", [surface, epoch.value]);
}

/**
 * The key of one revision within one View stream. The three components go into one canonical
 * tuple rather than being joined onto the stream key, because a delimiter join is not
 * injective: a Surface ID is unconstrained text, so appending a separator and a revision to
 * it lets two different revisions of two different Surfaces produce one key.
 */
export function surfaceRevisionKey(
    surface: string,
    epoch: SurfaceEpoch,
    revision: Revision
): string {
    return canonicalTupleKey("view.revision", [surface, epoch.value, revision.value]);
}
