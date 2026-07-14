import { hasOnlyUnicodeScalarValues } from "./unicode";

export abstract class TextId {
    readonly #value: string;
    readonly #type: Function;

    protected constructor(value: string, name: string) {
        if (
            typeof value !== "string" ||
            value.length === 0 ||
            value.length > 256 ||
            !hasOnlyUnicodeScalarValues(value)
        ) {
            throw new TypeError(`${name} must contain between 1 and 256 characters`);
        }

        this.#value = value;
        this.#type = new.target;
    }

    public get value(): string {
        return this.#value;
    }

    public equals(other: TextId): boolean {
        return (
            typeof other === "object" &&
            other !== null &&
            #value in other &&
            this.#type === other.#type &&
            this.#value === other.#value
        );
    }

    public toString(): string {
        return this.#value;
    }
}
