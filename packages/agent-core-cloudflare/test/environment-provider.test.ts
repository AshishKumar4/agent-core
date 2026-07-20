import {
    ContentRef,
    Digest,
    Revision,
    TenantId,
    encodeBase64,
    encodeCanonicalJson,
    type JsonValue
} from "@agent-core/core";
import {
    EnvironmentId,
    EnvironmentSessionId,
    EnvironmentSnapshotId,
    PortExposureId,
    ProviderDescriptor,
    ProviderId,
    type ExposePortRequest,
    type OpenSessionRequest,
    type SnapshotEnvironmentRequest
} from "@agent-core/core/environment-provider";
import {
    DurableObjectEnvironmentProvider,
    R2ContentObjectRepository,
    SqliteApplicationMigrator,
    contentObjectAddress,
    environmentProviderMigration
} from "../src/index.js";
import type { R2ObjectBodyLike, R2ObjectLike, R2PutOptionsLike } from "../src/index.js";
import { expectOperationalFailure } from "./assertions.js";
import { FakeR2Bucket, fakeErrors } from "./fakes.js";
import { NodeSqlite } from "./node-sqlite.js";

const SNAPSHOT_FORMAT = "agent-core-environment-snapshot/1";
const tenant = new TenantId("environment-tests");

const providerDescriptor = new ProviderDescriptor(
    new ProviderId("cloudflare-do"),
    "1",
    ContentRef.fromDigest(Digest.sha256(new Uint8Array([0])))
);

function sessionRequest(
    session: string,
    pin: {
        readonly revision?: number;
        readonly generation?: number;
        readonly restore?: ContentRef;
    } = {}
): OpenSessionRequest {
    return Object.freeze({
        environmentId: new EnvironmentId("env-1"),
        environmentRevision: new Revision(pin.revision ?? 0),
        generation: pin.generation ?? 0,
        sessionId: new EnvironmentSessionId(session),
        ...(pin.restore === undefined ? {} : { restore: pin.restore })
    });
}

function snapshotRequest(
    session: string,
    snapshot: string,
    pin: {
        readonly revision?: number;
        readonly generation?: number;
        readonly sessionEpoch?: number;
    } = {}
): SnapshotEnvironmentRequest {
    return Object.freeze({
        environmentId: new EnvironmentId("env-1"),
        environmentRevision: new Revision(pin.revision ?? 0),
        generation: pin.generation ?? 0,
        sessionId: new EnvironmentSessionId(session),
        sessionEpoch: pin.sessionEpoch ?? 0,
        snapshotId: new EnvironmentSnapshotId(snapshot)
    });
}

function exposureRequest(
    session: string,
    exposure: string,
    port = 8080,
    pin: {
        readonly revision?: number;
        readonly generation?: number;
        readonly sessionEpoch?: number;
    } = {}
): ExposePortRequest {
    return Object.freeze({
        environmentId: new EnvironmentId("env-1"),
        environmentRevision: new Revision(pin.revision ?? 0),
        generation: pin.generation ?? 0,
        sessionId: new EnvironmentSessionId(session),
        sessionEpoch: pin.sessionEpoch ?? 0,
        exposureId: new PortExposureId(exposure),
        port
    });
}

function createProvider(bucket: FakeR2Bucket = new FakeR2Bucket()): {
    readonly provider: DurableObjectEnvironmentProvider;
    readonly bucket: FakeR2Bucket;
    readonly sqlite: NodeSqlite;
} {
    const sqlite = new NodeSqlite();
    new SqliteApplicationMigrator(sqlite, fakeErrors, [environmentProviderMigration(1)]).migrate();
    const provider = new DurableObjectEnvironmentProvider(
        providerDescriptor,
        sqlite,
        new R2ContentObjectRepository(bucket, fakeErrors),
        tenant,
        { previewHost: "preview.test" },
        fakeErrors
    );
    return { provider, bucket, sqlite };
}

class GatedR2Bucket extends FakeR2Bucket {
    readonly #started = deferred();
    readonly #release = deferred();

    public get started(): Promise<void> {
        return this.#started.promise;
    }

    public release(): void {
        this.#release.resolve();
    }

