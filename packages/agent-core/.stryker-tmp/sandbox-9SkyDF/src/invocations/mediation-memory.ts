// @ts-nocheck
import { Digest } from "../core";
import { AgentCoreError } from "../errors";
import { AuditRecord } from "./audit";
import type { InvocationEvidencePersistence, InvocationReplayPersistence } from "./ports";
import { InvocationPublicationOutbox } from "./publication";
import { MediatedReplayRecord } from "./replay";

export interface InvocationMediationMemoryState {
    readonly replays: Map<string, Uint8Array>;
    readonly replayRevision: Map<string, number>;
    readonly replayByRequest: Map<string, string>;
    readonly audits: Map<string, Uint8Array>;
    readonly publications: Map<string, Uint8Array>;
}

export function createInvocationMediationMemoryState(): InvocationMediationMemoryState {
    return {
        replays: new Map(),
        replayRevision: new Map(),
        replayByRequest: new Map(),
        audits: new Map(),
        publications: new Map()
    };
}

export function cloneInvocationMediationMemoryState(
    state: InvocationMediationMemoryState
): InvocationMediationMemoryState {
    return {
        replays: cloneBytes(state.replays),
        replayRevision: new Map(state.replayRevision),
        replayByRequest: new Map(state.replayByRequest),
        audits: cloneBytes(state.audits),
        publications: cloneBytes(state.publications)
    };
}

export class MemoryInvocationMediationPersistence
    implements
        InvocationReplayPersistence<InvocationMediationMemoryState>,
        InvocationEvidencePersistence<InvocationMediationMemoryState>
{
    public replay(
        transaction: InvocationMediationMemoryState,
        scope: string,
        requestKey: string
    ): MediatedReplayRecord | undefined {
        const id = transaction.replayByRequest.get(requestIdentity(scope, requestKey));
        return id === undefined ? undefined : this.replayById(transaction, new Digest(id));
    }

    public replayById(
        transaction: InvocationMediationMemoryState,
        id: Digest
    ): MediatedReplayRecord | undefined {
        const revision = transaction.replayRevision.get(id.value);
        if (revision === undefined) return undefined;
        const bytes = transaction.replays.get(revisionKey(id.value, revision));
        if (bytes === undefined) corrupt("Replay revision index is corrupt");
        const record = MediatedReplayRecord.decode(bytes.slice());
        if (!record.id.equals(id) || record.revision.value !== revision) {
            corrupt("Replay projection does not match codec bytes");
        }
        return record;
    }

    public appendReplay(
        transaction: InvocationMediationMemoryState,
        record: MediatedReplayRecord
    ): void {
        const request = requestIdentity(record.scope, record.requestKey);
        const currentId = transaction.replayByRequest.get(request);
        const currentRevision = transaction.replayRevision.get(record.id.value);
        if (record.revision.value === 0) {
            if (currentId !== undefined || currentRevision !== undefined)
                duplicate("Replay reservation exists");
            transaction.replayByRequest.set(request, record.id.value);
        } else if (currentId !== record.id.value || currentRevision !== record.revision.value - 1) {
            duplicate("Replay revision is not the next reserved transition");
        }
        const key = revisionKey(record.id.value, record.revision.value);
        if (transaction.replays.has(key)) duplicate("Replay revision exists");
        transaction.replays.set(key, MediatedReplayRecord.encode(record));
        transaction.replayRevision.set(record.id.value, record.revision.value);
    }

    public appendAudit(transaction: InvocationMediationMemoryState, record: AuditRecord): void {
        if (transaction.audits.has(record.id.value)) duplicate("Audit record exists");
        transaction.audits.set(record.id.value, AuditRecord.encode(record));
    }

    public audit(
        transaction: InvocationMediationMemoryState,
        id: AuditRecord["id"]
    ): AuditRecord | undefined {
        const bytes = transaction.audits.get(id.value);
        if (bytes === undefined) return undefined;
        const record = AuditRecord.decode(bytes.slice());
        if (!record.id.equals(id)) corrupt("Audit projection does not match codec bytes");
        return record;
    }

    public publication(
        transaction: InvocationMediationMemoryState,
        id: Digest
    ): InvocationPublicationOutbox | undefined {
        const bytes = transaction.publications.get(id.value);
        if (bytes === undefined) return undefined;
        const record = InvocationPublicationOutbox.decode(bytes.slice());
        if (!record.id.equals(id)) corrupt("Publication projection does not match codec bytes");
        return record;
    }

    public pendingPublications(
        transaction: InvocationMediationMemoryState
    ): readonly InvocationPublicationOutbox[] {
        return Object.freeze(
            [...transaction.publications.values()]
                .map((bytes) => InvocationPublicationOutbox.decode(bytes.slice()))
                .filter((record) => record.state.kind === "pending")
                .sort((left, right) => left.id.value.localeCompare(right.id.value))
        );
    }

    public appendPublication(
        transaction: InvocationMediationMemoryState,
        record: InvocationPublicationOutbox
    ): void {
        const current = this.publication(transaction, record.id);
        if (
            (current === undefined && record.revision.value !== 0) ||
            (current !== undefined && !record.follows(current))
        ) {
            duplicate("Publication revision is not the next transition");
        }
        transaction.publications.set(record.id.value, InvocationPublicationOutbox.encode(record));
    }
}

function requestIdentity(scope: string, requestKey: string): string {
    return `${scope}\u0000${requestKey}`;
}

function revisionKey(id: string, revision: number): string {
    return `${id}\u0000${revision}`;
}

function cloneBytes(values: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
    return new Map([...values].map(([key, bytes]) => [key, bytes.slice()]));
}

function duplicate(message: string): never {
    throw new AgentCoreError("invocation.invalid", message);
}

function corrupt(message: string): never {
    throw new AgentCoreError("codec.invalid", message);
}
