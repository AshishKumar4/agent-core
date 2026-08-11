import { describe, expect, test } from "vitest";
import type { LeaseToken } from "../../src/agents";
import { TurnId } from "../../src/agents";
import {
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { EventKind, FacetPackageId, SurfaceId } from "../../src/facets";
import { CorrelationId, EventId } from "../../src/interaction-references";
import { ActionId, EventCursor } from "../../src/workspaces/id";
import { MemoryWorkspaceRecords } from "../../src/workspaces/memory";
import {
    AuthenticatedEventIntent,
    EventIntentAuthenticator,
    eventIntentBytes,
    type EventIntentInput
} from "../../src/workspaces/origin";
import { WorkspacePersistence } from "../../src/workspaces/persistence";
import { EventProvenance, EventVerification } from "../../src/workspaces/value";
import { ActionDescriptor, View, ViewDelta } from "../../src/workspaces/view";
import { ViewReplayProtocol } from "../../src/workspaces/view-replay";
import {
    DeterministicJsonPatchEngine,
    content,
    principal,
    retentionFixture,
    scope,
    sourceActor,
    targetActor,
    tenant,
    viewDeltaFixture,
    viewFixture
} from "./fixtures";

type JsonObject = { readonly [key: string]: JsonValue };

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return (
        value !== undefined && value !== null && !Array.isArray(value) && typeof value === "object"
    );
}

function recordPayload(bytes: Uint8Array): JsonObject {
    const envelope = decodeCanonicalJson(bytes);
    if (!isJsonObject(envelope) || !isJsonObject(envelope["payload"])) {
        throw new TypeError("Test fixture must contain an object payload");
    }
    return envelope["payload"];
}

function recordBytes(kind: string, payload: JsonValue): Uint8Array {
    return encodeCanonicalJson({ kind, payload, version: { major: 1, minor: 0 } });
}

function signature(message: Uint8Array): Uint8Array {
    return new TextEncoder().encode(Digest.sha256(message).value);
}

class SignatureIntentAuthenticator extends EventIntentAuthenticator {
    public evidence(intent: EventIntentInput): Uint8Array {
        return signature(eventIntentBytes(intent));
    }

    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        const expected = signature(message);
        return (
            expected.length === evidence.length &&
            expected.every((byte, index) => byte === evidence[index])
        );
    }
}

class WipingIntentAuthenticator extends EventIntentAuthenticator {
    public evidence(intent: EventIntentInput): Uint8Array {
        return signature(eventIntentBytes(intent));
    }

    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        const expected = signature(message);
        const matches =
            expected.length === evidence.length &&
            expected.every((byte, index) => byte === evidence[index]);
        message.fill(0);
        evidence.fill(0);
        return matches;
    }
}

function intentInput(
    suffix: string,
    options: {
        readonly causation?: EventId;
        readonly lease?: LeaseToken;
        readonly source?: "facet" | "actor";
    } = {}
): EventIntentInput {
    const payload = content(`intent-${suffix}`);
    return {
        id: new EventId(`event-intent-${suffix}`),
        scope,
        sourceActor,
        source:
            options.source === "actor"
                ? { kind: "actor", actor: sourceActor }
                : { kind: "facet", facet: new FacetPackageId("facet.intent") },
        kind: new EventKind("intent.created"),
        payload: payload.ref,
        payloadDigest: payload.digest,
        payloadRetention: retentionFixture({
            id: `retention-intent-${suffix}`,
            recordKind: "event",
            recordId: `event-intent-${suffix}`,
            content: payload
        }),
        idempotencyKey: `intent-key-${suffix}`,
        correlation: new CorrelationId(`correlation-intent-${suffix}`),
        ...(options.causation === undefined ? {} : { causation: options.causation }),
        provenance: new EventProvenance({
            verification: EventVerification.verified(),
            principal
        }),
        visibility: "workspace",
        ...(options.lease === undefined ? {} : { lease: options.lease })
    };
}

function intentData(intent: EventIntentInput): JsonObject {
    const decoded = decodeCanonicalJson(eventIntentBytes(intent));
    if (!isJsonObject(decoded)) {
        throw new TypeError("Event intent bytes must decode to an object");
    }
    return decoded;
}

interface ReplayHarness {
    readonly records: MemoryWorkspaceRecords;
    readonly engine: DeterministicJsonPatchEngine;
    readonly protocol: ViewReplayProtocol<MemoryWorkspaceRecords>;
}

