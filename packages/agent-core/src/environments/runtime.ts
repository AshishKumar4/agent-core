import type { LeaseToken, TurnLeaseVerifier } from "../agents";
import { ContentRef, Revision } from "../core";
import { AgentCoreError } from "../errors";
import { Environment, EnvironmentRevisionRecord } from "./environment";
import { advanceRevision, increment } from "./data";
import { PortExposure, PortExposureState } from "./exposure";
import type {
    EnvironmentId,
    EnvironmentSessionId,
    EnvironmentSnapshotId,
    PortExposureId
} from "./id";
import {
    EnvironmentProviderRegistry,
    ProviderActionOutcome,
    ProviderResourceOutcome,
    requireProviderActionOutcome,
    requireProviderResourceOutcome,
    type EnvironmentProvider,
    type ExposePortRequest,
    type LiveEnvironmentSession,
    type OpenSessionRequest,
    type ProviderActionOutcome as ActionOutcome,
    type ProviderResourceOutcome as ResourceOutcome,
    type ProviderDescriptor,
    type SnapshotEnvironmentRequest
} from "./provider";
import {
    EnvironmentSession,
    EnvironmentSessionState,
    type EnvironmentSessionCapability
} from "./session";
import { EnvironmentSnapshot, EnvironmentSnapshotState } from "./snapshot";
import { EnvironmentStore } from "./store";

export class EnvironmentController {
    readonly #liveSessions = new Map<string, LiveEnvironmentSession>();
    readonly #disposedSessions = new WeakSet<object>();
    readonly #pendingOpens = new Map<string, Promise<EnvironmentSession>>();

    public constructor(
        private readonly store: EnvironmentStore,
        private readonly providers: EnvironmentProviderRegistry,
        private readonly leases: TurnLeaseVerifier
    ) {}

