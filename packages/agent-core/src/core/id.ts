import { isJsonString } from "./json";
import { hasOnlyUnicodeScalarValues } from "./unicode";

/**
 * The longest an opaque identifier or short canonical name may be. Chosen by this
 * implementation rather than declared by the SPEC, which is exactly why it is named once
 * and interpolated into the refusal: a bare literal repeated at the comparison and again
 * in the message lets the two drift, and says nothing about which bound it is.
 */
const MAX_TEXT_VALUE_LENGTH = 256;

export abstract class TextId {
    readonly #value: string;
    readonly #type: Function;

    protected constructor(value: string, name: string) {
        if (
            !isJsonString(value) ||
            value.length === 0 ||
            value.length > MAX_TEXT_VALUE_LENGTH ||
            !hasOnlyUnicodeScalarValues(value)
        ) {
            throw new TypeError(
                `${name} must contain between 1 and ${MAX_TEXT_VALUE_LENGTH} characters`
            );
        }

        this.#value = value;
        this.#type = new.target;
    }

    public get value(): string {
        return this.#value;
    }

    public equals(other: TextId): boolean {
        return (
            other instanceof TextId &&
            #value in other &&
            this.#type === other.#type &&
            this.#value === other.#value
        );
    }

    public toString(): string {
        return this.#value;
    }
}
