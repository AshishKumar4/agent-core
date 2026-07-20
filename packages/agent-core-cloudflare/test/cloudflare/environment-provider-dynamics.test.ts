import fc from "fast-check";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { ContentRef, Digest, Revision, encodeBase64, encodeCanonicalJson } from "@agent-core/core";
import {
    EnvironmentId,
    EnvironmentSessionId,
    EnvironmentSnapshotId,
    PortExposureId,
    type ExposePortRequest,
    type OpenSessionRequest,
    type SnapshotEnvironmentRequest
} from "@agent-core/core/environment-provider";
import type { DurableObjectEnvironmentProvider } from "../../src/index.js";
import { PREVIEW_HOST, type EnvironmentProviderDurableObject } from "./worker.js";

const PROPERTY_SEED = 0x5e5510;
const SNAPSHOT_FORMAT = "agent-core-environment-snapshot/1";
const ENVIRONMENT = new EnvironmentId("environment-dynamics");
const PINS = [
    { revision: 0, generation: 0 },
    { revision: 1, generation: 1 },
    { revision: 2, generation: 2 },
    { revision: 2, generation: 1 }
] as const;
const PATHS = ["state.txt", "nested/data.bin"] as const;

interface SessionModel {
    readonly request: OpenSessionRequest;
    readonly files: Map<string, Uint8Array>;
    state: "open" | "closed";
}

interface SnapshotModel {
    readonly request: SnapshotEnvironmentRequest;
    readonly reference: ContentRef;
    readonly files: ReadonlyMap<string, Uint8Array>;
}

interface ExposureModel {
    readonly request: ExposePortRequest;
    readonly url: string;
    state: "exposed" | "revoked";
}

interface ProviderModel {
    pin: (typeof PINS)[number] | undefined;
    readonly sessions: Map<string, SessionModel>;
    readonly snapshots: Map<string, SnapshotModel>;
    readonly exposures: Map<string, ExposureModel>;
    readonly coverage: Set<Coverage>;
}

type Coverage =
    | Command["kind"]
    | "conflictingExposure"
    | "conflictingSession"
    | "conflictingSnapshot"
    | "exactRetry"
    | "restoredContent"
    | "staleGeneration"
    | "staleSessionEpoch";

type Command =
    | {
          readonly kind: "open";
          readonly session: number;
          readonly pin: number;
          readonly restore: number | undefined;
          readonly retry: boolean;
          readonly evictAfter: boolean;
      }
    | {
          readonly kind: "inspect";
          readonly session: number;
          readonly pin: number;
          readonly restore: number | undefined;
          readonly evictAfter: boolean;
      }
    | {
          readonly kind: "write";
          readonly session: number;
          readonly pin: number;
          readonly restore: number | undefined;
          readonly path: number;
          readonly bytes: readonly number[];
          readonly retry: boolean;
          readonly evictAfter: boolean;
      }
    | {
          readonly kind: "read";
          readonly session: number;
          readonly pin: number;
          readonly restore: number | undefined;
          readonly path: number;
          readonly evictAfter: boolean;
      }
    | {
          readonly kind: "snapshot";
          readonly session: number;
          readonly snapshot: number;
          readonly pin: number;
          readonly sessionEpoch: number;
          readonly retry: boolean;
          readonly evictAfter: boolean;
      }
    | {
          readonly kind: "inspectSnapshot";
          readonly session: number;
          readonly snapshot: number;
          readonly pin: number;
          readonly sessionEpoch: number;
          readonly evictAfter: boolean;
      }
    | {
          readonly kind: "expose";
          readonly session: number;
          readonly exposure: number;
          readonly pin: number;
          readonly sessionEpoch: number;
          readonly port: number;
          readonly retry: boolean;
          readonly evictAfter: boolean;
      }
    | {
          readonly kind: "revoke";
          readonly session: number;
          readonly exposure: number;
          readonly pin: number;
          readonly sessionEpoch: number;
          readonly port: number;
          readonly retry: boolean;
          readonly evictAfter: boolean;
      }
    | {
          readonly kind: "close";
          readonly session: number;
          readonly pin: number;
          readonly restore: number | undefined;
          readonly retry: boolean;
          readonly evictAfter: boolean;
      }
    | { readonly kind: "evict"; readonly evictAfter: false };

