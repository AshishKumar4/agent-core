import { describe, expect, test } from "vitest";
import {
    ContentRef,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue,
    type RecordEnvelope
} from "../../src/core";
import {
    Environment,
    EnvironmentId,
    EnvironmentRevisionRecord,
    EnvironmentSession,
    EnvironmentSessionId,
    EnvironmentSessionState,
    EnvironmentSnapshot,
    EnvironmentSnapshotId,
    EnvironmentSnapshotState,
    PortExposure,
    PortExposureId,
    PortExposureState,
    ProviderDescriptor,
    ProviderId
} from "../../src/environments";

const environmentId = new EnvironmentId("environment-record-mutation");
const sessionId = new EnvironmentSessionId("session-record-mutation");
const snapshotId = new EnvironmentSnapshotId("snapshot-record-mutation");
const exposureId = new PortExposureId("exposure-record-mutation");
const provider = new ProviderDescriptor(
    new ProviderId("provider-record-mutation"),
    "1",
    content("a")
);

describe("Environment record mutation kills", () => {
    test("names every Environment identifier subject exactly", { tags: "p2" }, () => {
        const cases = [
            [() => new EnvironmentId(""), "Environment ID"],
            [() => new ProviderId(""), "Provider ID"],
            [() => new EnvironmentSessionId(""), "Environment session ID"],
            [() => new EnvironmentSnapshotId(""), "Environment snapshot ID"],
            [() => new PortExposureId(""), "Port exposure ID"]
        ] as const;
        for (const [construct, subject] of cases) {
            expect(construct).toThrow(
                new TypeError(`${subject} must contain between 1 and 256 characters`)
            );
        }
    });

    test("invalid lifecycle transitions carry exact state names", { tags: "p1" }, () => {
        const reserved = sessionIn(EnvironmentSessionState.reserved);
        const failed = sessionIn(EnvironmentSessionState.failed);
        const closed = sessionIn(EnvironmentSessionState.closed);
        const cases = [
            [
                () => reserved.opened(),
                "Cannot complete open an Environment session in reserved state"
            ],
            [
                () => reserved.failOpen(),
                "Cannot fail open an Environment session in reserved state"
            ],
            [() => reserved.lost(), "Cannot mark lost an Environment session in reserved state"],
            [() => closed.beginOpen(), "Cannot open an Environment session in closed state"],
            [() => failed.closed(), "Cannot complete close an Environment session in failed state"],
            [() => reserved.assertUsable(), "Environment session is not open"],
            [
                () => snapshotIn(EnvironmentSnapshotState.ready).fail(),
                "Cannot fail an Environment snapshot in ready state"
            ],
            [
                () => snapshotIn(EnvironmentSnapshotState.failed).ready(content("b")),
                "Cannot complete an Environment snapshot in failed state"
            ],
            [
                () => exposureIn(PortExposureState.exposing).revoked(),
                "Cannot complete revocation in exposing port exposure state"
            ],
            [
                () => exposureIn(PortExposureState.failed).revoked(),
                "Cannot complete revocation in failed port exposure state"
            ],
            [
                () => exposureIn(PortExposureState.exposed, "https://preview.example.test/").fail(),
                "Cannot fail exposure in exposed port exposure state"
            ],
            [
                () =>
                    exposureIn(PortExposureState.revoked).exposed("https://preview.example.test/"),
                "Cannot complete exposure in revoked port exposure state"
            ]
        ] as const;
        for (const [operation, message] of cases) {
            expect(operation).toThrowError(
                expect.objectContaining({ code: "environment.invalid-session", message })
            );
        }
    });

    test("codec field failures name their exact subjects", { tags: "p1" }, () => {
        const session = sessionIn(EnvironmentSessionState.open);
        const sessionPayload = {
            id: sessionId.value,
            environmentId: environmentId.value,
            environmentRevision: 0,
            generation: 0,
            epoch: 0,
            state: "open",
            restoreFrom: null,
            recordRevision: 0
        };
        const snapshot = snapshotIn(EnvironmentSnapshotState.creating);
        const snapshotPayload = {
            id: snapshotId.value,
            environmentId: environmentId.value,
            sessionId: sessionId.value,
            environmentRevision: 0,
            generation: 0,
            sessionEpoch: 0,
            state: "creating",
            content: null,
            recordRevision: 0
        };
        const exposure = exposureIn(PortExposureState.exposing);
        const exposurePayload = {
            id: exposureId.value,
            environmentId: environmentId.value,
            sessionId: sessionId.value,
            environmentRevision: 0,
            generation: 0,
            sessionEpoch: 0,
            port: 4173,
            state: "exposing",
            url: null,
            recordRevision: 0
        };
        const environment = new Environment(
            environmentId,
            Revision.initial(),
            0,
            Revision.initial()
        );
        const revisionRecord = new EnvironmentRevisionRecord(
            environmentId,
            Revision.initial(),
            0,
            provider
        );

        expectDecodeFailure(
            EnvironmentSession,
            session,
            [],
            "Invalid environment.session record: Environment session must be an object"
        );
        expectDecodeFailure(
            EnvironmentSession,
            session,
            { ...sessionPayload, id: 1 },
            "Invalid environment.session record: Environment session ID must be a string"
        );
        expectDecodeFailure(
            EnvironmentSession,
            session,
            { ...sessionPayload, environmentId: 1 },
            "Invalid environment.session record: Environment ID must be a string"
        );
        expectDecodeFailure(
            EnvironmentSession,
            session,
            { ...sessionPayload, state: "unknown" },
            "Invalid environment.session record: Environment session state is invalid"
        );
        expectDecodeFailure(
            EnvironmentSession,
            session,
            { ...sessionPayload, environmentRevision: "0" },
            "Invalid environment.session record: Environment revision must be a non-negative safe integer"
        );
        expectDecodeFailure(
            EnvironmentSession,
            session,
            { ...sessionPayload, environmentRevision: 0.5 },
            "Invalid environment.session record: Environment revision must be a non-negative safe integer"
        );
        expectDecodeFailure(
            EnvironmentSession,
            session,
            { ...sessionPayload, environmentRevision: -1 },
            "Invalid environment.session record: Environment revision must be a non-negative safe integer"
        );
        expectDecodeFailure(
            EnvironmentSession,
            session,
            { ...sessionPayload, extra: true },
            "Invalid environment.session record: Environment session has invalid fields"
        );
        expectDecodeFailure(
            EnvironmentSnapshot,
            snapshot,
            { ...snapshotPayload, id: 1 },
            "Invalid environment.snapshot record: Environment snapshot ID must be a string"
        );
        expectDecodeFailure(
            EnvironmentSnapshot,
            snapshot,
            { ...snapshotPayload, environmentId: 1 },
            "Invalid environment.snapshot record: Environment ID must be a string"
        );
        expectDecodeFailure(
            EnvironmentSnapshot,
            snapshot,
            { ...snapshotPayload, sessionId: 1 },
            "Invalid environment.snapshot record: Environment session ID must be a string"
        );
        expectDecodeFailure(
            EnvironmentSnapshot,
            snapshot,
            { ...snapshotPayload, state: "unknown" },
            "Invalid environment.snapshot record: Environment snapshot state is invalid"
        );
        expectDecodeFailure(
            PortExposure,
            exposure,
            { ...exposurePayload, id: 1 },
            "Invalid environment.port-exposure record: Port exposure ID must be a string"
        );
        expectDecodeFailure(
            PortExposure,
            exposure,
            { ...exposurePayload, environmentId: 1 },
            "Invalid environment.port-exposure record: Environment ID must be a string"
        );
        expectDecodeFailure(
            PortExposure,
            exposure,
            { ...exposurePayload, sessionId: 1 },
            "Invalid environment.port-exposure record: Environment session ID must be a string"
        );
        expectDecodeFailure(
            PortExposure,
            exposure,
            { ...exposurePayload, state: "unknown" },
            "Invalid environment.port-exposure record: Port exposure state is invalid"
        );
        expectDecodeFailure(
            Environment,
            environment,
            {
                id: 1,
                activeRevision: 0,
                generation: 0,
                recordRevision: 0
            },
            "Invalid environment.head record: Environment ID must be a string"
        );
        expectDecodeFailure(
            EnvironmentRevisionRecord,
            revisionRecord,
            {
                environmentId: 1,
                revision: 0,
                generation: 0,
                provider: {
                    id: provider.id.value,
                    version: provider.version,
                    configuration: provider.configuration.value
                }
            },
            "Invalid environment.revision record: Environment ID must be a string"
        );
    });

    test("counter exhaustion names the exact subject", { tags: "p1" }, () => {
        const openAtMaxEpoch = new EnvironmentSession(
            sessionId,
            environmentId,
            Revision.initial(),
            0,
            Number.MAX_SAFE_INTEGER,
            EnvironmentSessionState.open,
            undefined,
            Revision.initial()
        );
        expect(() => openAtMaxEpoch.lost()).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Environment session epoch is exhausted"
            })
        );

        const openingAtMaxRevision = new EnvironmentSession(
            sessionId,
            environmentId,
            Revision.initial(),
            0,
            0,
            EnvironmentSessionState.opening,
            undefined,
            new Revision(Number.MAX_SAFE_INTEGER)
        );
        expect(() => openingAtMaxRevision.opened()).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Environment session record revision is exhausted"
            })
        );

        const openAtMaxRevision = new EnvironmentSession(
            sessionId,
            environmentId,
            Revision.initial(),
            0,
            0,
            EnvironmentSessionState.open,
            undefined,
            new Revision(Number.MAX_SAFE_INTEGER)
        );
        expect(() => openAtMaxRevision.lost()).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Environment session record revision is exhausted"
            })
        );
        expect(() => openAtMaxRevision.beginClose()).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Environment session record revision is exhausted"
            })
        );

        const exposingAtMaxRevision = new PortExposure(
            exposureId,
            environmentId,
            sessionId,
            Revision.initial(),
            0,
            0,
            4173,
            PortExposureState.exposing,
            undefined,
            new Revision(Number.MAX_SAFE_INTEGER)
        );
        expect(() => exposingAtMaxRevision.fail()).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Port exposure record revision is exhausted"
            })
        );
    });

    test("port bounds admit 1 and 65535 and reject their neighbors", { tags: "p1" }, () => {
        expect(exposureAtPort(1).port).toBe(1);
        expect(exposureAtPort(65_535).port).toBe(65_535);
        for (const port of [0, 65_536, 0.5]) {
            expect(() => exposureAtPort(port)).toThrow(
                new TypeError("Port exposure port must be between 1 and 65535")
            );
        }
    });

    test(
        "exposure URLs allow http, forbid credentials, and must be strings",
        { tags: "p1" },
        () => {
            expect(exposureWithUrl("http://preview.example.test/").url).toBe(
                "http://preview.example.test/"
            );
            expect(() => exposureWithUrl("https://user@example.test/")).toThrow(
                new TypeError("Port exposure URL must not contain credentials or bearer material")
            );
            expect(() => exposureWithUrl("https://:secret@example.test/")).toThrow(
                new TypeError("Port exposure URL must not contain credentials or bearer material")
            );
            expect(() => exposureWithUrl(42 as unknown as string)).toThrow(
                new TypeError("Port exposure URL must be a string")
            );
        }
    );

    test("provider versions admit exactly 128 characters", { tags: "p2" }, () => {
        const limit = new ProviderDescriptor(provider.id, "v".repeat(128), provider.configuration);
        expect(limit.version).toHaveLength(128);
        expect(
            () => new ProviderDescriptor(provider.id, "v".repeat(129), provider.configuration)
        ).toThrow(new TypeError("Provider version must contain between 1 and 128 characters"));
        expect(
            () =>
                new ProviderDescriptor(provider.id, 42 as unknown as string, provider.configuration)
        ).toThrow(new TypeError("Provider version must contain between 1 and 128 characters"));
    });

    test("snapshot epoch validation names its exact subject", { tags: "p2" }, () => {
        expect(
            () =>
                new EnvironmentSnapshot(
                    snapshotId,
                    environmentId,
                    sessionId,
                    Revision.initial(),
                    0,
                    -1,
                    EnvironmentSnapshotState.creating,
                    undefined,
                    Revision.initial()
                )
        ).toThrow(
            new TypeError("Environment snapshot session epoch must be a non-negative safe integer")
        );
    });
});

function expectDecodeFailure<Record>(
    recordClass: { encode(record: Record): Uint8Array; decode(bytes: Uint8Array): Record },
    record: Record,
    payload: JsonValue,
    message: string
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
    ).toThrowError(expect.objectContaining({ code: "codec.invalid", message }));
}

function sessionIn(state: EnvironmentSessionState): EnvironmentSession {
    return new EnvironmentSession(
        sessionId,
        environmentId,
        Revision.initial(),
        0,
        0,
        state,
        undefined,
        Revision.initial()
    );
}

function snapshotIn(state: EnvironmentSnapshotState): EnvironmentSnapshot {
    return new EnvironmentSnapshot(
        snapshotId,
        environmentId,
        sessionId,
        Revision.initial(),
        0,
        0,
        state,
        state.name === "ready" ? content("b") : undefined,
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

function exposureAtPort(port: number): PortExposure {
    return new PortExposure(
        exposureId,
        environmentId,
        sessionId,
        Revision.initial(),
        0,
        0,
        port,
        PortExposureState.exposing,
        undefined,
        Revision.initial()
    );
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

function content(character: string): ContentRef {
    return new ContentRef(`sha256:${character.repeat(64)}`);
}
