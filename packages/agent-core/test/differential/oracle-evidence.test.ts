import { expect, test } from "vitest";
import { LeanOracle } from "./oracle";

test("a differential suite fails if its declared oracle operation never runs", () => {
    const oracle = LeanOracle.start(["lease.admits"]);

    expect(() => oracle.stop()).toThrow(TypeError);
});

test("a differential suite cannot declare the same oracle operation twice", () => {
    expect(() => LeanOracle.start(["lease.admits", "lease.admits"])).toThrow(TypeError);
});

test("a rejected oracle request is not successful execution evidence", async () => {
    const oracle = LeanOracle.start(["lease.admits"]);

    await expect(oracle.ask({ op: "lease.admits" })).rejects.toBeInstanceOf(Error);
    expect(() => oracle.stop()).toThrow(TypeError);
});
