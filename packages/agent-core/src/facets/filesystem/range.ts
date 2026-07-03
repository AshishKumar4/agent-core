export abstract class ReadRange {
    public static all(): ReadRange {
        return new WholeRange();
    }

    public static from(offset: number): ReadRange {
        return new TailRange(nonnegative(offset, "Read offset"));
    }

    public static slice(offset: number, length: number): ReadRange {
        return new SliceRange(
            nonnegative(offset, "Read offset"),
            nonnegative(length, "Read length")
        );
    }

    public abstract read(content: Uint8Array): Uint8Array;
}

class WholeRange extends ReadRange {
    public read(content: Uint8Array): Uint8Array {
        return content.slice();
    }
}

class TailRange extends ReadRange {
    public constructor(private readonly offset: number) {
        super();
    }

    public read(content: Uint8Array): Uint8Array {
        return content.slice(this.offset);
    }
}

class SliceRange extends ReadRange {
    public constructor(
        private readonly offset: number,
        private readonly length: number
    ) {
        super();
    }

    public read(content: Uint8Array): Uint8Array {
        return content.slice(this.offset, this.offset + this.length);
    }
}

function nonnegative(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a nonnegative safe integer`);
    }

    return value;
}
