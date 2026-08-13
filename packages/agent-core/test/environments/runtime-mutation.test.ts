import { describe, expect, test } from "vitest";
import { TurnId, type LeaseToken, type TurnLeaseVerifier } from "../../src/agents";
import { ContentRef, Revision } from "../../src/core";
import {
    Environment,
    EnvironmentController,
    EnvironmentId,
    EnvironmentProvider,
    EnvironmentRevisionRecord,
    EnvironmentSession,
    EnvironmentSessionId,
    EnvironmentSessionState,
    EnvironmentSnapshot,
    EnvironmentSnapshotId,
    EnvironmentSnapshotState,
    EnvironmentStore,
    MemoryEnvironmentProviderRegistry,
    MemoryEnvironmentStore,
    PortExposure,
    PortExposureId,
    ProviderActionOutcome,
    ProviderDescriptor,
    ProviderId,
    ProviderResourceOutcome,
    type ExposePortRequest,
    type LiveEnvironmentSession,
    type OpenSessionRequest,
    type ProviderActionOutcome as ActionOutcome,
    type ProviderResourceOutcome as ResourceOutcome,
    type SnapshotEnvironmentRequest
} from "../../src/environments";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";

const environmentId = new EnvironmentId("environment-runtime-mutation");
const lease: LeaseToken = Object.freeze({
    turn: new TurnId("turn-runtime-mutation"),
    holder: new PrincipalRef(
        new TenantId("runtime-mutation-tenant"),
        new PrincipalId("runtime-mutation-principal")
    ),
    epoch: 3
});

