import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { AuditRecordId } from "../../../src/invocations";
import { FileSqlite } from "../../helpers/sqlite";
import { expectAgentCoreError } from "../../protocol/error-assertion";
import { SqliteCounterHarness } from "../../protocol/sqlite-counter-fixture";

/*
 * The restart journey end to end: a committed command survives closing the database
 * file and reopening it as a new process would. Activation validates the whole stored
 * record graph before serving anything, and the original envelope still replays.
 */
describe("file-backed SQLite restart and recovery journey", () => {
    test(
        "replays the original envelope as a duplicate after a close and reopen",
        { tags: "p0" },
        async () => {
            await withRestartDirectory(async (path) => {
                const database = new FileSqlite(path);
                const harness = new SqliteCounterHarness({}, database);
                const raw = harness.envelope({ key: "restart-journey", amount: 4 });
                const first = await harness.dispatch(raw);
                const before = harness.snapshot();
                expect(first.outcome).toBe("committed");
                expect(harness.recovery()).toMatchObject({ epoch: 0, recoveries: 1 });
                database.close();

                const reopened = new FileSqlite(path);
                try {
                    const restarted = new SqliteCounterHarness({}, reopened);
                    const after = restarted.snapshot();

                    expect(after.value).toBe(before.value);
                    expect(after.revision.value).toBe(before.revision.value);
                    expect(after.identityCount).toBe(1);
                    expect(after.writes.map((write) => write.id.value)).toEqual([
                        first.write.id.value
                    ]);
                    expect(after.audits.size).toBe(before.audits.size);

                    const duplicate = await restarted.dispatch(raw);

                    expect(duplicate.outcome).toBe("duplicate");
                    expect(duplicate.reply).toEqual(first.reply);
                    expect(duplicate.write.duplicateOf?.equals(first.write.id)).toBe(true);
                    expect(restarted.snapshot().value).toBe(before.value);
                    expect(restarted.recovery()).toMatchObject({ recoveries: 2 });
                } finally {
                    reopened.close();
                }
            });
        }
    );

    test("refuses to activate over a stored graph that lost a write audit", { tags: "p0" }, async () => {
        await withRestartDirectory(async (path) => {
            const database = new FileSqlite(path);
            const harness = new SqliteCounterHarness({}, database);
            const committed = await harness.dispatch(
                harness.envelope({ key: "restart-corruption", amount: 1 })
            );
            harness.corruptRemoveAudit(new AuditRecordId(committed.write.audit.value));
            database.close();

            const reopened = new FileSqlite(path);
            try {
                expectAgentCoreError(
                    () => new SqliteCounterHarness({}, reopened),
                    "protocol.invalid-state"
                );
            } finally {
                reopened.close();
            }
        });
    });
});

async function withRestartDirectory(run: (path: string) => Promise<void>): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "agent-core-e2e-restart-"));
    try {
        await run(join(directory, "protocol.sqlite"));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}
