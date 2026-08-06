import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Revision } from "../../../src/core";
import { SqliteProtocolPersistence, SqliteWorkspaceEventRecords } from "../../../src/substrates";
import { WorkspacePersistence } from "../../../src/workspaces";
import type { Event } from "../../../src/workspaces/event";
import { FileSqlite } from "../../helpers/sqlite";
import { expectAgentCoreError } from "../../protocol/error-assertion";
import { SqliteCounterHarness } from "../../protocol/sqlite-counter-fixture";
import {
    eventFixture,
    eventRetention,
    sourceActor,
    subscriptionFixture,
    tenant
} from "../../workspaces/fixtures";
import { StressRandom } from "./stress-support";

const STRESS_TIMEOUT = 120_000;
const BATCHES = 100;
const BATCH_SIZE = 100;
const ROLLED_BACK_IN = 5;
const SUBSCRIPTION_SUFFIX = "saturation";
const PROTOCOL_COMMANDS = 150;

const retentionPort = { verify: () => true, release: () => {}, discard: () => {} };

interface DatabaseFile {
    open(): FileSqlite;
    close(database: FileSqlite): void;
}

/** Runs against a real file-backed database so "reopen" means a fresh connection. */
async function withDatabaseFile(
    name: string,
    run: (file: DatabaseFile) => Promise<void> | void
): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), `agent-core-stress-${name}-`));
    const path = join(directory, "stress.sqlite");
    const handles = new Set<FileSqlite>();
    try {
        await run({
            open: () => {
                const database = new FileSqlite(path);
                handles.add(database);
                return database;
            },
            close: (database) => {
                handles.delete(database);
                database.close();
            }
        });
    } finally {
        for (const database of handles) database.close();
        rmSync(directory, { recursive: true, force: true });
    }
}

function persistenceFor(): WorkspacePersistence<SqliteWorkspaceEventRecords> {
    return new WorkspacePersistence<SqliteWorkspaceEventRecords>(
        (value) => value,
        retentionPort,
        sourceActor,
        tenant
    );
}

function batchEvents(batch: number): readonly Event[] {
    return Array.from({ length: BATCH_SIZE }, (_value, index) =>
        eventFixture(`saturation-${batch}-${index}`)
    );
}

function rowCount(database: FileSqlite, table: string): number {
    const value = database.all(`SELECT COUNT(*) AS count FROM ${table}`, [])[0]?.["count"];
    if (typeof value !== "number") throw new TypeError(`Expected a row count for ${table}`);
    return value;
}