interface Runtime {
    readonly stub: DurableObjectStub<EnvironmentProviderDurableObject>;
}

const identity = fc.integer({ min: 0, max: 2 });
const pinIndex = fc.integer({ min: 0, max: PINS.length - 1 });
const restore = fc.option(identity, { nil: undefined });
const retry = fc.boolean();
const evictAfter = fc.boolean();
const sessionEpoch = fc.integer({ min: 0, max: 1 });
const port = fc.constantFrom(3000, 8080, 9090);

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
    fc
        .record({ session: identity, pin: pinIndex, restore, retry, evictAfter })
        .map((value) => ({ kind: "open" as const, ...value })),
    fc
        .record({ session: identity, pin: pinIndex, restore, evictAfter })
        .map((value) => ({ kind: "inspect" as const, ...value })),
    fc
        .record({
            session: identity,
            pin: pinIndex,
            restore,
            path: fc.integer({ min: 0, max: PATHS.length - 1 }),
            bytes: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 5 }),
            retry,
            evictAfter
        })
        .map((value) => ({ kind: "write" as const, ...value })),
    fc
        .record({
            session: identity,
            pin: pinIndex,
            restore,
            path: fc.integer({ min: 0, max: PATHS.length - 1 }),
            evictAfter
        })
        .map((value) => ({ kind: "read" as const, ...value })),
    fc
        .record({
            session: identity,
            snapshot: identity,
            pin: pinIndex,
            sessionEpoch,
            retry,
            evictAfter
        })
        .map((value) => ({ kind: "snapshot" as const, ...value })),
    fc
        .record({ session: identity, snapshot: identity, pin: pinIndex, sessionEpoch, evictAfter })
        .map((value) => ({ kind: "inspectSnapshot" as const, ...value })),
    fc
        .record({
            session: identity,
            exposure: identity,
            pin: pinIndex,
            sessionEpoch,
            port,
            retry,
            evictAfter
        })
        .map((value) => ({ kind: "expose" as const, ...value })),
    fc
        .record({
            session: identity,
            exposure: identity,
            pin: pinIndex,
            sessionEpoch,
            port,
            retry,
            evictAfter
        })
        .map((value) => ({ kind: "revoke" as const, ...value })),
    fc
        .record({ session: identity, pin: pinIndex, restore, retry, evictAfter })
        .map((value) => ({ kind: "close" as const, ...value })),
    fc.constant({ kind: "evict" as const, evictAfter: false })
);

test(
    "generated environment-provider histories preserve durable public behavior across eviction",
    { tags: "p1", timeout: 30_000 },
    async () => {
        const coverage = new Set<Coverage>();
        await runHistory("required", requiredHistory(), coverage);

        let run = 0;
        await fc.assert(
            fc.asyncProperty(
                fc.array(commandArbitrary, { minLength: 10, maxLength: 24 }),
                async (commands) => runHistory(`generated-${run++}`, commands, coverage)
            ),
            { numRuns: 12, seed: PROPERTY_SEED }
        );

        expect([...coverage].sort()).toEqual(
            [
                "close",
                "conflictingExposure",
                "conflictingSession",
                "conflictingSnapshot",
                "evict",
                "exactRetry",
                "expose",
                "inspect",
                "inspectSnapshot",
                "open",
                "read",
                "restoredContent",
                "revoke",
                "snapshot",
                "staleGeneration",
                "staleSessionEpoch",
                "write"
            ].sort()
        );
    }
);

