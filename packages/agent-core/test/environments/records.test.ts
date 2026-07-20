import { describe, expect, test } from "vitest";
import {
    ContentRef,
    Revision,
    SecretRef,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue,
    type RecordEnvelope
} from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import {
    Environment,
    EnvironmentCredentialIsolationProxy,
    EnvironmentCredentialProxyCapability,
    EnvironmentId,
    EnvironmentRevisionRecord,
    EnvironmentSession,
    EnvironmentSessionCapability,
    EnvironmentSessionId,
    EnvironmentSessionState,
    EnvironmentSnapshot,
    EnvironmentSnapshotId,
    EnvironmentSnapshotState,
    MemoryEnvironmentStore,
    PortExposure,
    PortExposureId,
    PortExposureState,
    ProviderDescriptor,
    ProviderId
} from "../../src/environments";

const environmentId = new EnvironmentId("environment-records");
const sessionId = new EnvironmentSessionId("session-records");
const snapshotId = new EnvironmentSnapshotId("snapshot-records");
const exposureId = new PortExposureId("exposure-records");
const configuration = content("a");
const provider = new ProviderDescriptor(new ProviderId("provider-records"), "1", configuration);
const revisionRecord = new EnvironmentRevisionRecord(
    environmentId,
    Revision.initial(),
    0,
    provider
);
const environment = new Environment(environmentId, Revision.initial(), 0, Revision.initial());
const session = new EnvironmentSession(
    sessionId,
    environmentId,
    Revision.initial(),
    0,
    0,
    EnvironmentSessionState.open,
    undefined,
    Revision.initial()
);
const snapshot = new EnvironmentSnapshot(
    snapshotId,
    environmentId,
    sessionId,
    Revision.initial(),
    0,
    0,
    EnvironmentSnapshotState.ready,
    content("b"),
    Revision.initial()
);
const exposure = new PortExposure(
    exposureId,
    environmentId,
    sessionId,
    Revision.initial(),
    0,
    0,
    4173,
    PortExposureState.exposed,
    "https://preview.example.test/",
    Revision.initial()
);

