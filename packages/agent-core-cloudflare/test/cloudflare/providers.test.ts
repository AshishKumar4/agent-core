import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
    AgentCoreError,
    ContentRef,
    Digest,
    Revision,
    TenantId,
    encodeBase64,
    encodeCanonicalJson
} from "@agent-core/core";
import {
    EnvironmentId,
    EnvironmentSessionId,
    EnvironmentSnapshotId,
    PortExposureId,
    type ExposePortRequest,
    type OpenSessionRequest,
    type SnapshotEnvironmentRequest
} from "@agent-core/core/environment-provider";
import { contentObjectAddress, type CloudflareErrorPort } from "../../src/index.js";
import { ENVIRONMENT_PROVIDER_TENANT, PREVIEW_HOST } from "./worker.js";

const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};

interface PinInit {
    readonly environment?: string;
    readonly revision?: number;
    readonly generation?: number;
}

function pin(init: PinInit): {
    readonly environmentId: EnvironmentId;
    readonly environmentRevision: Revision;
    readonly generation: number;
} {
    return {
        environmentId: new EnvironmentId(init.environment ?? "env-1"),
        environmentRevision: new Revision(init.revision ?? 0),
        generation: init.generation ?? 0
    };
}

function sessionRequest(
    session: string,
    init: PinInit & { readonly restore?: ContentRef } = {}
): OpenSessionRequest {
    return Object.freeze({
        ...pin(init),
        sessionId: new EnvironmentSessionId(session),
        ...(init.restore === undefined ? {} : { restore: init.restore })
    });
}

function snapshotRequest(
    session: string,
    snapshot: string,
    init: PinInit = {}
): SnapshotEnvironmentRequest {
    return Object.freeze({
        ...pin(init),
        sessionId: new EnvironmentSessionId(session),
        sessionEpoch: 0,
        snapshotId: new EnvironmentSnapshotId(snapshot)
    });
}

function exposureRequest(
    session: string,
    exposure: string,
    port = 8080,
    init: PinInit = {}
): ExposePortRequest {
    return Object.freeze({
        ...pin(init),
        sessionId: new EnvironmentSessionId(session),
        sessionEpoch: 0,
        exposureId: new PortExposureId(exposure),
        port
    });
}