    public provision(revision: EnvironmentRevisionRecord, lease: LeaseToken): Environment {
        this.requireLease(lease);
        if (revision.revision.value !== 0 || revision.generation !== 0) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Initial Environment revision and generation must both be zero"
            );
        }
        const environment = new Environment(
            revision.environmentId,
            revision.revision,
            revision.generation,
            Revision.initial()
        );
        if (!this.store.compareAndSetEnvironment(undefined, revision, environment)) {
            const current = this.store.getEnvironment(revision.environmentId);
            const storedRevision = this.store.getRevision(
                revision.environmentId,
                revision.revision
            );
            if (
                current === undefined ||
                !current.activeRevision.equals(environment.activeRevision) ||
                current.generation !== environment.generation ||
                storedRevision === undefined ||
                !sameRevision(storedRevision, revision)
            ) {
                throw revisionConflict("Environment was provisioned concurrently");
            }
            return current;
        }
        return environment;
    }

    public rotate(
        environmentId: EnvironmentId,
        provider: ProviderDescriptor,
        lease: LeaseToken
    ): Environment {
        this.requireLease(lease);
        const current = this.requireEnvironment(environmentId);
        const revision = new EnvironmentRevisionRecord(
            environmentId,
            advanceRevision(current.activeRevision, "Environment revision"),
            increment(current.generation, "Environment generation"),
            provider
        );
        const rotated = current.rotate(revision);
        if (!this.store.compareAndSetEnvironment(current.recordRevision, revision, rotated)) {
            throw revisionConflict("Environment rotation lost its head CAS");
        }
        return rotated;
    }

    public reserveSession(
        environmentId: EnvironmentId,
        sessionId: EnvironmentSessionId,
        lease: LeaseToken,
        restoreFrom?: EnvironmentSnapshotId
    ): EnvironmentSession {
        this.requireLease(lease);
        const environment = this.requireEnvironment(environmentId);
        const session = new EnvironmentSession(
            sessionId,
            environmentId,
            environment.activeRevision,
            environment.generation,
            0,
            EnvironmentSessionState.reserved,
            restoreFrom,
            Revision.initial()
        );
        if (!this.store.compareAndSetSession(undefined, session)) {
            const existing = this.store.getSession(sessionId);
            if (existing === undefined || !sameReservation(existing, session)) {
                throw new AgentCoreError(
                    "environment.invalid-session",
                    "Environment session ID is already reserved for another generation"
                );
            }
            return existing;
        }
        return session;
    }

    public async openSession(
        capability: EnvironmentSessionCapability,
        lease: LeaseToken
    ): Promise<EnvironmentSession> {
        this.requireLease(lease);
        const current = this.requireCapability(capability);
        if (current.state.name === "open") return current;
        const provider = this.providerFor(current);
        const request = this.openRequest(current);
        const opening = current.beginOpen();
        this.persistSession(current, opening);
        return this.coalesceOpen(opening, async () =>
            this.settleOpen(
                opening,
                await this.callResource(() => provider.openSession(request), isLiveSession)
            )
        );
    }

    public async reconcileSession(
        sessionId: EnvironmentSessionId,
        lease: LeaseToken
    ): Promise<EnvironmentSession> {
        this.requireLease(lease);
        const session = this.requireSession(sessionId);
        if (session.state.name === "opening") {
            return this.coalesceOpen(session, async () => {
                const provider = this.providerFor(session);
                const request = this.openRequest(session);
                const inspected = await this.callResource(
                    () => provider.inspectSession(request),
                    isLiveSession
                );
                if (inspected.name === "absent") {
                    return this.settleOpen(
                        session,
                        await this.callResource(() => provider.openSession(request), isLiveSession)
                    );
                }
                return this.settleOpen(session, inspected);
            });
        }
        if (session.state.name === "closing") return this.continueClose(session);
        if (session.state.name === "open") {
            const provider = this.providerFor(session);
            const request = this.openRequest(session);
            const outcome = await this.callResource(
                () => provider.inspectSession(request),
                isLiveSession
            );
            if (outcome.name === "ready") this.replaceLiveSession(session.id, outcome.value);
            if (outcome.name === "absent") {
                const lost = this.markSessionLost(session);
                await this.disposeLiveSession(session.id);
                return lost;
            }
        }
        return this.requireSession(sessionId);
    }

    public session(capability: EnvironmentSessionCapability): EnvironmentSession {
        const session = this.requireCapability(capability);
        session.assertUsable();
        return session;
    }

    public async closeSession(
        capability: EnvironmentSessionCapability,
        lease: LeaseToken
    ): Promise<EnvironmentSession> {
        this.requireLease(lease);
        const current = this.requireCapability(capability, true);
        if (current.state.name === "closed") return current;
        const closing = current.beginClose();
        this.persistSession(current, closing);

        return this.continueClose(closing);
    }

    public async snapshot(
        capability: EnvironmentSessionCapability,
        snapshotId: EnvironmentSnapshotId,
        lease: LeaseToken
    ): Promise<EnvironmentSnapshot> {
        this.requireLease(lease);
        const session = this.requireCapability(capability);
        session.assertUsable();
        const provider = this.providerFor(session);
        const snapshot = new EnvironmentSnapshot(
            snapshotId,
            session.environmentId,
            session.id,
            session.environmentRevision,
            session.generation,
            EnvironmentSnapshotState.creating,
            undefined,
            Revision.initial()
        );
        if (!this.store.compareAndSetSnapshot(undefined, snapshot)) {
            const existing = this.store.getSnapshot(snapshotId);
            if (existing === undefined || !sameSnapshotRequest(existing, snapshot)) {
                throw new AgentCoreError(
                    "environment.invalid-session",
                    "Environment snapshot ID is already used by another session generation"
                );
            }
            return existing;
        }
        return this.settleSnapshot(
            snapshot,
            await this.callResource(
                () => provider.createSnapshot(this.snapshotRequest(snapshot)),
                isContentRef
            )
        );
    }

    public async reconcileSnapshot(
        snapshotId: EnvironmentSnapshotId,
        lease: LeaseToken
    ): Promise<EnvironmentSnapshot> {
        this.requireLease(lease);
        const snapshot = this.requireSnapshot(snapshotId);
        if (snapshot.state.name !== "creating") return snapshot;
        const provider = this.providerForSnapshot(snapshot);
        const request = this.snapshotRequest(snapshot);
        const inspected = await this.callResource(
            () => provider.inspectSnapshot(request),
            isContentRef
        );
        if (inspected.name === "absent") {
            return this.settleSnapshot(
                snapshot,
                await this.callResource(() => provider.createSnapshot(request), isContentRef)
            );
        }
        return this.settleSnapshot(snapshot, inspected);
    }

    public async expose(
        capability: EnvironmentSessionCapability,
        exposureId: PortExposureId,
        port: number,
        lease: LeaseToken
    ): Promise<PortExposure> {
        this.requireLease(lease);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Port exposure port must be between 1 and 65535"
            );
        }
        const session = this.requireCapability(capability);
        session.assertUsable();
        const provider = this.providerFor(session);
        const exposure = new PortExposure(
            exposureId,
            session.environmentId,
            session.id,
            session.environmentRevision,
            session.generation,
            session.epoch,
            port,
            PortExposureState.exposing,
            undefined,
            Revision.initial()
        );
        if (!this.store.compareAndSetExposure(undefined, exposure)) {
            const existing = this.store.getExposure(exposureId);
            if (existing === undefined || !sameExposureRequest(existing, exposure)) {
                throw new AgentCoreError(
                    "environment.invalid-session",
                    "Port exposure ID is already used by another session generation"
                );
            }
            return existing;
        }
        return this.settleExposure(
            exposure,
            await this.callResource(
                () => provider.exposePort(this.exposureRequest(exposure)),
                isString
            )
        );
    }

    public async reconcileExposure(
        exposureId: PortExposureId,
        lease: LeaseToken
    ): Promise<PortExposure> {
        this.requireLease(lease);
        const exposure = this.requireExposure(exposureId);
        const provider = this.providerForExposure(exposure);
        const request = this.exposureRequest(exposure);
        if (exposure.state.name === "exposing") {
            const inspected = await this.callResource(
                () => provider.inspectExposure(request),
                isString
            );
            if (inspected.name === "absent") {
                return this.settleExposure(
                    exposure,
                    await this.callResource(() => provider.exposePort(request), isString)
                );
            }
            return this.settleExposure(exposure, inspected);
        }
        if (exposure.state.name === "revoking") {
            const inspected = await this.callResource(
                () => provider.inspectExposure(request),
                isString
            );
            if (inspected.name === "absent") return this.markExposureRevoked(exposure);
            return this.revokeExposureRecord(exposure);
        }
        return exposure;
    }

    public async revoke(
        capability: EnvironmentSessionCapability,
        exposureId: PortExposureId,
        lease: LeaseToken
    ): Promise<PortExposure> {
        this.requireLease(lease);
        const session = this.requireCapability(capability);
        const exposure = this.requireExposure(exposureId);
        if (!exposure.sessionId.equals(session.id) || exposure.sessionEpoch !== capability.epoch) {
            throw staleSession(
                "Port exposure does not belong to the exact Environment session capability"
            );
        }
        return this.revokeExposureRecord(exposure);
    }

    private async settleOpen(
        attempted: EnvironmentSession,
        outcome: ResourceOutcome<LiveEnvironmentSession>
    ): Promise<EnvironmentSession> {
        const current = this.requireSession(attempted.id);
        if (outcome.name === "ready") {
            if (current.state.name === "open") {
                await this.disposeHandle(outcome.value);
                return current;
            }
            if (current.state.name === "closing") {
                this.replaceLiveSession(current.id, outcome.value);
                return this.continueClose(current);
            }
            if (current.state.name !== "opening" || current.epoch !== attempted.epoch) {
                await this.disposeHandle(outcome.value);
                await this.closeProviderSession(attempted);
                return this.requireSession(attempted.id);
            }
            const opened = current.opened();
            this.persistSession(current, opened);
            this.replaceLiveSession(opened.id, outcome.value);
            return opened;
        }
        if (outcome.name === "failed" || outcome.name === "absent") {
            if (current.state.name !== "opening") return current;
            const failed = current.failOpen();
            this.persistSession(current, failed);
            return failed;
        }
        return current;
    }

    private async finishClose(attempted: EnvironmentSession): Promise<EnvironmentSession> {
        const current = this.requireSession(attempted.id);
        if (current.state.name === "closed") return current;
        if (current.state.name !== "closing") return current;
        if (
            this.store
                .listExposures(current.id)
                .some((exposure) => exposure.state.name !== "revoked")
        ) {
            return current;
        }
        const provider = this.providerFor(current);
        const request = this.openRequest(current);
        const inspected = await this.callResource(
            () => provider.inspectSession(request),
            isLiveSession
        );
        if (inspected.name === "ready") {
            await this.disposeHandle(inspected.value);
        }
        const outcome = await this.callAction(() => provider.closeSession(request));
        return outcome.name === "succeeded" ? this.markSessionClosed(current) : current;
    }

    private async continueClose(attempted: EnvironmentSession): Promise<EnvironmentSession> {
        const current = this.requireSession(attempted.id);
        if (current.state.name === "closed") return current;
        if (current.state.name !== "closing") return current;

        // The session epoch is already durable here; every child cleanup happens behind that fence.
        for (const exposure of this.store.listExposures(current.id)) {
            if (exposure.state.name !== "revoked") await this.revokeExposureRecord(exposure);
        }
        if (
            this.store
                .listExposures(current.id)
                .some((exposure) => exposure.state.name !== "revoked")
        ) {
            return this.requireSession(current.id);
        }
        await this.disposeLiveSession(current.id);
        return this.finishClose(current);
    }

    private markSessionClosed(session: EnvironmentSession): EnvironmentSession {
        const current = this.requireSession(session.id);
        if (current.state.name === "closed") return current;
        if (current.state.name !== "closing") return current;
        const closed = current.closed();
        this.persistSession(current, closed);
        return closed;
    }

    private markSessionLost(session: EnvironmentSession): EnvironmentSession {
        const current = this.requireSession(session.id);
        if (current.state.name !== "open") return current;
        const lost = current.lost();
        this.persistSession(current, lost);
        return lost;
    }

    private settleSnapshot(
        attempted: EnvironmentSnapshot,
        outcome: ResourceOutcome<ContentRef>
    ): EnvironmentSnapshot {
        const current = this.requireSnapshot(attempted.id);
        if (current.state.name !== "creating") return current;
        if (outcome.name === "ready") {
            const ready = current.ready(outcome.value);
            this.persistSnapshot(current, ready);
            return ready;
        }
        if (outcome.name === "failed") {
            const failed = current.fail();
            this.persistSnapshot(current, failed);
            return failed;
        }
        return current;
    }

    private async settleExposure(
        attempted: PortExposure,
        outcome: ResourceOutcome<string>
    ): Promise<PortExposure> {
        const current = this.requireExposure(attempted.id);
        if (outcome.name === "ready") {
            if (current.state.name !== "exposing") {
                const provider = this.providerForExposure(current);
                const request = this.exposureRequest(current);
                const cleanup = await this.callAction(() => provider.revokeExposure(request));
                if (current.state.name === "revoking" && cleanup.name === "succeeded") {
                    return this.markExposureRevoked(current);
                }
                return this.requireExposure(current.id);
            }
            const exposed = current.exposed(outcome.value);
            this.persistExposure(current, exposed);
            return exposed;
        }
        if (outcome.name === "failed" && current.state.name === "exposing") {
            const failed = current.fail();
            this.persistExposure(current, failed);
            return failed;
        }
        return current;
    }

    private async revokeExposureRecord(exposure: PortExposure): Promise<PortExposure> {
        const current = this.requireExposure(exposure.id);
        if (current.state.name === "revoked") return current;
        const provider = this.providerForExposure(current);
        const request = this.exposureRequest(current);
        const revoking = current.beginRevoke();
        this.persistExposure(current, revoking);
        const outcome = await this.callAction(() => provider.revokeExposure(request));
        return outcome.name === "succeeded" ? this.markExposureRevoked(revoking) : revoking;
    }

    private markExposureRevoked(exposure: PortExposure): PortExposure {
        const current = this.requireExposure(exposure.id);
        if (current.state.name === "revoked") return current;
        if (current.state.name !== "revoking") return current;
        const revoked = current.revoked();
        this.persistExposure(current, revoked);
        return revoked;
    }

    private requireCapability(
        capability: EnvironmentSessionCapability,
        allowCloseReplay = false
    ): EnvironmentSession {
        const session = this.requireSession(capability.sessionId);
        const closeReplay =
            allowCloseReplay &&
            (session.state.name === "closing" || session.state.name === "closed") &&
            session.epoch === capability.epoch + 1;
        if (
            !session.environmentId.equals(capability.environmentId) ||
            !session.environmentRevision.equals(capability.environmentRevision) ||
            (!closeReplay && session.epoch !== capability.epoch)
        ) {
            throw staleSession(
                "Environment session capability is stale or belongs to another session"
            );
        }
        return session;
    }

    private requireEnvironment(id: EnvironmentId): Environment {
        const environment = this.store.getEnvironment(id);
        if (environment === undefined) {
            throw new AgentCoreError("environment.invalid-session", "Environment does not exist");
        }
        return environment;
    }

    private requireSession(id: EnvironmentSessionId): EnvironmentSession {
        const session = this.store.getSession(id);
        if (session === undefined) {
            throw new AgentCoreError(
                "environment.invalid-session",
                "Environment session does not exist"
            );
        }
        return session;
    }

    private requireSnapshot(id: EnvironmentSnapshotId): EnvironmentSnapshot {
        const snapshot = this.store.getSnapshot(id);
        if (snapshot === undefined) {
            throw new AgentCoreError(
                "environment.invalid-session",
                "Environment snapshot does not exist"
            );
        }
        return snapshot;
    }

    private requireExposure(id: PortExposureId): PortExposure {
        const exposure = this.store.getExposure(id);
        if (exposure === undefined) {
            throw new AgentCoreError("environment.invalid-session", "Port exposure does not exist");
        }
        return exposure;
    }

    private providerFor(session: EnvironmentSession): EnvironmentProvider {
        return this.resolveProvider(
            session.environmentId,
            session.environmentRevision,
            session.generation
        );
    }

    private providerForSnapshot(snapshot: EnvironmentSnapshot): EnvironmentProvider {
        return this.resolveProvider(
            snapshot.environmentId,
            snapshot.environmentRevision,
            snapshot.generation
        );
    }

    private providerForExposure(exposure: PortExposure): EnvironmentProvider {
        return this.resolveProvider(
            exposure.environmentId,
            exposure.environmentRevision,
            exposure.generation
        );
    }

    private resolveProvider(
        environmentId: EnvironmentId,
        revision: Revision,
        generation: number
    ): EnvironmentProvider {
        const record = this.store.getRevision(environmentId, revision);
        if (record === undefined || record.generation !== generation) {
            throw new AgentCoreError(
                "environment.stale-session",
                "Environment resource does not pin an exact provider generation"
            );
        }
        const provider = this.providers.resolve(record.provider);
        if (provider === undefined) {
            throw new AgentCoreError(
                "environment.invalid-session",
                "No provider is registered for the pinned Environment revision"
            );
        }
        return provider;
    }

    private openRequest(session: EnvironmentSession): OpenSessionRequest {
        const base = {
            environmentId: session.environmentId,
            environmentRevision: session.environmentRevision,
            generation: session.generation,
            sessionId: session.id
        };
        if (session.restoreFrom === undefined) return Object.freeze(base);
        const snapshot = this.requireSnapshot(session.restoreFrom);
        if (snapshot.content === undefined) {
            throw new AgentCoreError(
                "environment.invalid-session",
                "Restore snapshot is not ready"
            );
        }
        return Object.freeze({ ...base, restore: snapshot.content });
    }

    private snapshotRequest(snapshot: EnvironmentSnapshot): SnapshotEnvironmentRequest {
        return Object.freeze({
            environmentId: snapshot.environmentId,
            environmentRevision: snapshot.environmentRevision,
            generation: snapshot.generation,
            sessionId: snapshot.sessionId,
            snapshotId: snapshot.id
        });
    }

    private exposureRequest(exposure: PortExposure): ExposePortRequest {
        return Object.freeze({
            environmentId: exposure.environmentId,
            environmentRevision: exposure.environmentRevision,
            generation: exposure.generation,
            sessionId: exposure.sessionId,
            exposureId: exposure.id,
            port: exposure.port
        });
    }

    private persistSession(current: EnvironmentSession, next: EnvironmentSession): void {
        if (current === next) return;
        if (!this.store.compareAndSetSession(current.recordRevision, next)) {
            throw revisionConflict("Environment session CAS failed");
        }
    }

    private persistSnapshot(current: EnvironmentSnapshot, next: EnvironmentSnapshot): void {
        if (current === next) return;
        if (!this.store.compareAndSetSnapshot(current.recordRevision, next)) {
            throw revisionConflict("Environment snapshot CAS failed");
        }
    }

    private persistExposure(current: PortExposure, next: PortExposure): void {
        if (current === next) return;
        if (!this.store.compareAndSetExposure(current.recordRevision, next)) {
            throw revisionConflict("Port exposure CAS failed");
        }
    }

    private async closeProviderSession(session: EnvironmentSession): Promise<ActionOutcome> {
        const provider = this.providerFor(session);
        const request = this.openRequest(session);
        return this.callAction(() => provider.closeSession(request));
    }

    private coalesceOpen(
        session: EnvironmentSession,
        operation: () => Promise<EnvironmentSession>
    ): Promise<EnvironmentSession> {
        const existing = this.#pendingOpens.get(session.id.value);
        if (existing !== undefined) return existing;
        const pending = Promise.resolve().then(operation);
        this.#pendingOpens.set(session.id.value, pending);
        const clear = (): void => {
            if (this.#pendingOpens.get(session.id.value) === pending) {
                this.#pendingOpens.delete(session.id.value);
            }
        };
        void pending.then(clear, clear);
        return pending;
    }

    private replaceLiveSession(id: EnvironmentSessionId, handle: LiveEnvironmentSession): void {
        const previous = this.#liveSessions.get(id.value);
        this.#liveSessions.set(id.value, handle);
        if (previous !== undefined && previous !== handle) void this.disposeHandle(previous);
    }

    private async disposeLiveSession(id: EnvironmentSessionId): Promise<void> {
        const handle = this.#liveSessions.get(id.value);
        this.#liveSessions.delete(id.value);
        if (handle !== undefined) await this.disposeHandle(handle);
    }

    private async disposeHandle(handle: LiveEnvironmentSession): Promise<void> {
        if (this.#disposedSessions.has(handle)) return;
        this.#disposedSessions.add(handle);
        for (const child of handle.children) {
            try {
                await child.dispose();
            } catch {
                // Provider close remains the final cleanup layer if a child disposer fails.
            }
        }
        try {
            await handle.release();
        } catch {
            // Provider close remains the final cleanup layer if local handle release fails.
        }
    }

    private async callAction(call: () => Promise<ActionOutcome>): Promise<ActionOutcome> {
        let outcome: unknown;
        try {
            outcome = await call();
        } catch {
            return ProviderActionOutcome.indeterminate;
        }
        return requireProviderActionOutcome(outcome);
    }

    private async callResource<Value>(
        call: () => Promise<ResourceOutcome<Value>>,
        isReadyValue: (candidate: unknown) => candidate is Value
    ): Promise<ResourceOutcome<Value>> {
        let outcome: unknown;
        try {
            outcome = await call();
        } catch {
            return ProviderResourceOutcome.indeterminate;
        }
        return requireProviderResourceOutcome(outcome, isReadyValue);
    }

    private requireLease(lease: LeaseToken): void {
        if (!this.leases.permits(lease)) {
            throw new AgentCoreError(
                "lease.invalid",
                "Environment operation requires a live exact-Turn lease"
            );
        }
    }
}