describe("EnvironmentController mutation kills", () => {
    test("rejects nonzero initial revisions and generations independently", { tags: "p1" }, () => {
        const fixture = setup("initial-operands");
        const error = expect.objectContaining({
            code: "operation.invalid-input",
            message: "Initial Environment revision and generation must both be zero"
        });

        expect(() =>
            fixture.controller.provision(
                new EnvironmentRevisionRecord(
                    new EnvironmentId("environment-nonzero-revision"),
                    new Revision(1),
                    0,
                    fixture.provider.descriptor
                ),
                lease
            )
        ).toThrowError(error);
        expect(() =>
            fixture.controller.provision(
                new EnvironmentRevisionRecord(
                    new EnvironmentId("environment-nonzero-generation"),
                    Revision.initial(),
                    1,
                    fixture.provider.descriptor
                ),
                lease
            )
        ).toThrowError(error);
    });

    test(
        "[C13-ENVIRONMENT-ROTATION] provision replay after rotation is a conflict",
        { tags: "p0" },
        () => {
            const fixture = setup("provision-after-rotation");
            fixture.controller.rotate(environmentId, fixture.provider.descriptor, lease);

            expect(() =>
                fixture.controller.provision(initialRevision(fixture.provider.descriptor), lease)
            ).toThrowError(
                expect.objectContaining({
                    code: "protocol.revision-conflict",
                    message: "Environment was provisioned concurrently"
                })
            );
        }
    );

    test("reservation replay pins the restore snapshot in both directions", { tags: "p0" }, async () => {
        const fixture = setup("restore-pin-directions");
        const source = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-restore-pin-source"),
            lease
        );
        await fixture.controller.openSession(source.capability, lease);
        const snapshotId = new EnvironmentSnapshotId("snapshot-restore-pin");
        await fixture.controller.snapshot(source.capability, snapshotId, lease);
        const error = expect.objectContaining({
            code: "environment.invalid-session",
            message: "Environment session ID is already reserved for another generation"
        });

        const bare = new EnvironmentSessionId("session-reserved-bare");
        fixture.controller.reserveSession(environmentId, bare, lease);
        expect(() =>
            fixture.controller.reserveSession(environmentId, bare, lease, snapshotId)
        ).toThrowError(error);

        const restoring = new EnvironmentSessionId("session-reserved-restoring");
        fixture.controller.reserveSession(environmentId, restoring, lease, snapshotId);
        expect(() =>
            fixture.controller.reserveSession(environmentId, restoring, lease)
        ).toThrowError(error);
    });

    test("fences snapshot and exposure IDs to their exact session", { tags: "p0" }, async () => {
        const fixture = setup("resource-id-fencing");
        const first = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-fence-first"),
            lease
        );
        const second = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-fence-second"),
            lease
        );
        await fixture.controller.openSession(first.capability, lease);
        await fixture.controller.openSession(second.capability, lease);

        const snapshotId = new EnvironmentSnapshotId("snapshot-fenced-id");
        await fixture.controller.snapshot(first.capability, snapshotId, lease);
        await expect(
            fixture.controller.snapshot(second.capability, snapshotId, lease)
        ).rejects.toEqual(
            expect.objectContaining({
                code: "environment.invalid-session",
                message: "Environment snapshot ID is already used by another session generation"
            })
        );

        const exposureId = new PortExposureId("exposure-fenced-id");
        await fixture.controller.expose(first.capability, exposureId, 4173, lease);
        await expect(
            fixture.controller.expose(second.capability, exposureId, 4173, lease)
        ).rejects.toEqual(
            expect.objectContaining({
                code: "environment.invalid-session",
                message: "Port exposure ID is already used by another session generation"
            })
        );
    });

    test("admits boundary ports 1 and 65535 and rejects 65536", { tags: "p1" }, async () => {
        const fixture = setup("port-boundaries");
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-port-boundaries"),
            lease
        );
        await fixture.controller.openSession(reserved.capability, lease);

        const low = await fixture.controller.expose(
            reserved.capability,
            new PortExposureId("exposure-port-low"),
            1,
            lease
        );
        const high = await fixture.controller.expose(
            reserved.capability,
            new PortExposureId("exposure-port-high"),
            65_535,
            lease
        );
        expect(low.port).toBe(1);
        expect(high.port).toBe(65_535);
        expect(fixture.provider.exposureRequests.map((request) => request.port)).toEqual([
            1, 65_535
        ]);
        await expect(
            fixture.controller.expose(
                reserved.capability,
                new PortExposureId("exposure-port-overflow"),
                65_536,
                lease
            )
        ).rejects.toEqual(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: "Port exposure port must be between 1 and 65535"
            })
        );
    });

    test("opening an already-open session performs no provider work", { tags: "p1" }, async () => {
        const fixture = setup("open-idempotent");
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-open-idempotent"),
            lease
        );
        await fixture.controller.openSession(reserved.capability, lease);

        const replay = await fixture.controller.openSession(reserved.capability, lease);

        expect(replay.state.name).toBe("open");
        expect(fixture.provider.openRequests).toHaveLength(1);
        expect(fixture.provider.closeRequests).toHaveLength(0);
    });

    test("reconciling a reserved session performs no provider work", { tags: "p1" }, async () => {
        const fixture = setup("reconcile-reserved");
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-reconcile-reserved"),
            lease
        );

        const reconciled = await fixture.controller.reconcileSession(reserved.id, lease);

        expect(reconciled.state.name).toBe("reserved");
        expect(fixture.provider.openRequests).toHaveLength(0);
        expect(fixture.provider.inspectSessionRequests).toHaveLength(0);
    });

    test("reconciling an open session keeps the cached live handle", { tags: "p1" }, async () => {
        const fixture = setup("reconcile-keeps-handle");
        let releases = 0;
        fixture.provider.handle = {
            children: [],
            release: () => {
                releases += 1;
            }
        };
        fixture.provider.openResult = ProviderResourceOutcome.ready(fixture.provider.handle);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-reconcile-keeps-handle"),
            lease
        );
        await fixture.controller.openSession(reserved.capability, lease);

        const reconciled = await fixture.controller.reconcileSession(reserved.id, lease);
        await Promise.resolve();
        await Promise.resolve();

        expect(reconciled.state.name).toBe("open");
        expect(releases).toBe(0);
    });

    test(
        "reconciling an absent revoking exposure needs no second provider revoke",
        { tags: "p1" },
        async () => {
            const fixture = setup("reconcile-absent-revoking");
            const reserved = fixture.controller.reserveSession(
                environmentId,
                new EnvironmentSessionId("session-absent-revoking"),
                lease
            );
            await fixture.controller.openSession(reserved.capability, lease);
            const exposureId = new PortExposureId("exposure-absent-revoking");
            await fixture.controller.expose(reserved.capability, exposureId, 4173, lease);
            fixture.provider.revokeResults.push(ProviderActionOutcome.indeterminate);
            fixture.provider.removeIndeterminateExposure = true;
            const revoking = await fixture.controller.revoke(
                reserved.capability,
                exposureId,
                lease
            );
            expect(revoking.state.name).toBe("revoking");
            expect(fixture.provider.revokeRequests).toHaveLength(1);

            const reconciled = await fixture.controller.reconcileExposure(exposureId, lease);

            expect(reconciled.state.name).toBe("revoked");
            expect(fixture.provider.revokeRequests).toHaveLength(1);
        }
    );

    test("close replay is fenced to exactly one epoch of drift", { tags: "p0" }, async () => {
        const fixture = setup("close-replay-fence");
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-close-replay-fence"),
            lease
        );
        const opened = await fixture.controller.openSession(reserved.capability, lease);
        fixture.provider.sessions.delete(opened.id.value);
        const lost = await fixture.controller.reconcileSession(opened.id, lease);
        expect(lost.state.name).toBe("lost");

        const closed = await fixture.controller.closeSession(lost.capability, lease);
        expect(closed.state.name).toBe("closed");
        expect(closed.epoch).toBe(lost.epoch + 1);
        expect(
            (await fixture.controller.closeSession(lost.capability, lease)).state.name
        ).toBe("closed");
        await expect(
            fixture.controller.closeSession(opened.capability, lease)
        ).rejects.toEqual(
            expect.objectContaining({
                code: "environment.stale-session",
                message: "Environment session capability is stale or belongs to another session"
            })
        );
    });

    test("close replay while still closing returns without an error", { tags: "p1" }, async () => {
        const fixture = setup("close-replay-closing");
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-close-replay-closing"),
            lease
        );
        const opened = await fixture.controller.openSession(reserved.capability, lease);
        fixture.provider.closeResults.push(
            ProviderActionOutcome.indeterminate,
            ProviderActionOutcome.indeterminate
        );

        expect((await fixture.controller.closeSession(opened.capability, lease)).state.name).toBe(
            "closing"
        );
        expect((await fixture.controller.closeSession(opened.capability, lease)).state.name).toBe(
            "closing"
        );
    });

    test("a completed close never re-runs the provider close", { tags: "p1" }, async () => {
        const fixture = setup("close-once");
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-close-once"),
            lease
        );
        const opened = await fixture.controller.openSession(reserved.capability, lease);
        await fixture.controller.closeSession(opened.capability, lease);
        expect(fixture.provider.closeRequests).toHaveLength(1);

        const replay = await fixture.controller.closeSession(opened.capability, lease);

        expect(replay.state.name).toBe("closed");
        expect(fixture.provider.closeRequests).toHaveLength(1);
    });

    test(
        "a restarted close disposes the inspected provider handle before closing",
        { tags: "p1" },
        async () => {
            const fixture = setup("close-disposes-inspected");
            const events: string[] = [];
            fixture.provider.handle = {
                children: [],
                release: () => {
                    events.push("released");
                }
            };
            fixture.provider.openResult = ProviderResourceOutcome.ready(fixture.provider.handle);
            fixture.provider.onClose = () => events.push("provider-closed");
            const reserved = fixture.controller.reserveSession(
                environmentId,
                new EnvironmentSessionId("session-close-disposes-inspected"),
                lease
            );
            const opened = await fixture.controller.openSession(reserved.capability, lease);
            const restarted = new EnvironmentController(
                fixture.store,
                fixture.registry,
                fixture.verifier
            );

            const closed = await restarted.closeSession(opened.capability, lease);

            expect(closed.state.name).toBe("closed");
            expect(events).toEqual(["released", "provider-closed"]);
        }
    );

    test("restore fails closed when the pinned snapshot is not ready", { tags: "p0" }, async () => {
        const inner = new MemoryEnvironmentStore();
        const masking = new MaskingEnvironmentStore(inner);
        const provider = new TestProvider(descriptor("provider-restore-not-ready", "1"));
        const registry = new MemoryEnvironmentProviderRegistry([provider]);
        const verifier: TurnLeaseVerifier = { permits: (candidate) => candidate === lease };
        const controller = new EnvironmentController(masking, registry, verifier);
        controller.provision(initialRevision(provider.descriptor), lease);
        const source = controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-not-ready-source"),
            lease
        );
        await controller.openSession(source.capability, lease);
        const snapshotId = new EnvironmentSnapshotId("snapshot-not-ready-restore");
        await controller.snapshot(source.capability, snapshotId, lease);
        const restored = controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-not-ready-restore"),
            lease,
            snapshotId
        );
        masking.snapshotMask = "content";

        await expect(controller.openSession(restored.capability, lease)).rejects.toEqual(
            expect.objectContaining({
                code: "environment.invalid-session",
                message: "Restore snapshot is not ready"
            })
        );
        expect(provider.openRequests).toHaveLength(1);
    });

    test("provider resolution demands the exact pinned generation", { tags: "p0" }, async () => {
        const inner = new MemoryEnvironmentStore();
        const masking = new MaskingEnvironmentStore(inner);
        const provider = new TestProvider(descriptor("provider-wrong-generation", "2"));
        const registry = new MemoryEnvironmentProviderRegistry([provider]);
        const verifier: TurnLeaseVerifier = { permits: (candidate) => candidate === lease };
        const controller = new EnvironmentController(masking, registry, verifier);
        controller.provision(initialRevision(provider.descriptor), lease);
        const reserved = controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-wrong-generation"),
            lease
        );
        masking.revisionMask = "generation";

        await expect(controller.openSession(reserved.capability, lease)).rejects.toEqual(
            expect.objectContaining({
                code: "environment.stale-session",
                message: "Environment resource does not pin an exact provider generation"
            })
        );
        expect(provider.openRequests).toHaveLength(0);
    });

    test("every record CAS loss names its exact subject", { tags: "p1" }, async () => {
        const store = new RejectingEnvironmentStore();
        const provider = new TestProvider(descriptor("provider-cas-messages", "3"));
        const registry = new MemoryEnvironmentProviderRegistry([provider]);
        const controller = new EnvironmentController(store, registry, {
            permits: (candidate) => candidate === lease
        });
        controller.provision(initialRevision(provider.descriptor), lease);

        store.rejectEnvironment = true;
        expect(() =>
            controller.rotate(environmentId, provider.descriptor, lease)
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Environment rotation lost its head CAS"
            })
        );
        store.rejectEnvironment = false;

        const reserved = controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-cas-messages"),
            lease
        );
        store.rejectSession = true;
        await expect(controller.openSession(reserved.capability, lease)).rejects.toEqual(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Environment session CAS failed"
            })
        );
        store.rejectSession = false;
        const opened = await controller.openSession(reserved.capability, lease);

        const snapshotResult = new Deferred<ResourceOutcome<ContentRef>>();
        provider.deferredSnapshot = snapshotResult;
        const snapshot = controller.snapshot(
            opened.capability,
            new EnvironmentSnapshotId("snapshot-cas-message"),
            lease
        );
        await Promise.resolve();
        store.rejectSnapshot = true;
        snapshotResult.resolve(ProviderResourceOutcome.ready(provider.snapshotContent));
        await expect(snapshot).rejects.toEqual(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Environment snapshot CAS failed"
            })
        );
        store.rejectSnapshot = false;

        const exposureResult = new Deferred<ResourceOutcome<string>>();
        provider.deferredExposure = exposureResult;
        const exposure = controller.expose(
            opened.capability,
            new PortExposureId("exposure-cas-message"),
            4173,
            lease
        );
        await Promise.resolve();
        store.rejectExposure = true;
        exposureResult.resolve(ProviderResourceOutcome.ready(provider.exposureUrl));
        await expect(exposure).rejects.toEqual(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Port exposure CAS failed"
            })
        );
    });

    test("rotation surfaces exhausted revision and generation counters", { tags: "p1" }, () => {
        const store = new HeadOverrideEnvironmentStore();
        const provider = new TestProvider(descriptor("provider-exhausted-rotation", "4"));
        const registry = new MemoryEnvironmentProviderRegistry([provider]);
        const controller = new EnvironmentController(store, registry, {
            permits: (candidate) => candidate === lease
        });
        controller.provision(initialRevision(provider.descriptor), lease);

        store.headOverride = new Environment(
            environmentId,
            new Revision(Number.MAX_SAFE_INTEGER),
            0,
            Revision.initial()
        );
        expect(() =>
            controller.rotate(environmentId, provider.descriptor, lease)
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Environment revision is exhausted"
            })
        );

        store.headOverride = new Environment(
            environmentId,
            Revision.initial(),
            Number.MAX_SAFE_INTEGER,
            Revision.initial()
        );
        expect(() =>
            controller.rotate(environmentId, provider.descriptor, lease)
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Environment generation is exhausted"
            })
        );
    });

    test("missing environments and exposures carry exact messages", { tags: "p1" }, async () => {
        const fixture = setup("missing-messages");

        expect(() =>
            fixture.controller.reserveSession(
                new EnvironmentId("environment-not-provisioned"),
                new EnvironmentSessionId("session-missing-environment"),
                lease
            )
        ).toThrowError(
            expect.objectContaining({
                code: "environment.invalid-session",
                message: "Environment does not exist"
            })
        );
        await expect(
            fixture.controller.reconcileExposure(new PortExposureId("exposure-nonexistent"), lease)
        ).rejects.toEqual(
            expect.objectContaining({
                code: "environment.invalid-session",
                message: "Port exposure does not exist"
            })
        );
    });

    test("rejects ready session outcomes with null or primitive values", { tags: "p1" }, async () => {
        const fixture = setup("ready-value-shapes");
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-ready-value-shapes"),
            lease
        );
        const invalidResource = expect.objectContaining({
            code: "operation.invalid-output",
            message: "Environment provider resource outcome is malformed"
        });

        for (const value of [null, "handle", 42]) {
            fixture.provider.openOutcomeOverride = {
                name: "ready",
                value
            } as unknown as ResourceOutcome<LiveEnvironmentSession>;
            await expect(
                fixture.controller.openSession(reserved.capability, lease)
            ).rejects.toEqual(invalidResource);
        }
        expect(fixture.store.getSession(reserved.id)?.state.name).toBe("opening");
    });

    test("settles an absent open outcome as a failed session", { tags: "p1" }, async () => {
        const fixture = setup("absent-open");
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-absent-open"),
            lease
        );
        fixture.provider.openResult = ProviderResourceOutcome.absent;

        const settled = await fixture.controller.openSession(reserved.capability, lease);

        expect(settled.state.name).toBe("failed");
        expect(fixture.store.getSession(reserved.id)?.state.name).toBe("failed");
    });

    test(
        "rejects provider action outcomes whose keys cannot be enumerated",
        { tags: "p0" },
        async () => {
            const fixture = setup("proxy-action-outcome");
            const reserved = fixture.controller.reserveSession(
                environmentId,
                new EnvironmentSessionId("session-proxy-action"),
                lease
            );
            const opened = await fixture.controller.openSession(reserved.capability, lease);
            const hidden: ActionOutcome = { name: "succeeded" };
            fixture.provider.closeOutcomeOverride = new Proxy(hidden, {
                ownKeys() {
                    throw new RangeError("hidden keys");
                }
            });

            await expect(
                fixture.controller.closeSession(opened.capability, lease)
            ).rejects.toEqual(
                expect.objectContaining({
                    code: "operation.invalid-output",
                    message: "Environment provider action outcome is malformed"
                })
            );
            expect(fixture.store.getSession(opened.id)?.state.name).toBe("closing");
        }
    );

    test("codes a missing pinned revision during provider resolution", { tags: "p1" }, async () => {
        const inner = new MemoryEnvironmentStore();
        const masking = new MaskingEnvironmentStore(inner);
        const provider = new TestProvider(descriptor("provider-hidden-revision", "5"));
        const registry = new MemoryEnvironmentProviderRegistry([provider]);
        const verifier: TurnLeaseVerifier = { permits: (candidate) => candidate === lease };
        const controller = new EnvironmentController(masking, registry, verifier);
        controller.provision(initialRevision(provider.descriptor), lease);
        const reserved = controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-hidden-revision"),
            lease
        );
        masking.revisionMask = "hidden";

        await expect(controller.openSession(reserved.capability, lease)).rejects.toEqual(
            expect.objectContaining({
                code: "environment.stale-session",
                message: "Environment resource does not pin an exact provider generation"
            })
        );
        expect(provider.openRequests).toHaveLength(0);
    });

    test(
        "codes a provision conflict when the stored revision record is missing",
        { tags: "p1" },
        () => {
            const inner = new MemoryEnvironmentStore();
            const masking = new MaskingEnvironmentStore(inner);
            const provider = new TestProvider(descriptor("provider-conflict-no-revision", "6"));
            const registry = new MemoryEnvironmentProviderRegistry([provider]);
            const verifier: TurnLeaseVerifier = { permits: (candidate) => candidate === lease };
            const controller = new EnvironmentController(masking, registry, verifier);
            controller.provision(initialRevision(provider.descriptor), lease);
            masking.rejectCas = "environment";
            masking.revisionMask = "hidden";

            expect(() =>
                controller.provision(initialRevision(provider.descriptor), lease)
            ).toThrowError(
                expect.objectContaining({
                    code: "protocol.revision-conflict",
                    message: "Environment was provisioned concurrently"
                })
            );
        }
    );

    test(
        "fails a snapshot whose session is missing, not open, or epoch-drifted at settle time",
        { tags: "p0" },
        async () => {
            const inner = new MemoryEnvironmentStore();
            const masking = new MaskingEnvironmentStore(inner);
            const provider = new TestProvider(descriptor("provider-snapshot-session-guard", "7"));
            const registry = new MemoryEnvironmentProviderRegistry([provider]);
            const verifier: TurnLeaseVerifier = { permits: (candidate) => candidate === lease };
            const controller = new EnvironmentController(masking, registry, verifier);
            controller.provision(initialRevision(provider.descriptor), lease);
            const reserved = controller.reserveSession(
                environmentId,
                new EnvironmentSessionId("session-snapshot-guard"),
                lease
            );
            await controller.openSession(reserved.capability, lease);
            const masks = ["hidden", "failed-state", "epoch-drift"] as const;

            for (const mask of masks) {
                const snapshotId = new EnvironmentSnapshotId(`snapshot-guard-${mask}`);
                const result = new Deferred<ResourceOutcome<ContentRef>>();
                provider.deferredSnapshot = result;
                const pending = controller.snapshot(reserved.capability, snapshotId, lease);
                masking.sessionMask = mask;
                result.resolve(ProviderResourceOutcome.ready(provider.snapshotContent));

                expect((await pending).state.name).toBe("failed");
                expect(inner.getSnapshot(snapshotId)?.state.name).toBe("failed");
                masking.sessionMask = undefined;
                provider.deferredSnapshot = undefined;
            }
        }
    );

    test(
        "tells a replayed provision from the record the store answers with",
        { tags: "p0" },
        () => {
            // sameRevision re-reads the record this controller just wrote, and the memory
            // store refuses a row whose key contradicts its bytes, so every conjunct but
            // the provider is true by construction. Each mask falsifies exactly one.
            for (const mask of ["environment", "revision", "generation"] as const) {
                const inner = new MemoryEnvironmentStore();
                const masking = new MaskingEnvironmentStore(inner);
                const provider = new TestProvider(descriptor(`provider-replay-${mask}`, "c"));
                const registry = new MemoryEnvironmentProviderRegistry([provider]);
                const verifier: TurnLeaseVerifier = { permits: (candidate) => candidate === lease };
                const controller = new EnvironmentController(masking, registry, verifier);
                controller.provision(initialRevision(provider.descriptor), lease);

                // The replayed record matches the head's revision and generation, so the
                // conflict reaches the comparator instead of the head checks above it.
                masking.rejectCas = "environment";
                masking.revisionMask = mask;
                expect(() =>
                    controller.provision(initialRevision(provider.descriptor), lease)
                ).toThrowError(
                    expect.objectContaining({
                        code: "protocol.revision-conflict",
                        message: "Environment was provisioned concurrently"
                    })
                );
            }
        }
    );

    test(
        "tells a replayed reservation from the session the store answers with",
        { tags: "p0" },
        () => {
            const inner = new MemoryEnvironmentStore();
            const masking = new MaskingEnvironmentStore(inner);
            const provider = new TestProvider(descriptor("provider-replay-reservation", "e"));
            const registry = new MemoryEnvironmentProviderRegistry([provider]);
            const verifier: TurnLeaseVerifier = { permits: (candidate) => candidate === lease };
            const controller = new EnvironmentController(masking, registry, verifier);
            controller.provision(initialRevision(provider.descriptor), lease);
            const sessionId = new EnvironmentSessionId("session-replay-generation");
            controller.reserveSession(environmentId, sessionId, lease);

            // Rotation moves a session's environment revision and generation together, so
            // only an answered record leaves the generation as the single difference.
            masking.rejectCas = "session";
            masking.sessionMask = "generation";
            expect(() => controller.reserveSession(environmentId, sessionId, lease)).toThrowError(
                expect.objectContaining({
                    code: "environment.invalid-session",
                    message: "Environment session ID is already reserved for another generation"
                })
            );
        }
    );

    test(
        "tells a replayed snapshot and exposure from the record the store answers with",
        { tags: "p0" },
        async () => {
            // The store pins a stored snapshot and exposure to their session's generation
            // and epoch, so a request replayed against its own session agrees on both by
            // construction. Each mask leaves exactly one of them differing.
            for (const mask of ["generation", "epoch"] as const) {
                const inner = new MemoryEnvironmentStore();
                const masking = new MaskingEnvironmentStore(inner);
                const provider = new TestProvider(descriptor(`provider-replay-pin-${mask}`, "f"));
                const registry = new MemoryEnvironmentProviderRegistry([provider]);
                const verifier: TurnLeaseVerifier = { permits: (candidate) => candidate === lease };
                const controller = new EnvironmentController(masking, registry, verifier);
                controller.provision(initialRevision(provider.descriptor), lease);
                const reserved = controller.reserveSession(
                    environmentId,
                    new EnvironmentSessionId(`session-replay-pin-${mask}`),
                    lease
                );
                await controller.openSession(reserved.capability, lease);

                const snapshotId = new EnvironmentSnapshotId(`snapshot-replay-pin-${mask}`);
                await controller.snapshot(reserved.capability, snapshotId, lease);
                masking.rejectCas = "snapshot";
                masking.snapshotMask = mask;
                await expect(
                    controller.snapshot(reserved.capability, snapshotId, lease)
                ).rejects.toEqual(
                    expect.objectContaining({
                        code: "environment.invalid-session",
                        message:
                            "Environment snapshot ID is already used by another session generation"
                    })
                );

                const exposureId = new PortExposureId(`exposure-replay-pin-${mask}`);
                masking.rejectCas = undefined;
                masking.snapshotMask = undefined;
                await controller.expose(reserved.capability, exposureId, 4173, lease);
                masking.rejectCas = "exposure";
                masking.exposureMask = mask;
                await expect(
                    controller.expose(reserved.capability, exposureId, 4173, lease)
                ).rejects.toEqual(
                    expect.objectContaining({
                        code: "environment.invalid-session",
                        message: "Port exposure ID is already used by another session generation"
                    })
                );
            }
        }
    );
});