async function runHistory(
    name: string,
    commands: readonly Command[],
    coverage: Set<Coverage>
): Promise<void> {
    const runtime: Runtime = { stub: env.ENVIRONMENTS.getByName(`dynamics-${name}`) };
    const model: ProviderModel = {
        pin: undefined,
        sessions: new Map(),
        snapshots: new Map(),
        exposures: new Map(),
        coverage
    };

    await assertObservableState(model, runtime);
    for (const command of commands) {
        await execute(model, runtime, command);
        await assertObservableState(model, runtime);
        if (command.evictAfter) {
            await evictDurableObject(runtime.stub);
            await assertObservableState(model, runtime);
        }
    }
}

async function execute(model: ProviderModel, runtime: Runtime, command: Command): Promise<void> {
    model.coverage.add(command.kind);
    switch (command.kind) {
        case "open":
            return executeOpen(model, runtime, command);
        case "inspect":
            return executeInspect(model, runtime, command);
        case "write":
            return executeWrite(model, runtime, command);
        case "read":
            return executeRead(model, runtime, command);
        case "snapshot":
            return executeSnapshot(model, runtime, command);
        case "inspectSnapshot":
            return executeInspectSnapshot(model, runtime, command);
        case "expose":
            return executeExpose(model, runtime, command);
        case "revoke":
            return executeRevoke(model, runtime, command);
        case "close":
            return executeClose(model, runtime, command);
        case "evict":
            await evictDurableObject(runtime.stub);
    }
}

async function executeOpen(
    model: ProviderModel,
    runtime: Runtime,
    command: Extract<Command, { readonly kind: "open" }>
): Promise<void> {
    const request = openRequest(model, command.session, command.pin, command.restore);
    const id = request.sessionId.value;
    const existing = model.sessions.get(id);
    const restoreSnapshot =
        command.restore === undefined
            ? undefined
            : model.snapshots.get(snapshotId(command.restore));
    const stale = existing === undefined && comparePin(model.pin, PINS[command.pin]!) === "stale";
    const expected =
        existing === undefined
            ? stale || (command.restore !== undefined && restoreSnapshot === undefined)
                ? "failed"
                : "ready"
            : sameOpenRequest(existing.request, request) && existing.state === "open"
              ? "ready"
              : "failed";

    const observed = await withProvider(runtime, (provider) => provider.openSession(request));
    expect(observed.name).toBe(expected);

    if (existing === undefined && expected === "ready") {
        if (comparePin(model.pin, PINS[command.pin]!) === "advance") model.pin = PINS[command.pin];
        model.sessions.set(id, {
            request,
            files: cloneFiles(restoreSnapshot?.files),
            state: "open"
        });
        if (restoreSnapshot !== undefined) model.coverage.add("restoredContent");
    } else if (existing !== undefined && !sameOpenRequest(existing.request, request)) {
        model.coverage.add("conflictingSession");
    } else if (existing === undefined) {
        if (stale) model.coverage.add("staleGeneration");
        expect(
            (await withProvider(runtime, (provider) => provider.inspectSession(request))).name
        ).toBe("absent");
    }

    if (command.retry) {
        expect(
            projectResource(
                await withProvider(runtime, (provider) => provider.openSession(request))
            )
        ).toEqual(projectResource(observed));
        model.coverage.add("exactRetry");
    }
}

async function executeInspect(
    model: ProviderModel,
    runtime: Runtime,
    command: Extract<Command, { readonly kind: "inspect" }>
): Promise<void> {
    const request = openRequest(model, command.session, command.pin, command.restore);
    const existing = model.sessions.get(request.sessionId.value);
    const expected =
        existing === undefined
            ? "absent"
            : !sameOpenRequest(existing.request, request)
              ? "failed"
              : existing.state === "open"
                ? "ready"
                : "absent";
    expect((await withProvider(runtime, (provider) => provider.inspectSession(request))).name).toBe(
        expected
    );
}

