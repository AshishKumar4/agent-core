import { AgentCoreError } from "@agent-core/core";
import { CloudflareSqlite } from "../src/index.js";
import { storedRowReader } from "../src/sqlite.js";
import { malformedInput } from "./assertions.js";
import { FakeDurableObjectStorage, FakeSqlStorage, boundInteger, fakeErrors } from "./fakes.js";

describe("CloudflareSqlite", () => {
    test("fully consumes cursors and normalizes detached BLOB values", () => {
        let consumed = 0;
        const source = new Uint8Array([3, 4, 5]);
        const sql = new FakeSqlStorage((statement) => ({
            rows:
                statement === "SELECT value"
                    ? [{ value: source.buffer, count: 2 }]
                    : [{ ignored: 1 }],
            onConsumed: () => {
                consumed += 1;
            }
        }));
        const database = new CloudflareSqlite(new FakeDurableObjectStorage(sql), fakeErrors);
        const binding = new Uint8Array([1, 2]);

        const rows = database.all("SELECT value", [binding]);
        database.run("UPDATE value", []);
        binding.fill(9);
        source.fill(8);

        expect(consumed).toBe(2);
        expect(rows).toEqual([{ value: new Uint8Array([3, 4, 5]), count: 2 }]);
        const recorded = sql.calls[0]?.bindings[0];
        expect(recorded).toBeInstanceOf(ArrayBuffer);
        expect(recorded instanceof ArrayBuffer ? new Uint8Array(recorded) : recorded).toEqual(
            new Uint8Array([1, 2])
        );
    });

    test("maps an unsupported collaborator row value to invalid output", () => {
        // A boolean is outside every value type the platform declares for a SQL column,
        // which is exactly the collaborator misbehavior under test.
        const sql = new FakeSqlStorage(() => ({ rows: [{ invalid: malformedInput(true) }] }));
        const database = new CloudflareSqlite(new FakeDurableObjectStorage(sql), fakeErrors);

        try {
            database.all("SELECT invalid", []);
        } catch (error) {
            expect(error).toMatchObject({ code: "operation.invalid-output" });
            return;
        }
        throw new TypeError("Expected unsupported SQLite output to fail");
    });

    test("rolls back consumed writes when a transaction throws", () => {
        const values: number[] = [];
        const sql = new FakeSqlStorage((_statement, bindings) => ({
            onConsumed: () => {
                values.push(boundInteger(bindings, 0));
            }
        }));
        const storage = new FakeDurableObjectStorage(sql, {
            capture: () => [...values],
            restore: (snapshot) => {
                values.splice(0, values.length, ...snapshot);
            }
        });
        const database = new CloudflareSqlite(storage, fakeErrors);

        expect(() =>
            database.transaction(() => {
                database.run("INSERT", [7]);
                throw new TypeError("stop");
            })
        ).toThrow("stop");
        expect(values).toEqual([]);
    });

    test("rejects nested transactions and rolls back the outer transaction", () => {
        const values: number[] = [];
        const sql = new FakeSqlStorage((_statement, bindings) => ({
            onConsumed: () => {
                values.push(boundInteger(bindings, 0));
            }
        }));
        const database = new CloudflareSqlite(
            new FakeDurableObjectStorage(sql, {
                capture: () => [...values],
                restore: (snapshot) => {
                    values.splice(0, values.length, ...snapshot);
                }
            }),
            fakeErrors
        );

        expect(() =>
            database.transaction(() => {
                database.run("INSERT", [1]);
                database.transaction(() => undefined);
            })
        ).toThrow("Nested Cloudflare SQLite transactions are not supported");
        expect(values).toEqual([]);
    });

    test("permanently poisons the adapter against post-settlement detached writes", async () => {
        const values: number[] = [];
        const sql = new FakeSqlStorage((_statement, bindings) => ({
            onConsumed: () => {
                values.push(boundInteger(bindings, 0));
            }
        }));
        const database = new CloudflareSqlite(
            new FakeDurableObjectStorage(sql, {
                capture: () => [...values],
                restore: (snapshot) => {
                    values.splice(0, values.length, ...snapshot);
                }
            }),
            fakeErrors
        );

        const rejected: string[] = [];
        const attempt = (source: string, value: number): void => {
            try {
                database.run("INSERT", [value]);
            } catch (error) {
                if (error instanceof AgentCoreError) rejected.push(`${source}:${error.message}`);
            }
        };
        expect(() =>
            database.transaction(async () => {
                database.run("INSERT", [2]);
                queueMicrotask(() => {
                    attempt("queueMicrotask", 3);
                });
                void Promise.resolve().then(() => {
                    attempt("promise", 4);
                });
                setTimeout(() => {
                    attempt("timer", 5);
                }, 0);
            }, "Actor transaction callbacks must be synchronous")
        ).toThrow("Cloudflare SQLite transaction callbacks must be synchronous");
        expect(values).toEqual([]);
        expect(() => database.run("INSERT", [6])).toThrow("adapter is poisoned");
        await Promise.resolve();
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(values).toEqual([]);
        expect(rejected).toHaveLength(3);
        expect(rejected.every((message) => message.includes("adapter is poisoned"))).toBe(true);
        expect(() => database.all("SELECT", [])).toThrow("adapter is poisoned");
        expect(() => database.transaction(() => undefined)).toThrow("adapter is poisoned");
    });

    test("rejects non-Promise thenables and poisons subsequent access", () => {
        const database = new CloudflareSqlite(
            new FakeDurableObjectStorage(new FakeSqlStorage(() => ({}))),
            fakeErrors
        );
        // A thenable only a property get can see: `in` and getOwnPropertyDescriptor both
        // report `then` as absent, so an adapter that probed either way would call this
        // asynchronous callback synchronous.
        const thenable = new Proxy(() => undefined, {
            get: (_target, property) => (property === "then" ? () => undefined : undefined)
        });
        expect(() => database.transaction(() => thenable)).toThrow("must be synchronous");
        expect(() => database.run("UPDATE", [])).toThrow("adapter is poisoned");
    });

    test(
        "settles a rejected asynchronous callback instead of leaking it",
        { tags: "p1" },
        async () => {
            const database = new CloudflareSqlite(
                new FakeDurableObjectStorage(new FakeSqlStorage(() => ({}))),
                fakeErrors
            );
            let leaked = 0;
            const collect = (): void => {
                leaked += 1;
            };

            process.on("unhandledRejection", collect);
            try {
                expect(() =>
                    database.transaction(async () => {
                        throw new TypeError("the callback failed after the adapter refused it");
                    }, "Actor transaction callbacks must be synchronous")
                ).toThrow("Cloudflare SQLite transaction callbacks must be synchronous");
                // Node decides a rejection is unhandled at the end of the tick that
                // created it, so the check phase is the earliest point that answer exists.
                await new Promise<void>((resolve) => {
                    setImmediate(resolve);
                });
            } finally {
                process.off("unhandledRejection", collect);
            }

            // The refused callback keeps running, and its failure is the adapter's to
            // absorb: an unhandled rejection here would take down the whole isolate over
            // work the adapter already refused.
            expect(leaked).toBe(0);
            expect(() => database.run("UPDATE", [])).toThrow("adapter is poisoned");
        }
    );
});

