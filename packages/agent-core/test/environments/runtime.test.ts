import { describe, expect, test } from "vitest";
import { TurnId, type LeaseToken, type TurnLeaseVerifier } from "../../src/agents";
import { ContentRef, Revision } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import {
    Environment,
    EnvironmentController,
    EnvironmentId,
    EnvironmentProvider,
    EnvironmentRevisionRecord,
    EnvironmentSession,
    EnvironmentSessionCapability,
    EnvironmentSessionId,
    EnvironmentSnapshotId,
    EnvironmentSnapshot,
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
import { PrincipalId } from "../../src/identity";

const environmentId = new EnvironmentId("environment-runtime");
const lease: LeaseToken = Object.freeze({
    turn: new TurnId("turn-environment-runtime"),
    holder: new PrincipalId("lease-not-durable"),
    epoch: 7
});

describe("EnvironmentController", () => {
    test("codes invalid operation inputs", async () => {
        const provider = new TestProvider(descriptor("provider-invalid-input", "0"));
        const store = new MemoryEnvironmentStore();
        const controller = new EnvironmentController(
            store,
            new MemoryEnvironmentProviderRegistry([provider]),
            { permits: (candidate) => candidate === lease }
        );
        expect(() =>
            controller.provision(
                new EnvironmentRevisionRecord(
                    environmentId,
                    new Revision(1),
                    1,
                    provider.descriptor
                ),
                lease
            )
        ).toThrow(
            new AgentCoreError(
                "operation.invalid-input",
                "Initial Environment revision and generation must both be zero"
            )
        );

        controller.provision(initialRevision(provider.descriptor), lease);
        const reserved = controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-invalid-port"),
            lease
        );
        await controller.openSession(reserved.capability, lease);
        await expect(
            controller.expose(
                reserved.capability,
                new PortExposureId("exposure-invalid-port"),
                0,
                lease
            )
        ).rejects.toEqual(
            new AgentCoreError(
                "operation.invalid-input",
                "Port exposure port must be between 1 and 65535"
            )
        );
    });

    test("[C13-ENVIRONMENT-ROTATION] rotates future sessions without retargeting an open session", async () => {
        const first = new TestProvider(descriptor("provider-first", "a"));
        const second = new TestProvider(descriptor("provider-second", "b"));
        const fixture = setup([first, second]);
        const oldSession = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-old-generation"),
            lease
        );
        await fixture.controller.openSession(oldSession.capability, lease);

        const rotated = fixture.controller.rotate(environmentId, second.descriptor, lease);
        const newSession = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-new-generation"),
            lease
        );
        await fixture.controller.openSession(newSession.capability, lease);

        expect(rotated.activeRevision.value).toBe(1);
        expect(
            first.openRequests.map((request) => [
                request.environmentRevision.value,
                request.generation
            ])
        ).toEqual([[0, 0]]);
        expect(
            second.openRequests.map((request) => [
                request.environmentRevision.value,
                request.generation
            ])
        ).toEqual([[1, 1]]);
        expect(fixture.controller.session(oldSession.capability).generation).toBe(0);
    });

    test("[C13-ENVIRONMENT-DISPOSE-CLOSE] fences close before child disposal and rejects stale capabilities", async () => {
        const events: string[] = [];
        const provider = new TestProvider(descriptor("provider-close", "c"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-close"),
            lease
        );
        provider.handle = {
            marker: "live-handle-not-durable",
            children: [
                {
                    dispose: () => {
                        const fenced = fixture.store.getSession(reserved.id);
                        expect(fenced?.state.name).toBe("closing");
                        expect(fenced?.epoch).toBe(1);
                        events.push("child-disposed");
                    }
                }
            ],
            release: () => {
                events.push("handle-released");
            }
        };
        provider.openResult = ProviderResourceOutcome.ready(provider.handle);
        provider.onClose = () => events.push("provider-closed");
        await fixture.controller.openSession(reserved.capability, lease);

        const closed = await fixture.controller.closeSession(reserved.capability, lease);

        expect(closed.state.name).toBe("closed");
        expect(events).toEqual(["child-disposed", "handle-released", "provider-closed"]);
        expect(() => fixture.controller.session(reserved.capability)).toThrow(
            new AgentCoreError(
                "environment.stale-session",
                "Environment session capability is stale or belongs to another session"
            )
        );
        expect(() =>
            fixture.controller.session(
                new EnvironmentSessionCapability(
                    environmentId,
                    reserved.id,
                    reserved.environmentRevision,
                    closed.epoch
                )
            )
        ).toThrow(
            new AgentCoreError("environment.closed-session", "Environment session is closed")
        );

        const durableText = fixture.store
            .exportImage()
            .rows.map((row) => new TextDecoder().decode(row.bytes))
            .join("\n");
        expect(durableText).not.toContain("live-handle-not-durable");
        expect(durableText).not.toContain(lease.holder.value);
    });

    test("keeps the exact Turn lease as an injected verifier seam", () => {
        const provider = new TestProvider(descriptor("provider-lease", "d"));
        const seen: LeaseToken[] = [];
        const verifier: TurnLeaseVerifier = {
            permits(candidate) {
                seen.push(candidate);
                return candidate === lease;
            }
        };
        const store = new MemoryEnvironmentStore();
        const controller = new EnvironmentController(
            store,
            new MemoryEnvironmentProviderRegistry([provider]),
            verifier
        );
        controller.provision(initialRevision(provider.descriptor), lease);
        const copied = { ...lease };

        expect(() =>
            controller.reserveSession(
                environmentId,
                new EnvironmentSessionId("session-copied-lease"),
                copied
            )
        ).toThrow(
            new AgentCoreError(
                "lease.invalid",
                "Environment operation requires a live exact-Turn lease"
            )
        );
        expect(seen[0]).toBe(lease);
        expect(seen[1]).toBe(copied);
    });

    test("[P11-ENVIRONMENT-OPEN] reconciles an indeterminate open after controller restart", async () => {
        const provider = new TestProvider(descriptor("provider-restart", "e"));
        provider.openResult = ProviderResourceOutcome.indeterminate;
        provider.materializeIndeterminateOpen = true;
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-restart"),
            lease
        );

        const opening = await fixture.controller.openSession(reserved.capability, lease);
        const restarted = new EnvironmentController(
            fixture.store,
            fixture.registry,
            fixture.verifier
        );
        const reconciled = await restarted.reconcileSession(reserved.id, lease);

        expect(opening.state.name).toBe("opening");
        expect(reconciled.state.name).toBe("open");
        expect(provider.openRequests).toHaveLength(1);
        expect(provider.inspectSessionRequests).toHaveLength(1);
    });

    test("coalesces concurrent open calls into one provider operation", async () => {
        const provider = new TestProvider(descriptor("provider-coalesced-open", "7"));
        const deferred = new Deferred<ResourceOutcome<LiveEnvironmentSession>>();
        provider.deferredOpen = deferred;
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-coalesced-open"),
            lease
        );

        const first = fixture.controller.openSession(reserved.capability, lease);
        const second = fixture.controller.openSession(reserved.capability, lease);
        await Promise.resolve();
        expect(provider.openRequests).toHaveLength(1);

        provider.sessions.set(reserved.id.value, provider.handle);
        deferred.resolve(ProviderResourceOutcome.ready(provider.handle));
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult.state.name).toBe("open");
        expect(secondResult.state.name).toBe("open");
        expect(provider.closeRequests).toHaveLength(0);
    });

    test("does not clean up a winning provider session when a stale ready result arrives", async () => {
        const provider = new TestProvider(descriptor("provider-stale-ready", "6"));
        const winnerDeferred = new Deferred<ResourceOutcome<LiveEnvironmentSession>>();
        const staleDeferred = new Deferred<ResourceOutcome<LiveEnvironmentSession>>();
        provider.deferredOpens.push(winnerDeferred, staleDeferred);
        const fixture = setup([provider]);
        const competingController = new EnvironmentController(
            fixture.store,
            fixture.registry,
            fixture.verifier
        );
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-stale-ready"),
            lease
        );
        let winnerDisposals = 0;
        let staleDisposals = 0;
        let winnerReleases = 0;
        let staleReleases = 0;
        const winner = {
            children: [
                {
                    dispose: () => {
                        winnerDisposals += 1;
                    }
                }
            ],
            release: () => {
                winnerReleases += 1;
            }
        };
        const stale = {
            children: [
                {
                    dispose: () => {
                        staleDisposals += 1;
                    }
                }
            ],
            release: () => {
                staleReleases += 1;
            }
        };

        const winningOpen = fixture.controller.openSession(reserved.capability, lease);
        const staleOpen = competingController.openSession(reserved.capability, lease);
        await Promise.resolve();
        await Promise.resolve();
        expect(provider.openRequests).toHaveLength(2);

        provider.sessions.set(reserved.id.value, winner);
        winnerDeferred.resolve(ProviderResourceOutcome.ready(winner));
        expect((await winningOpen).state.name).toBe("open");
        staleDeferred.resolve(ProviderResourceOutcome.ready(stale));
        expect((await staleOpen).state.name).toBe("open");

        expect(provider.sessions.get(reserved.id.value)).toBe(winner);
        expect(provider.closeRequests).toHaveLength(0);
        expect(winnerDisposals).toBe(0);
        expect(winnerReleases).toBe(0);
        expect(staleDisposals).toBe(1);
        expect(staleReleases).toBe(1);
    });

    test("[P11-ENVIRONMENT-CLOSE] reconciles an indeterminate close after controller restart", async () => {
        const provider = new TestProvider(descriptor("provider-close-restart", "8"));
        provider.closeResults.push(
            ProviderActionOutcome.indeterminate,
            ProviderActionOutcome.succeeded
        );
        provider.materializeIndeterminateClose = true;
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-close-restart"),
            lease
        );
        await fixture.controller.openSession(reserved.capability, lease);

        const closing = await fixture.controller.closeSession(reserved.capability, lease);
        const restarted = new EnvironmentController(
            fixture.store,
            fixture.registry,
            fixture.verifier
        );
        const closed = await restarted.reconcileSession(reserved.id, lease);

        expect(closing.state.name).toBe("closing");
        expect(closed.state.name).toBe("closed");
        expect(provider.closeRequests).toHaveLength(2);
    });

    test("keeps close fenced until every exposure revocation reconciles", async () => {
        const provider = new TestProvider(descriptor("provider-close-exposure", "5"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-close-exposure"),
            lease
        );
        await fixture.controller.openSession(reserved.capability, lease);
        const exposureId = new PortExposureId("exposure-close-restart");
        await fixture.controller.expose(reserved.capability, exposureId, 4173, lease);
        provider.revokeResults.push(
            ProviderActionOutcome.indeterminate,
            ProviderActionOutcome.indeterminate,
            ProviderActionOutcome.succeeded
        );

        const closing = await fixture.controller.closeSession(reserved.capability, lease);
        const restarted = new EnvironmentController(
            fixture.store,
            fixture.registry,
            fixture.verifier
        );
        const stillClosing = await restarted.reconcileSession(reserved.id, lease);

        expect(closing.state.name).toBe("closing");
        expect(stillClosing.state.name).toBe("closing");
        expect(fixture.store.getExposure(exposureId)?.state.name).toBe("revoking");
        expect(provider.closeRequests).toHaveLength(0);

        const closed = await restarted.reconcileSession(reserved.id, lease);
        expect(closed.state.name).toBe("closed");
        expect(fixture.store.getExposure(exposureId)?.state.name).toBe("revoked");
        expect(provider.closeRequests).toHaveLength(1);
    });

    test("[P11-ENVIRONMENT-DISPOSE] cleans up an open callback that arrives after close", async () => {
        const provider = new TestProvider(descriptor("provider-late-open", "f"));
        const deferred = new Deferred<ResourceOutcome<LiveEnvironmentSession>>();
        provider.deferredOpen = deferred;
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-late-open"),
            lease
        );
        let disposals = 0;
        let releases = 0;
        const handle = {
            children: [
                {
                    dispose: () => {
                        disposals += 1;
                    }
                }
            ],
            release: () => {
                releases += 1;
            }
        };

        const opening = fixture.controller.openSession(reserved.capability, lease);
        await fixture.controller.closeSession(reserved.capability, lease);
        provider.sessions.set(reserved.id.value, handle);
        deferred.resolve(ProviderResourceOutcome.ready(handle));
        const settled = await opening;

        expect(settled.state.name).toBe("closed");
        expect(disposals).toBe(1);
        expect(releases).toBe(1);
        expect(provider.closeRequests).toHaveLength(2);
        expect(provider.sessions.has(reserved.id.value)).toBe(false);
    });

    test("reconciles snapshots and exposures and restores from exact content", async () => {
        const provider = new TestProvider(descriptor("provider-resources", "1"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-resources"),
            lease
        );
        await fixture.controller.openSession(reserved.capability, lease);

        provider.snapshotResult = ProviderResourceOutcome.indeterminate;
        provider.materializeIndeterminateSnapshot = true;
        const snapshotId = new EnvironmentSnapshotId("snapshot-runtime");
        const creating = await fixture.controller.snapshot(reserved.capability, snapshotId, lease);
        const ready = await fixture.controller.reconcileSnapshot(snapshotId, lease);

        provider.exposureResult = ProviderResourceOutcome.indeterminate;
        provider.materializeIndeterminateExposure = true;
        const exposureId = new PortExposureId("exposure-runtime");
        const exposing = await fixture.controller.expose(
            reserved.capability,
            exposureId,
            4173,
            lease
        );
        const exposed = await fixture.controller.reconcileExposure(exposureId, lease);
        provider.revokeResults.push(
            ProviderActionOutcome.indeterminate,
            ProviderActionOutcome.succeeded
        );
        provider.removeIndeterminateExposure = true;
        const revoking = await fixture.controller.revoke(reserved.capability, exposureId, lease);
        const revoked = await fixture.controller.reconcileExposure(exposureId, lease);

        const restored = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-restored"),
            lease,
            snapshotId
        );
        provider.openResult = ProviderResourceOutcome.ready(provider.handle);
        await fixture.controller.openSession(restored.capability, lease);

        expect(creating.state.name).toBe("creating");
        expect(ready.state.name).toBe("ready");
        expect(ready.content?.equals(provider.snapshotContent)).toBe(true);
        expect(exposing.state.name).toBe("exposing");
        expect(exposed.url).toBe(provider.exposureUrl);
        expect(revoking.state.name).toBe("revoking");
        expect(revoked.state.name).toBe("revoked");
        expect(provider.openRequests.at(-1)?.restore?.equals(provider.snapshotContent)).toBe(true);
    });

    test("revokes a late exposure callback instead of resurrecting it", async () => {
        const provider = new TestProvider(descriptor("provider-late-exposure", "2"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-late-exposure"),
            lease
        );
        await fixture.controller.openSession(reserved.capability, lease);
        const deferred = new Deferred<ResourceOutcome<string>>();
        provider.deferredExposure = deferred;
        provider.revokeResult = ProviderActionOutcome.indeterminate;
        const exposureId = new PortExposureId("exposure-late");

        const exposing = fixture.controller.expose(reserved.capability, exposureId, 8080, lease);
        const revoked = await fixture.controller.revoke(reserved.capability, exposureId, lease);
        provider.exposures.set(exposureId.value, provider.exposureUrl);
        deferred.resolve(ProviderResourceOutcome.ready(provider.exposureUrl));
        const settled = await exposing;

        expect(revoked.state.name).toBe("revoking");
        expect(settled.state.name).toBe("revoking");
        expect(provider.revokeRequests).toHaveLength(2);
        expect(provider.exposures.has(exposureId.value)).toBe(true);

        provider.revokeResult = ProviderActionOutcome.succeeded;
        const reconciled = await fixture.controller.reconcileExposure(exposureId, lease);
        expect(reconciled.state.name).toBe("revoked");
        expect(provider.exposures.has(exposureId.value)).toBe(false);
    });

    test("keeps provider failures recoverable without inventing successful resources", async () => {
        const provider = new TestProvider(descriptor("provider-failures", "3"));
        const fixture = setup([provider]);
        const failedOpen = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-provider-throw"),
            lease
        );
        provider.throwOpen = true;
        expect(
            (await fixture.controller.openSession(failedOpen.capability, lease)).state.name
        ).toBe("opening");
        provider.throwOpen = false;
        provider.openResult = ProviderResourceOutcome.failed;
        expect((await fixture.controller.reconcileSession(failedOpen.id, lease)).state.name).toBe(
            "failed"
        );

        const session = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-resource-failures"),
            lease
        );
        provider.openResult = ProviderResourceOutcome.ready(provider.handle);
        const opened = await fixture.controller.openSession(session.capability, lease);
        provider.snapshotResult = ProviderResourceOutcome.failed;
        const failedSnapshot = await fixture.controller.snapshot(
            opened.capability,
            new EnvironmentSnapshotId("snapshot-failed"),
            lease
        );
        expect(failedSnapshot.state.name).toBe("failed");
        expect(
            (await fixture.controller.reconcileSnapshot(failedSnapshot.id, lease)).state.name
        ).toBe("failed");

        provider.exposureResult = ProviderResourceOutcome.failed;
        const failedExposure = await fixture.controller.expose(
            opened.capability,
            new PortExposureId("exposure-failed"),
            8080,
            lease
        );
        expect(failedExposure.state.name).toBe("failed");
        expect(
            (await fixture.controller.reconcileExposure(failedExposure.id, lease)).state.name
        ).toBe("failed");

        provider.exposureResult = ProviderResourceOutcome.ready(provider.exposureUrl);
        const exposure = await fixture.controller.expose(
            opened.capability,
            new PortExposureId("exposure-revoke-throw"),
            8081,
            lease
        );
        provider.throwRevoke = true;
        expect(
            (await fixture.controller.revoke(opened.capability, exposure.id, lease)).state.name
        ).toBe("revoking");
        expect((await fixture.controller.reconcileExposure(exposure.id, lease)).state.name).toBe(
            "revoking"
        );
        provider.throwRevoke = false;
        expect((await fixture.controller.reconcileExposure(exposure.id, lease)).state.name).toBe(
            "revoked"
        );
    });

    test("rejects malformed resource outcomes from every provider resource operation", async () => {
        const provider = new TestProvider(descriptor("provider-malformed-resources", "e"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-malformed-resources"),
            lease
        );
        const invalidOutput = new AgentCoreError(
            "operation.invalid-output",
            "Environment provider resource outcome is malformed"
        );

        provider.openOutcomeOverride = malformedResource({});
        await expect(fixture.controller.openSession(reserved.capability, lease)).rejects.toEqual(
            invalidOutput
        );
        provider.openOutcomeOverride = undefined;
        const opened = await fixture.controller.openSession(reserved.capability, lease);

        provider.inspectSessionOutcomeOverride = malformedResource({ name: "ready" });
        await expect(fixture.controller.reconcileSession(opened.id, lease)).rejects.toEqual(
            invalidOutput
        );
        provider.inspectSessionOutcomeOverride = undefined;

        provider.snapshotOutcomeOverride = malformedResource({
            name: "ready",
            value: "not-content"
        });
        await expect(
            fixture.controller.snapshot(
                opened.capability,
                new EnvironmentSnapshotId("snapshot-malformed-create"),
                lease
            )
        ).rejects.toEqual(invalidOutput);
        provider.snapshotOutcomeOverride = undefined;
        provider.snapshotResult = ProviderResourceOutcome.indeterminate;
        const creatingSnapshot = await fixture.controller.snapshot(
            opened.capability,
            new EnvironmentSnapshotId("snapshot-malformed-inspect"),
            lease
        );
        provider.inspectSnapshotOutcomeOverride = malformedResource({
            name: "absent",
            value: undefined
        });
        await expect(
            fixture.controller.reconcileSnapshot(creatingSnapshot.id, lease)
        ).rejects.toEqual(invalidOutput);
        provider.inspectSnapshotOutcomeOverride = undefined;

        provider.exposureOutcomeOverride = malformedResource({ name: "ready", value: 4173 });
        await expect(
            fixture.controller.expose(
                opened.capability,
                new PortExposureId("exposure-malformed-create"),
                4173,
                lease
            )
        ).rejects.toEqual(invalidOutput);
        provider.exposureOutcomeOverride = undefined;
        provider.exposureResult = ProviderResourceOutcome.indeterminate;
        const exposing = await fixture.controller.expose(
            opened.capability,
            new PortExposureId("exposure-malformed-inspect"),
            4174,
            lease
        );
        provider.inspectExposureOutcomeOverride = malformedResource({ name: "unknown" });
        await expect(fixture.controller.reconcileExposure(exposing.id, lease)).rejects.toEqual(
            invalidOutput
        );
    });

    test("rejects non-object outcomes and malformed ready session handles", async () => {
        const provider = new TestProvider(descriptor("provider-malformed-handles", "7"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-malformed-handles"),
            lease
        );
        const invalidResource = new AgentCoreError(
            "operation.invalid-output",
            "Environment provider resource outcome is malformed"
        );

        provider.openOutcomeOverride = malformedResource(null);
        await expect(fixture.controller.openSession(reserved.capability, lease)).rejects.toEqual(
            invalidResource
        );
        for (const handle of [
            { children: {}, release() {} },
            { children: [{}], release() {} },
            { children: [], release: "not-a-function" }
        ]) {
            provider.openOutcomeOverride = malformedResource({ name: "ready", value: handle });
            await expect(
                fixture.controller.openSession(reserved.capability, lease)
            ).rejects.toEqual(invalidResource);
        }
    });

    test("rejects malformed provider action outcomes from exposure revoke and session close", async () => {
        const provider = new TestProvider(descriptor("provider-malformed-actions", "f"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-malformed-actions"),
            lease
        );
        const opened = await fixture.controller.openSession(reserved.capability, lease);
        const exposure = await fixture.controller.expose(
            opened.capability,
            new PortExposureId("exposure-malformed-revoke"),
            4173,
            lease
        );
        const invalidOutput = new AgentCoreError(
            "operation.invalid-output",
            "Environment provider action outcome is malformed"
        );

        provider.revokeOutcomeOverride = malformedAction({ name: "succeeded", extra: true });
        await expect(
            fixture.controller.revoke(opened.capability, exposure.id, lease)
        ).rejects.toEqual(invalidOutput);
        expect(fixture.store.getExposure(exposure.id)?.state.name).toBe("revoking");
        provider.revokeOutcomeOverride = undefined;
        expect((await fixture.controller.reconcileExposure(exposure.id, lease)).state.name).toBe(
            "revoked"
        );

        provider.closeOutcomeOverride = malformedAction({ name: "absent" });
        await expect(fixture.controller.closeSession(opened.capability, lease)).rejects.toEqual(
            invalidOutput
        );
        expect(fixture.store.getSession(opened.id)?.state.name).toBe("closing");

        const nullProvider = new TestProvider(descriptor("provider-null-action", "8"));
        const nullFixture = setup([nullProvider]);
        const nullReserved = nullFixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-null-action"),
            lease
        );
        const nullOpened = await nullFixture.controller.openSession(nullReserved.capability, lease);
        nullProvider.closeOutcomeOverride = malformedAction(null);
        await expect(
            nullFixture.controller.closeSession(nullOpened.capability, lease)
        ).rejects.toEqual(invalidOutput);
    });

    test("rejects absent pinned providers before any provider operation", async () => {
        const provider = new TestProvider(descriptor("provider-unregistered", "4"));
        const fixture = setup([provider]);
        const controller = new EnvironmentController(
            fixture.store,
            new MemoryEnvironmentProviderRegistry([]),
            fixture.verifier
        );
        const reserved = controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-provider-unregistered"),
            lease
        );

        await expect(controller.openSession(reserved.capability, lease)).rejects.toEqual(
            new AgentCoreError(
                "environment.invalid-session",
                "No provider is registered for the pinned Environment revision"
            )
        );
        expect(fixture.store.getSession(reserved.id)?.state.name).toBe("reserved");
        expect(provider.openRequests).toHaveLength(0);
    });

    test("never normalizes missing providers during resource and cleanup operations", async () => {
        const provider = new TestProvider(descriptor("provider-missing-operations", "d"));
        const fixture = setup([provider]);
        const first = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-missing-operations"),
            lease
        );
        const opened = await fixture.controller.openSession(first.capability, lease);
        const exposure = await fixture.controller.expose(
            opened.capability,
            new PortExposureId("exposure-missing-operations"),
            8080,
            lease
        );
        const missing = new EnvironmentController(
            fixture.store,
            new MemoryEnvironmentProviderRegistry([]),
            fixture.verifier
        );
        const error = new AgentCoreError(
            "environment.invalid-session",
            "No provider is registered for the pinned Environment revision"
        );

        await expect(missing.reconcileSession(opened.id, lease)).rejects.toEqual(error);
        const snapshotId = new EnvironmentSnapshotId("snapshot-missing-provider");
        await expect(missing.snapshot(opened.capability, snapshotId, lease)).rejects.toEqual(error);
        expect(fixture.store.getSnapshot(snapshotId)).toBeUndefined();
        const exposureId = new PortExposureId("exposure-missing-provider");
        await expect(missing.expose(opened.capability, exposureId, 8081, lease)).rejects.toEqual(
            error
        );
        expect(fixture.store.getExposure(exposureId)).toBeUndefined();
        await expect(missing.revoke(opened.capability, exposure.id, lease)).rejects.toEqual(error);
        expect(fixture.store.getExposure(exposure.id)?.state.name).toBe("exposed");

        const second = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-missing-close-provider"),
            lease
        );
        const secondOpened = await fixture.controller.openSession(second.capability, lease);
        await expect(missing.closeSession(secondOpened.capability, lease)).rejects.toEqual(error);
        expect(fixture.store.getSession(second.id)?.state.name).toBe("closing");
    });

    test("replays identical reservations and rejects IDs reused across generations", async () => {
        const first = new TestProvider(descriptor("provider-replay-first", "a"));
        const second = new TestProvider(descriptor("provider-replay-second", "b"));
        const fixture = setup([first, second]);
        expect(
            fixture.controller.provision(initialRevision(first.descriptor), lease).generation
        ).toBe(0);
        expect(() =>
            fixture.controller.provision(initialRevision(second.descriptor), lease)
        ).toThrow(
            new AgentCoreError(
                "protocol.revision-conflict",
                "Environment was provisioned concurrently"
            )
        );
        expect(
            fixture.store
                .getRevision(environmentId, Revision.initial())
                ?.provider.equals(first.descriptor)
        ).toBe(true);

        const sessionId = new EnvironmentSessionId("session-replayed");
        const reserved = fixture.controller.reserveSession(environmentId, sessionId, lease);
        expect(
            fixture.controller.reserveSession(environmentId, sessionId, lease).capability
        ).toEqual(reserved.capability);
        await fixture.controller.openSession(reserved.capability, lease);
        fixture.controller.rotate(environmentId, second.descriptor, lease);
        expect(() => fixture.controller.reserveSession(environmentId, sessionId, lease)).toThrow(
            new AgentCoreError(
                "environment.invalid-session",
                "Environment session ID is already reserved for another generation"
            )
        );

        const other = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-replayed-other"),
            lease
        );
        await fixture.controller.openSession(other.capability, lease);
        const snapshotId = new EnvironmentSnapshotId("snapshot-replayed");
        const snapshot = await fixture.controller.snapshot(other.capability, snapshotId, lease);
        expect(
            (await fixture.controller.snapshot(other.capability, snapshotId, lease)).content
        ).toEqual(snapshot.content);
        await expect(
            fixture.controller.snapshot(reserved.capability, snapshotId, lease)
        ).rejects.toEqual(
            new AgentCoreError(
                "environment.invalid-session",
                "Environment snapshot ID is already used by another session generation"
            )
        );

        const exposureId = new PortExposureId("exposure-replayed");
        const exposure = await fixture.controller.expose(other.capability, exposureId, 4173, lease);
        expect(
            (await fixture.controller.expose(other.capability, exposureId, 4173, lease)).url
        ).toBe(exposure.url);
        await expect(
            fixture.controller.expose(other.capability, exposureId, 4174, lease)
        ).rejects.toEqual(
            new AgentCoreError(
                "environment.invalid-session",
                "Port exposure ID is already used by another session generation"
            )
        );
    });

    test("requires an exact ProviderDescriptor for provision replay", () => {
        const first = descriptor("provider-exact-replay", "1");
        const changes = [
            descriptor("provider-other-id", "1"),
            new ProviderDescriptor(first.id, "2", first.configuration),
            new ProviderDescriptor(first.id, first.version, content("2"))
        ];

        for (const changed of changes) {
            const store = new MemoryEnvironmentStore();
            const controller = new EnvironmentController(
                store,
                new MemoryEnvironmentProviderRegistry([]),
                { permits: (candidate) => candidate === lease }
            );
            expect(controller.provision(initialRevision(first), lease).generation).toBe(0);
            expect(() => controller.provision(initialRevision(changed), lease)).toThrow(
                new AgentCoreError(
                    "protocol.revision-conflict",
                    "Environment was provisioned concurrently"
                )
            );
        }
    });

    test("retries provider-absent resources and replays terminal operations", async () => {
        const provider = new TestProvider(descriptor("provider-absent-retry", "a"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-absent-retry"),
            lease
        );
        provider.openResult = ProviderResourceOutcome.indeterminate;
        expect((await fixture.controller.openSession(reserved.capability, lease)).state.name).toBe(
            "opening"
        );
        provider.openResult = ProviderResourceOutcome.ready(provider.handle);
        const opened = await fixture.controller.reconcileSession(reserved.id, lease);
        expect(opened.state.name).toBe("open");
        expect((await fixture.controller.openSession(opened.capability, lease)).state.name).toBe(
            "open"
        );

        provider.snapshotResult = ProviderResourceOutcome.indeterminate;
        const snapshotId = new EnvironmentSnapshotId("snapshot-absent-retry");
        expect(
            (await fixture.controller.snapshot(opened.capability, snapshotId, lease)).state.name
        ).toBe("creating");
        provider.snapshotResult = ProviderResourceOutcome.ready(provider.snapshotContent);
        expect((await fixture.controller.reconcileSnapshot(snapshotId, lease)).state.name).toBe(
            "ready"
        );
        expect((await fixture.controller.reconcileSnapshot(snapshotId, lease)).state.name).toBe(
            "ready"
        );

        provider.exposureResult = ProviderResourceOutcome.indeterminate;
        const exposureId = new PortExposureId("exposure-absent-retry");
        expect(
            (await fixture.controller.expose(opened.capability, exposureId, 4173, lease)).state.name
        ).toBe("exposing");
        provider.exposureResult = ProviderResourceOutcome.ready(provider.exposureUrl);
        expect((await fixture.controller.reconcileExposure(exposureId, lease)).state.name).toBe(
            "exposed"
        );
        expect((await fixture.controller.reconcileExposure(exposureId, lease)).state.name).toBe(
            "exposed"
        );

        provider.closeResults.push(ProviderActionOutcome.failed, ProviderActionOutcome.succeeded);
        expect((await fixture.controller.closeSession(opened.capability, lease)).state.name).toBe(
            "closing"
        );
        const closed = await fixture.controller.reconcileSession(opened.id, lease);
        expect(closed.state.name).toBe("closed");
        expect((await fixture.controller.closeSession(opened.capability, lease)).state.name).toBe(
            "closed"
        );
    });

    test("codes missing resources and cross-session revocation", async () => {
        const provider = new TestProvider(descriptor("provider-missing-resources", "b"));
        const fixture = setup([provider]);
        const missingEnvironment = new EnvironmentId("environment-missing");
        expect(() =>
            fixture.controller.reserveSession(
                missingEnvironment,
                new EnvironmentSessionId("session-missing-environment"),
                lease
            )
        ).toThrowError(expect.objectContaining({ code: "environment.invalid-session" }));
        await expect(
            fixture.controller.reconcileSession(new EnvironmentSessionId("session-missing"), lease)
        ).rejects.toMatchObject({ code: "environment.invalid-session" });
        await expect(
            fixture.controller.reconcileSnapshot(
                new EnvironmentSnapshotId("snapshot-missing"),
                lease
            )
        ).rejects.toMatchObject({ code: "environment.invalid-session" });
        await expect(
            fixture.controller.reconcileExposure(new PortExposureId("exposure-missing"), lease)
        ).rejects.toMatchObject({ code: "environment.invalid-session" });

        const first = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-revoke-first"),
            lease
        );
        const second = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-revoke-second"),
            lease
        );
        await fixture.controller.openSession(first.capability, lease);
        await fixture.controller.openSession(second.capability, lease);
        const exposure = await fixture.controller.expose(
            first.capability,
            new PortExposureId("exposure-cross-session"),
            8080,
            lease
        );
        await expect(
            fixture.controller.revoke(second.capability, exposure.id, lease)
        ).rejects.toMatchObject({ code: "environment.stale-session" });
    });

    test("[P11-ENVIRONMENT-USE] rehydrates open provider handles after restart without reopening", async () => {
        const provider = new TestProvider(descriptor("provider-rehydrate-open", "c"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-rehydrate-open"),
            lease
        );
        const opened = await fixture.controller.openSession(reserved.capability, lease);
        const restarted = new EnvironmentController(
            fixture.store,
            fixture.registry,
            fixture.verifier
        );
        expect((await restarted.reconcileSession(opened.id, lease)).state.name).toBe("open");
        expect(provider.inspectSessionRequests).toHaveLength(1);

        provider.sessions.delete(opened.id.value);
        const anotherRestart = new EnvironmentController(
            fixture.store,
            fixture.registry,
            fixture.verifier
        );
        const lost = await anotherRestart.reconcileSession(opened.id, lease);
        expect(lost.state.name).toBe("lost");
        expect(lost.epoch).toBe(opened.epoch + 1);
        expect(fixture.store.getSession(opened.id)?.state.name).toBe("lost");
        expect(() => anotherRestart.session(opened.capability)).toThrow(
            new AgentCoreError(
                "environment.stale-session",
                "Environment session capability is stale or belongs to another session"
            )
        );
        expect(() => anotherRestart.session(lost.capability)).toThrow(
            new AgentCoreError(
                "environment.stale-session",
                "Environment session provider resource was lost"
            )
        );
        expect(provider.openRequests).toHaveLength(1);
    });

    test("[C13-ENVIRONMENT-STALE-SESSION] detects provider loss despite a cached handle and releases it fail-closed", async () => {
        const provider = new TestProvider(descriptor("provider-cached-loss", "0"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-cached-loss"),
            lease
        );
        let childDisposals = 0;
        let releases = 0;
        provider.handle = {
            children: [
                {
                    dispose: () => {
                        expect(fixture.store.getSession(reserved.id)?.state.name).toBe("lost");
                        childDisposals += 1;
                    }
                }
            ],
            release: () => {
                expect(fixture.store.getSession(reserved.id)?.state.name).toBe("lost");
                releases += 1;
            }
        };
        provider.openResult = ProviderResourceOutcome.ready(provider.handle);
        const opened = await fixture.controller.openSession(reserved.capability, lease);
        provider.sessions.delete(opened.id.value);

        const lost = await fixture.controller.reconcileSession(opened.id, lease);

        expect(provider.inspectSessionRequests).toHaveLength(1);
        expect(lost.state.name).toBe("lost");
        expect(lost.epoch).toBe(opened.epoch + 1);
        expect(childDisposals).toBe(1);
        expect(releases).toBe(1);
        expect(fixture.store.getSession(opened.id)?.state.name).toBe("lost");
    });

    test("[P11-ENVIRONMENT-STALE] settles provider callbacks against the latest close fence", async () => {
        const provider = new TestProvider(descriptor("provider-close-races", "1"));
        const fixture = setup([provider]);
        const closingReservation = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-ready-while-closing"),
            lease
        );
        const ready = new Deferred<ResourceOutcome<LiveEnvironmentSession>>();
        provider.deferredOpen = ready;
        provider.closeResults.push(ProviderActionOutcome.indeterminate);
        const opening = fixture.controller.openSession(closingReservation.capability, lease);
        const closing = await fixture.controller.closeSession(closingReservation.capability, lease);
        expect(closing.state.name).toBe("closing");
        provider.sessions.set(closing.id.value, provider.handle);
        ready.resolve(ProviderResourceOutcome.ready(provider.handle));
        expect((await opening).state.name).toBe("closed");

        provider.deferredOpen = undefined;
        const failedReservation = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-failed-after-close"),
            lease
        );
        const failed = new Deferred<ResourceOutcome<LiveEnvironmentSession>>();
        provider.deferredOpen = failed;
        const failingOpen = fixture.controller.openSession(failedReservation.capability, lease);
        expect(
            (await fixture.controller.closeSession(failedReservation.capability, lease)).state.name
        ).toBe("closed");
        failed.resolve(ProviderResourceOutcome.failed);
        expect((await failingOpen).state.name).toBe("closed");
    });

    test("revokes a late ready exposure and disposes a replaced live provider handle", async () => {
        const provider = new TestProvider(descriptor("provider-late-cleanup", "2"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-late-cleanup"),
            lease
        );
        let replacedReleases = 0;
        provider.handle = {
            children: [],
            release: () => {
                replacedReleases += 1;
            }
        };
        provider.openResult = ProviderResourceOutcome.ready(provider.handle);
        const opened = await fixture.controller.openSession(reserved.capability, lease);
        const replacement = { children: [], release() {} };
        provider.sessions.set(opened.id.value, replacement);
        await fixture.controller.reconcileSession(opened.id, lease);
        await Promise.resolve();
        expect(replacedReleases).toBe(1);

        const exposureId = new PortExposureId("exposure-late-successful-cleanup");
        const deferredExposure = new Deferred<ResourceOutcome<string>>();
        provider.deferredExposure = deferredExposure;
        provider.revokeResults.push(
            ProviderActionOutcome.indeterminate,
            ProviderActionOutcome.succeeded
        );
        const exposing = fixture.controller.expose(opened.capability, exposureId, 8080, lease);
        expect(
            (await fixture.controller.revoke(opened.capability, exposureId, lease)).state.name
        ).toBe("revoking");
        provider.exposures.set(exposureId.value, provider.exposureUrl);
        deferredExposure.resolve(ProviderResourceOutcome.ready(provider.exposureUrl));
        expect((await exposing).state.name).toBe("revoked");
        expect(provider.exposures.has(exposureId.value)).toBe(false);
        expect(
            (await fixture.controller.revoke(opened.capability, exposureId, lease)).state.name
        ).toBe("revoked");
    });

    test("[P11-ENVIRONMENT-ROTATION] surfaces rotation and resource CAS loss without reporting provider success", async () => {
        const provider = new TestProvider(descriptor("provider-cas-loss", "3"));
        const store = new RejectingEnvironmentStore();
        const registry = new MemoryEnvironmentProviderRegistry([provider]);
        const controller = new EnvironmentController(store, registry, {
            permits: (candidate) => candidate === lease
        });
        controller.provision(initialRevision(provider.descriptor), lease);
        store.rejectEnvironment = true;
        expect(() => controller.rotate(environmentId, provider.descriptor, lease)).toThrowError(
            expect.objectContaining({ code: "protocol.revision-conflict" })
        );

        const reserved = controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-cas-loss"),
            lease
        );
        store.rejectSession = true;
        await expect(controller.openSession(reserved.capability, lease)).rejects.toMatchObject({
            code: "protocol.revision-conflict"
        });
        expect(provider.openRequests).toEqual([]);

        store.rejectSession = false;
        const opened = await controller.openSession(reserved.capability, lease);
        const snapshotResult = new Deferred<ResourceOutcome<ContentRef>>();
        provider.deferredSnapshot = snapshotResult;
        const snapshot = controller.snapshot(
            opened.capability,
            new EnvironmentSnapshotId("snapshot-cas-loss"),
            lease
        );
        await Promise.resolve();
        store.rejectSnapshot = true;
        snapshotResult.resolve(ProviderResourceOutcome.ready(provider.snapshotContent));
        await expect(snapshot).rejects.toMatchObject({ code: "protocol.revision-conflict" });

        const exposureResult = new Deferred<ResourceOutcome<string>>();
        provider.deferredExposure = exposureResult;
        const exposure = controller.expose(
            opened.capability,
            new PortExposureId("exposure-cas-loss"),
            8080,
            lease
        );
        await Promise.resolve();
        store.rejectExposure = true;
        exposureResult.resolve(ProviderResourceOutcome.ready(provider.exposureUrl));
        await expect(exposure).rejects.toMatchObject({ code: "protocol.revision-conflict" });
    });

    test("pins restore reservations to one exact snapshot and fails closed on missing generations", async () => {
        const provider = new TestProvider(descriptor("provider-restore-pins", "4"));
        const fixture = setup([provider]);
        const source = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-restore-source"),
            lease
        );
        const opened = await fixture.controller.openSession(source.capability, lease);
        const first = await fixture.controller.snapshot(
            opened.capability,
            new EnvironmentSnapshotId("snapshot-restore-first"),
            lease
        );
        const second = await fixture.controller.snapshot(
            opened.capability,
            new EnvironmentSnapshotId("snapshot-restore-second"),
            lease
        );
        const restoredId = new EnvironmentSessionId("session-restore-pinned");
        const restored = fixture.controller.reserveSession(
            environmentId,
            restoredId,
            lease,
            first.id
        );
        expect(
            fixture.controller.reserveSession(environmentId, restoredId, lease, first.id)
                .restoreFrom
        ).toEqual(first.id);
        expect(() =>
            fixture.controller.reserveSession(environmentId, restoredId, lease, second.id)
        ).toThrowError(expect.objectContaining({ code: "environment.invalid-session" }));

        const missingRevision = new MissingRevisionEnvironmentStore(fixture.store.exportImage());
        missingRevision.hideRevisions = true;
        const restarted = new EnvironmentController(
            missingRevision,
            fixture.registry,
            fixture.verifier
        );
        await expect(restarted.openSession(restored.capability, lease)).rejects.toMatchObject({
            code: "environment.stale-session"
        });
    });

    test("keeps thrown provider close errors indeterminate and restart-reconcilable", async () => {
        const provider = new TestProvider(descriptor("provider-close-throw", "5"));
        const fixture = setup([provider]);
        const reserved = fixture.controller.reserveSession(
            environmentId,
            new EnvironmentSessionId("session-close-throw"),
            lease
        );
        const opened = await fixture.controller.openSession(reserved.capability, lease);
        provider.throwClose = true;
        expect((await fixture.controller.closeSession(opened.capability, lease)).state.name).toBe(
            "closing"
        );
        provider.throwClose = false;
        const restarted = new EnvironmentController(
            fixture.store,
            fixture.registry,
            fixture.verifier
        );
        expect((await restarted.reconcileSession(opened.id, lease)).state.name).toBe("closed");
    });
});