async function executeWrite(
    model: ProviderModel,
    runtime: Runtime,
    command: Extract<Command, { readonly kind: "write" }>
): Promise<void> {
    const request = openRequest(model, command.session, command.pin, command.restore);
    const session = model.sessions.get(request.sessionId.value);
    const allowed =
        session !== undefined &&
        session.state === "open" &&
        sameOpenRequest(session.request, request);
    const path = PATHS[command.path]!;
    const bytes = new Uint8Array(command.bytes);
    const observed = await captureFailure(() =>
        withProvider(runtime, (provider) => provider.writeSessionFile(request, path, bytes))
    );
    expect(observed).toBe(allowed ? "succeeded" : "protocol.invalid-state");
    if (allowed) session.files.set(path, bytes.slice());

    if (command.retry) {
        const replay = await captureFailure(() =>
            withProvider(runtime, (provider) => provider.writeSessionFile(request, path, bytes))
        );
        expect(replay).toBe(observed);
        model.coverage.add("exactRetry");
    }
}

async function executeRead(
    model: ProviderModel,
    runtime: Runtime,
    command: Extract<Command, { readonly kind: "read" }>
): Promise<void> {
    const request = openRequest(model, command.session, command.pin, command.restore);
    const session = model.sessions.get(request.sessionId.value);
    const allowed =
        session !== undefined &&
        session.state === "open" &&
        sameOpenRequest(session.request, request);
    const path = PATHS[command.path]!;
    if (!allowed) {
        expect(
            await captureFailure(() =>
                withProvider(runtime, (provider) => provider.readSessionFile(request, path))
            )
        ).toBe("protocol.invalid-state");
        return;
    }
    expect(
        await withProvider(runtime, (provider) => provider.readSessionFile(request, path))
    ).toEqual(session.files.get(path));
}

async function executeSnapshot(
    model: ProviderModel,
    runtime: Runtime,
    command: Extract<Command, { readonly kind: "snapshot" }>
): Promise<void> {
    const request = snapshotRequest(
        command.session,
        command.snapshot,
        command.pin,
        command.sessionEpoch
    );
    const existing = model.snapshots.get(request.snapshotId.value);
    const session = model.sessions.get(request.sessionId.value);
    const exactSession = session !== undefined && sameSnapshotSession(session, request);
    const expected =
        existing !== undefined
            ? sameSnapshotRequest(existing.request, request)
                ? "ready"
                : "failed"
            : exactSession && session.state === "open"
              ? "ready"
              : "failed";
    const observed = await withProvider(runtime, (provider) => provider.createSnapshot(request));
    expect(observed.name).toBe(expected);

    if (existing === undefined && expected === "ready" && session !== undefined) {
        const files = cloneFiles(session.files);
        model.snapshots.set(request.snapshotId.value, {
            request,
            reference: snapshotReference(files),
            files
        });
        expect(projectResource(observed)).toEqual({
            name: "ready",
            value: snapshotReference(files).value
        });
    } else if (existing !== undefined && !sameSnapshotRequest(existing.request, request)) {
        model.coverage.add("conflictingSnapshot");
    } else if (existing === undefined) {
        if (session !== undefined && request.sessionEpoch !== 0) {
            model.coverage.add("staleSessionEpoch");
        }
        expect(
            (await withProvider(runtime, (provider) => provider.inspectSnapshot(request))).name
        ).toBe("absent");
    }

    if (command.retry) {
        expect(
            projectResource(
                await withProvider(runtime, (provider) => provider.createSnapshot(request))
            )
        ).toEqual(projectResource(observed));
        model.coverage.add("exactRetry");
    }
}

async function executeInspectSnapshot(
    model: ProviderModel,
    runtime: Runtime,
    command: Extract<Command, { readonly kind: "inspectSnapshot" }>
): Promise<void> {
    const request = snapshotRequest(
        command.session,
        command.snapshot,
        command.pin,
        command.sessionEpoch
    );
    const existing = model.snapshots.get(request.snapshotId.value);
    const expected =
        existing === undefined
            ? { name: "absent" }
            : sameSnapshotRequest(existing.request, request)
              ? { name: "ready", value: existing.reference.value }
              : { name: "failed" };
    expect(
        projectResource(
            await withProvider(runtime, (provider) => provider.inspectSnapshot(request))
        )
    ).toEqual(expected);
}