    public override async put(
        key: string,
        value: ArrayBuffer | ArrayBufferView,
        options: R2PutOptionsLike
    ): Promise<R2ObjectLike | null> {
        this.#started.resolve();
        await this.#release.promise;
        return super.put(key, value, options);
    }
}

class FailingReadR2Bucket extends FakeR2Bucket {
    public failNextRead = false;

    public override async get(key: string): Promise<R2ObjectBodyLike | null> {
        if (this.failNextRead) {
            this.failNextRead = false;
            throw new TypeError("Injected R2 read failure");
        }
        return super.get(key);
    }
}

function deferred(): {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
} {
    let settle: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        settle = resolve;
    });
    return {
        promise,
        resolve(): void {
            if (settle === undefined) throw new TypeError("Deferred promise is unavailable");
            settle();
        }
    };
}

describe("DurableObjectEnvironmentProvider", () => {
    test("opens, inspects, and closes a session with idempotent replays", async () => {
        const { provider } = createProvider();
        const request = sessionRequest("sess-1");

        const opened = await provider.openSession(request);
        expect(opened.name).toBe("ready");
        if (opened.name !== "ready") throw new TypeError("Expected ready outcome");
        expect(Object.isFrozen(opened)).toBe(true);
        expect(Reflect.ownKeys(opened).sort()).toEqual(["name", "value"]);
        expect(opened.value.children).toEqual([]);
        await opened.value.release();

        const replayed = await provider.openSession(request);
        expect(replayed.name).toBe("ready");
        expect(await provider.inspectSession(request)).toMatchObject({ name: "ready" });

        expect(await provider.closeSession(request)).toEqual({ name: "succeeded" });
        expect(await provider.closeSession(request)).toEqual({ name: "succeeded" });
        expect(await provider.inspectSession(request)).toEqual({ name: "absent" });
        expect(await provider.openSession(request)).toEqual({ name: "failed" });
    });

    test("rejects a stale generation once a newer pin is observed", async () => {
        const { provider } = createProvider();
        const first = sessionRequest("sess-old", { revision: 1, generation: 1 });
        expect(await provider.openSession(first)).toMatchObject({ name: "ready" });

        const rotated = sessionRequest("sess-new", { revision: 2, generation: 2 });
        expect(await provider.openSession(rotated)).toMatchObject({ name: "ready" });

        expect(
            await provider.openSession(sessionRequest("sess-stale", { revision: 1, generation: 1 }))
        ).toEqual({ name: "failed" });
        expect(
            await provider.openSession(sessionRequest("sess-mixed", { revision: 3, generation: 2 }))
        ).toEqual({ name: "failed" });

        // The already-open old-generation session drains normally under its own pin.
        expect(await provider.inspectSession(first)).toMatchObject({ name: "ready" });
        expect(await provider.closeSession(first)).toEqual({ name: "succeeded" });
    });

    test("rejects requests whose pin does not match the exact session reservation", async () => {
        const { provider } = createProvider();
        const request = sessionRequest("sess-1");
        expect(await provider.openSession(request)).toMatchObject({ name: "ready" });

        const wrongGeneration = sessionRequest("sess-1", { revision: 1, generation: 1 });
        expect(await provider.openSession(wrongGeneration)).toEqual({ name: "failed" });
        expect(await provider.inspectSession(wrongGeneration)).toEqual({ name: "failed" });
        expect(await provider.closeSession(wrongGeneration)).toEqual({ name: "failed" });
        expect(
            await provider.createSnapshot(snapshotRequest("sess-1", "snap-1", { generation: 1 }))
        ).toEqual({
            name: "failed"
        });
        expect(
            await provider.exposePort(exposureRequest("sess-1", "exp-1", 8080, { generation: 1 }))
        ).toEqual({
            name: "failed"
        });
    });

    test("snapshots session files to a content-addressed ContentRef", async () => {
        const { provider, bucket } = createProvider();
        const request = sessionRequest("sess-1");
        await provider.openSession(request);
        provider.writeSessionFile(request, "a.txt", new Uint8Array([1, 2, 3]));
        provider.writeSessionFile(request, "b/c.txt", new Uint8Array([4]));

        const snapshot = await provider.createSnapshot(snapshotRequest("sess-1", "snap-1"));
        if (snapshot.name !== "ready") throw new TypeError("Expected ready snapshot");
        const expectedBytes = encodeCanonicalJson({
            files: {
                "a.txt": encodeBase64(new Uint8Array([1, 2, 3])),
                "b/c.txt": encodeBase64(new Uint8Array([4]))
            },
            format: SNAPSHOT_FORMAT
        });
        expect(snapshot.value).toBeInstanceOf(ContentRef);
        expect(snapshot.value.value).toBe(`sha256:${Digest.sha256(expectedBytes).value}`);

        const writes = bucket.putCalls.length;
        const replayed = await provider.createSnapshot(snapshotRequest("sess-1", "snap-1"));
        if (replayed.name !== "ready") throw new TypeError("Expected ready snapshot replay");
        expect(replayed.value.equals(snapshot.value)).toBe(true);
        expect(bucket.putCalls.length).toBe(writes);

        expect(await provider.inspectSnapshot(snapshotRequest("sess-1", "snap-1"))).toMatchObject({
            name: "ready"
        });
        expect(await provider.inspectSnapshot(snapshotRequest("sess-1", "snap-unknown"))).toEqual({
            name: "absent"
        });
        expect(await provider.inspectSnapshot(snapshotRequest("sess-other", "snap-1"))).toEqual({
            name: "failed"
        });
        expect(await provider.createSnapshot(snapshotRequest("sess-other", "snap-1"))).toEqual({
            name: "failed"
        });
    });

    test("fences snapshot and exposure effects to the exact live session epoch", async () => {
        const { provider } = createProvider();
        const session = sessionRequest("sess-1");
        expect(await provider.openSession(session)).toMatchObject({ name: "ready" });

        expect(
            await provider.createSnapshot(
                snapshotRequest("sess-1", "snap-stale", { sessionEpoch: 1 })
            )
        ).toEqual({ name: "failed" });
        expect(
            await provider.exposePort(
                exposureRequest("sess-1", "exp-stale", 8080, { sessionEpoch: 1 })
            )
        ).toEqual({ name: "failed" });
    });

    test("does not publish a snapshot after its session closes during the R2 write", async () => {
        const bucket = new GatedR2Bucket();
        const { provider } = createProvider(bucket);
        const session = sessionRequest("sess-1");
        await provider.openSession(session);
        provider.writeSessionFile(session, "a.txt", new Uint8Array([1]));

        const request = snapshotRequest("sess-1", "snap-raced");
        const snapshot = provider.createSnapshot(request);
        await bucket.started;
        expect(await provider.closeSession(session)).toEqual({ name: "succeeded" });
        bucket.release();

        await expect(snapshot).resolves.toEqual({ name: "failed" });
        expect(await provider.inspectSnapshot(request)).toEqual({ name: "absent" });
    });

    test("restores a snapshot exactly and refuses snapshots of closed sessions", async () => {
        const { provider } = createProvider();
        const source = sessionRequest("sess-source");
        await provider.openSession(source);
        provider.writeSessionFile(source, "state.json", new Uint8Array([7, 8]));
        const snapshot = await provider.createSnapshot(snapshotRequest("sess-source", "snap-1"));
        if (snapshot.name !== "ready") throw new TypeError("Expected ready snapshot");

        const restored = sessionRequest("sess-restored", { restore: snapshot.value });
        expect(await provider.openSession(restored)).toMatchObject({ name: "ready" });
        expect(provider.readSessionFile(restored, "state.json")).toEqual(new Uint8Array([7, 8]));

        // The restore reference participates in the reservation identity.
        expect(await provider.openSession(sessionRequest("sess-restored"))).toEqual({
            name: "failed"
        });

        await provider.closeSession(source);
        expect(await provider.createSnapshot(snapshotRequest("sess-source", "snap-2"))).toEqual({
            name: "failed"
        });
        expectOperationalFailure(
            () => provider.writeSessionFile(source, "state.json", new Uint8Array([9])),
            "protocol.invalid-state"
        );
    });

    test("does not collapse a transient R2 restore failure into a definitive absence", async () => {
        const bucket = new FailingReadR2Bucket();
        const { provider } = createProvider(bucket);
        const source = sessionRequest("sess-source");
        await provider.openSession(source);
        provider.writeSessionFile(source, "state.txt", new Uint8Array([1]));
        const snapshot = await provider.createSnapshot(snapshotRequest("sess-source", "snap-1"));
        if (snapshot.name !== "ready") throw new TypeError("Expected ready snapshot");

        const restore = sessionRequest("sess-restore", { restore: snapshot.value });
        bucket.failNextRead = true;
        await expect(provider.openSession(restore)).rejects.toMatchObject({
            code: "protocol.invalid-state"
        });
        expect(await provider.openSession(restore)).toMatchObject({ name: "ready" });
    });

    test("fails closed when restoring missing or corrupt snapshot content", async () => {
        const { provider, bucket } = createProvider();
        const missing = ContentRef.fromDigest(Digest.sha256(new Uint8Array([9, 9, 9])));
        expect(
            await provider.openSession(sessionRequest("sess-missing", { restore: missing }))
        ).toEqual({ name: "failed" });

        const source = sessionRequest("sess-source");
        await provider.openSession(source);
        provider.writeSessionFile(source, "a.txt", new Uint8Array([1]));
        const snapshot = await provider.createSnapshot(snapshotRequest("sess-source", "snap-1"));
        if (snapshot.name !== "ready") throw new TypeError("Expected ready snapshot");
        const address = await contentObjectAddress(
            tenant,
            encodeCanonicalJson({
                files: { "a.txt": encodeBase64(new Uint8Array([1])) },
                format: SNAPSHOT_FORMAT
            }),
            fakeErrors
        );
        bucket.corruptBody(address.key, new Uint8Array([0, 0, 0]));
        expect(
            await provider.openSession(sessionRequest("sess-corrupt", { restore: snapshot.value }))
        ).toEqual({ name: "failed" });
    });

    test("derives a deterministic preview URL and revokes it fail-closed", async () => {
        const { provider } = createProvider();
        const session = sessionRequest("sess-1");
        await provider.openSession(session);
        const request = exposureRequest("sess-1", "exp-1", 8080);

        const exposed = await provider.exposePort(request);
        if (exposed.name !== "ready") throw new TypeError("Expected ready exposure");
        const token = Digest.sha256(
            encodeCanonicalJson({
                environmentId: "env-1",
                environmentRevision: 0,
                exposureId: "exp-1",
                generation: 0,
                port: 8080,
                sessionEpoch: 0,
                sessionId: "sess-1"
            })
        ).value;
        expect(exposed.value).toBe(
            `https://${token.slice(0, 32)}.${token.slice(32)}.preview.test/`
        );

        expect(await provider.exposePort(request)).toEqual(exposed);
        expect(await provider.inspectExposure(request)).toEqual(exposed);
        expect(await provider.inspectExposure(exposureRequest("sess-1", "exp-1", 9090))).toEqual({
            name: "failed"
        });

        expect(await provider.revokeExposure(request)).toEqual({ name: "succeeded" });
        expect(await provider.revokeExposure(request)).toEqual({ name: "succeeded" });
        expect(await provider.inspectExposure(request)).toEqual({ name: "absent" });
        expect(await provider.exposePort(request)).toEqual({ name: "failed" });
    });

    test("keeps revocation authoritative for exposures it never materialized", async () => {
        const { provider } = createProvider();
        await provider.openSession(sessionRequest("sess-1"));
        const request = exposureRequest("sess-1", "exp-lost", 3000);

        expect(await provider.revokeExposure(request)).toEqual({ name: "succeeded" });
        expect(await provider.inspectExposure(request)).toEqual({ name: "absent" });
        expect(await provider.exposePort(request)).toEqual({ name: "failed" });
        expect(await provider.revokeExposure(exposureRequest("sess-1", "exp-lost", 3001))).toEqual({
            name: "failed"
        });
    });

    test("closing a session revokes its exposures and drops its files", async () => {
        const { provider } = createProvider();
        const session = sessionRequest("sess-1");
        await provider.openSession(session);
        provider.writeSessionFile(session, "a.txt", new Uint8Array([1]));
        const exposure = exposureRequest("sess-1", "exp-1");
        await provider.exposePort(exposure);

        expect(await provider.closeSession(session)).toEqual({ name: "succeeded" });
        expect(await provider.inspectExposure(exposure)).toEqual({ name: "absent" });
        expect(await provider.exposePort(exposure)).toEqual({ name: "failed" });
        expectOperationalFailure(
            () => provider.readSessionFile(session, "a.txt"),
            "protocol.invalid-state"
        );

        // Closing an unknown session tombstones its ID against later opens.
        const unknown = sessionRequest("sess-unknown");
        expect(await provider.closeSession(unknown)).toEqual({ name: "succeeded" });
        expect(await provider.openSession(unknown)).toEqual({ name: "failed" });
    });

    test("rejects malformed requests before touching storage", async () => {
        const { provider } = createProvider();
        const malformedSession = Object.freeze({
            ...sessionRequest("valid"),
            sessionId: Object.freeze({ value: "" })
        });
        await expect(
            Reflect.apply(provider.openSession, provider, [malformedSession])
        ).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
        await expect(
            provider.exposePort(exposureRequest("sess-1", "exp-1", 0))
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
        await expect(
            provider.exposePort(exposureRequest("sess-1", "exp-1", 65_536))
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
        expectOperationalFailure(
            () => provider.writeSessionFile(sessionRequest("sess-1"), "", new Uint8Array([1])),
            "operation.invalid-input"
        );
    });

    test("validates its descriptor, tenant, and preview host at construction", () => {
        const sqlite = new NodeSqlite();
        new SqliteApplicationMigrator(sqlite, fakeErrors, [environmentProviderMigration(1)]).migrate();
        const content = new R2ContentObjectRepository(new FakeR2Bucket(), fakeErrors);
        const construct = (
            descriptor: unknown,
            tenantValue: unknown,
            previewHost: string
        ): unknown =>
            Reflect.construct(DurableObjectEnvironmentProvider, [
                descriptor,
                sqlite,
                content,
                tenantValue,
                { previewHost },
                fakeErrors
            ]);
        expectOperationalFailure(
            () => construct({ id: "cloudflare-do" }, tenant, "preview.test"),
            "operation.invalid-input"
        );
        expectOperationalFailure(
            () => construct(providerDescriptor, "environment-tests", "preview.test"),
            "operation.invalid-input"
        );
        expectOperationalFailure(
            () => construct(providerDescriptor, tenant, "Not-A-Host!"),
            "operation.invalid-input"
        );
    });

    test("validates every request pin with its canonical branded classes", async () => {
        const { provider } = createProvider();
        const call = (request: unknown): Promise<unknown> =>
            Reflect.apply(provider.openSession, provider, [request]);
        await expect(
            call({ ...sessionRequest("sess-1"), restore: "not-a-content-ref" })
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
        await expect(
            call({ ...sessionRequest("sess-1"), environmentRevision: 0 })
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
        await expect(
            call({ ...sessionRequest("sess-1"), generation: -1 })
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
        await expect(
            Reflect.apply(provider.createSnapshot, provider, [
                { ...snapshotRequest("sess-1", "snap-1"), sessionEpoch: -1 }
            ])
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
    });

    test("reports an unknown session as absent on inspection", async () => {
        const { provider } = createProvider();
        expect(await provider.inspectSession(sessionRequest("sess-unknown"))).toEqual({
            name: "absent"
        });
    });

    test("guards session file writes and reads", async () => {
        const { provider } = createProvider();
        const session = sessionRequest("sess-1");
        await provider.openSession(session);
        expectOperationalFailure(
            () =>
                Reflect.apply(provider.writeSessionFile, provider, [
                    session,
                    "state.txt",
                    "not-bytes"
                ]),
            "operation.invalid-input"
        );
        expect(provider.readSessionFile(session, "missing.txt")).toBeUndefined();
    });

    test("fails closed when any substrate record decodes to a corrupt shape", async () => {
        const arm = (
            match: string,
            rows: readonly Record<string, string | number | Uint8Array | null>[]
        ): { readonly provider: DurableObjectEnvironmentProvider; trigger: () => void } => {
            let armed = false;
            const sqlite = new (class extends NodeSqlite {
                public override all(
                    statement: string,
                    bindings: readonly (string | number | Uint8Array | null)[]
                ): readonly Record<string, string | number | Uint8Array | null>[] {
                    if (armed && statement.includes(match)) return rows;
                    return super.all(statement, bindings);
                }
            })();
            new SqliteApplicationMigrator(sqlite, fakeErrors, [
                environmentProviderMigration(1)
            ]).migrate();
            const provider = new DurableObjectEnvironmentProvider(
                providerDescriptor,
                sqlite,
                new R2ContentObjectRepository(new FakeR2Bucket(), fakeErrors),
                tenant,
                { previewHost: "preview.test" },
                fakeErrors
            );
            return {
                provider,
                trigger: () => {
                    armed = true;
                }
            };
        };

        const pin = arm("FROM agent_core_environment_pins", [{ revision: "x", generation: 0 }]);
        await pin.provider.openSession(sessionRequest("sess-1"));
        pin.trigger();
        await expect(pin.provider.openSession(sessionRequest("sess-2"))).rejects.toMatchObject({
            code: "codec.invalid"
        });

        const session = arm("FROM agent_core_environment_sessions WHERE session_id", [
            { environment_id: "env-1", revision: 0, generation: 0, session_epoch: 0, restore_ref: null, state: "limbo" }
        ]);
        await session.provider.openSession(sessionRequest("sess-1"));
        session.trigger();
        await expect(
            session.provider.inspectSession(sessionRequest("sess-1"))
        ).rejects.toMatchObject({ code: "codec.invalid" });

        const file = arm("AND path = ?", [{ content: "not-bytes" }]);
        await file.provider.openSession(sessionRequest("sess-1"));
        file.provider.writeSessionFile(sessionRequest("sess-1"), "a.txt", new Uint8Array([1]));
        file.trigger();
        expectOperationalFailure(
            () => file.provider.readSessionFile(sessionRequest("sess-1"), "a.txt"),
            "codec.invalid"
        );

        const files = arm("ORDER BY path", [{ path: 1, content: new Uint8Array([1]) }]);
        await files.provider.openSession(sessionRequest("sess-1"));
        files.trigger();
        await expect(
            files.provider.createSnapshot(snapshotRequest("sess-1", "snap-1"))
        ).rejects.toMatchObject({ code: "codec.invalid" });

        const snapshot = arm("FROM agent_core_environment_snapshots", [
            { environment_id: "env-1", session_id: "sess-1", revision: 0, generation: 0, session_epoch: 0, content_ref: 7 }
        ]);
        snapshot.trigger();
        await expect(
            snapshot.provider.inspectSnapshot(snapshotRequest("sess-1", "snap-1"))
        ).rejects.toMatchObject({ code: "codec.invalid" });

        const exposure = arm("FROM agent_core_environment_exposures", [
            { environment_id: "env-1", session_id: "sess-1", revision: 0, generation: 0, session_epoch: 0, port: 8080, url: null, state: "open" }
        ]);
        exposure.trigger();
        await expect(
            exposure.provider.inspectExposure(exposureRequest("sess-1", "exp-1"))
        ).rejects.toMatchObject({ code: "codec.invalid" });
    });

    test("treats an exposed record without its preview URL as corrupt", async () => {
        const { provider, sqlite } = createProvider();
        await provider.openSession(sessionRequest("sess-1"));
        sqlite.run(
            `INSERT INTO agent_core_environment_exposures
                (exposure_id, environment_id, session_id, revision, generation, session_epoch, port, url, state)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ["exp-1", "env-1", "sess-1", 0, 0, 0, 8080, null, "exposed"]
        );
        await expect(provider.inspectExposure(exposureRequest("sess-1", "exp-1"))).rejects.toMatchObject(
            { code: "codec.invalid" }
        );
    });

    test("fails closed when restoring a structurally invalid snapshot document", async () => {
        const { provider, bucket } = createProvider();
        const repository = new R2ContentObjectRepository(bucket, fakeErrors);
        const restoreOf = async (document: JsonValue): Promise<ContentRef> => {
            const stored = await repository.put(tenant, encodeCanonicalJson(document));
            return ContentRef.fromDigest(new Digest(stored.digest));
        };

        const wrongFormat = await restoreOf({ files: {}, format: "other-format/1" });
        expect(
            await provider.openSession(sessionRequest("sess-a", { restore: wrongFormat }))
        ).toEqual({ name: "failed" });

        const extraKeys = await restoreOf({ files: {}, format: SNAPSHOT_FORMAT, extra: true });
        expect(
            await provider.openSession(sessionRequest("sess-b", { restore: extraKeys }))
        ).toEqual({ name: "failed" });

        const filesNotRecord = await restoreOf({ files: "nope", format: SNAPSHOT_FORMAT });
        expect(
            await provider.openSession(sessionRequest("sess-c", { restore: filesNotRecord }))
        ).toEqual({ name: "failed" });

        const encodedNotString = await restoreOf({ files: { "a.txt": 1 }, format: SNAPSHOT_FORMAT });
        expect(
            await provider.openSession(sessionRequest("sess-d", { restore: encodedNotString }))
        ).toEqual({ name: "failed" });

        const invalidBase64 = await restoreOf({ files: { "a.txt": "!!!" }, format: SNAPSHOT_FORMAT });
        expect(
            await provider.openSession(sessionRequest("sess-e", { restore: invalidBase64 }))
        ).toEqual({ name: "failed" });
    });

    test("settles an open that raced a conflicting reservation or a newer pin while restoring", async () => {
        const snapshotFor = async (bucket: FakeR2Bucket): Promise<ContentRef> => {
            const stored = await new R2ContentObjectRepository(bucket, fakeErrors).put(
                tenant,
                encodeCanonicalJson({ files: {}, format: SNAPSHOT_FORMAT })
            );
            return ContentRef.fromDigest(new Digest(stored.digest));
        };

        {
            const bucket = new GatedGetR2Bucket();
            const { provider } = createProvider(bucket);
            const restore = await snapshotFor(bucket);
            bucket.arm();
            const racing = provider.openSession(sessionRequest("sess-r", { restore }));
            await bucket.started;
            expect(await provider.openSession(sessionRequest("sess-r"))).toMatchObject({
                name: "ready"
            });
            bucket.release();
            expect(await racing).toEqual({ name: "failed" });
        }

        {
            const bucket = new GatedGetR2Bucket();
            const { provider } = createProvider(bucket);
            const restore = await snapshotFor(bucket);
            bucket.arm();
            const racing = provider.openSession(sessionRequest("sess-r", { restore }));
            await bucket.started;
            expect(
                await provider.openSession(sessionRequest("sess-newer", { revision: 1, generation: 1 }))
            ).toMatchObject({ name: "ready" });
            bucket.release();
            expect(await racing).toEqual({ name: "failed" });
        }
    });

    test("replays a snapshot that raced its own record during the R2 write", async () => {
        const bucket = new GatedR2Bucket();
        const { provider, sqlite } = createProvider(bucket);
        await provider.openSession(sessionRequest("sess-1"));
        const pending = provider.createSnapshot(snapshotRequest("sess-1", "snap-1"));
        await bucket.started;
        const recorded = ContentRef.fromDigest(Digest.sha256(new Uint8Array([42])));
        sqlite.run(
            `INSERT INTO agent_core_environment_snapshots
                (snapshot_id, environment_id, session_id, revision, generation, session_epoch, content_ref)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ["snap-1", "env-1", "sess-1", 0, 0, 0, recorded.value]
        );
        bucket.release();
        expect(await pending).toEqual({ name: "ready", value: recorded });
    });
});

class GatedGetR2Bucket extends FakeR2Bucket {
    readonly #started = deferred();
    readonly #release = deferred();
    #gate = false;

    public arm(): void {
        this.#gate = true;
    }

    public get started(): Promise<void> {
        return this.#started.promise;
    }

    public release(): void {
        this.#release.resolve();
    }

    public override async get(key: string): Promise<R2ObjectBodyLike | null> {
        if (this.#gate) {
            this.#started.resolve();
            await this.#release.promise;
            this.#gate = false;
        }
        return super.get(key);
    }
}
