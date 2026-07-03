export class Revision {
    readonly #value: number;

    public constructor(value: number) {
        if (!Number.isInteger(value) || value < 0) {
            throw new TypeError("Revision must be a non-negative integer");
        }

        this.#value = value;
    }

    public static initial(): Revision {
        return new Revision(0);
    }

    public get value(): number {
        return this.#value;
    }

    public next(): Revision {
        return new Revision(this.#value + 1);
    }

    public equals(other: Revision): boolean {
        return this.#value === other.#value;
    }
}

export class ContentRef {
    readonly #value: string;

    public constructor(value: string) {
        if (value.length === 0 || value.length > 2048) {
            throw new TypeError("Content reference must contain between 1 and 2048 characters");
        }

        this.#value = value;
    }

    public get value(): string {
        return this.#value;
    }

    public equals(other: ContentRef): boolean {
        return this.#value === other.#value;
    }

    public toString(): string {
        return this.#value;
    }
}

export class Digest {
    readonly #value: string;

    public constructor(value: string) {
        if (value.length === 0 || value.length > 512) {
            throw new TypeError("Digest must contain between 1 and 512 characters");
        }

        this.#value = value;
    }

    public get value(): string {
        return this.#value;
    }

    public equals(other: Digest): boolean {
        return this.#value === other.#value;
    }

    public toString(): string {
        return this.#value;
    }
}