function replayHarness(): ReplayHarness {
    const records = new MemoryWorkspaceRecords();
    const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
        (value) => value,
        { verify: () => true, release: () => {}, discard: () => {} },
        sourceActor,
        tenant
    );
    const engine = new DeterministicJsonPatchEngine();
    return {
        records,
        engine,
        protocol: new ViewReplayProtocol(persistence, engine, sourceActor, tenant)
    };
}

describe("View record mutation coverage", () => {
    test("ActionDescriptor requires an ActionId instance for its ID", { tags: "p1" }, () => {
        expect(
            () =>
                new ActionDescriptor({
                    id: new EventCursor("cursor-not-action"),
                    label: "Label",
                    emits: new EventKind("kind.action")
                })
        ).toThrow(expect.objectContaining({ message: "Action ID must be an ActionId" }));
    });

    test("View decode reports each tampered field with its exact subject label", {
        tags: "p2"
    }, () => {
        const payload = recordPayload(View.encode(viewFixture(0, "view-labels")));
        const cases = [
            { field: "surface", value: 5, message: "View Surface ID must be a string" },
            { field: "revision", value: "one", message: "View revision must be a non-negative safe integer" },
            { field: "cursor", value: 5, message: "View cursor must be a string" }
        ];
        for (const entry of cases) {
            expect(() =>
                View.decode(recordBytes("workspace.view", { ...payload, [entry.field]: entry.value }))
            ).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: `Invalid workspace.view record: ${entry.message}`
                })
            );
        }
    });

    test("ViewDelta decode reports each tampered field with its exact subject label", {
        tags: "p2"
    }, () => {
        const delta = viewDeltaFixture(viewFixture(0, "delta-labels"));
        const payload = recordPayload(ViewDelta.encode(delta));
        const cases = [
            { field: "surface", value: 5, message: "Delta Surface ID must be a string" },
            {
                field: "baseRevision",
                value: "one",
                message: "Delta base revision must be a non-negative safe integer"
            },
            { field: "revision", value: "one", message: "Delta revision must be a non-negative safe integer" },
            { field: "cursor", value: 5, message: "Delta cursor must be a string" }
        ];
        for (const entry of cases) {
            expect(() =>
                ViewDelta.decode(
                    recordBytes("workspace.view-delta", { ...payload, [entry.field]: entry.value })
                )
            ).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: `Invalid workspace.view-delta record: ${entry.message}`
                })
            );
        }
    });

    test("ActionDescriptor decode reports each tampered field with its exact subject label", {
        tags: "p2"
    }, () => {
        const descriptor = new ActionDescriptor({
            id: new ActionId("action-labels"),
            label: "Label",
            emits: new EventKind("kind.decode")
        });
        const payload = recordPayload(ActionDescriptor.encode(descriptor));
        const cases = [
            { field: "id", value: 5, message: "Action ID must be a string" },
            { field: "label", value: 5, message: "Action label must be a string" },
            { field: "emits", value: 5, message: "Action Event kind must be a string" }
        ];
        for (const entry of cases) {
            expect(() =>
                ActionDescriptor.decode(
                    recordBytes("workspace.action-descriptor", {
                        ...payload,
                        [entry.field]: entry.value
                    })
                )
            ).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: `Invalid workspace.action-descriptor record: ${entry.message}`
                })
            );
        }
    });
});