describe("Environment records", () => {
    test("keeps snapshot and exposure identifiers nominally distinct", () => {
        expect(snapshotId.equals(new EnvironmentSnapshotId(snapshotId.value))).toBe(true);
        expect(snapshotId.equals(new PortExposureId(snapshotId.value))).toBe(false);
        expect(exposureId.equals(new EnvironmentSessionId(exposureId.value))).toBe(false);
    });

    test("[environment.head] [environment.revision] [environment.port-exposure] [environment.session] [environment.snapshot] round-trips every immutable record through RecordCodec 1.0", () => {
        const records = [
            [Environment, environment],
            [EnvironmentRevisionRecord, revisionRecord],
            [EnvironmentSession, session],
            [EnvironmentSnapshot, snapshot],
            [PortExposure, exposure]
        ] as const;

        for (const [recordClass, record] of records) {
            const bytes = recordClass.encode(record as never);
            const decoded = recordClass.decode(bytes);
            const envelope = decodeCanonicalJson(bytes) as JsonValue & RecordEnvelope;

            expect(envelope.version).toEqual({ major: 1, minor: 0 });
            expect(recordClass.encode(decoded as never)).toEqual(bytes);
            expect(Object.isFrozen(decoded)).toBe(true);
        }
    });

    test("rejects an unknown major for every Environment record", () => {
        const records = [
            [Environment, environment],
            [EnvironmentRevisionRecord, revisionRecord],
            [EnvironmentSession, session],
            [EnvironmentSnapshot, snapshot],
            [PortExposure, exposure]
        ] as const;

        for (const [recordClass, record] of records) {
            const envelope = decodeCanonicalJson(recordClass.encode(record as never)) as JsonValue &
                RecordEnvelope;
            const unknownMajor = encodeCanonicalJson({
                kind: envelope.kind,
                version: { major: 2, minor: 0 },
                payload: envelope.payload
            });
            expect(() => recordClass.decode(unknownMajor)).toThrow(
                new AgentCoreError(
                    "codec.unknown-major",
                    `Unsupported ${envelope.kind} codec major 2`
                )
            );
        }
    });

    test("carries lifecycle behavior and rejects illegal transitions", () => {
        const reserved = new EnvironmentSession(
            sessionId,
            environmentId,
            Revision.initial(),
            0,
            0,
            EnvironmentSessionState.reserved,
            undefined,
            Revision.initial()
        );
        const opening = reserved.beginOpen();
        const opened = opening.opened();
        const lost = opened.lost();
        const closing = opened.beginClose();
        const closed = closing.closed();

        expect(opening.state.name).toBe("opening");
        expect(opened.state.name).toBe("open");
        expect(lost.state.name).toBe("lost");
        expect(lost.epoch).toBe(1);
        expect(() => lost.assertUsable()).toThrow(
            new AgentCoreError(
                "environment.stale-session",
                "Environment session provider resource was lost"
            )
        );
        expect(closing.epoch).toBe(1);
        expect(closed.state.name).toBe("closed");
        expect(() => closed.assertUsable()).toThrow(
            new AgentCoreError("environment.closed-session", "Environment session is closed")
        );
        expect(() => closed.beginOpen()).toThrow(AgentCoreError);
        expect(() => snapshot.fail()).toThrow(AgentCoreError);
        expect(() => exposure.exposed("https://other.example.test/")).not.toThrow();
        expect(() => exposure.revoked()).toThrow(AgentCoreError);
    });

    test("makes every terminal lifecycle transition idempotent and every illegal transition fail", () => {
        const reserved = sessionIn(EnvironmentSessionState.reserved);
        const opening = reserved.beginOpen();
        const opened = opening.opened();
        const lost = opened.lost();
        const failed = opening.failOpen();
        const closing = opened.beginClose();
        const closed = closing.closed();

        expect(opening.beginOpen()).toBe(opening);
        expect(opened.beginOpen()).toBe(opened);
        expect(opened.opened()).toBe(opened);
        expect(lost.lost()).toBe(lost);
        expect(lost.beginClose().state.name).toBe("closing");
        expect(failed.failOpen()).toBe(failed);
        expect(closing.beginClose()).toBe(closing);
        expect(closed.beginClose()).toBe(closed);
        expect(closed.closed()).toBe(closed);
        expect(() => reserved.opened()).toThrow(AgentCoreError);
        expect(() => reserved.failOpen()).toThrow(AgentCoreError);
        expect(() => failed.beginOpen()).toThrow(AgentCoreError);
        expect(() => opened.failOpen()).toThrow(AgentCoreError);
        expect(() => failed.closed()).toThrow(AgentCoreError);
        expect(() => opening.assertUsable()).toThrow(AgentCoreError);
        expect(() => failed.assertUsable()).toThrow(AgentCoreError);

        const creatingSnapshot = snapshotIn(EnvironmentSnapshotState.creating);
        const readySnapshot = creatingSnapshot.ready(content("d"));
        const failedSnapshot = creatingSnapshot.fail();
        expect(readySnapshot.ready(readySnapshot.content!)).toBe(readySnapshot);
        expect(failedSnapshot.fail()).toBe(failedSnapshot);
        expect(() => readySnapshot.fail()).toThrow(AgentCoreError);
        expect(() => failedSnapshot.ready(content("e"))).toThrow(AgentCoreError);

        const exposing = exposureIn(PortExposureState.exposing);
        const exposed = exposing.exposed("https://preview.example.test/");
        const failedExposure = exposing.fail();
        const revoking = exposed.beginRevoke();
        const revoked = revoking.revoked();
        expect(exposed.exposed(exposed.url!)).toBe(exposed);
        expect(failedExposure.fail()).toBe(failedExposure);
        expect(revoking.beginRevoke()).toBe(revoking);
        expect(revoked.beginRevoke()).toBe(revoked);
        expect(revoked.revoked()).toBe(revoked);
        expect(() => exposed.fail()).toThrow(AgentCoreError);
        expect(() => failedExposure.exposed("https://preview.example.test/")).toThrow(
            AgentCoreError
        );
        expect(() => failedExposure.revoked()).toThrow(AgentCoreError);
        expect(() => revoked.exposed("https://preview.example.test/")).toThrow(AgentCoreError);
    });

    test("rejects malformed codec payloads instead of constructing impossible durable states", () => {
        expectInvalidPayload(Environment, environment, null);
        expectInvalidPayload(Environment, environment, { id: environmentId.value });
        expectInvalidPayload(Environment, environment, {
            id: environmentId.value,
            activeRevision: -1,
            generation: 0,
            recordRevision: 0
        });
        expectInvalidPayload(EnvironmentRevisionRecord, revisionRecord, {
            environmentId: environmentId.value,
            revision: 0,
            generation: 0,
            provider: { id: provider.id.value, version: "", configuration: configuration.value }
        });
        expectInvalidPayload(EnvironmentSession, session, {
            id: session.id.value,
            environmentId: environmentId.value,
            environmentRevision: 0,
            generation: 0,
            epoch: 0,
            state: "unknown",
            restoreFrom: null,
            recordRevision: 0
        });
        expectInvalidPayload(EnvironmentSnapshot, snapshot, {
            id: snapshot.id.value,
            environmentId: environmentId.value,
            sessionId: session.id.value,
            environmentRevision: 0,
            generation: 0,
            state: "failed",
            content: content("f").value,
            recordRevision: 0
        });
        expectInvalidPayload(PortExposure, exposure, {
            id: exposure.id.value,
            environmentId: environmentId.value,
            sessionId: session.id.value,
            environmentRevision: 0,
            generation: 0,
            sessionEpoch: 0,
            port: 0,
            state: "exposed",
            url: "not a URL",
            recordRevision: 0
        });
    });

    test("rejects exhausted counters and invalid record invariants", () => {
        const exhausted = new Environment(
            environmentId,
            Revision.initial(),
            Number.MAX_SAFE_INTEGER,
            Revision.initial()
        );
        expect(() =>
            exhausted.rotate(
                new EnvironmentRevisionRecord(
                    environmentId,
                    new Revision(1),
                    Number.MAX_SAFE_INTEGER,
                    provider
                )
            )
        ).toThrow(
            new AgentCoreError("protocol.invalid-state", "Environment generation is exhausted")
        );
        expect(
            () => new Environment(environmentId, Revision.initial(), -1, Revision.initial())
        ).toThrow(TypeError);
        expect(
            () => new EnvironmentRevisionRecord(environmentId, Revision.initial(), -1, provider)
        ).toThrow(TypeError);
        expect(
            () => new EnvironmentSessionCapability(environmentId, sessionId, Revision.initial(), -1)
        ).toThrow(TypeError);
        expect(() => sessionIn(EnvironmentSessionState.open, -1)).toThrow(TypeError);
        expect(
            () =>
                new EnvironmentCredentialProxyCapability(
                    session.capability,
                    -1,
                    new SecretRef("vault", "credential-provider", "invalid-generation")
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new EnvironmentSnapshot(
                    snapshotId,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    0,
                    0,
                    EnvironmentSnapshotState.ready,
                    undefined,
                    Revision.initial()
                )
        ).toThrow(TypeError);
        expect(() =>
            exposureIn(PortExposureState.exposing, "https://preview.example.test/")
        ).toThrow(TypeError);
        expect(() => exposureWithUrl("relative")).toThrow(TypeError);
        expect(() => new ProviderDescriptor(provider.id, " ", configuration)).toThrow(TypeError);
    });

    test("requires branded values for every record and capability field", () => {
        const invalid = {} as never;
        const credential = new SecretRef("vault", "credential-provider", "strict-shape");
        const actions = [
            () => new ProviderDescriptor(invalid, "1", configuration),
            () => new ProviderDescriptor(provider.id, invalid, configuration),
            () => new ProviderDescriptor(provider.id, "1", invalid),
            () => new Environment(invalid, Revision.initial(), 0, Revision.initial()),
            () => new Environment(environmentId, invalid, 0, Revision.initial()),
            () => new Environment(environmentId, Revision.initial(), 0, invalid),
            () => new EnvironmentRevisionRecord(invalid, Revision.initial(), 0, provider),
            () => new EnvironmentRevisionRecord(environmentId, invalid, 0, provider),
            () => new EnvironmentRevisionRecord(environmentId, Revision.initial(), 0, invalid),
            () => new EnvironmentSessionCapability(invalid, sessionId, Revision.initial(), 0),
            () => new EnvironmentSessionCapability(environmentId, invalid, Revision.initial(), 0),
            () => new EnvironmentSessionCapability(environmentId, sessionId, invalid, 0),
            () => new EnvironmentCredentialProxyCapability(invalid, 0, credential),
            () => new EnvironmentCredentialProxyCapability(session.capability, 0, invalid),
            () =>
                new EnvironmentSession(
                    invalid,
                    environmentId,
                    Revision.initial(),
                    0,
                    0,
                    EnvironmentSessionState.open,
                    undefined,
                    Revision.initial()
                ),
            () =>
                new EnvironmentSession(
                    sessionId,
                    invalid,
                    Revision.initial(),
                    0,
                    0,
                    EnvironmentSessionState.open,
                    undefined,
                    Revision.initial()
                ),
            () =>
                new EnvironmentSession(
                    sessionId,
                    environmentId,
                    invalid,
                    0,
                    0,
                    EnvironmentSessionState.open,
                    undefined,
                    Revision.initial()
                ),
            () =>
                new EnvironmentSession(
                    sessionId,
                    environmentId,
                    Revision.initial(),
                    0,
                    0,
                    invalid,
                    undefined,
                    Revision.initial()
                ),
            () =>
                new EnvironmentSession(
                    sessionId,
                    environmentId,
                    Revision.initial(),
                    0,
                    0,
                    EnvironmentSessionState.open,
                    invalid,
                    Revision.initial()
                ),
            () =>
                new EnvironmentSession(
                    sessionId,
                    environmentId,
                    Revision.initial(),
                    0,
                    0,
                    EnvironmentSessionState.open,
                    undefined,
                    invalid
                ),
            () =>
                new EnvironmentSnapshot(
                    invalid,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    0,
                    0,
                    EnvironmentSnapshotState.ready,
                    configuration,
                    Revision.initial()
                ),
            () =>
                new EnvironmentSnapshot(
                    snapshotId,
                    invalid,
                    sessionId,
                    Revision.initial(),
                    0,
                    0,
                    EnvironmentSnapshotState.ready,
                    configuration,
                    Revision.initial()
                ),
            () =>
                new EnvironmentSnapshot(
                    snapshotId,
                    environmentId,
                    invalid,
                    Revision.initial(),
                    0,
                    0,
                    EnvironmentSnapshotState.ready,
                    configuration,
                    Revision.initial()
                ),
            () =>
                new EnvironmentSnapshot(
                    snapshotId,
                    environmentId,
                    sessionId,
                    invalid,
                    0,
                    0,
                    EnvironmentSnapshotState.ready,
                    configuration,
                    Revision.initial()
                ),
            () =>
                new EnvironmentSnapshot(
                    snapshotId,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    0,
                    0,
                    invalid,
                    configuration,
                    Revision.initial()
                ),
            () =>
                new EnvironmentSnapshot(
                    snapshotId,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    0,
                    0,
                    EnvironmentSnapshotState.ready,
                    invalid,
                    Revision.initial()
                ),
            () =>
                new EnvironmentSnapshot(
                    snapshotId,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    0,
                    0,
                    EnvironmentSnapshotState.ready,
                    configuration,
                    invalid
                ),
            () =>
                new PortExposure(
                    invalid,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    0,
                    0,
                    4173,
                    PortExposureState.exposed,
                    "https://preview.example.test/",
                    Revision.initial()
                ),
            () =>
                new PortExposure(
                    exposureId,
                    invalid,
                    sessionId,
                    Revision.initial(),
                    0,
                    0,
                    4173,
                    PortExposureState.exposed,
                    "https://preview.example.test/",
                    Revision.initial()
                ),
            () =>
                new PortExposure(
                    exposureId,
                    environmentId,
                    invalid,
                    Revision.initial(),
                    0,
                    0,
                    4173,
                    PortExposureState.exposed,
                    "https://preview.example.test/",
                    Revision.initial()
                ),
            () =>
                new PortExposure(
                    exposureId,
                    environmentId,
                    sessionId,
                    invalid,
                    0,
                    0,
                    4173,
                    PortExposureState.exposed,
                    "https://preview.example.test/",
                    Revision.initial()
                ),
            () =>
                new PortExposure(
                    exposureId,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    0,
                    0,
                    4173,
                    invalid,
                    "https://preview.example.test/",
                    Revision.initial()
                ),
            () =>
                new PortExposure(
                    exposureId,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    0,
                    0,
                    4173,
                    PortExposureState.exposed,
                    invalid,
                    Revision.initial()
                ),
            () =>
                new PortExposure(
                    exposureId,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    0,
                    0,
                    4173,
                    PortExposureState.exposed,
                    "https://preview.example.test/",
                    invalid
                )
        ];

        for (const action of actions) expect(action).toThrow(TypeError);
    });

    test("codes operational transition failures without changing constructor validation", () => {
        expect(() =>
            environment.rotate(
                new EnvironmentRevisionRecord(environmentId, new Revision(1), 2, provider)
            )
        ).toThrow(
            new AgentCoreError(
                "operation.invalid-input",
                "Environment rotation must advance the exact revision and generation"
            )
        );
        expect(() =>
            new Environment(
                environmentId,
                Revision.initial(),
                0,
                new Revision(Number.MAX_SAFE_INTEGER)
            ).rotate(revision(1, 1))
        ).toThrow(
            new AgentCoreError("protocol.invalid-state", "Environment record revision is exhausted")
        );
        expect(() =>
            new EnvironmentSession(
                sessionId,
                environmentId,
                Revision.initial(),
                0,
                Number.MAX_SAFE_INTEGER,
                EnvironmentSessionState.reserved,
                undefined,
                Revision.initial()
            ).beginClose()
        ).toThrow(
            new AgentCoreError("protocol.invalid-state", "Environment session epoch is exhausted")
        );
        expect(() =>
            new EnvironmentSnapshot(
                snapshotId,
                environmentId,
                sessionId,
                Revision.initial(),
                0,
                0,
                EnvironmentSnapshotState.creating,
                undefined,
                new Revision(Number.MAX_SAFE_INTEGER)
            ).fail()
        ).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                "Environment snapshot record revision is exhausted"
            )
        );
        expect(() =>
            new PortExposure(
                exposureId,
                environmentId,
                sessionId,
                Revision.initial(),
                0,
                0,
                4173,
                PortExposureState.exposing,
                undefined,
                Revision.initial()
            ).exposed("relative")
        ).toThrow(
            new AgentCoreError("operation.invalid-output", "Port exposure URL must be absolute")
        );

        expect(
            () => new Environment(environmentId, Revision.initial(), -1, Revision.initial())
        ).toThrow(TypeError);
    });

    test("rejects credential-bearing exposure URLs", () => {
        expect(() => exposureWithUrl("https://user:password@example.test/")).toThrow(TypeError);
        expect(() => exposureWithUrl("https://example.test/?token=secret")).toThrow(TypeError);
        expect(() => exposureWithUrl("https://example.test/#secret")).toThrow(TypeError);
        expect(() => exposureWithUrl("ftp://example.test/resource")).toThrow(TypeError);
    });

    test("validates every counter and decodes every lifecycle state", () => {
        expect(
            () =>
                new EnvironmentSession(
                    sessionId,
                    environmentId,
                    Revision.initial(),
                    0,
                    -1,
                    EnvironmentSessionState.reserved,
                    undefined,
                    Revision.initial()
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new EnvironmentSnapshot(
                    snapshotId,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    -1,
                    0,
                    EnvironmentSnapshotState.creating,
                    undefined,
                    Revision.initial()
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new PortExposure(
                    exposureId,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    -1,
                    0,
                    4173,
                    PortExposureState.exposing,
                    undefined,
                    Revision.initial()
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new PortExposure(
                    exposureId,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    0,
                    -1,
                    4173,
                    PortExposureState.exposing,
                    undefined,
                    Revision.initial()
                )
        ).toThrow(TypeError);

        for (const state of [
            EnvironmentSessionState.reserved,
            EnvironmentSessionState.opening,
            EnvironmentSessionState.open,
            EnvironmentSessionState.lost,
            EnvironmentSessionState.failed,
            EnvironmentSessionState.closing,
            EnvironmentSessionState.closed
        ]) {
            const candidate = sessionIn(state);
            expect(EnvironmentSession.decode(EnvironmentSession.encode(candidate)).state.name).toBe(
                state.name
            );
        }
        for (const state of [
            EnvironmentSnapshotState.creating,
            EnvironmentSnapshotState.ready,
            EnvironmentSnapshotState.failed
        ]) {
            const candidate = snapshotIn(state);
            expect(
                EnvironmentSnapshot.decode(EnvironmentSnapshot.encode(candidate)).state.name
            ).toBe(state.name);
        }
        for (const state of [
            PortExposureState.exposing,
            PortExposureState.exposed,
            PortExposureState.failed,
            PortExposureState.revoking,
            PortExposureState.revoked
        ]) {
            const candidate = exposureIn(
                state,
                state.name === "exposed" || state.name === "revoking"
                    ? "https://preview.example.test/"
                    : undefined
            );
            expect(PortExposure.decode(PortExposure.encode(candidate)).state.name).toBe(state.name);
        }
    });

    test("rejects mistyped required and optional codec fields", () => {
        expectInvalidPayload(Environment, environment, {
            id: 1,
            activeRevision: 0,
            generation: 0,
            recordRevision: 0
        });
        expectInvalidPayload(EnvironmentSession, session, {
            id: session.id.value,
            environmentId: environmentId.value,
            environmentRevision: 0,
            generation: 0,
            epoch: 0,
            state: "open",
            restoreFrom: 1,
            recordRevision: 0
        });
        expectInvalidPayload(EnvironmentSnapshot, snapshot, {
            id: snapshot.id.value,
            environmentId: environmentId.value,
            sessionId: session.id.value,
            environmentRevision: 0,
            generation: 0,
            state: "ready",
            content: 1,
            recordRevision: 0
        });
        expectInvalidPayload(PortExposure, exposure, {
            id: exposure.id.value,
            environmentId: environmentId.value,
            sessionId: session.id.value,
            environmentRevision: 0,
            generation: 0,
            sessionEpoch: 0,
            port: 4173,
            state: "exposed",
            url: 1,
            recordRevision: 0
        });
    });

    test("[P11-ENVIRONMENT-CREDENTIAL-SEAM] credential isolation passes only a bound capability and content references", async () => {
        const credential = new SecretRef("vault", "credential-provider", "environment-token");
        const capability = new EnvironmentCredentialProxyCapability(
            session.capability,
            session.generation,
            credential
        );
        const proxy = new TestCredentialProxy();
        const request = content("c");

        const response = await proxy.forward(capability, request);

        expect(proxy.capability).toBe(capability);
        expect(proxy.request).toBe(request);
        expect(response).toBe(request);
        expect(capability.credential).toBe(credential);
        expect(Object.isFrozen(capability)).toBe(true);
    });
});

describe("MemoryEnvironmentStore", () => {
    test("[environment.head] [environment.revision] [environment.port-exposure] [environment.session] [environment.snapshot] uses codec bytes for equal replay and exact record-revision CAS", () => {
        const store = seededStore();

        expect(store.compareAndSetSession(undefined, session)).toBe(true);
        expect(store.compareAndSetSession(undefined, session)).toBe(true);
        expect(store.compareAndSetSession(new Revision(9), session.beginClose())).toBe(false);
        expect(store.compareAndSetSession(session.recordRevision, session.beginClose())).toBe(true);
        expect(store.getSession(sessionId)?.state.name).toBe("closing");
    });

    test("rejects records that do not pin the exact stored generation", () => {
        const store = seededStore();
        const unpinned = new EnvironmentSession(
            sessionId,
            environmentId,
            Revision.initial(),
            1,
            0,
            EnvironmentSessionState.reserved,
            undefined,
            Revision.initial()
        );

        expect(() => store.compareAndSetSession(undefined, unpinned)).toThrow(
            new AgentCoreError(
                "environment.stale-session",
                "Environment session must pin a stored Environment generation"
            )
        );
        const invalidRevision = new EnvironmentRevisionRecord(
            environmentId,
            new Revision(1),
            2,
            provider
        );
        const invalidHead = new Environment(
            environmentId,
            invalidRevision.revision,
            invalidRevision.generation,
            environment.recordRevision.next()
        );
        expect(() =>
            store.compareAndSetEnvironment(environment.recordRevision, invalidRevision, invalidHead)
        ).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                "Environment revisions must form a contiguous generation sequence"
            )
        );
        expect(store.getRevision(environmentId, invalidRevision.revision)).toBeUndefined();
    });

    test("codes invalid restore, snapshot, and exposure pins", () => {
        const store = seededStore();
        const restore = new EnvironmentSession(
            new EnvironmentSessionId("session-invalid-restore"),
            environmentId,
            Revision.initial(),
            0,
            0,
            EnvironmentSessionState.reserved,
            new EnvironmentSnapshotId("snapshot-missing"),
            Revision.initial()
        );
        expect(() => store.compareAndSetSession(undefined, restore)).toThrow(
            new AgentCoreError(
                "environment.invalid-session",
                "Environment session restore must use a ready snapshot from its exact generation"
            )
        );

        const invalidSnapshot = new EnvironmentSnapshot(
            new EnvironmentSnapshotId("snapshot-missing-session"),
            environmentId,
            new EnvironmentSessionId("session-missing"),
            Revision.initial(),
            0,
            0,
            EnvironmentSnapshotState.creating,
            undefined,
            Revision.initial()
        );
        expect(() => store.compareAndSetSnapshot(undefined, invalidSnapshot)).toThrow(
            new AgentCoreError(
                "environment.invalid-session",
                "Environment snapshot must pin its source session generation and epoch"
            )
        );

        const invalidExposure = new PortExposure(
            new PortExposureId("exposure-missing-session"),
            environmentId,
            new EnvironmentSessionId("session-missing"),
            Revision.initial(),
            0,
            0,
            4173,
            PortExposureState.exposing,
            undefined,
            Revision.initial()
        );
        expect(() => store.compareAndSetExposure(undefined, invalidExposure)).toThrow(
            new AgentCoreError(
                "environment.stale-session",
                "Port exposure must pin its source session generation and epoch"
            )
        );
    });

    test("rejects future snapshot epochs while retaining fenced snapshot history", () => {
        const store = seededStore();
        expect(store.compareAndSetSession(undefined, session)).toBe(true);
        const future = new EnvironmentSnapshot(
            new EnvironmentSnapshotId("snapshot-future-epoch"),
            environmentId,
            sessionId,
            Revision.initial(),
            0,
            1,
            EnvironmentSnapshotState.creating,
            undefined,
            Revision.initial()
        );
        expect(() => store.compareAndSetSnapshot(undefined, future)).toThrow(
            new AgentCoreError(
                "environment.invalid-session",
                "Environment snapshot must pin its source session generation and epoch"
            )
        );

        const creating = new EnvironmentSnapshot(
            new EnvironmentSnapshotId("snapshot-fenced-history"),
            environmentId,
            sessionId,
            Revision.initial(),
            0,
            0,
            EnvironmentSnapshotState.creating,
            undefined,
            Revision.initial()
        );
        expect(store.compareAndSetSnapshot(undefined, creating)).toBe(true);
        expect(store.compareAndSetSession(session.recordRevision, session.beginClose())).toBe(true);
        expect(store.compareAndSetSnapshot(creating.recordRevision, creating.fail())).toBe(true);
    });

    test("codes CAS progression and immutable revision violations as invalid state", () => {
        const empty = new MemoryEnvironmentStore();
        expect(() =>
            empty.compareAndSetEnvironment(
                undefined,
                revisionRecord,
                new Environment(environmentId, Revision.initial(), 1, Revision.initial())
            )
        ).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                "Environment head must advance with its exact revision generation"
            )
        );

        const store = seededStore();
        const nextRevision = revision(1, 1);
        expect(() =>
            store.compareAndSetEnvironment(
                environment.recordRevision,
                nextRevision,
                new Environment(environmentId, nextRevision.revision, 1, new Revision(2))
            )
        ).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                "Environment head CAS must advance exactly one record revision"
            )
        );
        const skippedSession = new EnvironmentSession(
            sessionId,
            environmentId,
            Revision.initial(),
            0,
            0,
            EnvironmentSessionState.open,
            undefined,
            new Revision(2)
        );
        expect(() => store.compareAndSetSession(undefined, skippedSession)).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                "Environment store CAS must advance exactly one record revision"
            )
        );

        const conflictingRevision = new EnvironmentRevisionRecord(
            environmentId,
            Revision.initial(),
            0,
            new ProviderDescriptor(new ProviderId("provider-conflict"), "1", content("c"))
        );
        const conflictingHead = new Environment(
            environmentId,
            Revision.initial(),
            0,
            environment.recordRevision.next()
        );
        expect(() =>
            store.compareAndSetEnvironment(
                environment.recordRevision,
                conflictingRevision,
                conflictingHead
            )
        ).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                `Environment revision ${environmentId.value}\u00000 is immutable`
            )
        );
    });

    test("leaves no orphan revision when the atomic head CAS conflicts", () => {
        const store = seededStore();
        const nextRevision = revision(1, 1);
        const nextHead = environment.rotate(nextRevision);

        expect(store.compareAndSetEnvironment(new Revision(9), nextRevision, nextHead)).toBe(false);
        expect(store.getEnvironment(environmentId)?.activeRevision.value).toBe(0);
        expect(store.getRevision(environmentId, nextRevision.revision)).toBeUndefined();
    });

    test("rolls back a revision when atomic head persistence fails", () => {
        const store = new FailingEnvironmentStore();
        seedStore(store);
        const nextRevision = revision(1, 1);
        const nextHead = environment.rotate(nextRevision);
        store.failNextHeadCommit = true;

        expect(() =>
            store.compareAndSetEnvironment(environment.recordRevision, nextRevision, nextHead)
        ).toThrow(
            new AgentCoreError("protocol.invalid-state", "Environment atomic head CAS failed")
        );
        expect(store.getEnvironment(environmentId)?.activeRevision.value).toBe(0);
        expect(store.getRevision(environmentId, nextRevision.revision)).toBeUndefined();
    });

    test("validates stored projections against their codec bytes on restore", () => {
        const store = seededStore();
        expect(store.compareAndSetSession(undefined, session)).toBe(true);
        const image = store.exportImage();
        const rows = image.rows.map((row) =>
            row.kind === "session" ? { ...row, projection: Object.freeze(["tampered"]) } : row
        );

        expect(() => new MemoryEnvironmentStore({ rows })).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                "Environment store projection does not match codec bytes"
            )
        );
    });

    test("rejects duplicate, malformed, mismatched, and orphaned store image rows", () => {
        const store = seededStore();
        expect(store.compareAndSetSession(undefined, session)).toBe(true);
        const image = store.exportImage();
        const head = image.rows.find((row) => row.kind === "head")!;
        const revisionRow = image.rows.find((row) => row.kind === "revision")!;
        const sessionRow = image.rows.find((row) => row.kind === "session")!;

        expect(() => new MemoryEnvironmentStore({ rows: [...image.rows, head] })).toThrowError(
            expect.objectContaining({ code: "protocol.invalid-state" })
        );
        expect(
            () =>
                new MemoryEnvironmentStore({
                    rows: image.rows.map((row) =>
                        row === sessionRow
                            ? {
                                  ...row,
                                  recordRevision: -1,
                                  projection: [...row.projection.slice(0, -1), "-1"]
                              }
                            : row
                    )
                })
        ).toThrowError(expect.objectContaining({ code: "protocol.invalid-state" }));
        expect(
            () =>
                new MemoryEnvironmentStore({
                    rows: image.rows.map((row) =>
                        row === sessionRow ? { ...row, key: "wrong-session" } : row
                    )
                })
        ).toThrowError(expect.objectContaining({ code: "protocol.invalid-state" }));
        expect(() => new MemoryEnvironmentStore({ rows: [revisionRow] })).toThrowError(
            expect.objectContaining({ code: "protocol.invalid-state" })
        );
    });

    test("validates every durable row key and resource projection after restart", () => {
        const store = seededStore();
        store.compareAndSetSession(undefined, session);
        store.compareAndSetSnapshot(undefined, snapshot);
        store.compareAndSetExposure(undefined, exposure);
        const image = store.exportImage();

        for (const kind of ["head", "revision", "session", "snapshot", "exposure"] as const) {
            expect(
                () =>
                    new MemoryEnvironmentStore({
                        rows: image.rows.map((row) =>
                            row.kind === kind ? { ...row, key: `wrong-${kind}` } : row
                        )
                    })
            ).toThrow(AgentCoreError);
        }
        const sessionRow = image.rows.find((row) => row.kind === "session")!;
        expect(
            () =>
                new MemoryEnvironmentStore({
                    rows: image.rows.map((row) =>
                        row === sessionRow
                            ? {
                                  ...row,
                                  recordRevision: Number.NaN,
                                  projection: [...row.projection.slice(0, -1), "NaN"]
                              }
                            : row
                    )
                })
        ).toThrow(/projection does not match/);
    });

    test("rejects nonzero initial generations and revisions beyond the durable head", () => {
        const invalidRevision = new EnvironmentRevisionRecord(
            environmentId,
            Revision.initial(),
            1,
            provider
        );
        const invalidHead = new Environment(
            environmentId,
            Revision.initial(),
            1,
            Revision.initial()
        );
        expect(
            () =>
                new MemoryEnvironmentStore({
                    rows: [
                        {
                            kind: "head",
                            key: environmentId.value,
                            recordRevision: 0,
                            projection: [environmentId.value, "0", "1", "0"],
                            bytes: Environment.encode(invalidHead)
                        },
                        {
                            kind: "revision",
                            key: `${environmentId.value}\u00000`,
                            recordRevision: 0,
                            projection: [
                                environmentId.value,
                                "0",
                                "1",
                                provider.id.value,
                                provider.version,
                                provider.configuration.value,
                                "0"
                            ],
                            bytes: EnvironmentRevisionRecord.encode(invalidRevision)
                        }
                    ]
                })
        ).toThrow(/contiguous generation sequence/);

        const initialImage = seededStore().exportImage();
        const advanced = seededStore();
        const nextRevision = revision(1, 1);
        advanced.compareAndSetEnvironment(
            environment.recordRevision,
            nextRevision,
            environment.rotate(nextRevision)
        );
        const rows = advanced
            .exportImage()
            .rows.filter((row) => row.kind !== "head")
            .concat(initialImage.rows.filter((row) => row.kind === "head"));
        expect(() => new MemoryEnvironmentStore({ rows })).toThrow(/orphan revision/);
    });

    test("restores the prior image when the head hook throws a typed store error", () => {
        const store = new TypedFailingEnvironmentStore();
        seedStore(store);
        const nextRevision = revision(1, 1);
        store.failNextHeadCommit = true;

        expect(() =>
            store.compareAndSetEnvironment(
                environment.recordRevision,
                nextRevision,
                environment.rotate(nextRevision)
            )
        ).toThrowError(expect.objectContaining({ code: "protocol.revision-conflict" }));
        expect(store.getEnvironment(environmentId)?.activeRevision.value).toBe(0);
        expect(store.getRevision(environmentId, nextRevision.revision)).toBeUndefined();
    });
});