async function executeExpose(
    model: ProviderModel,
    runtime: Runtime,
    command: Extract<Command, { readonly kind: "expose" }>
): Promise<void> {
    const request = exposureRequest(
        command.session,
        command.exposure,
        command.pin,
        command.sessionEpoch,
        command.port
    );
    const existing = model.exposures.get(request.exposureId.value);
    const session = model.sessions.get(request.sessionId.value);
    const expected =
        existing !== undefined
            ? existing.state === "exposed" && sameExposureRequest(existing.request, request)
                ? { name: "ready", value: existing.url }
                : { name: "failed" }
            : session !== undefined &&
                session.state === "open" &&
                sameExposureSession(session, request)
              ? { name: "ready", value: previewUrl(request) }
              : { name: "failed" };
    const observed = await withProvider(runtime, (provider) => provider.exposePort(request));
    expect(projectResource(observed)).toEqual(expected);

    if (existing === undefined && expected.name === "ready") {
        model.exposures.set(request.exposureId.value, {
            request,
            url: previewUrl(request),
            state: "exposed"
        });
    } else if (existing !== undefined && !sameExposureRequest(existing.request, request)) {
        model.coverage.add("conflictingExposure");
    } else if (existing === undefined) {
        if (session !== undefined && request.sessionEpoch !== 0) {
            model.coverage.add("staleSessionEpoch");
        }
        expect(
            (await withProvider(runtime, (provider) => provider.inspectExposure(request))).name
        ).toBe("absent");
    }

    if (command.retry) {
        expect(
            projectResource(await withProvider(runtime, (provider) => provider.exposePort(request)))
        ).toEqual(projectResource(observed));
        model.coverage.add("exactRetry");
    }
}

async function executeRevoke(
    model: ProviderModel,
    runtime: Runtime,
    command: Extract<Command, { readonly kind: "revoke" }>
): Promise<void> {
    const request = exposureRequest(
        command.session,
        command.exposure,
        command.pin,
        command.sessionEpoch,
        command.port
    );
    const existing = model.exposures.get(request.exposureId.value);
    const exact = existing === undefined || sameExposureRequest(existing.request, request);
    const observed = await withProvider(runtime, (provider) => provider.revokeExposure(request));
    expect(observed.name).toBe(exact ? "succeeded" : "failed");
    if (existing === undefined) {
        model.exposures.set(request.exposureId.value, {
            request,
            url: previewUrl(request),
            state: "revoked"
        });
    } else if (exact) {
        existing.state = "revoked";
    } else {
        model.coverage.add("conflictingExposure");
    }

    if (command.retry) {
        expect(await withProvider(runtime, (provider) => provider.revokeExposure(request))).toEqual(
            observed
        );
        model.coverage.add("exactRetry");
    }
}

async function executeClose(
    model: ProviderModel,
    runtime: Runtime,
    command: Extract<Command, { readonly kind: "close" }>
): Promise<void> {
    const request = openRequest(model, command.session, command.pin, command.restore);
    const existing = model.sessions.get(request.sessionId.value);
    const exact = existing === undefined || sameOpenRequest(existing.request, request);
    const observed = await withProvider(runtime, (provider) => provider.closeSession(request));
    expect(observed.name).toBe(exact ? "succeeded" : "failed");
    if (existing === undefined) {
        model.sessions.set(request.sessionId.value, {
            request,
            files: new Map(),
            state: "closed"
        });
    } else if (exact && existing.state === "open") {
        existing.state = "closed";
        existing.files.clear();
        for (const exposure of model.exposures.values()) {
            if (exposure.request.sessionId.equals(request.sessionId)) exposure.state = "revoked";
        }
    } else if (!exact) {
        model.coverage.add("conflictingSession");
    }

    if (command.retry) {
        expect(await withProvider(runtime, (provider) => provider.closeSession(request))).toEqual(
            observed
        );
        model.coverage.add("exactRetry");
    }
}

