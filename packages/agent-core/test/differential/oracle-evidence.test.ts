import { expect, test } from "vitest";
import { LeanOracle } from "./oracle";

/*
 * Every assertion here is pure: the oracle either refuses a declaration or refuses to
 * stop without evidence. The only slow step is `LeanOracle.start`, which runs
 * `lake build oracle` behind a cross-process build lock shared by every differential
 * suite and waits up to 900s for whichever process holds it. Without the same timeout
 * the sibling suites pass to `beforeAll`, these tests fail on a busy machine for a
 * reason that has nothing to do with what they assert.
 */
const oracleBuildTimeout = 900_000;

test(
    "a differential suite fails if its declared oracle operation never runs",
    { timeout: oracleBuildTimeout },
    () => {
        const oracle = LeanOracle.start(["lease.admits"]);

        expect(() => oracle.stop()).toThrow(TypeError);
    }
);

test(
    "a differential suite cannot declare the same oracle operation twice",
    { timeout: oracleBuildTimeout },
    () => {
        expect(() => LeanOracle.start(["lease.admits", "lease.admits"])).toThrow(TypeError);
    }
);

test(
    "a rejected oracle request is not successful execution evidence",
    { timeout: oracleBuildTimeout },
    async () => {
        const oracle = LeanOracle.start(["lease.admits"]);

        await expect(oracle.ask({ op: "lease.admits" })).rejects.toBeInstanceOf(Error);
        expect(() => oracle.stop()).toThrow(TypeError);
    }
);