class TestProvider extends EnvironmentProvider {
    public readonly openRequests: OpenSessionRequest[] = [];
    public readonly inspectSessionRequests: OpenSessionRequest[] = [];
    public readonly closeRequests: OpenSessionRequest[] = [];
    public readonly snapshotRequests: SnapshotEnvironmentRequest[] = [];
    public readonly exposureRequests: ExposePortRequest[] = [];
    public readonly revokeRequests: ExposePortRequest[] = [];
    public readonly sessions = new Map<string, LiveEnvironmentSession>();
    public readonly snapshots = new Map<string, ContentRef>();
    public readonly exposures = new Map<string, string>();
    public handle: LiveEnvironmentSession & { readonly marker?: string } = {
        children: [],
        release: () => {}
    };
    public readonly snapshotContent = content("9");
    public readonly exposureUrl = "https://preview.example.test/";
    public readonly closeResults: ActionOutcome[] = [];
    public readonly revokeResults: ActionOutcome[] = [];
    public openResult: ResourceOutcome<LiveEnvironmentSession> = ProviderResourceOutcome.ready(
        this.handle
    );
    public snapshotResult: ResourceOutcome<ContentRef> = ProviderResourceOutcome.ready(
        this.snapshotContent
    );
    public exposureResult: ResourceOutcome<string> = ProviderResourceOutcome.ready(
        this.exposureUrl
    );
    public revokeResult: ActionOutcome = ProviderActionOutcome.succeeded;
    public materializeIndeterminateOpen = false;
    public materializeIndeterminateSnapshot = false;
    public materializeIndeterminateExposure = false;
    public materializeIndeterminateClose = false;
    public removeIndeterminateExposure = false;
    public deferredOpen: Deferred<ResourceOutcome<LiveEnvironmentSession>> | undefined;
    public readonly deferredOpens: Deferred<ResourceOutcome<LiveEnvironmentSession>>[] = [];
    public deferredSnapshot: Deferred<ResourceOutcome<ContentRef>> | undefined;
    public deferredExposure: Deferred<ResourceOutcome<string>> | undefined;
    public onClose: (() => void) | undefined;
    public throwOpen = false;
    public throwClose = false;
    public throwRevoke = false;
    public openOutcomeOverride: ResourceOutcome<LiveEnvironmentSession> | undefined;
    public inspectSessionOutcomeOverride: ResourceOutcome<LiveEnvironmentSession> | undefined;
    public closeOutcomeOverride: ActionOutcome | undefined;
    public snapshotOutcomeOverride: ResourceOutcome<ContentRef> | undefined;
    public inspectSnapshotOutcomeOverride: ResourceOutcome<ContentRef> | undefined;
    public exposureOutcomeOverride: ResourceOutcome<string> | undefined;
    public inspectExposureOutcomeOverride: ResourceOutcome<string> | undefined;
    public revokeOutcomeOverride: ActionOutcome | undefined;