async function assertObservableState(model: ProviderModel, runtime: Runtime): Promise<void> {
    await withProvider(runtime, async (provider) => {
        for (const session of model.sessions.values()) {
            const inspected = await provider.inspectSession(session.request);
            expect(inspected.name).toBe(session.state === "open" ? "ready" : "absent");
            expect((await provider.openSession(session.request)).name).toBe(
                session.state === "open" ? "ready" : "failed"
            );
            const conflicting = withPin(session.request, alternatePin(session.request));
            expect((await provider.openSession(conflicting)).name).toBe("failed");
            if (session.state === "open") {
                for (const path of PATHS) {
                    expect(provider.readSessionFile(session.request, path)).toEqual(
                        session.files.get(path)
                    );
                }
            } else {
                expect(
                    captureSynchronousFailure(() =>
                        provider.readSessionFile(session.request, PATHS[0])
                    )
                ).toBe("protocol.invalid-state");
            }
        }

        for (const snapshot of model.snapshots.values()) {
            expect(projectResource(await provider.inspectSnapshot(snapshot.request))).toEqual({
                name: "ready",
                value: snapshot.reference.value
            });
            expect(
                (
                    await provider.inspectSnapshot({
                        ...snapshot.request,
                        sessionId: new EnvironmentSessionId("session-conflict")
                    })
                ).name
            ).toBe("failed");
        }

        for (const exposure of model.exposures.values()) {
            expect(projectResource(await provider.inspectExposure(exposure.request))).toEqual(
                exposure.state === "exposed"
                    ? { name: "ready", value: exposure.url }
                    : { name: "absent" }
            );
            expect(projectResource(await provider.exposePort(exposure.request))).toEqual(
                exposure.state === "exposed"
                    ? { name: "ready", value: exposure.url }
                    : { name: "failed" }
            );
            expect(
                (
                    await provider.exposePort({
                        ...exposure.request,
                        port: exposure.request.port === 8080 ? 9090 : 8080
                    })
                ).name
            ).toBe("failed");
        }
    });
}

function requiredHistory(): readonly Command[] {
    return [
        { kind: "open", session: 0, pin: 0, restore: undefined, retry: true, evictAfter: true },
        {
            kind: "write",
            session: 0,
            pin: 0,
            restore: undefined,
            path: 0,
            bytes: [1, 2, 3],
            retry: true,
            evictAfter: false
        },
        { kind: "read", session: 0, pin: 0, restore: undefined, path: 0, evictAfter: false },
        {
            kind: "snapshot",
            session: 0,
            snapshot: 0,
            pin: 0,
            sessionEpoch: 0,
            retry: true,
            evictAfter: true
        },
        {
            kind: "inspectSnapshot",
            session: 0,
            snapshot: 0,
            pin: 0,
            sessionEpoch: 0,
            evictAfter: false
        },
        {
            kind: "expose",
            session: 0,
            exposure: 0,
            pin: 0,
            sessionEpoch: 0,
            port: 8080,
            retry: true,
            evictAfter: false
        },
        {
            kind: "revoke",
            session: 0,
            exposure: 0,
            pin: 0,
            sessionEpoch: 0,
            port: 8080,
            retry: true,
            evictAfter: true
        },
        { kind: "close", session: 0, pin: 0, restore: undefined, retry: true, evictAfter: true },
        { kind: "inspect", session: 0, pin: 0, restore: undefined, evictAfter: false },
        { kind: "open", session: 1, pin: 0, restore: 0, retry: true, evictAfter: true },
        { kind: "read", session: 1, pin: 0, restore: 0, path: 0, evictAfter: false },
        { kind: "open", session: 2, pin: 2, restore: undefined, retry: true, evictAfter: false },
        { kind: "open", session: 3, pin: 1, restore: undefined, retry: false, evictAfter: true },
        {
            kind: "write",
            session: 1,
            pin: 1,
            restore: 0,
            path: 1,
            bytes: [9],
            retry: false,
            evictAfter: false
        },
        {
            kind: "snapshot",
            session: 1,
            snapshot: 1,
            pin: 0,
            sessionEpoch: 1,
            retry: false,
            evictAfter: false
        },
        {
            kind: "expose",
            session: 1,
            exposure: 1,
            pin: 0,
            sessionEpoch: 1,
            port: 3000,
            retry: false,
            evictAfter: false
        },
        { kind: "open", session: 2, pin: 0, restore: undefined, retry: false, evictAfter: false },
        {
            kind: "snapshot",
            session: 1,
            snapshot: 0,
            pin: 0,
            sessionEpoch: 0,
            retry: false,
            evictAfter: false
        },
        {
            kind: "expose",
            session: 1,
            exposure: 0,
            pin: 0,
            sessionEpoch: 0,
            port: 9090,
            retry: false,
            evictAfter: false
        },
        { kind: "evict", evictAfter: false }
    ];
}

