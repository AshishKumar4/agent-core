import { describe, expect, it } from "vitest";
import { call, harnessUrl } from "./harness";

/**
 * Phase 3 runs against the release phases 1 and 2 ran before: the deployed code no longer
 * declares the schema the previous release applied. The object must still construct, so it
 * stays reachable, and every operation on it must refuse with the profile's own code.
 */
describe("live Cloudflare substrate evidence after a one-release rollback", () => {
    it("[C13-CLOUDFLARE-ROLLBACK-WINDOW] refuses every operation on an object whose applied schema this release does not declare", async () => {
        // Assert the release, not just that something answered. Every deployment in this
        // walk carries one commit, so "the harness is up" is not evidence that the harness
        // is the rolled-back one — and a phase that cannot name the release it tested
        // cannot tell a missing refusal from a stale edge.
        const meta = await fetch(`${harnessUrl}/meta`);
        expect(meta.ok).toBe(true);
        expect(await meta.json()).toMatchObject({ release: "base" });

        // Collect every operation before asserting any of them: the shape of the gap is
        // which operations refuse, and a loop that throws on the first tells you only its
        // first symptom.
        const operations = ["blob-read", "outbox", "alarms", "events"];
        const outcomes = await Promise.all(
            operations.map(async (operation) => {
                const outcome = await call("runtime", "blob", operation, { channel: "limits" });
                return {
                    operation,
                    ok: outcome.ok,
                    code: outcome.code ?? null,
                    names: (outcome.message ?? "").includes("live-harness-rollout")
                };
            })
        );

        expect(outcomes).toEqual(
            operations.map((operation) => ({
                operation,
                ok: false,
                code: "schema.unreadable",
                names: true
            }))
        );
    });

    it("[C13-CLOUDFLARE-ROLLBACK-WINDOW] keeps serving an object whose applied schema this release does declare", async () => {
        // The refusal is a property of one object's applied schema, not of the release: an
        // object this release migrates itself carries only markers it declares.
        expect(await call("runtime", "rollback-fresh", "outbox")).toMatchObject({ ok: true });

        // A lane whose schema never advanced is untouched by the rollback.
        expect(
            await call("env", "rollback", "open", {
                environmentId: "env-rollback",
                environmentRevision: 0,
                generation: 0,
                sessionId: "sess-rollback"
            })
        ).toMatchObject({ ok: true, result: { name: "ready" } });
    });
});