class TestProvider extends EnvironmentProvider {
    public readonly openRequests: OpenSessionRequest[] = [];
    public readonly inspectSessionRequests: OpenSessionRequest[] = [];
    public readonly closeRequests: OpenSessionRequest[] = [];
    public readonly exposureRequests: ExposePortRequest[] = [];
    public readonly revokeRequests: ExposePortRequest[] = [];
    public readonly sessions = new Map<string, LiveEnvironmentSession>();
    public readonly snapshots = new Map<string, ContentRef>();
    public readonly exposures = new Map<string, string>();
    public handle: LiveEnvironmentSession = { children: [], release: () => {} };
    public readonly snapshotContent = content("9");
    public readonly exposureUrl = "https://preview.example.test/";
    public readonly closeResults: ActionOutcome[] = [];
    public readonly revokeResults: ActionOutcome[] = [];
    public openResult: ResourceOutcome<LiveEnvironmentSession> | undefined;
    public openOutcomeOverride: ResourceOutcome<LiveEnvironmentSession> | undefined;
    public closeOutcomeOverride: ActionOutcome | undefined;
    public deferredSnapshot: Deferred<ResourceOutcome<ContentRef>> | undefined;
    public deferredExposure: Deferred<ResourceOutcome<string>> | undefined;
    public removeIndeterminateExposure = false;
    public onClose: (() => void) | undefined;

