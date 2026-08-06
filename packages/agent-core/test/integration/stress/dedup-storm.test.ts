import { describe, expect, test } from "vitest";
import type { AuditRecord } from "../../../src/invocations";
import type { CommandDispatchResult } from "../../../src/protocol/dispatcher";
import type { WriteRecord } from "../../../src/protocol/write";
import { CounterHarness, type CounterFixture } from "../../protocol/counter-fixture";
import { SqliteCounterHarness } from "../../protocol/sqlite-counter-fixture";
import { StressRandom } from "./stress-support";

const STORM_KEY = "storm";
const STORM_AMOUNT = 7;
const DISTINCT_PREFIX = "distinct-";
const STRESS_TIMEOUT = 90_000;

interface StormShape {
    /** Concurrent submissions that all carry the single contended idempotency key. */
    readonly duplicates: number;
    /** Distinct keys interleaved into the same concurrent wave. */
    readonly distinctKeys: number;
    /** Full-key replay waves issued after the storm has settled. */
    readonly replayRounds: number;
}

interface Submission {
    readonly key: string;
    readonly raw: Uint8Array;
}

interface Storm {
    readonly harness: CounterFixture;
    readonly keys: readonly string[];
    readonly submissions: readonly Submission[];
    readonly results: readonly CommandDispatchResult[];
}

function keyAmount(key: string): number {
    return key === STORM_KEY ? STORM_AMOUNT : Number(key.slice(DISTINCT_PREFIX.length)) + 1;
}

function stormKeys(shape: StormShape): readonly string[] {
    return [
        STORM_KEY,
        ...Array.from(
            { length: shape.distinctKeys },
            (_value, index) => `${DISTINCT_PREFIX}${index}`
        )
    ];
}

function submit(harness: CounterFixture, key: string): Submission {
    return {
        key,
        raw: harness.envelope({ key, amount: keyAmount(key), omitRevision: true })
    };
}

/**
 * Drives one concurrent wave carrying `duplicates` copies of a single idempotency key
 * interleaved with `distinctKeys` unique keys, in a seed-determined order.
 */
async function runStorm(
    harness: CounterFixture,
    shape: StormShape,
    seed: string
): Promise<Storm> {
    const planned: Submission[] = [];
    for (let index = 0; index < shape.duplicates; index += 1) {
        planned.push(submit(harness, STORM_KEY));
    }
    for (const key of stormKeys(shape).slice(1)) {
        planned.push(submit(harness, key));
    }
    const submissions = new StressRandom(seed).shuffle(planned);
    const results = await Promise.all(
        submissions.map((submission) => harness.dispatch(submission.raw))
    );
    return { harness, keys: stormKeys(shape), submissions, results };
}

function resultsForKey(storm: Storm, key: string): readonly CommandDispatchResult[] {
    return storm.results.filter((_result, index) => storm.submissions[index]?.key === key);
}

function committedFor(storm: Storm, key: string): CommandDispatchResult {
    const committed = resultsForKey(storm, key).filter(
        (result) => result.outcome === "committed"
    );
    expect(committed).toHaveLength(1);
    const only = committed[0];
    if (only === undefined) throw new TypeError("Storm key has no committed write");
    return only;
}

/** Every write must own exactly one write-kind audit, and no write audit may be orphaned. */
function writeAuditBijection(
    writes: readonly WriteRecord[],
    audits: ReadonlyMap<string, AuditRecord>
): { readonly covered: number; readonly writeAudits: number } {
    for (const write of writes) {
        expect(audits.get(write.audit.value)?.kind).toMatchObject({
            kind: "write",
            id: write.id,
            outcome: write.outcome
        });
    }
    const writeAudits = [...audits.values()].filter((audit) => audit.kind.kind === "write");
    for (const audit of writeAudits) {
        if (audit.kind.kind !== "write") throw new TypeError("Expected a write audit");
        const id = audit.kind.id;
        expect(writes.some((write) => write.id.equals(id))).toBe(true);
    }
    return { covered: writes.length, writeAudits: writeAudits.length };
}