describe("Event intent mutation coverage", () => {
    test("event intent bytes bind the exact signing domain and source shapes", {
        tags: "p0"
    }, () => {
        const facet = intentData(intentInput("facet-shape"));
        expect(facet["domain"]).toBe("agent-core.event-intent.v1");
        expect(facet["sourceActor"]).toEqual({ kind: "workspace", id: "workspace-source" });
        expect(facet["source"]).toEqual({ kind: "facet", facet: "facet.intent" });
        expect(facet["lease"]).toBeNull();

        const actor = intentData(intentInput("actor-shape", { source: "actor" }));
        expect(actor["source"]).toEqual({
            kind: "actor",
            actor: { kind: "workspace", id: "workspace-source" }
        });

        const lease: LeaseToken = { turn: new TurnId("turn-intent"), holder: principal, epoch: 4 };
        const leased = intentData(intentInput("lease-shape", { lease }));
        expect(leased["lease"]).toEqual({
            turn: "turn-intent",
            holder: { principal: "principal-test", tenant: "tenant-test" },
            epoch: 4
        });
    });

    test("authentication verifies detached copies so verifiers cannot corrupt evidence", {
        tags: "p0"
    }, () => {
        const authenticator = new WipingIntentAuthenticator();
        const intent = intentInput("wiping-verifier");
        const evidence = authenticator.evidence(intent);
        const original = evidence.slice();

        expect(authenticator.authenticate(intent, evidence)).toBeInstanceOf(
            AuthenticatedEventIntent
        );
        expect(evidence).toEqual(original);
        expect(authenticator.authenticate(intent, evidence)).toBeInstanceOf(
            AuthenticatedEventIntent
        );
    });

    test("detached authenticated intent omits the causation key when absent", {
        tags: "p1"
    }, () => {
        const authenticator = new SignatureIntentAuthenticator();
        const absent = intentInput("causation-absent");
        const authenticated = authenticator.authenticate(absent, authenticator.evidence(absent));
        expect(Object.hasOwn(authenticated.intent, "causation")).toBe(false);

        const causation = new EventId("event-cause");
        const present = intentInput("causation-present", { causation });
        const authenticatedPresent = authenticator.authenticate(
            present,
            authenticator.evidence(present)
        );
        expect(authenticatedPresent.intent.causation).toEqual(causation);
    });
});

describe("ViewReplayProtocol mutation coverage", () => {
    test("replay without a durable View fails with the exact invalid-state error", {
        tags: "p2"
    }, () => {
        const { records, protocol } = replayHarness();
        expect(() =>
            protocol.replay(records, new SurfaceId("surface-absent"), Revision.initial())
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Surface has no durable View"
            })
        );
    });

    test("replay ahead of the durable View fails with the exact revision-conflict error", {
        tags: "p2"
    }, () => {
        const { records, protocol } = replayHarness();
        const current = viewFixture(0, "ahead");
        protocol.publishSnapshot(records, current, []);
        expect(() => protocol.replay(records, current.surface, new Revision(2))).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Replay revision is ahead of the current View"
            })
        );
    });

    test("replay at the current revision short-circuits before consulting stored deltas", {
        tags: "p1"
    }, () => {
        const { records, engine, protocol } = replayHarness();
        const current = viewFixture(0, "fast-path");
        protocol.publishSnapshot(records, current, []);
        const orphan = viewDeltaFixture(current, 1);
        records.insertRecord({
            kind: "viewDelta",
            id: `${orphan.surface.value}@${orphan.revision.value}`,
            bytes: ViewDelta.encode(orphan)
        });

        const replay = protocol.replay(records, current.surface, current.revision);
        expect(replay).toEqual({
            kind: "deltas",
            base: current.revision,
            deltas: [],
            view: current
        });
        expect(engine.calls).toEqual([]);
    });

    test("replayed deltas that diverge from the durable View by content fall back to a snapshot", {
        tags: "p0"
    }, () => {
        const { records, protocol } = replayHarness();
        const initial = viewFixture(0, "diverged");
        protocol.publishSnapshot(records, initial, []);
        const applied = viewDeltaFixture(initial, 1);
        const current = protocol.publish(records, applied, [], []);

        const diverged = viewDeltaFixture(initial, 2);
        const snapshot = records.snapshot();
        const tampered = new MemoryWorkspaceRecords({
            ...snapshot,
            records: snapshot.records.map((record) =>
                record.kind === "viewDelta" && record.id === `${applied.surface.value}@1`
                    ? { ...record, bytes: ViewDelta.encode(diverged) }
                    : record
            )
        });

        const divergedView = new View({
            ...current,
            body: { count: 2, nested: { enabled: true } }
        });
        expect(View.codec.encode(divergedView).byteLength).toBe(
            View.codec.encode(current).byteLength
        );
        expect(View.codec.encode(divergedView)).not.toEqual(View.codec.encode(current));

        expect(protocol.replay(tampered, initial.surface, Revision.initial())).toEqual({
            kind: "snapshot",
            view: current
        });
    });

    test("publish rejects retentions owned by another Actor with the exact error", {
        tags: "p0"
    }, () => {
        const { records, protocol } = replayHarness();
        const view = viewFixture(0, "foreign-retention");
        const foreign = retentionFixture({
            actor: targetActor,
            id: "retention-foreign-owner",
            recordKind: "view",
            recordId: `${view.surface.value}@0`,
            content: content("foreign-owner")
        });
        expect(() => protocol.publishSnapshot(records, view, [foreign])).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "View retention belongs to another Actor, tenant, or View revision"
            })
        );
    });
});