describe("Cloudflare substrate providers", () => {
    it("[P11-ENVIRONMENT-EPHEMERAL-DURABILITY] persists session state across Durable Object eviction", async () => {
        const stub = env.ENVIRONMENTS.getByName("durability");
        const request = sessionRequest("sess-durable", { environment: "env-durable" });
        await runInDurableObject(stub, async (instance) => {
            expect(await instance.environments.openSession(request)).toMatchObject({
                name: "ready"
            });
            instance.environments.writeSessionFile(request, "state.txt", new Uint8Array([1, 2, 3]));
        });

        await evictDurableObject(stub);

        await runInDurableObject(stub, async (instance) => {
            expect(await instance.environments.inspectSession(request)).toMatchObject({
                name: "ready"
            });
            expect(instance.environments.readSessionFile(request, "state.txt")).toEqual(
                new Uint8Array([1, 2, 3])
            );
            expect(await instance.environments.closeSession(request)).toEqual({
                name: "succeeded"
            });
        });

        await evictDurableObject(stub);

        await runInDurableObject(stub, async (instance) => {
            expect(await instance.environments.inspectSession(request)).toEqual({ name: "absent" });
            expect(await instance.environments.openSession(request)).toEqual({ name: "failed" });
        });
    });

    it("[P11-ENVIRONMENT-EPHEMERAL-DURABILITY] rejects stale-generation requests after rotation, across eviction", async () => {
        const stub = env.ENVIRONMENTS.getByName("rotation");
        const environment = "env-rotation";
        const oldSession = sessionRequest("sess-gen1", {
            environment,
            revision: 1,
            generation: 1
        });
        await runInDurableObject(stub, async (instance) => {
            expect(await instance.environments.openSession(oldSession)).toMatchObject({
                name: "ready"
            });
            expect(
                await instance.environments.openSession(
                    sessionRequest("sess-gen2", { environment, revision: 2, generation: 2 })
                )
            ).toMatchObject({ name: "ready" });
        });

        await evictDurableObject(stub);

        await runInDurableObject(stub, async (instance) => {
            expect(
                await instance.environments.openSession(
                    sessionRequest("sess-stale", { environment, revision: 1, generation: 1 })
                )
            ).toEqual({ name: "failed" });
            expect(
                await instance.environments.exposePort(
                    exposureRequest("sess-gen1", "exp-mismatch", 8080, {
                        environment,
                        revision: 2,
                        generation: 2
                    })
                )
            ).toEqual({ name: "failed" });
            // The surviving old-generation session drains under its own exact pin.
            expect(await instance.environments.inspectSession(oldSession)).toMatchObject({
                name: "ready"
            });
            expect(await instance.environments.closeSession(oldSession)).toEqual({
                name: "succeeded"
            });
        });
    });

    it("[P11-ENVIRONMENT-SNAPSHOT] snapshots to content-addressed R2 and restores exactly, across eviction", async () => {
        const stub = env.ENVIRONMENTS.getByName("snapshot");
        const environment = "env-snapshot";
        const source = sessionRequest("sess-source", { environment });
        const restoreRef = await runInDurableObject(stub, async (instance) => {
            await instance.environments.openSession(source);
            instance.environments.writeSessionFile(source, "a.txt", new Uint8Array([1, 2, 3]));
            instance.environments.writeSessionFile(source, "b.txt", new Uint8Array([4]));
            const snapshot = await instance.environments.createSnapshot(
                snapshotRequest("sess-source", "snap-1", { environment })
            );
            if (snapshot.name !== "ready") throw new TypeError("Expected ready snapshot");
            const replay = await instance.environments.createSnapshot(
                snapshotRequest("sess-source", "snap-1", { environment })
            );
            if (replay.name !== "ready") throw new TypeError("Expected ready snapshot replay");
            expect(replay.value.equals(snapshot.value)).toBe(true);
            return snapshot.value.value;
        });

        const expectedBytes = encodeCanonicalJson({
            files: {
                "a.txt": encodeBase64(new Uint8Array([1, 2, 3])),
                "b.txt": encodeBase64(new Uint8Array([4]))
            },
            format: "agent-core-environment-snapshot/1"
        });
        expect(restoreRef).toBe(`sha256:${Digest.sha256(expectedBytes).value}`);

        await evictDurableObject(stub);

        const restored = sessionRequest("sess-restored", {
            environment,
            restore: new ContentRef(restoreRef)
        });
        await runInDurableObject(stub, async (instance) => {
            expect(
                await instance.environments.inspectSnapshot(
                    snapshotRequest("sess-source", "snap-1", { environment })
                )
            ).toMatchObject({ name: "ready" });
            expect(await instance.environments.openSession(restored)).toMatchObject({
                name: "ready"
            });
            expect(instance.environments.readSessionFile(restored, "a.txt")).toEqual(
                new Uint8Array([1, 2, 3])
            );
            expect(instance.environments.readSessionFile(restored, "b.txt")).toEqual(
                new Uint8Array([4])
            );
        });
    });

    it("[P11-ENVIRONMENT-SNAPSHOT] fails closed restoring missing or corrupt snapshot content", async () => {
        const stub = env.ENVIRONMENTS.getByName("snapshot-adversarial");
        const environment = "env-snapshot-adversarial";
        const missing = ContentRef.fromDigest(Digest.sha256(new Uint8Array([9, 9, 9])));
        await runInDurableObject(stub, async (instance) => {
            expect(
                await instance.environments.openSession(
                    sessionRequest("sess-missing", { environment, restore: missing })
                )
            ).toEqual({ name: "failed" });

            const source = sessionRequest("sess-source", { environment });
            await instance.environments.openSession(source);
            instance.environments.writeSessionFile(source, "a.txt", new Uint8Array([1]));
            const snapshot = await instance.environments.createSnapshot(
                snapshotRequest("sess-source", "snap-1", { environment })
            );
            if (snapshot.name !== "ready") throw new TypeError("Expected ready snapshot");
            return snapshot.value.value;
        });

        const snapshotBytes = encodeCanonicalJson({
            files: { "a.txt": encodeBase64(new Uint8Array([1])) },
            format: "agent-core-environment-snapshot/1"
        });
        const address = await contentObjectAddress(
            new TenantId(ENVIRONMENT_PROVIDER_TENANT),
            snapshotBytes,
            errors
        );
        await env.CONTENT.put(address.key, new Uint8Array([0, 0, 0]));

        await evictDurableObject(stub);

        await runInDurableObject(stub, async (instance) => {
            expect(
                await instance.environments.openSession(
                    sessionRequest("sess-corrupt", {
                        environment,
                        restore: new ContentRef(`sha256:${address.digest}`)
                    })
                )
            ).toEqual({ name: "failed" });
        });
    });

    it("[P11-ENVIRONMENT-PREVIEW] derives a deterministic durable preview URL and revokes it fail-closed across eviction", async () => {
        const stub = env.ENVIRONMENTS.getByName("preview");
        const environment = "env-preview";
        const session = sessionRequest("sess-preview", { environment });
        const exposure = exposureRequest("sess-preview", "exp-1", 8080, { environment });

        const url = await runInDurableObject(stub, async (instance) => {
            await instance.environments.openSession(session);
            const exposed = await instance.environments.exposePort(exposure);
            if (exposed.name !== "ready") throw new TypeError("Expected ready exposure");
            return exposed.value;
        });
        const token = Digest.sha256(
            encodeCanonicalJson({
                environmentId: environment,
                environmentRevision: 0,
                exposureId: "exp-1",
                generation: 0,
                port: 8080,
                sessionEpoch: 0,
                sessionId: "sess-preview"
            })
        ).value;
        expect(url).toBe(`https://${token.slice(0, 32)}.${token.slice(32)}.${PREVIEW_HOST}/`);

        await evictDurableObject(stub);

        await runInDurableObject(stub, async (instance) => {
            expect(await instance.environments.inspectExposure(exposure)).toEqual({
                name: "ready",
                value: url
            });
            expect(await instance.environments.exposePort(exposure)).toEqual({
                name: "ready",
                value: url
            });
            expect(await instance.environments.revokeExposure(exposure)).toEqual({
                name: "succeeded"
            });
        });

        await evictDurableObject(stub);

        await runInDurableObject(stub, async (instance) => {
            expect(await instance.environments.inspectExposure(exposure)).toEqual({
                name: "absent"
            });
            expect(await instance.environments.exposePort(exposure)).toEqual({ name: "failed" });
            expect(await instance.environments.revokeExposure(exposure)).toEqual({
                name: "succeeded"
            });
        });
    });
});