    public constructor(public readonly descriptor: ProviderDescriptor) {
        super();
    }

    public async openSession(
        request: OpenSessionRequest
    ): Promise<ResourceOutcome<LiveEnvironmentSession>> {
        this.openRequests.push(request);
        if (this.throwOpen) throw new TypeError("Injected open failure");
        const deferred = this.deferredOpens.shift() ?? this.deferredOpen;
        if (deferred !== undefined) return deferred.promise;
        if (this.openOutcomeOverride !== undefined) return this.openOutcomeOverride;
        if (this.openResult.name === "ready")
            this.sessions.set(request.sessionId.value, this.openResult.value);
        if (this.openResult.name === "indeterminate" && this.materializeIndeterminateOpen) {
            this.sessions.set(request.sessionId.value, this.handle);
        }
        return this.openResult;
    }

    public inspectSession(
        request: OpenSessionRequest
    ): Promise<ResourceOutcome<LiveEnvironmentSession>> {
        this.inspectSessionRequests.push(request);
        if (this.inspectSessionOutcomeOverride !== undefined) {
            return Promise.resolve(this.inspectSessionOutcomeOverride);
        }
        const handle = this.sessions.get(request.sessionId.value);
        return Promise.resolve(
            handle === undefined
                ? ProviderResourceOutcome.absent
                : ProviderResourceOutcome.ready(handle)
        );
    }