function seededStore(): MemoryEnvironmentStore {
    const store = new MemoryEnvironmentStore();
    seedStore(store);
    return store;
}

function seedStore(store: MemoryEnvironmentStore): void {
    expect(store.compareAndSetEnvironment(undefined, revisionRecord, environment)).toBe(true);
}

function revision(revisionValue: number, generation: number): EnvironmentRevisionRecord {
    return new EnvironmentRevisionRecord(
        environmentId,
        new Revision(revisionValue),
        generation,
        provider
    );
}

class FailingEnvironmentStore extends MemoryEnvironmentStore {
    public failNextHeadCommit = false;

    protected override beforeEnvironmentHeadCommit(): void {
        if (!this.failNextHeadCommit) return;
        this.failNextHeadCommit = false;
        throw new TypeError("Injected Environment head persistence failure");
    }
}

class TypedFailingEnvironmentStore extends MemoryEnvironmentStore {
    public failNextHeadCommit = false;

    protected override beforeEnvironmentHeadCommit(): void {
        if (!this.failNextHeadCommit) return;
        this.failNextHeadCommit = false;
        throw new AgentCoreError("protocol.revision-conflict", "Injected typed CAS failure");
    }
}

class TestCredentialProxy extends EnvironmentCredentialIsolationProxy {
    public capability: EnvironmentCredentialProxyCapability | undefined;
    public request: ContentRef | undefined;

