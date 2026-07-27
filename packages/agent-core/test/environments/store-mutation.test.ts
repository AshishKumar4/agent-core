import { describe, expect, test } from "vitest";
import { ContentRef, Revision } from "../../src/core";
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
    MemoryEnvironmentStore,
    PortExposure,
    PortExposureId,
    PortExposureState,
    ProviderDescriptor,
    ProviderId
} from "../../src/environments";

const environmentId = new EnvironmentId("environment-store-mutation");
const sessionId = new EnvironmentSessionId("session-store-mutation");
const provider = new ProviderDescriptor(
    new ProviderId("provider-store-mutation"),
    "1",
    content("a")
);
const revisionRecord = new EnvironmentRevisionRecord(
    environmentId,
    Revision.initial(),
    0,
    provider
);
const environment = new Environment(environmentId, Revision.initial(), 0, Revision.initial());

describe("MemoryEnvironmentStore mutation kills", () => {
    test(
        "replays an identical environment CAS regardless of the expected revision",
        { tags: "p0" },
        () => {
            const store = seededStore();

            expect(store.compareAndSetEnvironment(new Revision(9), revisionRecord, environment))
                .toBe(true);
            expect(store.getEnvironment(environmentId)?.recordRevision.value).toBe(0);
            expect(store.getEnvironment(environmentId)?.activeRevision.value).toBe(0);
        }
    );

    test("requires the head and revision to name the same environment", { tags: "p0" }, () => {
        const store = new MemoryEnvironmentStore();
        const otherHead = new Environment(
            new EnvironmentId("environment-store-other"),
            Revision.initial(),
            0,
            Revision.initial()
        );

        expect(() =>
            store.compareAndSetEnvironment(undefined, revisionRecord, otherHead)
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Environment head must advance with its exact revision generation"
            })
        );
    });

    test("exports rows sorted by kind and key", { tags: "p1" }, () => {
        const store = seededStore();
        expect(store.compareAndSetSession(undefined, sessionRecord("session-b"))).toBe(true);
        expect(store.compareAndSetSession(undefined, sessionRecord("session-a"))).toBe(true);
        expect(
            store.compareAndSetSnapshot(undefined, creatingSnapshot("snapshot-a", "session-a"))
        ).toBe(true);
        expect(
            store.compareAndSetExposure(undefined, exposingExposure("exposure-a", "session-a", 0))
        ).toBe(true);

        expect(store.exportImage().rows.map((row) => [row.kind, row.key])).toEqual([
            ["exposure", "exposure-a"],
            ["head", environmentId.value],
            ["revision", `${environmentId.value}\u00000`],
            ["session", "session-a"],
            ["session", "session-b"],
            ["snapshot", "snapshot-a"]
        ]);
    });

    test("lists exposures for the exact session sorted by ID", { tags: "p1" }, () => {
        const store = seededStore();
        expect(store.compareAndSetSession(undefined, sessionRecord("session-a"))).toBe(true);
        expect(store.compareAndSetSession(undefined, sessionRecord("session-b"))).toBe(true);
        expect(
            store.compareAndSetExposure(undefined, exposingExposure("exposure-b", "session-a", 0))
        ).toBe(true);
        expect(
            store.compareAndSetExposure(undefined, exposingExposure("exposure-a", "session-a", 0))
        ).toBe(true);
        expect(
            store.compareAndSetExposure(undefined, exposingExposure("exposure-c", "session-b", 0))
        ).toBe(true);

        expect(
            store
                .listExposures(new EnvironmentSessionId("session-a"))
                .map((exposure) => exposure.id.value)
        ).toEqual(["exposure-a", "exposure-b"]);
    });

    test("projects empty strings for absent optional record fields", { tags: "p0" }, () => {
        const store = seededStore();
        expect(store.compareAndSetSession(undefined, sessionRecord(sessionId.value))).toBe(true);
        expect(
            store.compareAndSetSnapshot(
                undefined,
                creatingSnapshot("snapshot-projection", sessionId.value)
            )
        ).toBe(true);
        expect(
            store.compareAndSetExposure(
                undefined,
                exposingExposure("exposure-projection", sessionId.value, 0)
            )
        ).toBe(true);
        const rows = store.exportImage().rows;
        const projectionOf = (kind: string, key: string): readonly string[] => {
            const row = rows.find((candidate) => candidate.kind === kind && candidate.key === key);
            if (row === undefined) throw new TypeError(`Missing ${kind} row ${key}`);
            return row.projection;
        };

        expect(projectionOf("session", sessionId.value)).toEqual([
            sessionId.value,
            environmentId.value,
            "0",
            "0",
            "0",
            "open",
            "",
            "0"
        ]);
        expect(projectionOf("snapshot", "snapshot-projection")).toEqual([
            "snapshot-projection",
            environmentId.value,
            sessionId.value,
            "0",
            "0",
            "0",
            "creating",
            "",
            "0"
        ]);
        expect(projectionOf("exposure", "exposure-projection")).toEqual([
            "exposure-projection",
            environmentId.value,
            sessionId.value,
            "0",
            "0",
            "0",
            "4173",
            "exposing",
            "",
            "0"
        ]);
        expect(projectionOf("head", environmentId.value)).toEqual([
            environmentId.value,
            "0",
            "0",
            "0"
        ]);
        expect(projectionOf("revision", `${environmentId.value}\u00000`)).toEqual([
            environmentId.value,
            "0",
            "0",
            provider.id.value,
            provider.version,
            provider.configuration.value,
            "0"
        ]);
    });

    test(
        "rejects non-ready restore snapshots and future exposure epochs exactly",
        { tags: "p0" },
        () => {
            const store = seededStore();
            expect(store.compareAndSetSession(undefined, sessionRecord(sessionId.value))).toBe(
                true
            );
            expect(
                store.compareAndSetSnapshot(
                    undefined,
                    creatingSnapshot("snapshot-not-ready", sessionId.value)
                )
            ).toBe(true);
            const restoring = new EnvironmentSession(
                new EnvironmentSessionId("session-restore-creating"),
                environmentId,
                Revision.initial(),
                0,
                0,
                EnvironmentSessionState.reserved,
                new EnvironmentSnapshotId("snapshot-not-ready"),
                Revision.initial()
            );
            expect(() => store.compareAndSetSession(undefined, restoring)).toThrowError(
                expect.objectContaining({
                    code: "environment.invalid-session",
                    message:
                        "Environment session restore must use a ready snapshot from its exact generation"
                })
            );

            expect(() =>
                store.compareAndSetExposure(
                    undefined,
                    exposingExposure("exposure-future-epoch", sessionId.value, 1)
                )
            ).toThrowError(
                expect.objectContaining({
                    code: "environment.stale-session",
                    message: "Port exposure must pin its source session generation and epoch"
                })
            );
        }
    );

    test("rejects images whose revision chain has a gap", { tags: "p1" }, () => {
        const store = seededStore();
        const next = new EnvironmentRevisionRecord(environmentId, new Revision(1), 1, provider);
        expect(
            store.compareAndSetEnvironment(
                environment.recordRevision,
                next,
                environment.rotate(next)
            )
        ).toBe(true);
        const rows = store
            .exportImage()
            .rows.filter(
                (row) => row.kind !== "revision" || row.key !== `${environmentId.value}\u00000`
            );

        expect(() => new MemoryEnvironmentStore({ rows })).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Environment revisions must form a contiguous generation sequence"
            })
        );
    });

    test("names every mismatched durable key exactly", { tags: "p1" }, () => {
        const store = seededStore();
        expect(store.compareAndSetSession(undefined, sessionRecord(sessionId.value))).toBe(true);
        expect(
            store.compareAndSetSnapshot(undefined, creatingSnapshot("snapshot-key", sessionId.value))
        ).toBe(true);
        expect(
            store.compareAndSetExposure(
                undefined,
                exposingExposure("exposure-key", sessionId.value, 0)
            )
        ).toBe(true);
        const image = store.exportImage();
        const cases = [
            ["head", "Environment head key does not match codec bytes"],
            ["session", "Environment session key does not match codec bytes"],
            ["snapshot", "Environment snapshot key does not match codec bytes"],
            ["exposure", "Port exposure key does not match codec bytes"]
        ] as const;

        for (const [kind, message] of cases) {
            const tampered = image.rows
                .filter((row) => row.kind === kind)
                .map((row) => ({ ...row, key: `wrong-${kind}` }));
            const rows = [...tampered, ...image.rows.filter((row) => row.kind !== kind)];
            expect(() => new MemoryEnvironmentStore({ rows })).toThrowError(
                expect.objectContaining({ code: "protocol.invalid-state", message })
            );
        }

        const headRow = image.rows.find((row) => row.kind === "head");
        const revisionRow = image.rows.find((row) => row.kind === "revision");
        if (headRow === undefined || revisionRow === undefined) {
            throw new TypeError("Missing head or revision row");
        }
        expect(
            () =>
                new MemoryEnvironmentStore({
                    rows: [{ ...revisionRow, key: "wrong-revision" }, headRow]
                })
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Environment revision key does not match codec bytes"
            })
        );
    });

    test("rejects duplicate image keys exactly", { tags: "p1" }, () => {
        const image = seededStore().exportImage();
        const head = image.rows.find((row) => row.kind === "head");
        if (head === undefined) throw new TypeError("Missing head row");

        expect(() => new MemoryEnvironmentStore({ rows: [...image.rows, head] })).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Environment store image contains a duplicate key"
            })
        );
    });
});