function openRequest(
    model: Readonly<ProviderModel>,
    session: number,
    pin: number,
    restore: number | undefined
): OpenSessionRequest {
    const snapshot = restore === undefined ? undefined : model.snapshots.get(snapshotId(restore));
    const reference =
        restore === undefined
            ? undefined
            : (snapshot?.reference ??
              ContentRef.fromDigest(
                  Digest.sha256(encodeCanonicalJson({ missingSnapshot: restore }))
              ));
    return Object.freeze({
        environmentId: ENVIRONMENT,
        environmentRevision: new Revision(PINS[pin]!.revision),
        generation: PINS[pin]!.generation,
        sessionId: new EnvironmentSessionId(sessionId(session)),
        ...(reference === undefined ? {} : { restore: reference })
    });
}

function snapshotRequest(
    session: number,
    snapshot: number,
    pin: number,
    epoch: number
): SnapshotEnvironmentRequest {
    return Object.freeze({
        environmentId: ENVIRONMENT,
        environmentRevision: new Revision(PINS[pin]!.revision),
        generation: PINS[pin]!.generation,
        sessionId: new EnvironmentSessionId(sessionId(session)),
        sessionEpoch: epoch,
        snapshotId: new EnvironmentSnapshotId(snapshotId(snapshot))
    });
}

function exposureRequest(
    session: number,
    exposure: number,
    pin: number,
    epoch: number,
    exposedPort: number
): ExposePortRequest {
    return Object.freeze({
        environmentId: ENVIRONMENT,
        environmentRevision: new Revision(PINS[pin]!.revision),
        generation: PINS[pin]!.generation,
        sessionId: new EnvironmentSessionId(sessionId(session)),
        sessionEpoch: epoch,
        exposureId: new PortExposureId(exposureId(exposure)),
        port: exposedPort
    });
}

function sessionId(value: number): string {
    return `session-${value}`;
}

function snapshotId(value: number): string {
    return `snapshot-${value}`;
}

function exposureId(value: number): string {
    return `exposure-${value}`;
}

function comparePin(
    current: (typeof PINS)[number] | undefined,
    candidate: (typeof PINS)[number]
): "current" | "advance" | "stale" {
    if (current === undefined) return "advance";
    if (current.revision === candidate.revision && current.generation === candidate.generation) {
        return "current";
    }
    return candidate.revision > current.revision && candidate.generation > current.generation
        ? "advance"
        : "stale";
}

function sameOpenRequest(left: OpenSessionRequest, right: OpenSessionRequest): boolean {
    return (
        samePin(left, right) &&
        left.sessionId.equals(right.sessionId) &&
        (left.restore?.value ?? null) === (right.restore?.value ?? null)
    );
}

function sameSnapshotSession(session: SessionModel, request: SnapshotEnvironmentRequest): boolean {
    return (
        samePin(session.request, request) &&
        session.request.sessionId.equals(request.sessionId) &&
        request.sessionEpoch === 0
    );
}

