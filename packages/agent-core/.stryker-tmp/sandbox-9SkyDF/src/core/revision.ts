// @ts-nocheck
import { AgentCoreError } from "../errors";

const exactRevisions = new WeakSet<object>();

export class Revision {
    readonly #value: number;

    public constructor(value: number) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new TypeError("Revision must be a non-negative safe integer");
        }
        this.#value = value;
        if (new.target === Revision) exactRevisions.add(this);
        Object.freeze(this);
    }

    public static isExact(value: unknown): value is Revision {
        return value !== null && typeof value === "object" && exactRevisions.has(value);
    }

    public static initial(): Revision {
        return new Revision(0);
    }

    public get value(): number {
        return this.#value;
    }

    public next(): Revision {
        if (this.#value === Number.MAX_SAFE_INTEGER) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Revision cannot exceed the maximum safe integer"
            );
        }
        return new Revision(this.#value + 1);
    }

    public equals(other: Revision): boolean {
        return (
            typeof other === "object" &&
            other !== null &&
            #value in other &&
            this.#value === other.#value
        );
    }
}