function seededStore(): MemoryEnvironmentStore {
    const store = new MemoryEnvironmentStore();
    expect(store.compareAndSetEnvironment(undefined, revisionRecord, environment)).toBe(true);
    return store;
}

function sessionRecord(id: string): EnvironmentSession {
    return new EnvironmentSession(
        new EnvironmentSessionId(id),
        environmentId,
        Revision.initial(),
        0,
        0,
        EnvironmentSessionState.open,
        undefined,
        Revision.initial()
    );
}

function creatingSnapshot(id: string, session: string): EnvironmentSnapshot {
    return new EnvironmentSnapshot(
        new EnvironmentSnapshotId(id),
        environmentId,
        new EnvironmentSessionId(session),
        Revision.initial(),
        0,
        0,
        EnvironmentSnapshotState.creating,
        undefined,
        Revision.initial()
    );
}

function exposingExposure(id: string, session: string, epoch: number): PortExposure {
    return new PortExposure(
        new PortExposureId(id),
        environmentId,
        new EnvironmentSessionId(session),
        Revision.initial(),
        0,
        epoch,
        4173,
        PortExposureState.exposing,
        undefined,
        Revision.initial()
    );
}

function content(character: string): ContentRef {
    return new ContentRef(`sha256:${character.repeat(64)}`);
}