    public constructor(public readonly descriptor: ProviderDescriptor) {
        super();
    }

    public openSession(
        request: OpenSessionRequest
    ): Promise<ResourceOutcome<LiveEnvironmentSession>> {
        this.openRequests.push(request);
        if (this.openOutcomeOverride !== undefined) {
            return Promise.resolve(this.openOutcomeOverride);
        }
        const outcome = this.openResult ?? ProviderResourceOutcome.ready(this.handle);
        if (outcome.name === "ready") this.sessions.set(request.sessionId.value, outcome.value);
        return Promise.resolve(outcome);
    }

    public inspectSession(
        request: OpenSessionRequest
    ): Promise<ResourceOutcome<LiveEnvironmentSession>> {
        this.inspectSessionRequests.push(request);
        const handle = this.sessions.get(request.sessionId.value);
        return Promise.resolve(
            handle === undefined
                ? ProviderResourceOutcome.absent
                : ProviderResourceOutcome.ready(handle)
        );
    }

    public closeSession(request: OpenSessionRequest): Promise<ActionOutcome> {
        this.closeRequests.push(request);
        if (this.closeOutcomeOverride !== undefined) {
            return Promise.resolve(this.closeOutcomeOverride);
        }
        const outcome = this.closeResults.shift() ?? ProviderActionOutcome.succeeded;
        if (outcome.name === "succeeded") this.sessions.delete(request.sessionId.value);
        this.onClose?.();
        return Promise.resolve(outcome);
    }