describe("storedRowReader", () => {
    const reader = storedRowReader((column): never => {
        throw new AgentCoreError("codec.invalid", `stored column ${column} is corrupt`);
    });

    test("reads a nullable INTEGER as null only for SQL NULL", { tags: "p1" }, () => {
        expect(reader.nullableInteger({ due_at: null }, "due_at")).toBeNull();
        expect(reader.nullableInteger({ due_at: 0 }, "due_at")).toBe(0);
        // Absent is not NULL: a column the query never selected is corrupt storage, not
        // a recorded absence.
        expect(() => reader.nullableInteger({}, "due_at")).toThrow("stored column due_at is corrupt");
        expect(() => reader.nullableInteger({ due_at: 1.5 }, "due_at")).toThrow(
            "stored column due_at is corrupt"
        );
    });

    test("hands a BLOB column over without copying it", { tags: "p1" }, () => {
        const stored = new Uint8Array([7, 8, 9]);

        expect(reader.bytes({ payload: stored }, "payload")).toBe(stored);
        // Every other representation SQLite can hold in the column names that column.
        expect(() => reader.bytes({ payload: "Bwg" }, "payload")).toThrow(
            "stored column payload is corrupt"
        );
        expect(() => reader.bytes({ payload: 7 }, "payload")).toThrow(
            "stored column payload is corrupt"
        );
        expect(() => reader.bytes({ payload: null }, "payload")).toThrow(
            "stored column payload is corrupt"
        );
    });
});
