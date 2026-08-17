import { describe, expect, it } from "vitest";
import { call, harnessUrl } from "./harness";

/**
 * Phase 3 runs against the release phases 1 and 2 ran before: the deployed code no longer
 * declares the schema the previous release applied. The object must still construct, so it
 * stays reachable, and every operation on it must refuse with the profile's own code.
 */
describe("live Cloudflare substrate evidence after a one-release rollback", () => {
    it("[C13-CLOUDFLARE-ROLLBACK-WINDOW] refuses every operation on an object whose applied schema this release does not declare", async () => {
        const meta = await fetch(`${harnessUrl}/meta`);
        expect(meta.ok).toBe(true);

        for (const operation of ["blob-read", "outbox", "alarms", "events"]) {
            const refused = await call("runtime", "blob", operation, { channel: "limits" });
            expect(refused.ok, `${operation} must refuse`).toBe(false);
            expect(refused.code, `${operation} must name the schema`).toBe("schema.unreadable");
            expect(refused.message).toContain("live-harness-rollout");
        }
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