    public createSnapshot(
        request: SnapshotEnvironmentRequest
    ): Promise<ResourceOutcome<ContentRef>> {
        if (this.deferredSnapshot !== undefined) return this.deferredSnapshot.promise;
        this.snapshots.set(request.snapshotId.value, this.snapshotContent);
        return Promise.resolve(ProviderResourceOutcome.ready(this.snapshotContent));
    }

    public inspectSnapshot(
        request: SnapshotEnvironmentRequest
    ): Promise<ResourceOutcome<ContentRef>> {
        const snapshot = this.snapshots.get(request.snapshotId.value);
        return Promise.resolve(
            snapshot === undefined
                ? ProviderResourceOutcome.absent
                : ProviderResourceOutcome.ready(snapshot)
        );
    }

    public exposePort(request: ExposePortRequest): Promise<ResourceOutcome<string>> {
        this.exposureRequests.push(request);
        if (this.deferredExposure !== undefined) return this.deferredExposure.promise;
        this.exposures.set(request.exposureId.value, this.exposureUrl);
        return Promise.resolve(ProviderResourceOutcome.ready(this.exposureUrl));
    }

    public inspectExposure(request: ExposePortRequest): Promise<ResourceOutcome<string>> {
        const url = this.exposures.get(request.exposureId.value);
        return Promise.resolve(
            url === undefined ? ProviderResourceOutcome.absent : ProviderResourceOutcome.ready(url)
        );
    }

