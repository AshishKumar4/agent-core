import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { sourceSymbolLines } from "../../scripts/quality/evidence.mjs";

const packageRoot = resolve(import.meta.dirname, "../..");

/**
 * The durable-record seams SPEC §4.1 stops the cancellation requirement at. A §8.5 command
 * has a linearization point and an idempotency key, and a §8.2 `put` is content-addressed
 * while `get` and `stat` are reads, so neither owns ongoing effect on a caller's behalf:
 * abandoning a wait there changes no outcome the closed `CommandOutcome` set admits.
 */
const CANCELLATION_FREE_SEAMS: readonly string[] = [
    "src/content/store.ts#ContentStore",
    "src/protocol/dispatcher.ts#CommandDispatcher",
    "src/protocol/registration.ts#ProtocolCommandRegistration"
];

/**
 * The contexts the same rule requires cancellation on. They are the positive control: the
 * screen below finds a declared cancellation here, so a seam it reports clean is clean
 * rather than unread.
 */
const CANCELLATION_CARRYING_CONTEXTS: readonly string[] = [
    "src/facets/runtime.ts#OperationContext",
    "src/facets/runtime.ts#FacetLifecycleContext"
];

const declaredCancellation = /\bAbortSignal\b|\bsignal\s*[?]?\s*:/u;

describe("Cancellation stops at the durable-record seams", () => {
    test(
        "[C13-FACET-CANCELLATION-REACH] the §8.2 content seam and the §8.5 command dispatcher declare no cancellation",
        { tags: "p1" },
        () => {
            // Satisfied by construction today, which is the direction a regression comes
            // from: a signal added to either seam would silently widen this atom into the
            // requirement it explicitly is not — cancellation of a durable write would invite
            // exactly the third state between committed and rejected that §8.5 does not have.
            for (const seam of CANCELLATION_FREE_SEAMS) {
                expect(declaration(seam)).not.toMatch(declaredCancellation);
            }
        }
    );

    test(
        "[C13-FACET-CANCELLATION-REACH] the same screen finds the cancellation the invocation contexts do declare",
        { tags: "p1" },
        () => {
            for (const context of CANCELLATION_CARRYING_CONTEXTS) {
                expect(declaration(context)).toMatch(declaredCancellation);
            }
        }
    );
});

/** The exact declaration text one source symbol selects, comments and members included. */
function declaration(selector: string): string {
    const span = sourceSymbolLines(selector);
    const path = selector.slice(0, selector.indexOf("#"));
    const lines = readFileSync(resolve(packageRoot, path), "utf8").split("\n");
    return lines.slice(span.startLine - 1, span.endLine).join("\n");
}
