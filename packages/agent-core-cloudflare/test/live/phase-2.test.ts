import { describe, expect, it } from "vitest";
import { call, loadState } from "./harness";


function pin(environment: string, revision = 0, generation = 0): Record<string, string | number> {
    return { environmentId: environment, environmentRevision: revision, generation };
}

describe("live Cloudflare substrate evidence after redeployment", () => {
    it("[P11-ENVIRONMENT-EPHEMERAL-DURABILITY] keeps session state across a full worker redeployment", async () => {
        const session = { ...pin("env-durable"), sessionId: "sess-durable" };
        expect(await call("env", "durability", "inspect", session)).toMatchObject({
            ok: true,
            result: { name: "ready" }
        });
        const read = await call("env", "durability", "read-file", {
            ...session,
            path: "state.txt"
        });
        expect(Buffer.from(String(read.result), "base64")).toEqual(Buffer.from([1, 2, 3]));
    });

    it("[P11-SLATE-DEPLOY] settles a deployment recorded before the redeployment to its exact materialization", async () => {
        const state = loadState();
        const request = state["deployment"] as Record<string, string | number>;
        expect(await call("slate", "deploy", "reconcile-deploy", request)).toMatchObject({
            ok: true,
            result: { materialization: state["materialization"] }
        });
        const resource = state["resource"] as Record<string, string | number>;
        const materialized = await call("slate", "deploy", "materialize-resource", resource);
        expect(materialized.ok).toBe(true);
        expect(await call("slate", "deploy", "reconcile-resource", resource)).toMatchObject({
            ok: true,
            result: { materialization: materialized.result?.materialization }
        });
    });
});
