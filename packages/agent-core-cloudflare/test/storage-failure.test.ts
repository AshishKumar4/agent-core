import { CloudflareStorageFailure } from "../src/storage-failure.js";

const FULL_TEXT = "SQLITE_FULL: database or disk is full";
const RESET_TEXT = "storage operation exceeded timeout after 10s";

describe("CloudflareStorageFailure", () => {
    /**
     * The three conditions exist to be acted on differently: a drain recovers a full
     * object, a retry recovers a reset one, and neither helps a refused statement. A
     * pair that collapsed would send a caller down a recovery that cannot work.
     */
    test("gives each condition its own recovery pair", { tags: "p0" }, () => {
        expect({
            drainable: CloudflareStorageFailure.full.drainable,
            transient: CloudflareStorageFailure.full.transient
        }).toEqual({ drainable: true, transient: false });
        expect({
            drainable: CloudflareStorageFailure.reset.drainable,
            transient: CloudflareStorageFailure.reset.transient
        }).toEqual({ drainable: false, transient: true });
        expect({
            drainable: CloudflareStorageFailure.statement.drainable,
            transient: CloudflareStorageFailure.statement.transient
        }).toEqual({ drainable: false, transient: false });
    });

    test("keeps the three conditions distinguishable in a log", { tags: "p2" }, () => {
        const summaries = [
            CloudflareStorageFailure.full.summary,
            CloudflareStorageFailure.reset.summary,
            CloudflareStorageFailure.statement.summary
        ];

        expect(new Set(summaries).size).toBe(3);
        expect(summaries.filter((summary) => summary.length === 0)).toEqual([]);
    });

    test("reads a full object from every shape a throw carries", { tags: "p0" }, () => {
        for (const cause of [FULL_TEXT, new Error(FULL_TEXT), { message: FULL_TEXT }]) {
            expect(
                CloudflareStorageFailure.classify({ value: cause }).equals(
                    CloudflareStorageFailure.full
                )
            ).toBe(true);
        }
    });

    test("reads a reset object from every shape a throw carries", { tags: "p0" }, () => {
        for (const cause of [RESET_TEXT, new Error(RESET_TEXT), { message: RESET_TEXT }]) {
            expect(
                CloudflareStorageFailure.classify({ value: cause }).equals(
                    CloudflareStorageFailure.reset
                )
            ).toBe(true);
        }
    });

    /**
     * Both markers on one message is the case where the two recoveries disagree: a drain
     * fixes the object and a retry does not, so the reading that offers the drain has to
     * win or a full object stays full while its caller retries.
     */
    test("reads a full object when a message also reports the timeout", { tags: "p0" }, () => {
        const both = `${RESET_TEXT}; ${FULL_TEXT}`;

        expect(
            CloudflareStorageFailure.classify({ value: both }).equals(CloudflareStorageFailure.full)
        ).toBe(true);
        expect(CloudflareStorageFailure.classify({ value: new Error(both) }).drainable).toBe(true);
    });

    /**
     * A refused statement is the reading that claims least, so every throw the markers do
     * not appear in has to land there rather than on a recovery that cannot apply.
     */
    test("reads every unrecognized throw as a refused statement", { tags: "p1" }, () => {
        const unrecognized: readonly unknown[] = [
            undefined,
            null,
            42,
            "constraint failed",
            "",
            {},
            { message: 7 },
            { message: null },
            new Error("constraint failed"),
            []
        ];

        for (const cause of unrecognized) {
            expect(
                CloudflareStorageFailure.classify({ value: cause }).equals(
                    CloudflareStorageFailure.statement
                )
            ).toBe(true);
        }
    });

    test("compares equal only to the same condition", { tags: "p2" }, () => {
        const conditions = [
            CloudflareStorageFailure.full,
            CloudflareStorageFailure.reset,
            CloudflareStorageFailure.statement
        ];

        for (const [index, left] of conditions.entries()) {
            for (const [other, right] of conditions.entries()) {
                expect(left.equals(right)).toBe(index === other);
            }
        }
        expect(CloudflareStorageFailure.full.equals(CloudflareStorageFailure.full)).toBe(true);
    });
});
