import {
    DurableViewRevisionLog,
    type SqliteRow,
    type SynchronousSqlitePort
} from "../src/index.js";
import { FakeRuntimeSqlite, fakeErrors } from "./fakes.js";
import { expectOperationalFailure } from "./assertions.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

describe("DurableViewRevisionLog", () => {
    test("appends and replays a contiguous monotonic revision log", () => {
        const log = new DurableViewRevisionLog(new FakeRuntimeSqlite(), fakeErrors);
        const first = bytes("one");
        log.append("surface", 1, first);
        first.fill(0);
        log.append("surface", 2, bytes("two"));

        const replay = log.replay("surface", 0);
        expect(replay.currentRevision).toBe(2);
        expect(replay.snapshot).toBeUndefined();
        expect(replay.deltas.map((entry) => [entry.revision, text(entry.payload)])).toEqual([
            [1, "one"],
            [2, "two"]
        ]);
        replay.deltas[0]?.payload.fill(0);
        expect(text(log.replay("surface", 0).deltas[0]?.payload ?? new Uint8Array())).toBe("one");
    });

    test("compacts replay behind a durable snapshot", () => {
        const log = new DurableViewRevisionLog(new FakeRuntimeSqlite(), fakeErrors);
        log.append("surface", 1, bytes("delta-1"));
        log.append("surface", 2, bytes("delta-2"));
        log.compact("surface", 2, bytes("snapshot-2"));
        log.append("surface", 3, bytes("delta-3"));

        const behind = log.replay("surface", 0);
        expect(text(behind.snapshot?.payload ?? new Uint8Array())).toBe("snapshot-2");
        expect(behind.deltas.map((entry) => entry.revision)).toEqual([3]);
        expect(log.replay("surface", 2).snapshot).toBeUndefined();
        expect(log.replay("surface", 2).deltas.map((entry) => entry.revision)).toEqual([3]);
    });

    test("rejects gaps, stale compaction, and future replay cursors", () => {
        const log = new DurableViewRevisionLog(new FakeRuntimeSqlite(), fakeErrors);
        expectOperationalFailure(
            () => log.append("surface", 2, bytes("gap")),
            "protocol.revision-conflict"
        );
        log.append("surface", 1, bytes("one"));
        expectOperationalFailure(
            () => log.compact("surface", 2, bytes("future")),
            "protocol.revision-conflict"
        );
        expectOperationalFailure(() => log.replay("surface", 2), "protocol.revision-conflict");
        expectOperationalFailure(() => log.append("", 2, bytes("bad")), "operation.invalid-input");
        expectOperationalFailure(
            () => log.append("surface", 0, bytes("bad")),
            "operation.invalid-input"
        );
        expectOperationalFailure(
            () => log.append("surface", 2, new Uint8Array()),
            "operation.invalid-input"
        );
    });

    test("rejects corrupt revision rows, payloads, gaps, and incomplete replay", () => {
        const scripted = (
            current: readonly SqliteRow[],
            snapshots: readonly SqliteRow[],
            deltas: readonly SqliteRow[]
        ): SynchronousSqlitePort => ({
            all: (statement) => {
                if (statement.startsWith("SELECT MAX")) return current;
                if (statement.includes("view_snapshots")) return snapshots;
                return deltas;
            },
            run: () => {},
            transaction: <Result>(
                operation: () => Result,
                ..._guard: import("../src/index.js").SynchronousResultGuard<Result>
            ): Result => operation()
        });
        const fails = (
            database: SynchronousSqlitePort,
            operation: (log: DurableViewRevisionLog) => unknown = (log) => log.replay("surface", 0)
        ): void =>
            expectOperationalFailure(
                () => operation(new DurableViewRevisionLog(database, fakeErrors)),
                "codec.invalid"
            );

        fails(scripted([], [], []), (log) => log.currentRevision("surface"));
        fails(scripted([{ revision: -1 }], [], []), (log) => log.currentRevision("surface"));
        fails(
            scripted(
                [{ revision: 1 }],
                [
                    { revision: 1, payload: bytes("a") },
                    { revision: 1, payload: bytes("a") }
                ],
                []
            )
        );
        fails(scripted([{ revision: 1 }], [], [{ revision: 1, payload: "bad" }]));
        fails(scripted([{ revision: 2 }], [], [{ revision: 2, payload: bytes("gap") }]));
        fails(scripted([{ revision: 2 }], [], [{ revision: 1, payload: bytes("one") }]));
        expectOperationalFailure(
            () =>
                new DurableViewRevisionLog(new FakeRuntimeSqlite(), fakeErrors).replay(
                    "surface",
                    -1
                ),
            "operation.invalid-input"
        );
    });
});