    public revokeExposure(request: ExposePortRequest): Promise<ActionOutcome> {
        this.revokeRequests.push(request);
        const outcome = this.revokeResults.shift() ?? ProviderActionOutcome.succeeded;
        if (outcome.name === "succeeded" || this.removeIndeterminateExposure) {
            this.exposures.delete(request.exposureId.value);
        }
        return Promise.resolve(outcome);
    }
}

/**
 * What one Environment record table answers instead of what it holds.
 *
 * The controller's replay comparators re-read the record its own writer just committed,
 * and MemoryEnvironmentStore refuses to return a row whose key contradicts its bytes, so
 * varying the request cannot falsify their identity conjuncts one at a time. Nothing but
 * a store that accepts every write and then answers the later read with a different
 * record separates those conjuncts from their absence. Every read here is a point read
 * over the inner store, so there is no walk to bound.
 */
class MaskingEnvironmentStore extends EnvironmentStore {
    public rejectCas: "environment" | "session" | "snapshot" | "exposure" | undefined;
    public revisionMask: "hidden" | "generation" | "environment" | "revision" | undefined;
    public sessionMask: "hidden" | "failed-state" | "epoch-drift" | "generation" | undefined;
    public snapshotMask: "content" | "generation" | "epoch" | undefined;
    public exposureMask: "generation" | "epoch" | undefined;