    public closeSession(request: OpenSessionRequest): Promise<ActionOutcome> {
        this.closeRequests.push(request);
        if (this.throwClose) throw new TypeError("Injected close failure");
        if (this.closeOutcomeOverride !== undefined)
            return Promise.resolve(this.closeOutcomeOverride);
        const outcome = this.closeResults.shift() ?? ProviderActionOutcome.succeeded;
        if (outcome.name === "succeeded" || this.materializeIndeterminateClose) {
            this.sessions.delete(request.sessionId.value);
        }
        this.onClose?.();
        return Promise.resolve(outcome);
    }

    public createSnapshot(
        request: SnapshotEnvironmentRequest
    ): Promise<ResourceOutcome<ContentRef>> {
        this.snapshotRequests.push(request);
        if (this.deferredSnapshot !== undefined) return this.deferredSnapshot.promise;
        if (this.snapshotOutcomeOverride !== undefined)
            return Promise.resolve(this.snapshotOutcomeOverride);
        if (this.snapshotResult.name === "ready") {
            this.snapshots.set(request.snapshotId.value, this.snapshotResult.value);
        }
        if (this.snapshotResult.name === "indeterminate" && this.materializeIndeterminateSnapshot) {
            this.snapshots.set(request.snapshotId.value, this.snapshotContent);
        }
        return Promise.resolve(this.snapshotResult);
    }