describe("sqlite saturation", () => {
    test(
        "keeps append-only tables exact across interleaved commits and rollbacks",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        async () => {
            await withDatabaseFile("append-only", (file) => {
                const database = file.open();
                const records = new SqliteWorkspaceEventRecords(database);
                const persistence = persistenceFor();
                const random = new StressRandom("sqlite-saturation-append");
                const committed: Event[] = [];
                const discarded: Event[] = [];
                let subscriptionRevision: Revision | undefined;
                let conflicts = 0;

                for (let batch = 0; batch < BATCHES; batch += 1) {
                    const events = batchEvents(batch);
                    const rollback = random.integer(ROLLED_BACK_IN) === 0;
                    const before = rowCount(database, "workspace_event_records");

                    if (rollback) {
                        expect(() =>
                            database.transaction(() => {
                                for (const event of events) {
                                    persistence.appendEvent(records, event, eventRetention(event));
                                }
                                throw new TypeError("stress rollback");
                            })
                        ).toThrow(TypeError);
                        discarded.push(...events);
                        expect(rowCount(database, "workspace_event_records")).toBe(before);
                        continue;
                    }

                    const expected = subscriptionRevision;
                    const next = expected?.next() ?? Revision.initial();
                    database.transaction(() => {
                        for (const event of events) {
                            persistence.appendEvent(records, event, eventRetention(event));
                        }
                        persistence.saveSubscription(
                            records,
                            subscriptionFixture(SUBSCRIPTION_SUFFIX, { revision: next }),
                            expected
                        );
                    });
                    subscriptionRevision = next;
                    committed.push(...events);
                    expect(rowCount(database, "workspace_event_records")).toBe(
                        before + events.length * 2 + 1
                    );

                    // A stale compare-and-set must never advance the durable pointer.
                    expectAgentCoreError(
                        () =>
                            database.transaction(() =>
                                persistence.saveSubscription(
                                    records,
                                    subscriptionFixture(SUBSCRIPTION_SUFFIX, {
                                        revision: next.next()
                                    }),
                                    expected
                                )
                            ),
                        "protocol.revision-conflict"
                    );
                    conflicts += 1;
                    expect(
                        persistence.currentSubscription(
                            records,
                            subscriptionFixture(SUBSCRIPTION_SUFFIX).id
                        )?.revision.value
                    ).toBe(next.value);
                }

                expect(committed.length + discarded.length).toBe(BATCHES * BATCH_SIZE);
                expect(discarded.length).toBeGreaterThan(0);
                expect(conflicts).toBe(committed.length / BATCH_SIZE);
                expect(rowCount(database, "workspace_event_records")).toBe(
                    committed.length * 2 + committed.length / BATCH_SIZE
                );
                expect(rowCount(database, "workspace_event_uniques")).toBe(committed.length);
                expect(rowCount(database, "workspace_event_pointers")).toBe(1);
                for (const event of discarded) {
                    expect(persistence.findEvent(records, event.id)).toBeUndefined();
                    expect(
                        persistence.findEventByIdentity(records, event.idempotencyKey)
                    ).toBeUndefined();
                }
            });
        }
    );

    test(
        "reads every committed row back through a reopened connection",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        async () => {
            await withDatabaseFile("reopen", (file) => {
                const first = file.open();
                const firstRecords = new SqliteWorkspaceEventRecords(first);
                const persistence = persistenceFor();
                const events: Event[] = [];
                for (let batch = 0; batch < BATCHES; batch += 1) {
                    const batched = batchEvents(batch);
                    first.transaction(() => {
                        for (const event of batched) {
                            persistence.appendEvent(firstRecords, event, eventRetention(event));
                        }
                    });
                    events.push(...batched);
                }
                const expectedRecords = rowCount(first, "workspace_event_records");
                const expectedUniques = rowCount(first, "workspace_event_uniques");
                file.close(first);

                const reopened = file.open();
                const reopenedRecords = new SqliteWorkspaceEventRecords(reopened);
                const reopenedPersistence = persistenceFor();

                expect(rowCount(reopened, "workspace_event_records")).toBe(expectedRecords);
                expect(rowCount(reopened, "workspace_event_uniques")).toBe(expectedUniques);
                expect(expectedUniques).toBe(events.length);
                for (const event of events) {
                    expect(
                        reopenedPersistence
                            .findEventByIdentity(reopenedRecords, event.idempotencyKey)
                            ?.id.value
                    ).toBe(event.id.value);
                }
                const replayed = events[0];
                if (replayed === undefined) throw new TypeError("Expected a committed event");
                expectAgentCoreError(
                    () =>
                        reopened.transaction(() =>
                            reopenedPersistence.appendEvent(
                                reopenedRecords,
                                replayed,
                                eventRetention(replayed)
                            )
                        ),
                    "protocol.duplicate"
                );
                expect(rowCount(reopened, "workspace_event_records")).toBe(expectedRecords);
            });
        }
    );

    test(
        "revalidates the whole protocol record graph when the database is reopened",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        async () => {
            await withDatabaseFile("protocol-graph", async (file) => {
                const first = file.open();
                const harness = new SqliteCounterHarness({ expectedRevision: "optional" }, first);
                const random = new StressRandom("sqlite-saturation-protocol");
                const keys = random.shuffle(
                    Array.from({ length: PROTOCOL_COMMANDS }, (_value, index) => `graph-${index}`)
                );
                for (const key of keys) {
                    const result = await harness.dispatch(
                        harness.envelope({ key, amount: 1, omitRevision: true })
                    );
                    expect(result.outcome).toBe("committed");
                }
                const before = {
                    writes: rowCount(first, "protocol_write_records"),
                    audits: rowCount(first, "protocol_audit_records"),
                    identities: rowCount(first, "protocol_command_identities")
                };
                expect(before.writes).toBe(PROTOCOL_COMMANDS);
                expect(before.identities).toBe(PROTOCOL_COMMANDS);
                file.close(first);

                const reopened = file.open();
                // Construction revalidates the stored audit and write graph and rebuilds
                // the identity projection; a corrupt graph throws instead of returning.
                const persistence = new SqliteProtocolPersistence(reopened);
                reopened.transaction(() => persistence.repair(reopened));

                expect({
                    writes: rowCount(reopened, "protocol_write_records"),
                    audits: rowCount(reopened, "protocol_audit_records"),
                    identities: rowCount(reopened, "protocol_command_identities")
                }).toEqual(before);

                const restarted = new SqliteCounterHarness(
                    { expectedRevision: "optional" },
                    reopened
                );
                const replayedKey = keys[0];
                if (replayedKey === undefined) throw new TypeError("Expected a dispatched key");
                const replay = await restarted.dispatch(
                    restarted.envelope({ key: replayedKey, amount: 1, omitRevision: true })
                );
                expect(replay.outcome).toBe("duplicate");
                expect(restarted.snapshot().value).toBe(PROTOCOL_COMMANDS);
                expect(rowCount(reopened, "protocol_command_identities")).toBe(
                    before.identities
                );
            });
        }
    );
});
