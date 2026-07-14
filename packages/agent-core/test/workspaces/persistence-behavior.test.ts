import { describe, expect, test } from "vitest";
import { EventId } from "../../src/interaction-references";
import { Event } from "../../src/workspaces/event";
import { MemoryWorkspaceRecords } from "../../src/workspaces/memory";
import { WorkspacePersistence } from "../../src/workspaces/persistence";
import type { ContentRetentionPort } from "../../src/workspaces/retention";
import { eventFixture, eventRetention, sourceActor, tenant } from "./fixtures";

class DurableRetention implements ContentRetentionPort<MemoryWorkspaceRecords> {
    public verify(): boolean {
        return true;
    }

    public release(): void {}

    public discard(): void {}
}

describe("workspace persistence behavior", () => {
    test("restarts from durable records and rejects duplicate and conflicting identities", () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = workspacePersistence();
        const event = eventFixture("persistence-restart");
        persistence.appendEvent(records, event, eventRetention(event));

        const restartedRecords = new MemoryWorkspaceRecords(records.snapshot());
        const restarted = workspacePersistence();
        expect(restarted.findEvent(restartedRecords, event.id)).toEqual(event);
        expect(restarted.findEventByIdentity(restartedRecords, event.idempotencyKey)).toEqual(
            event
        );

        expect(() =>
            restarted.appendEvent(
                restartedRecords,
                event,
                eventRetention(event, "duplicate-retention")
            )
        ).toThrow(expect.objectContaining({ code: "protocol.duplicate" }));

        const conflict = eventWithIdentity(eventFixture("persistence-conflict"), event);
        expect(() =>
            restarted.appendEvent(restartedRecords, conflict, eventRetention(conflict))
        ).toThrow(expect.objectContaining({ code: "protocol.duplicate" }));
        expect(restarted.findEventByIdentity(restartedRecords, event.idempotencyKey)).toEqual(
            event
        );
    });

    test("fails closed when authoritative bytes or reciprocal indexes are corrupted", () => {
        const records = new MemoryWorkspaceRecords();
        const persistence = workspacePersistence();
        const event = eventFixture("persistence-corruption");
        persistence.appendEvent(records, event, eventRetention(event));
        const snapshot = records.snapshot();

        const corruptBytes = new MemoryWorkspaceRecords({
            ...snapshot,
            records: snapshot.records.map((record) =>
                record.kind === "event" ? { ...record, bytes: Uint8Array.of(0) } : record
            )
        });
        expect(() => persistence.findEvent(corruptBytes, event.id)).toThrow(
            expect.objectContaining({ code: "codec.invalid" })
        );

        const lostIndex = new MemoryWorkspaceRecords({ ...snapshot, uniques: [] });
        expect(persistence.findEventByIdentity(lostIndex, event.idempotencyKey)).toBeUndefined();
        expect(() => persistence.findEvent(lostIndex, event.id)).toThrow(/reciprocal idempotency/);

        const danglingIndex = new MemoryWorkspaceRecords({
            ...snapshot,
            uniques: snapshot.uniques.map((unique) => ({
                ...unique,
                recordKey: "event-missing"
            }))
        });
        expect(() => persistence.findEventByIdentity(danglingIndex, event.idempotencyKey)).toThrow(
            /missing authoritative record/
        );
    });
});

function workspacePersistence(): WorkspacePersistence<MemoryWorkspaceRecords> {
    return new WorkspacePersistence(
        (records) => records,
        new DurableRetention(),
        sourceActor,
        tenant
    );
}

function eventWithIdentity(source: Event, identity: Event): Event {
    return new Event({
        id: new EventId(`${source.id.value}-other`),
        scope: source.scope,
        source: source.source,
        kind: source.kind,
        payload: source.payload,
        payloadDigest: source.payloadDigest,
        idempotencyKey: identity.idempotencyKey,
        correlation: source.correlation,
        provenance: source.provenance,
        trust: source.trust,
        visibility: source.visibility,
        ...(source.initiator === undefined ? {} : { initiator: source.initiator })
    });
}