    public inspectSnapshot(
        request: SnapshotEnvironmentRequest
    ): Promise<ResourceOutcome<ContentRef>> {
        if (this.inspectSnapshotOutcomeOverride !== undefined) {
            return Promise.resolve(this.inspectSnapshotOutcomeOverride);
        }
        const snapshot = this.snapshots.get(request.snapshotId.value);
        return Promise.resolve(
            snapshot === undefined
                ? ProviderResourceOutcome.absent
                : ProviderResourceOutcome.ready(snapshot)
        );
    }

    public async exposePort(request: ExposePortRequest): Promise<ResourceOutcome<string>> {
        this.exposureRequests.push(request);
        if (this.deferredExposure !== undefined) return this.deferredExposure.promise;
        if (this.exposureOutcomeOverride !== undefined) return this.exposureOutcomeOverride;
        if (this.exposureResult.name === "ready") {
            this.exposures.set(request.exposureId.value, this.exposureResult.value);
        }
        if (this.exposureResult.name === "indeterminate" && this.materializeIndeterminateExposure) {
            this.exposures.set(request.exposureId.value, this.exposureUrl);
        }
        return this.exposureResult;
    }

    public inspectExposure(request: ExposePortRequest): Promise<ResourceOutcome<string>> {
        if (this.inspectExposureOutcomeOverride !== undefined) {
            return Promise.resolve(this.inspectExposureOutcomeOverride);
        }
        const url = this.exposures.get(request.exposureId.value);
        return Promise.resolve(
            url === undefined ? ProviderResourceOutcome.absent : ProviderResourceOutcome.ready(url)
        );
    }