    public forward(
        capability: EnvironmentCredentialProxyCapability,
        request: ContentRef
    ): Promise<ContentRef> {
        this.capability = capability;
        this.request = request;
        return Promise.resolve(request);
    }
}

function exposureWithUrl(url: string): PortExposure {
    return new PortExposure(
        exposureId,
        environmentId,
        sessionId,
        Revision.initial(),
        0,
        0,
        4173,
        PortExposureState.exposed,
        url,
        Revision.initial()
    );
}

function sessionIn(state: EnvironmentSessionState, generation = 0): EnvironmentSession {
    return new EnvironmentSession(
        sessionId,
        environmentId,
        Revision.initial(),
        generation,
        0,
        state,
        undefined,
        Revision.initial()
    );
}

function snapshotIn(
    state: EnvironmentSnapshotState,
    snapshotContent: ContentRef | undefined = state.name === "ready" ? content("b") : undefined
): EnvironmentSnapshot {
    return new EnvironmentSnapshot(
        snapshotId,
        environmentId,
        sessionId,
        Revision.initial(),
        0,
        0,
        state,
        snapshotContent,
        Revision.initial()
    );
}

function exposureIn(state: PortExposureState, url?: string): PortExposure {
    return new PortExposure(
        exposureId,
        environmentId,
        sessionId,
        Revision.initial(),
        0,
        0,
        4173,
        state,
        url,
        Revision.initial()
    );
}

function expectInvalidPayload<Record>(
    recordClass: { encode(record: Record): Uint8Array; decode(bytes: Uint8Array): Record },
    record: Record,
    payload: JsonValue
): void {
    const envelope = decodeCanonicalJson(recordClass.encode(record)) as JsonValue & RecordEnvelope;
    expect(() =>
        recordClass.decode(
            encodeCanonicalJson({
                kind: envelope.kind,
                version: { major: envelope.version.major, minor: envelope.version.minor },
                payload
            })
        )
    ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
}

function content(character: string): ContentRef {
    return new ContentRef(`sha256:${character.repeat(64)}`);
}