export { EnvironmentController as EnvironmentRuntime };

function sameReservation(left: EnvironmentSession, right: EnvironmentSession): boolean {
    return (
        left.environmentId.equals(right.environmentId) &&
        left.environmentRevision.equals(right.environmentRevision) &&
        left.generation === right.generation &&
        (left.restoreFrom === undefined
            ? right.restoreFrom === undefined
            : right.restoreFrom !== undefined && left.restoreFrom.equals(right.restoreFrom))
    );
}

function sameRevision(left: EnvironmentRevisionRecord, right: EnvironmentRevisionRecord): boolean {
    return (
        left.environmentId.equals(right.environmentId) &&
        left.revision.equals(right.revision) &&
        left.generation === right.generation &&
        left.provider.equals(right.provider)
    );
}

function sameSnapshotRequest(left: EnvironmentSnapshot, right: EnvironmentSnapshot): boolean {
    return (
        left.environmentId.equals(right.environmentId) &&
        left.sessionId.equals(right.sessionId) &&
        left.environmentRevision.equals(right.environmentRevision) &&
        left.generation === right.generation
    );
}

function sameExposureRequest(left: PortExposure, right: PortExposure): boolean {
    return (
        left.environmentId.equals(right.environmentId) &&
        left.sessionId.equals(right.sessionId) &&
        left.environmentRevision.equals(right.environmentRevision) &&
        left.generation === right.generation &&
        left.sessionEpoch === right.sessionEpoch &&
        left.port === right.port
    );
}

function staleSession(message: string): AgentCoreError {
    return new AgentCoreError("environment.stale-session", message);
}

function revisionConflict(message: string): AgentCoreError {
    return new AgentCoreError("protocol.revision-conflict", message);
}

function isContentRef(value: unknown): value is ContentRef {
    return value instanceof ContentRef;
}

function isLiveSession(value: unknown): value is LiveEnvironmentSession {
    if (value === null || typeof value !== "object") return false;
    try {
        const session = value as { readonly children?: unknown; readonly release?: unknown };
        return (
            Array.isArray(session.children) &&
            session.children.every(
                (child) =>
                    child !== null &&
                    typeof child === "object" &&
                    typeof (child as { readonly dispose?: unknown }).dispose === "function"
            ) &&
            typeof session.release === "function"
        );
    } catch {
        return false;
    }
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}