    public revokeExposure(request: ExposePortRequest): Promise<ActionOutcome> {
        this.revokeRequests.push(request);
        if (this.throwRevoke) throw new TypeError("Injected revoke failure");
        if (this.revokeOutcomeOverride !== undefined)
            return Promise.resolve(this.revokeOutcomeOverride);
        const outcome = this.revokeResults.shift() ?? this.revokeResult;
        if (outcome.name === "succeeded" || this.removeIndeterminateExposure) {
            this.exposures.delete(request.exposureId.value);
        }
        return Promise.resolve(outcome);
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

class MissingRevisionEnvironmentStore extends MemoryEnvironmentStore {
    public hideRevisions = false;

    public override getRevision(
        id: EnvironmentId,
        revision: Revision
    ): EnvironmentRevisionRecord | undefined {
        return this.hideRevisions ? undefined : super.getRevision(id, revision);
    }
}

class Deferred<Value> {
    public readonly promise: Promise<Value>;
    public resolve!: (value: Value) => void;

    public constructor() {
        this.promise = new Promise((resolve) => {
            this.resolve = resolve;
        });
    }
}

function setup(providers: readonly TestProvider[]): {
    readonly store: MemoryEnvironmentStore;
    readonly registry: MemoryEnvironmentProviderRegistry;
    readonly verifier: TurnLeaseVerifier;
    readonly controller: EnvironmentController;
} {
    const store = new MemoryEnvironmentStore();
    const registry = new MemoryEnvironmentProviderRegistry(providers);
    const verifier: TurnLeaseVerifier = { permits: (candidate) => candidate === lease };
    const controller = new EnvironmentController(store, registry, verifier);
    controller.provision(initialRevision(providers[0]!.descriptor), lease);
    return { store, registry, verifier, controller };
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

function malformedResource<Value>(value: unknown): ResourceOutcome<Value> {
    return value as ResourceOutcome<Value>;
}

function malformedAction(value: unknown): ActionOutcome {
    return value as ActionOutcome;
}