    public constructor(private readonly inner: MemoryEnvironmentStore) {
        super();
    }

    public getEnvironment(id: EnvironmentId): Environment | undefined {
        return this.inner.getEnvironment(id);
    }

    public getRevision(
        id: EnvironmentId,
        revision: Revision
    ): EnvironmentRevisionRecord | undefined {
        if (this.revisionMask === "hidden") return undefined;
        const record = this.inner.getRevision(id, revision);
        if (record === undefined || this.revisionMask === undefined) return record;
        return new EnvironmentRevisionRecord(
            this.revisionMask === "environment"
                ? new EnvironmentId("environment-answered-elsewhere")
                : record.environmentId,
            this.revisionMask === "revision" ? new Revision(4) : record.revision,
            this.revisionMask === "generation" ? record.generation + 1 : record.generation,
            record.provider
        );
    }

    public compareAndSetEnvironment(
        expected: Revision | undefined,
        revision: EnvironmentRevisionRecord,
        environment: Environment
    ): boolean {
        if (this.rejectCas === "environment") return false;
        return this.inner.compareAndSetEnvironment(expected, revision, environment);
    }

    public getSession(id: EnvironmentSessionId): EnvironmentSession | undefined {
        const session = this.inner.getSession(id);
        if (session === undefined || this.sessionMask === undefined) return session;
        if (this.sessionMask === "hidden") return undefined;
        return new EnvironmentSession(
            session.id,
            session.environmentId,
            session.environmentRevision,
            this.sessionMask === "generation" ? session.generation + 1 : session.generation,
            this.sessionMask === "epoch-drift" ? session.epoch + 1 : session.epoch,
            this.sessionMask === "failed-state" ? EnvironmentSessionState.failed : session.state,
            session.restoreFrom,
            session.recordRevision
        );
    }

    public compareAndSetSession(
        expected: Revision | undefined,
        session: EnvironmentSession
    ): boolean {
        if (this.rejectCas === "session") return false;
        return this.inner.compareAndSetSession(expected, session);
    }

