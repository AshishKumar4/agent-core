import { AgentCoreError } from "@agent-core/core";
import { CloudflareSqlite } from "../src/index.js";
import { FakeDurableObjectStorage, FakeSqlStorage, fakeErrors } from "./fakes.js";

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
        expect(sql.calls[0]?.bindings[0]).toBeInstanceOf(ArrayBuffer);
        expect(new Uint8Array(sql.calls[0]?.bindings[0] as ArrayBuffer)).toEqual(
            new Uint8Array([1, 2])
        );
    });

    test("maps an unsupported collaborator row value to invalid output", () => {
        const sql = new FakeSqlStorage(() => ({
            rows: [{ invalid: true } as unknown as Record<string, never>]
        }));
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
                values.push(bindings[0] as number);
            }
        }));
        const storage = new FakeDurableObjectStorage(
            sql,
            () => [...values],
            (snapshot) => {
                values.splice(0, values.length, ...(snapshot as number[]));
            }
        );
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
                values.push(bindings[0] as number);
            }
        }));
        const database = new CloudflareSqlite(
            new FakeDurableObjectStorage(
                sql,
                () => [...values],
                (snapshot) => {
                    values.splice(0, values.length, ...(snapshot as number[]));
                }
            ),
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
                values.push(bindings[0] as number);
            }
        }));
        const database = new CloudflareSqlite(
            new FakeDurableObjectStorage(
                sql,
                () => [...values],
                (snapshot) => {
                    values.splice(0, values.length, ...(snapshot as number[]));
                }
            ),
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
        const thenable = new Proxy(() => undefined, {
            get: (target, property) =>
                property === "then" ? () => undefined : Reflect.get(target, property)
        });
        expect(() => database.transaction(() => thenable)).toThrow("must be synchronous");
        expect(() => database.run("UPDATE", [])).toThrow("adapter is poisoned");
    });
});
