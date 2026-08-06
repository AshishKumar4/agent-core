/**
 * Determinism primitives for the load and stress suite. Stress schedules must be
 * reproducible byte for byte across runs, so every ordering decision comes from a
 * named seed and every rendezvous point is explicit rather than timing dependent.
 */

const FNV_OFFSET = 2_166_136_261;
const FNV_PRIME = 16_777_619;
const MULBERRY_INCREMENT = 0x6d2b79f5;
const UNSIGNED_DIVISOR = 4_294_967_296;

/** Seeded PRNG. Every stress schedule draws its ordering from a named seed. */
export class StressRandom {
    #state: number;

    public constructor(seed: string) {
        let hash = FNV_OFFSET;
        for (let index = 0; index < seed.length; index += 1) {
            hash = Math.imul(hash ^ seed.charCodeAt(index), FNV_PRIME) >>> 0;
        }
        this.#state = hash;
    }

    /** Uniform integer in [0, bound). */
    public integer(bound: number): number {
        if (!Number.isSafeInteger(bound) || bound <= 0) {
            throw new TypeError("Stress random bound must be a positive safe integer");
        }
        this.#state = (this.#state + MULBERRY_INCREMENT) >>> 0;
        let mixed = Math.imul(this.#state ^ (this.#state >>> 15), 1 | this.#state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / UNSIGNED_DIVISOR) * bound);
    }

    public boolean(): boolean {
        return this.integer(2) === 1;
    }

    /** Fisher-Yates over a copy, so callers keep their source ordering. */
    public shuffle<Item>(items: readonly Item[]): Item[] {
        const shuffled = [...items];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const target = this.integer(index + 1);
            const held = shuffled[index]!;
            shuffled[index] = shuffled[target]!;
            shuffled[target] = held;
        }
        return shuffled;
    }
}

/**
 * A one-shot rendezvous used to suspend an in-flight operation at a known seam so a
 * competing operation can be driven to completion against the same durable state.
 */
export class StressGate {
    public readonly reached: Promise<void>;
    readonly #released: Promise<void>;
    #reach: (() => void) | undefined;
    #release: (() => void) | undefined;

    public constructor() {
        this.reached = new Promise((resolve) => {
            this.#reach = resolve;
        });
        this.#released = new Promise((resolve) => {
            this.#release = resolve;
        });
    }

    /** Called from inside the operation under contention. */
    public async wait(): Promise<void> {
        this.#reach?.();
        this.#reach = undefined;
        await this.#released;
    }

    public release(): void {
        this.#release?.();
        this.#release = undefined;
    }
}
