import { AgentCoreError } from "../errors";

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

    public read(bytes: Uint8Array): Uint8Array {
        const end = this.length === undefined ? bytes.byteLength : this.offset + this.length;
        requireRange(this.offset <= bytes.byteLength && end <= bytes.byteLength);
        return bytes.slice(this.offset, end);
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