function dedupStormContract(
    title: string,
    seed: string,
    shape: StormShape,
    create: () => CounterFixture
): void {
    describe(title, () => {
        const total = shape.duplicates + shape.distinctKeys;

        test(
            "commits exactly one write per idempotency key under a concurrent storm",
            { tags: "p0", timeout: STRESS_TIMEOUT },
            async () => {
                const storm = await runStorm(create(), shape, `${seed}-commit`);
                const snapshot = storm.harness.snapshot();

                for (const key of storm.keys) {
                    const forKey = resultsForKey(storm, key);
                    committedFor(storm, key);
                    expect([...new Set(forKey.map((result) => result.outcome))].sort()).toEqual(
                        forKey.length === 1 ? ["committed"] : ["committed", "duplicate"]
                    );
                }

                const distinctSum = (shape.distinctKeys * (shape.distinctKeys + 1)) / 2;
                expect(snapshot.value).toBe(STORM_AMOUNT + distinctSum);
                expect(snapshot.revision.value).toBe(shape.distinctKeys + 1);
                expect(snapshot.identityCount).toBe(shape.distinctKeys + 1);
                expect(snapshot.writes).toHaveLength(total);
                expect(snapshot.contentPuts).toBe(0);
                expect(writeAuditBijection(snapshot.writes, snapshot.audits)).toEqual({
                    covered: total,
                    writeAudits: total
                });
            }
        );

        test(
            "replays every duplicate byte-identically against its original write",
            { tags: "p0", timeout: STRESS_TIMEOUT },
            async () => {
                const storm = await runStorm(create(), shape, `${seed}-replay`);

                for (const key of storm.keys) {
                    const committed = committedFor(storm, key);
                    for (const result of resultsForKey(storm, key)) {
                        if (result === committed) continue;
                        expect(result.outcome).toBe("duplicate");
                        expect(result.reply).toEqual(committed.reply);
                        expect(result.observation).toBeUndefined();
                        expect(result.write.observation).toBeUndefined();
                        expect(result.write.duplicateOf?.equals(committed.write.id)).toBe(true);
                        expect(result.write.idempotencyKey).toBe(key);
                        expect(result.write.actor.equals(committed.write.actor)).toBe(true);
                        expect(
                            result.write.envelopeDigest.equals(committed.write.envelopeDigest)
                        ).toBe(true);
                    }
                }
            }
        );

        test(
            "reserves no further identity and fetches no content when a settled storm is replayed",
            { tags: "p0", timeout: STRESS_TIMEOUT },
            async () => {
                const storm = await runStorm(create(), shape, `${seed}-quiescent`);
                const settled = storm.harness.snapshot();
                const originals = new Map(
                    storm.keys.map((key) => [key, committedFor(storm, key)] as const)
                );
                const random = new StressRandom(`${seed}-quiescent-replay`);

                for (let round = 0; round < shape.replayRounds; round += 1) {
                    const replayed = random.shuffle(storm.keys);
                    const results = await Promise.all(
                        replayed.map((key) =>
                            storm.harness.dispatch(submit(storm.harness, key).raw)
                        )
                    );
                    for (const [index, result] of results.entries()) {
                        const original = originals.get(replayed[index] ?? "");
                        expect(result.outcome).toBe("duplicate");
                        expect(result.reply).toEqual(original?.reply);
                        expect(result.write.duplicateOf?.value).toBe(original?.write.id.value);
                    }
                }

                const after = storm.harness.snapshot();
                expect(after.contentGets).toBe(settled.contentGets);
                expect(after.contentPuts).toBe(settled.contentPuts);
                expect(after.identityCount).toBe(settled.identityCount);
                expect(after.value).toBe(settled.value);
                expect(after.revision.value).toBe(settled.revision.value);
                expect(after.writes).toHaveLength(
                    total + shape.replayRounds * storm.keys.length
                );
                expect(writeAuditBijection(after.writes, after.audits)).toEqual({
                    covered: after.writes.length,
                    writeAudits: after.writes.length
                });
            }
        );
    });
}

// The memory protocol persistence rescans and re-decodes its whole record set on every
// identity lookup, so its storm carries the same contention over fewer records.
dedupStormContract(
    "dedup storm over the memory actor store",
    "memory",
    { duplicates: 12, distinctKeys: 6, replayRounds: 2 },
    () => new CounterHarness({ expectedRevision: "optional" })
);

dedupStormContract(
    "dedup storm over the SQLite actor store",
    "sqlite",
    { duplicates: 40, distinctKeys: 20, replayRounds: 2 },
    () => new SqliteCounterHarness({ expectedRevision: "optional" })
);