function sameSnapshotRequest(
    left: SnapshotEnvironmentRequest,
    right: SnapshotEnvironmentRequest
): boolean {
    return (
        samePin(left, right) &&
        left.sessionId.equals(right.sessionId) &&
        left.sessionEpoch === right.sessionEpoch &&
        left.snapshotId.equals(right.snapshotId)
    );
}

function sameExposureSession(session: SessionModel, request: ExposePortRequest): boolean {
    return (
        samePin(session.request, request) &&
        session.request.sessionId.equals(request.sessionId) &&
        request.sessionEpoch === 0
    );
}

function sameExposureRequest(left: ExposePortRequest, right: ExposePortRequest): boolean {
    return (
        samePin(left, right) &&
        left.sessionId.equals(right.sessionId) &&
        left.sessionEpoch === right.sessionEpoch &&
        left.exposureId.equals(right.exposureId) &&
        left.port === right.port
    );
}

function samePin(
    left: Pick<OpenSessionRequest, "environmentId" | "environmentRevision" | "generation">,
    right: Pick<OpenSessionRequest, "environmentId" | "environmentRevision" | "generation">
): boolean {
    return (
        left.environmentId.equals(right.environmentId) &&
        left.environmentRevision.equals(right.environmentRevision) &&
        left.generation === right.generation
    );
}

function snapshotReference(files: ReadonlyMap<string, Uint8Array>): ContentRef {
    const encodedFiles: Record<string, string> = {};
    for (const [path, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
        encodedFiles[path] = encodeBase64(bytes);
    }
    return ContentRef.fromDigest(
        Digest.sha256(encodeCanonicalJson({ files: encodedFiles, format: SNAPSHOT_FORMAT }))
    );
}

function previewUrl(request: ExposePortRequest): string {
    const token = Digest.sha256(
        encodeCanonicalJson({
            environmentId: request.environmentId.value,
            environmentRevision: request.environmentRevision.value,
            exposureId: request.exposureId.value,
            generation: request.generation,
            port: request.port,
            sessionEpoch: request.sessionEpoch,
            sessionId: request.sessionId.value
        })
    ).value;
    return `https://${token.slice(0, 32)}.${token.slice(32)}.${PREVIEW_HOST}/`;
}

function cloneFiles(files: ReadonlyMap<string, Uint8Array> | undefined): Map<string, Uint8Array> {
    return new Map([...(files ?? [])].map(([path, bytes]) => [path, bytes.slice()]));
}

function alternatePin(request: OpenSessionRequest): (typeof PINS)[number] {
    return request.generation === 0 ? PINS[1] : PINS[0];
}

function withPin(request: OpenSessionRequest, pin: (typeof PINS)[number]): OpenSessionRequest {
    return Object.freeze({
        ...request,
        environmentRevision: new Revision(pin.revision),
        generation: pin.generation
    });
}

async function withProvider<Result>(
    runtime: Runtime,
    operation: (provider: DurableObjectEnvironmentProvider) => Result | Promise<Result>
): Promise<Result> {
    return runInDurableObject(runtime.stub, (instance) => operation(instance.environments));
}

function projectResource(outcome: { readonly name: string; readonly value?: unknown }): {
    readonly name: string;
    readonly value?: string;
} {
    if (!("value" in outcome)) return { name: outcome.name };
    if (typeof outcome.value === "string") return { name: outcome.name, value: outcome.value };
    if (outcome.value instanceof ContentRef)
        return { name: outcome.name, value: outcome.value.value };
    return { name: outcome.name };
}

async function captureFailure(operation: () => Promise<unknown>): Promise<string> {
    try {
        await operation();
        return "succeeded";
    } catch (error) {
        return errorCode(error);
    }
}

function captureSynchronousFailure(operation: () => unknown): string {
    try {
        operation();
        return "succeeded";
    } catch (error) {
        return errorCode(error);
    }
}

function errorCode(error: unknown): string {
    if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
    ) {
        return error.code;
    }
    throw error;
}
