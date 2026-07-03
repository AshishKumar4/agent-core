export abstract class TextId {
    readonly #value: string;

    protected constructor(value: string, name: string) {
        if (value.length === 0 || value.length > 256) {
            throw new TypeError(`${name} must contain between 1 and 256 characters`);
        }

        this.#value = value;
    }

    public get value(): string {
        return this.#value;
    }

    public equals(other: TextId): boolean {
        return this.constructor === other.constructor && this.#value === other.#value;
    }

    public toString(): string {
        return this.#value;
    }
}
