import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeCanonicalJson } from "@agent-core/core";
import { abortInstance, call, loadState, phase, saveState } from "./harness";

const PREVIEW_HOST = "preview.agent-core-live.test";
const publicationMaterialization = `sha256:${"1".repeat(64)}`;

function pin(environment: string, revision = 0, generation = 0): Record<string, string | number> {
    return { environmentId: environment, environmentRevision: revision, generation };
}

function deployment(
    id: string,
    init: { readonly target?: string; readonly invocation?: string; readonly key?: string } = {}
): Record<string, string | number> {
    return {
        workspaceId: "ws-live",
        slateId: "slate-live",
        deploymentId: id,
        publicationId: "pub-live",
        publicationMaterialization,
        target: init.target ?? "production",
        invocationId: init.invocation ?? `inv-${id}`,
        idempotencyKey: init.key ?? `deploy-${id}`,
        itemIndex: 0,
        attemptOrdinal: 0
    };
}

describe.runIf(phase === 1)("live Cloudflare substrate evidence", () => {
    it("[P11-ENVIRONMENT-EPHEMERAL-DURABILITY] persists session state across a real Durable Object instance kill", async () => {
        const session = { ...pin("env-durable"), sessionId: "sess-durable" };
        expect(await call("env", "durability", "open", session)).toMatchObject({
            ok: true,
            result: { name: "ready" }
        });
        expect(
            await call("env", "durability", "write-file", {
                ...session,
                path: "state.txt",
                contentBase64: Buffer.from([1, 2, 3]).toString("base64")
            })
        ).toMatchObject({ ok: true });

        await abortInstance("env", "durability");

        expect(await call("env", "durability", "inspect", session)).toMatchObject({
            ok: true,
            result: { name: "ready" }
        });
        const read = await call("env", "durability", "read-file", {
            ...session,
            path: "state.txt"
        });
        expect(read.ok).toBe(true);
        expect(Buffer.from(String(read.result), "base64")).toEqual(Buffer.from([1, 2, 3]));
    });

    it("[P11-ENVIRONMENT-EPHEMERAL-DURABILITY] rejects stale generations after rotation, across a real instance kill", async () => {
        expect(
            await call("env", "rotation", "open", {
                ...pin("env-rotation", 1, 1),
                sessionId: "sess-gen1"
            })
        ).toMatchObject({ ok: true, result: { name: "ready" } });
        expect(
            await call("env", "rotation", "open", {
                ...pin("env-rotation", 2, 2),
                sessionId: "sess-gen2"
            })
        ).toMatchObject({ ok: true, result: { name: "ready" } });

        await abortInstance("env", "rotation");

        expect(
            await call("env", "rotation", "open", {
                ...pin("env-rotation", 1, 1),
                sessionId: "sess-stale"
            })
        ).toMatchObject({ ok: true, result: { name: "failed" } });
    });

    it("[P11-ENVIRONMENT-SNAPSHOT] snapshots through real R2 and restores exactly on a different instance", async () => {
        const session = { ...pin("env-snap"), sessionId: "sess-source" };
        await call("env", "snap-a", "open", session);
        await call("env", "snap-a", "write-file", {
            ...session,
            path: "a.json",
            contentBase64: Buffer.from("live-evidence").toString("base64")
        });
        const snapshot = await call("env", "snap-a", "snapshot", {
            ...session,
            sessionEpoch: 0,
            snapshotId: "snap-1"
        });
        expect(snapshot).toMatchObject({ ok: true, result: { name: "ready" } });
        const reference = snapshot.result?.value;
        if (typeof reference !== "string") throw new TypeError("Expected a snapshot ContentRef");

        await abortInstance("env", "snap-a");

        // A different Durable Object instance shares nothing but the R2 bucket:
        // an exact restore proves the snapshot's real round trip through R2.
        const restored = { ...pin("env-restore"), sessionId: "sess-restored", restore: reference };
        expect(await call("env", "snap-b", "open", restored)).toMatchObject({
            ok: true,
            result: { name: "ready" }
        });
        const read = await call("env", "snap-b", "read-file", { ...restored, path: "a.json" });
        expect(Buffer.from(String(read.result), "base64").toString("utf8")).toBe("live-evidence");

        expect(
            await call("env", "snap-b", "open", {
                ...pin("env-missing"),
                sessionId: "sess-missing",
                restore: `sha256:${"9".repeat(64)}`
            })
        ).toMatchObject({ ok: true, result: { name: "failed" } });
    });

    it("[P11-ENVIRONMENT-PREVIEW] derives the deterministic preview URL, keeps it across an instance kill, and revokes fail-closed", async () => {
        const session = { ...pin("env-preview"), sessionId: "sess-preview" };
        await call("env", "preview", "open", session);
        const exposure = {
            ...session,
            sessionEpoch: 0,
            exposureId: "exp-1",
            port: 8080
        };
        const exposed = await call("env", "preview", "expose", exposure);
        expect(exposed).toMatchObject({ ok: true, result: { name: "ready" } });

        const token = createHash("sha256")
            .update(
                encodeCanonicalJson({
                    environmentId: "env-preview",
                    environmentRevision: 0,
                    exposureId: "exp-1",
                    generation: 0,
                    port: 8080,
                    sessionEpoch: 0,
                    sessionId: "sess-preview"
                })
            )
            .digest("hex");
        expect(exposed.result?.value).toBe(
            `https://${token.slice(0, 32)}.${token.slice(32)}.${PREVIEW_HOST}/`
        );

        await abortInstance("env", "preview");

        expect(await call("env", "preview", "inspect-exposure", exposure)).toMatchObject({
            ok: true,
            result: { name: "ready", value: exposed.result?.value }
        });
        expect(await call("env", "preview", "revoke", exposure)).toMatchObject({
            ok: true,
            result: { name: "succeeded" }
        });
        expect(await call("env", "preview", "inspect-exposure", exposure)).toMatchObject({
            ok: true,
            result: { name: "absent" }
        });
        expect(await call("env", "preview", "expose", exposure)).toMatchObject({
            ok: true,
            result: { name: "failed" }
        });
    });

    it("[P11-SLATE-DEPLOY] deploys once against the real substrate and rejects identity reuse across an instance kill", async () => {
        const request = deployment("dep-live");
        const first = await call("slate", "deploy", "deploy", request);
        expect(first.ok).toBe(true);
        const materialization = first.result?.materialization;
        if (typeof materialization !== "string") throw new TypeError("Expected a materialization");
        expect(materialization.startsWith("sha256:")).toBe(true);

        await abortInstance("slate", "deploy");

        expect(await call("slate", "deploy", "deploy", request)).toMatchObject({
            ok: true,
            result: { materialization }
        });
        expect(
            await call("slate", "deploy", "deploy", deployment("dep-live", { target: "staging" }))
        ).toMatchObject({ ok: false, code: "protocol.invalid-state" });

        saveState({
            deployment: request,
            materialization,
            resource: {
                workspaceId: "ws-live",
                slateId: "slate-live",
                resourceId: "res-live",
                deploymentId: "dep-live",
                deploymentMaterialization: materialization,
                resourceName: "database",
                resourceSource: publicationMaterialization,
                invocationId: "inv-res-live",
                idempotencyKey: "resource-res-live",
                itemIndex: 0,
                attemptOrdinal: 0
            }
        });
    });

    it("[P11-SLATE-MEDIATED-DEPLOY] settles an indeterminate mediated attempt by reconciling the frozen intent across an instance kill", async () => {
        // The caller's view of an indeterminate attempt: the effect was requested but
        // the outcome never observed. Reconciliation with the identical frozen intent
        // must settle to the exact recorded materialization, not repeat the effect.
        const request = deployment("dep-mediated");
        const attempted = await call("slate", "mediated", "deploy", request);
        expect(attempted.ok).toBe(true);

        await abortInstance("slate", "mediated");

        const settled = await call("slate", "mediated", "reconcile-deploy", request);
        expect(settled).toMatchObject({
            ok: true,
            result: { materialization: attempted.result?.materialization }
        });
        expect(
            await call("slate", "mediated", "reconcile-deploy", {
                ...request,
                attemptOrdinal: 1
            })
        ).toMatchObject({ ok: true, result: { materialization: attempted.result?.materialization } });
        expect(
            await call("slate", "mediated", "reconcile-deploy", {
                ...request,
                invocationId: "inv-foreign"
            })
        ).toMatchObject({ ok: false, code: "protocol.invalid-state" });

        const resource = {
            workspaceId: "ws-live",
            slateId: "slate-live",
            resourceId: "res-mediated",
            deploymentId: "dep-mediated",
            deploymentMaterialization: String(attempted.result?.materialization),
            resourceName: "database",
            resourceSource: publicationMaterialization,
            invocationId: "inv-res-mediated",
            idempotencyKey: "resource-res-mediated",
            itemIndex: 0,
            attemptOrdinal: 0
        };
        const materialized = await call("slate", "mediated", "materialize-resource", resource);
        expect(materialized.ok).toBe(true);
        await abortInstance("slate", "mediated");
        expect(await call("slate", "mediated", "reconcile-resource", resource)).toMatchObject({
            ok: true,
            result: { materialization: materialized.result?.materialization }
        });
    });
});

describe.runIf(phase === 2)("live Cloudflare substrate evidence after redeployment", () => {
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