    public getSnapshot(id: EnvironmentSnapshotId): EnvironmentSnapshot | undefined {
        const snapshot = this.inner.getSnapshot(id);
        if (snapshot === undefined || this.snapshotMask === undefined) return snapshot;
        return new EnvironmentSnapshot(
            snapshot.id,
            snapshot.environmentId,
            snapshot.sessionId,
            snapshot.environmentRevision,
            this.snapshotMask === "generation" ? snapshot.generation + 1 : snapshot.generation,
            this.snapshotMask === "epoch" ? snapshot.sessionEpoch + 1 : snapshot.sessionEpoch,
            this.snapshotMask === "content" ? EnvironmentSnapshotState.creating : snapshot.state,
            this.snapshotMask === "content" ? undefined : snapshot.content,
            snapshot.recordRevision
        );
    }

    public compareAndSetSnapshot(
        expected: Revision | undefined,
        snapshot: EnvironmentSnapshot
    ): boolean {
        if (this.rejectCas === "snapshot") return false;
        return this.inner.compareAndSetSnapshot(expected, snapshot);
    }

    public getExposure(id: PortExposureId): PortExposure | undefined {
        const exposure = this.inner.getExposure(id);
        if (exposure === undefined || this.exposureMask === undefined) return exposure;
        return new PortExposure(
            exposure.id,
            exposure.environmentId,
            exposure.sessionId,
            exposure.environmentRevision,
            this.exposureMask === "generation" ? exposure.generation + 1 : exposure.generation,
            this.exposureMask === "epoch" ? exposure.sessionEpoch + 1 : exposure.sessionEpoch,
            exposure.port,
            exposure.state,
            exposure.url,
            exposure.recordRevision
        );
    }

    public listExposures(sessionId: EnvironmentSessionId): readonly PortExposure[] {
        return this.inner.listExposures(sessionId);
    }

    public compareAndSetExposure(expected: Revision | undefined, exposure: PortExposure): boolean {
        if (this.rejectCas === "exposure") return false;
        return this.inner.compareAndSetExposure(expected, exposure);
    }
}

class RejectingEnvironmentStore extends MemoryEnvironmentStore {
    public rejectEnvironment = false;
    public rejectSession = false;
    public rejectSnapshot = false;
    public rejectExposure = false;

    public override compareAndSetEnvironment(
        expected: Revision | undefined,
        revision: EnvironmentRevisionRecord,
        environment: Environment
    ): boolean {
        if (this.rejectEnvironment) return false;
        return super.compareAndSetEnvironment(expected, revision, environment);
    }

    public override compareAndSetSession(
        expected: Revision | undefined,
        session: EnvironmentSession
    ): boolean {
        if (this.rejectSession) return false;
        return super.compareAndSetSession(expected, session);
    }

    public override compareAndSetSnapshot(
        expected: Revision | undefined,
        snapshot: EnvironmentSnapshot
    ): boolean {
        if (this.rejectSnapshot) return false;
        return super.compareAndSetSnapshot(expected, snapshot);
    }

    public override compareAndSetExposure(
        expected: Revision | undefined,
        exposure: PortExposure
    ): boolean {
        if (this.rejectExposure) return false;
        return super.compareAndSetExposure(expected, exposure);
    }
}

class HeadOverrideEnvironmentStore extends MemoryEnvironmentStore {
    public headOverride: Environment | undefined;

    public override getEnvironment(id: EnvironmentId): Environment | undefined {
        return this.headOverride ?? super.getEnvironment(id);
    }
}

class Deferred<Value> {
    public readonly promise: Promise<Value>;
    public readonly resolve: (value: Value) => void;

    public constructor() {
        let resolver: (value: Value) => void = () => {};
        this.promise = new Promise((resolve) => {
            resolver = resolve;
        });
        this.resolve = resolver;
    }
}

function setup(label: string): {
    readonly store: MemoryEnvironmentStore;
    readonly registry: MemoryEnvironmentProviderRegistry;
    readonly verifier: TurnLeaseVerifier;
    readonly controller: EnvironmentController;
    readonly provider: TestProvider;
} {
    const provider = new TestProvider(descriptor(`provider-${label}`, "0"));
    const store = new MemoryEnvironmentStore();
    const registry = new MemoryEnvironmentProviderRegistry([provider]);
    const verifier: TurnLeaseVerifier = { permits: (candidate) => candidate === lease };
    const controller = new EnvironmentController(store, registry, verifier);
    controller.provision(initialRevision(provider.descriptor), lease);
    return { store, registry, verifier, controller, provider };
}

function initialRevision(provider: ProviderDescriptor): EnvironmentRevisionRecord {
    return new EnvironmentRevisionRecord(environmentId, Revision.initial(), 0, provider);
}

function descriptor(id: string, digestCharacter: string): ProviderDescriptor {
    return new ProviderDescriptor(new ProviderId(id), "1", content(digestCharacter));
}

function content(character: string): ContentRef {
    return new ContentRef(`sha256:${character.repeat(64)}`);
}
