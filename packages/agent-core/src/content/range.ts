import { AgentCoreError } from "../errors";

/** The offset and length one `ByteRange` names inside content of a known size. */
export interface ByteRangeWindow {
    readonly offset: number;
    readonly length: number;
}

export class ByteRange {
    static readonly #whole = new ByteRange(0, undefined);

    private constructor(
        private readonly offset: number,
        private readonly length: number | undefined
    ) {
        if (new.target !== ByteRange) {
            throw new TypeError("ByteRange cannot be subclassed");
        }
        Object.freeze(this);
    }

    public static all(): ByteRange {
        return ByteRange.#whole;
    }

    public static from(offset: number): ByteRange {
        return new ByteRange(requireNonnegative(offset, "Byte range offset"), undefined);
    }

    public static slice(offset: number, length: number): ByteRange {
        const validOffset = requireNonnegative(offset, "Byte range offset");
        const validLength = requireNonnegative(length, "Byte range length");
        requireSafeRangeEnd(validOffset + validLength);
        return new ByteRange(validOffset, validLength);
    }

    /**
     * The exact window this range names inside content of `size` bytes, refused rather
     * than clamped when it reaches past them. A store that carries its content in memory
     * has no use for this beyond `read`, but one that pushes a range down to a platform
     * that answers ranges itself — an R2 ranged `get`, an HTTP `Range` — needs the window
     * as data before it asks, and taking it from here is what keeps one refusal rule for
     * every substrate: the platform is only ever asked for bytes this range has already
     * proved are inside the content, so a platform that clamps an over-long range never
     * gets the chance to answer with fewer bytes than the caller asked for.
     */
    public resolve(size: number): ByteRangeWindow {
        const total = requireNonnegative(size, "Content size");
        const end = this.length === undefined ? total : this.offset + this.length;
        requireRange(this.offset <= total && end <= total);
        return { offset: this.offset, length: end - this.offset };
    }

    public read(bytes: Uint8Array): Uint8Array {
        const window = this.resolve(bytes.byteLength);
        return bytes.slice(window.offset, window.offset + window.length);
    }
}

Object.freeze(ByteRange.prototype);

function requireNonnegative(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`);
    }
    return value;
}

function requireSafeRangeEnd(end: number): void {
    if (!Number.isSafeInteger(end)) {
        throw new TypeError("Byte range end must be a safe integer");
    }
}

function requireRange(condition: boolean): void {
    if (!condition) {
        throw new AgentCoreError("content.invalid-range", "Byte range exceeds content bounds");
    }
}
