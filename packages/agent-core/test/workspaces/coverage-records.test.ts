import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { TurnId, type LeaseToken } from "../../src/agents";
import {
    ContentRef,
    Digest,
    JsonSchema,
    RecordCodec,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonObject,
    type JsonSchemaDocument,
    type JsonValue
} from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import {
    BindingName,
    EventKind,
    EventPattern,
    FacetPackageId,
    FieldMove,
    OperationRef,
    PayloadMapping,
    SurfaceId,
    type TrustTier
} from "../../src/facets";
import { PrincipalId, PrincipalRef, ScopeRef, TenantId, WorkspaceId } from "../../src/identity";
import { CorrelationId, EventId, SubscriptionId } from "../../src/interaction-references";
import {
    decodeActor,
    decodeContent,
    decodeOptionalPrincipalRef,
    decodeRevision,
    decodeScope,
    encodeActor,
    encodeContent,
    encodeOptionalPrincipalRef,
    encodeRevision,
    encodeScope,
    requireArray,
    requireBoolean,
    requireFields,
    requireInteger,
    requireNullableString,
    requireObject,
    requireString,
    requireTenant
} from "../../src/workspaces/codec";
import { Event, type EventInit } from "../../src/workspaces/event";
import {
    ActionId,
    ContentRetentionId,
    EventCursor,
    InboxReferenceId,
    RetainedRecordRef
} from "../../src/workspaces/id";
import { InboxEventReference } from "../../src/workspaces/inbox";
import {
    AuthenticatedEventIntent,
    EventIntentAuthenticator,
    eventIntentBytes,
    requireAuthenticatedEventIntent,
    type EventIntentInput
} from "../../src/workspaces/origin";
import { ContentRetentionReference, RetainedRecordKind } from "../../src/workspaces/retention";
import { Subscription } from "../../src/workspaces/subscription";
import { EventProvenance, EventVerification, canonicalJson } from "../../src/workspaces/value";
import {
    ActionDescriptor,
    View,
    ViewDelta,
    viewDocument,
    viewFromDocument
} from "../../src/workspaces/view";
import { content, principal, scope, sourceActor, tenant } from "./fixtures";

const otherPrincipal = new PrincipalRef(tenant, new PrincipalId("principal-other"));

function recordPayload(bytes: Uint8Array): JsonObject {
    const envelope = decodeCanonicalJson(bytes);
    if (!isJsonObject(envelope) || !isJsonObject(envelope["payload"])) {
        throw new TypeError("Test fixture must contain an object payload");
    }
    return envelope["payload"];
}

function recordBytes(
    kind: string,
    payload: JsonValue,
    version: { readonly major: number; readonly minor: number } = { major: 1, minor: 0 }
): Uint8Array {
    return encodeCanonicalJson({ kind, payload, version });
}

function expectCodecInvalid(action: () => void): void {
    expect(action).toThrow(expect.objectContaining({ code: "codec.invalid" }));
}

function expectAuthorityDenied(action: () => void): void {
    expect(action).toThrow(expect.objectContaining({ code: "authority.denied" }));
}

interface StaticCodec<Record> {
    readonly codec: RecordCodec<Record>;
    encode(record: Record): Uint8Array;
    decode(bytes: Uint8Array): Record;
}

function expectUniformCodec<Record>(record: Record, type: StaticCodec<Record>): void {
    const encoded = type.encode(record);
    expect(encoded).toEqual(type.codec.encode(record));
    expect(type.encode(type.decode(encoded))).toEqual(encoded);
}

function provenance(
    init: {
        readonly verification?: EventVerification;
        readonly principal?: PrincipalRef;
        readonly channel?: string;
        readonly group?: string;
        readonly claims?: JsonValue;
    } = {}
): EventProvenance {
    const fields: ProvenanceFields = {
        verification: init.verification ?? EventVerification.verified()
    };
    if (init.principal !== undefined) fields.principal = init.principal;
    if (init.channel !== undefined) fields.channel = init.channel;
    if (init.group !== undefined) fields.group = init.group;
    if (init.claims !== undefined) fields.claims = init.claims;
    return new EventProvenance(fields);
}

/** The provenance fields a fixture fills in, before the absent ones are dropped. */
type ProvenanceFields = {
    verification: EventVerification;
    principal?: PrincipalRef;
    channel?: string;
    group?: string;
    claims?: JsonValue;
};

function eventInit(
    suffix: string,
    options: {
        readonly trust?: TrustTier;
        readonly provenance?: EventProvenance;
        readonly initiator?: PrincipalRef | null;
        readonly causation?: EventId;
        readonly source?: "facet" | "actor";
        readonly idempotencyKey?: string;
    } = {}
): EventInit {
    const payload = content(`coverage-event-${suffix}`);
    const eventProvenance =
        options.provenance ??
        provenance({
            principal,
            channel: "channel",
            group: "group",
            claims: { nested: [true, null] }
        });
    const initiator = options.initiator === undefined ? principal : options.initiator;
    const base: EventInit = {
        id: new EventId(`event-coverage-${suffix}`),
        scope,
        source:
            options.source === "actor"
                ? { kind: "actor", actor: sourceActor }
                : { kind: "facet", facet: new FacetPackageId("facet.coverage") },
        kind: new EventKind("coverage.created"),
        payload: payload.ref,
        payloadDigest: payload.digest,
        idempotencyKey: options.idempotencyKey ?? `key-${suffix}`,
        correlation: new CorrelationId(`correlation-coverage-${suffix}`),
        provenance: eventProvenance,
        trust: options.trust ?? "authenticated",
        visibility: "workspace"
    };
    const withInitiator: EventInit = initiator === null ? base : { ...base, initiator };
    return options.causation === undefined
        ? withInitiator
        : { ...withInitiator, causation: options.causation };
}

function eventIntent(
    suffix: string,
    options: {
        readonly causation?: EventId;
        readonly idempotencyKey?: string;
        readonly lease?: LeaseToken;
        readonly payload?: ReturnType<typeof content>;
        readonly provenance?: EventProvenance;
        readonly scope?: ScopeRef;
        readonly source?: "facet" | "actor";
    } = {}
): EventIntentInput {
    const payload = options.payload ?? content(`coverage-intent-${suffix}`);
    const intent: EventIntentInput = {
        id: new EventId(`event-intent-${suffix}`),
        scope: options.scope ?? scope,
        sourceActor,
        source:
            options.source === "actor"
                ? { kind: "actor", actor: sourceActor }
                : { kind: "facet", facet: new FacetPackageId("facet.coverage") },
        kind: new EventKind("coverage.created"),
        payload: payload.ref,
        payloadDigest: payload.digest,
        payloadRetention: new ContentRetentionReference({
            id: new ContentRetentionId(`retention-intent-${suffix}`),
            tenant,
            actor: sourceActor,
            recordKind: RetainedRecordKind.event(),
            record: new RetainedRecordRef(`record-intent-${suffix}`),
            content: payload.ref,
            digest: payload.digest
        }),
        idempotencyKey: options.idempotencyKey ?? `intent-key-${suffix}`,
        correlation: new CorrelationId(`correlation-intent-${suffix}`),
        provenance:
            options.provenance ??
            provenance({
                principal,
                channel: "channel",
                group: "group",
                claims: { nested: [true, null] }
            }),
        visibility: "workspace"
    };
    const withLease: EventIntentInput =
        options.lease === undefined ? intent : { ...intent, lease: options.lease };
    return options.causation === undefined
        ? withLease
        : { ...withLease, causation: options.causation };
}

function subscription(
    suffix: string,
    authority: "initiator" | "delegated" = "initiator"
): Subscription {
    return new Subscription({
        id: new SubscriptionId(`subscription-coverage-${suffix}`),
        revision: Revision.initial(),
        source: new EventPattern("coverage.*", ["authenticated"]),
        target: new OperationRef("facet.coverage:operation"),
        mapping: new PayloadMapping([new FieldMove("/value", { from: "/value" })]),
        dedupe: "event",
        authority: { kind: authority, binding: new BindingName("binding.coverage") }
    });
}

function retention(
    kind: RetainedRecordKind,
    suffix: string = kind.kind
): ContentRetentionReference {
    const retained = content(`coverage-retention-${suffix}`);
    return new ContentRetentionReference({
        id: new ContentRetentionId(`retention-coverage-${suffix}`),
        tenant,
        actor: sourceActor,
        recordKind: kind,
        record: new RetainedRecordRef(`record-coverage-${suffix}`),
        content: retained.ref,
        digest: retained.digest
    });
}

function inbox(sequence = 0, leaseEpoch = 0): InboxEventReference {
    return new InboxEventReference({
        id: new InboxReferenceId(`inbox-coverage-${sequence}-${leaseEpoch}`),
        turn: new TurnId("turn-coverage"),
        event: new EventId("event-coverage-inbox"),
        sequence,
        leaseEpoch
    });
}

function action(id = "submit", argumentsSchema?: JsonSchema): ActionDescriptor {
    const descriptor = {
        id: new ActionId(id),
        label: "Submit",
        emits: new EventKind("coverage.submitted")
    };
    return new ActionDescriptor(
        argumentsSchema === undefined
            ? descriptor
            : { ...descriptor, arguments: argumentsSchema }
    );
}

function view(
    body: JsonValue = { ready: true },
    actions: readonly ActionDescriptor[] = [action()]
): View {
    return new View({
        surface: new SurfaceId("surface-coverage"),
        revision: Revision.initial(),
        body,
        actions,
        cursor: new EventCursor("cursor-coverage-0")
    });
}

function delta(previous: View): ViewDelta {
    return new ViewDelta({
        surface: previous.surface,
        baseRevision: previous.revision,
        revision: previous.revision.next(),
        patch: [{ op: "replace", path: "/body", value: { ready: false } }],
        cursor: new EventCursor("cursor-coverage-1")
    });
}

class ExactEventIntentAuthenticator extends EventIntentAuthenticator {
    public evidence(value: EventIntentInput): Uint8Array {
        return eventIntentBytes(value);
    }

    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        return (
            message.length === evidence.length &&
            message.every((byte, index) => byte === evidence[index])
        );
    }
}

describe("workspace codec primitives", () => {
    test("accepts valid primitive values and rejects malformed JSON shapes", { tags: "p2" }, () => {
        expect(requireObject({ value: true }, "subject")).toEqual({ value: true });
        for (const malformed of [null, [], "scalar"] satisfies readonly JsonValue[]) {
            expect(() => requireObject(malformed, "subject")).toThrow(/must be an object/);
        }

        expect(() => requireFields({ value: true }, ["value"], "subject")).not.toThrow();
        expect(() => requireFields({}, ["value"], "subject")).toThrow(/missing or unknown/);
        expect(() => requireFields({ extra: true, value: true }, ["value"], "subject")).toThrow(
            /missing or unknown/
        );

        expect(requireString("value", "subject")).toBe("value");
        expect(() => requireString(false, "subject")).toThrow(/must be a string/);
        expect(requireNullableString(null, "subject")).toBeUndefined();
        expect(requireNullableString("value", "subject")).toBe("value");
        expect(() => requireNullableString(undefined, "subject")).toThrow(/must be a string/);
        expect(requireBoolean(true, "subject")).toBe(true);
        expect(() => requireBoolean("true", "subject")).toThrow(/must be a boolean/);
        expect(requireInteger(0, "subject")).toBe(0);
        for (const malformed of [
            -1,
            1.5,
            Number.MAX_SAFE_INTEGER + 1,
            "1"
        ] satisfies readonly JsonValue[]) {
            expect(() => requireInteger(malformed, "subject")).toThrow(/non-negative safe integer/);
        }
        expect(requireArray([1, "two"], "subject")).toEqual([1, "two"]);
        expect(() => requireArray({}, "subject")).toThrow(/must be an array/);
    });

    test("round-trips actors, content, revisions, optional principals, scopes, and tenants", { tags: "p1" }, () => {
        const actors = [
            new ActorRef("tenant", new ActorId("actor-tenant")),
            new ActorRef("workspace", new ActorId("actor-workspace")),
            new ActorRef("run", new ActorId("actor-run")),
            new ActorRef("environment", new ActorId("actor-environment")),
            new ActorRef("slate", new ActorId("actor-slate"))
        ];
        for (const actor of actors) {
            const decoded = decodeActor(encodeActor(actor), "Actor");
            expect(decoded.kind).toBe(actor.kind);
            expect(decoded.id.equals(actor.id)).toBe(true);
        }
        expect(() => decodeActor({ id: "actor", kind: "unknown" }, "Actor")).toThrow(
            /kind is invalid/
        );
        expect(() => decodeActor({ id: false, kind: "workspace" }, "Actor")).toThrow(
            /ID must be a string/
        );

        const retained = content("coverage-codec-content");
        expect(decodeContent(encodeContent(retained.ref, retained.digest), "Content")).toEqual(
            retained
        );
        expect(() =>
            decodeContent(
                { digest: Digest.sha256(new Uint8Array()).value, ref: retained.ref.value },
                "Content"
            )
        ).toThrow(/do not match/);

        const revision = new Revision(7);
        expect(decodeRevision(encodeRevision(revision), "Revision").equals(revision)).toBe(true);
        expect(() => decodeRevision(-1, "Revision")).toThrow(/non-negative safe integer/);
        expect(
            decodeOptionalPrincipalRef(encodeOptionalPrincipalRef(principal), "Principal")?.equals(
                principal
            )
        ).toBe(true);
        expect(
            decodeOptionalPrincipalRef(encodeOptionalPrincipalRef(undefined), "Principal")
        ).toBeUndefined();
        expect(() => decodeOptionalPrincipalRef(false, "Principal")).toThrow(/must be an object/);
        expect(decodeScope(encodeScope(scope)).equals(scope)).toBe(true);
        expect(requireTenant(tenant.value, "Tenant").equals(tenant)).toBe(true);
    });
});

describe("event values and records", () => {
    test("models both verification cases and canonical immutable provenance", { tags: "p1" }, () => {
        expect(EventVerification.verified().kind).toBe("verified");
        expect(EventVerification.host().kind).toBe("host");
        expect(EventVerification.verified().equals(EventVerification.verified())).toBe(true);
        expect(EventVerification.verified().equals(EventVerification.host())).toBe(false);
        expect(Object.isFrozen(EventVerification.verified())).toBe(true);
        expect(Object.isFrozen(EventVerification.host())).toBe(true);

        const claims = { array: [{ nested: true }], scalar: 3 };
        const complete = provenance({
            verification: EventVerification.host(),
            principal,
            channel: "channel",
            group: "group",
            claims
        });
        claims.array[0]!.nested = false;
        expect(complete.verification.kind).toBe("host");
        expect(complete.claims).toEqual({ array: [{ nested: true }], scalar: 3 });
        expect(Object.isFrozen(complete)).toBe(true);
        expect(Object.isFrozen(complete.claims)).toBe(true);
        if (!isJsonObject(complete.claims)) {
            throw new TypeError("Complete provenance fixture changed shape");
        }
        expect(Object.isFrozen(complete.claims["array"])).toBe(true);

        const minimal = provenance();
        expect(minimal).toMatchObject({
            channel: undefined,
            group: undefined,
            principal: undefined,
            claims: {}
        });
        expect(() => provenance({ channel: "" })).toThrow(/nonblank canonical string/);
        expect(() => provenance({ channel: " padded" })).toThrow(/nonblank canonical string/);
        expect(() => provenance({ group: "" })).toThrow(/nonblank canonical string/);
        expect(() => provenance({ group: "padded " })).toThrow(/nonblank canonical string/);
    });

    test("canonicalizes and deeply freezes JSON scalars, arrays, and objects", { tags: "p1" }, () => {
        for (const scalar of [null, true, 42, "text"] satisfies readonly JsonValue[]) {
            expect(canonicalJson(scalar)).toBe(scalar);
        }
        const nestedInput = { nested: [1, false] };
        const input = [nestedInput, "tail"];
        const copied = canonicalJson(input);
        nestedInput.nested.push(2);
        expect(copied).toEqual([{ nested: [1, false] }, "tail"]);
        expect(Object.isFrozen(copied)).toBe(true);
        if (!Array.isArray(copied) || !isJsonObject(copied[0])) {
            throw new TypeError("Canonical array fixture changed shape");
        }
        expect(Object.isFrozen(copied[0])).toBe(true);
        expect(Object.isFrozen(copied[0]["nested"])).toBe(true);
    });

    test("enforces every Event constructor trust and identity invariant", { tags: "p0" }, () => {
        const matching = eventInit("matching");
        const other = content("coverage-other-content");
        expect(() => new Event({ ...matching, payloadDigest: other.digest })).toThrow(
            /payload reference and digest must match/
        );
        for (const idempotencyKey of ["", " padded", "padded ", "x".repeat(513)]) {
            expect(
                () => new Event(eventInit(`key-${idempotencyKey.length}`, { idempotencyKey }))
            ).toThrow(/idempotency key/);
        }
        expect(() => new Event(eventInit("self-verified", { trust: "self" }))).toThrow(
            /Self trust requires host provenance/
        );
        expect(
            () => new Event(eventInit("owner-anonymous", { trust: "owner", initiator: null }))
        ).toThrow(/Owner trust requires an authenticated initiator/);
        expect(
            () =>
                new Event(
                    eventInit("owner-no-principal", {
                        trust: "owner",
                        provenance: provenance(),
                        initiator: principal
                    })
                )
        ).toThrow(/exact provenance Principal/);
        expect(
            () =>
                new Event(
                    eventInit("authenticated-anonymous", {
                        trust: "authenticated",
                        provenance: provenance({ principal }),
                        initiator: null
                    })
                )
        ).toThrow(/exact provenance Principal/);
        expect(
            () =>
                new Event(
                    eventInit("authenticated-substitution", {
                        trust: "authenticated",
                        provenance: provenance({ principal }),
                        initiator: otherPrincipal
                    })
                )
        ).toThrow(/exact provenance Principal/);
        expect(
            () =>
                new Event(
                    eventInit("external-substitution", {
                        trust: "external",
                        provenance: provenance({ principal }),
                        initiator: otherPrincipal
                    })
                )
        ).toThrow(/cannot substitute another Principal/);

        const foreignPrincipal = new PrincipalRef(
            new TenantId("tenant-other"),
            new PrincipalId("principal-other-tenant")
        );
        expect(
            () =>
                new Event(
                    eventInit("foreign-tenant", {
                        provenance: provenance({ principal: foreignPrincipal }),
                        initiator: foreignPrincipal
                    })
                )
        ).toThrow(/initiator Tenant must match/);

        expect(
            () =>
                new Event(
                    eventInit("self-host", {
                        trust: "self",
                        provenance: provenance({
                            verification: EventVerification.host(),
                            principal
                        })
                    })
                )
        ).not.toThrow();
        expect(
            () =>
                new Event(
                    eventInit("external-anonymous", {
                        trust: "external",
                        provenance: provenance(),
                        initiator: null
                    })
                )
        ).not.toThrow();
    });

    test("round-trips every source and optional provenance shape without aliasing", { tags: "p1" }, () => {
        const cause = new EventId("event-coverage-cause");
        const complete = new Event(eventInit("complete", { causation: cause, source: "actor" }));
        const decodedComplete = Event.decode(Event.encode(complete));
        expect(decodedComplete.source.kind).toBe("actor");
        expect(decodedComplete.causation?.equals(cause)).toBe(true);
        expect(decodedComplete.provenance).toMatchObject({ channel: "channel", group: "group" });
        expect(decodedComplete.initiator?.equals(principal)).toBe(true);
        expect(Object.isFrozen(decodedComplete.source)).toBe(true);
        expect(Object.isFrozen(decodedComplete.provenance)).toBe(true);

        const anonymous = new Event(
            eventInit("anonymous", {
                trust: "external",
                provenance: provenance({ claims: [1, { accepted: true }] }),
                initiator: null
            })
        );
        const decodedAnonymous = Event.decode(Event.encode(anonymous));
        expect(decodedAnonymous.source.kind).toBe("facet");
        expect(decodedAnonymous.causation).toBeUndefined();
        expect(decodedAnonymous.initiator).toBeUndefined();
        expect(decodedAnonymous.provenance).toMatchObject({
            channel: undefined,
            group: undefined,
            principal: undefined,
            claims: [1, { accepted: true }]
        });
        const hosted = new Event(
            eventInit("hosted", {
                trust: "self",
                provenance: provenance({
                    verification: EventVerification.host(),
                    principal
                })
            })
        );
        expect(Event.decode(Event.encode(hosted)).provenance.verification.kind).toBe("host");
        expectUniformCodec(complete, Event);
    });

    test("rejects malformed Event fields, types, discriminants, and envelope versions", { tags: "p2" }, () => {
        const valid = new Event(eventInit("codec"));
        const payload = recordPayload(Event.encode(valid));
        const { id, ...missingId } = payload;
        expect(id).toBe(valid.id.value);

        expectCodecInvalid(() => Event.decode(recordBytes(Event.codec.kind, [])));
        expectCodecInvalid(() => Event.decode(recordBytes(Event.codec.kind, missingId)));
        expectCodecInvalid(() =>
            Event.decode(recordBytes(Event.codec.kind, { ...payload, unknown: true }))
        );
        expectCodecInvalid(() =>
            Event.decode(recordBytes(Event.codec.kind, { ...payload, id: false }))
        );
        expectCodecInvalid(() =>
            Event.decode(recordBytes(Event.codec.kind, { ...payload, causation: false }))
        );
        expectCodecInvalid(() =>
            Event.decode(recordBytes(Event.codec.kind, { ...payload, initiator: false }))
        );
        expectCodecInvalid(() =>
            Event.decode(
                recordBytes(Event.codec.kind, {
                    ...payload,
                    source: { kind: "unknown" }
                })
            )
        );
        expectCodecInvalid(() =>
            Event.decode(
                recordBytes(Event.codec.kind, {
                    ...payload,
                    source: { actor: { id: "actor", kind: "unknown" }, kind: "actor" }
                })
            )
        );
        expectCodecInvalid(() =>
            Event.decode(
                recordBytes(Event.codec.kind, {
                    ...payload,
                    provenance: {
                        channel: null,
                        claims: {},
                        group: null,
                        principal: null,
                        verification: "unknown"
                    }
                })
            )
        );
        expectCodecInvalid(() =>
            Event.decode(recordBytes(Event.codec.kind, { ...payload, trust: "unknown" }))
        );
        expectCodecInvalid(() =>
            Event.decode(recordBytes(Event.codec.kind, { ...payload, visibility: "unknown" }))
        );
        expectCodecInvalid(() => Event.decode(recordBytes("workspace.other", payload)));
        expect(() =>
            Event.decode(recordBytes(Event.codec.kind, payload, { major: 2, minor: 0 }))
        ).toThrow(expect.objectContaining({ code: "codec.unknown-major" }));
    });
});

describe("authenticated event intents", () => {
    test("authenticates and detaches complete and minimal intent variants", { tags: "p0" }, () => {
        const authenticator = new ExactEventIntentAuthenticator();
        const cause = new EventId("event-intent-cause");
        const lease = {
            turn: new TurnId("turn-intent"),
            holder: principal,
            epoch: 7
        } satisfies LeaseToken;
        const complete = eventIntent("complete", {
            causation: cause,
            lease,
            source: "actor",
            provenance: provenance({
                verification: EventVerification.host(),
                principal,
                channel: "channel",
                group: "group",
                claims: { source: ["host"] }
            })
        });
        const authenticated = authenticator.authenticate(
            complete,
            authenticator.evidence(complete)
        );
        expect(() => requireAuthenticatedEventIntent(authenticated)).not.toThrow();
        expect(authenticated.intent).not.toBe(complete);
        expect(authenticated.intent.scope).not.toBe(complete.scope);
        expect(authenticated.intent.sourceActor).not.toBe(complete.sourceActor);
        expect(authenticated.intent.source).not.toBe(complete.source);
        expect(authenticated.intent.provenance).not.toBe(complete.provenance);
        expect(authenticated.intent.payloadRetention).not.toBe(complete.payloadRetention);
        expect(authenticated.intent.source.kind).toBe("actor");
        expect(authenticated.intent.causation?.equals(cause)).toBe(true);
        expect(authenticated.intent.lease).toMatchObject({ epoch: 7 });
        expect(authenticated.digest.equals(Digest.sha256(eventIntentBytes(complete)))).toBe(true);
        expect(Object.isFrozen(authenticated)).toBe(true);
        expect(Object.isFrozen(authenticated.intent)).toBe(true);
        expect(Object.isFrozen(authenticated.intent.source)).toBe(true);
        expect(Object.isFrozen(authenticated.intent.lease)).toBe(true);

        const minimal = eventIntent("minimal", { provenance: provenance() });
        const minimalIntent = authenticator.authenticate(minimal, authenticator.evidence(minimal));
        expect(minimalIntent.intent.source.kind).toBe("facet");
        expect(minimalIntent.intent.causation).toBeUndefined();
        expect(minimalIntent.intent.lease).toBeUndefined();
        expect(minimalIntent.intent.provenance).toMatchObject({
            principal: undefined,
            channel: undefined,
            group: undefined
        });
    });

    test("rejects tampered full-intent evidence and changed signed fields", { tags: "p0" }, () => {
        const authenticator = new ExactEventIntentAuthenticator();
        const original = eventIntent("signed");
        const evidence = authenticator.evidence(original);
        const tamperedEvidence = evidence.slice();
        tamperedEvidence[0] = tamperedEvidence[0] === 0 ? 1 : 0;
        expectAuthorityDenied(() => authenticator.authenticate(original, tamperedEvidence));

        const changedPayload = content("coverage-intent-changed-payload");
        expect(() =>
            authenticator.authenticate(
                {
                    ...original,
                    payloadDigest: changedPayload.digest
                },
                evidence
            )
        ).toThrow(/payload reference and digest must match/);
        const substitutions: readonly EventIntentInput[] = [
            {
                ...original,
                payload: changedPayload.ref,
                payloadDigest: changedPayload.digest
            },
            {
                ...original,
                source: { kind: "actor", actor: sourceActor }
            },
            {
                ...original,
                scope: ScopeRef.tenant(new TenantId("tenant-intent-substitution"))
            },
            {
                ...original,
                idempotencyKey: "intent-key-substituted"
            }
        ];
        for (const substituted of substitutions) {
            expectAuthorityDenied(() => authenticator.authenticate(substituted, evidence));
        }
    });

    test("detaches getter substitutions and rejects constructor and structural forgeries", { tags: "p0" }, () => {
        const authenticator = new ExactEventIntentAuthenticator();
        const original = eventIntent("getter");
        const substitutedId = new EventId("event-intent-substituted");
        let idReads = 0;
        const getterIntent: EventIntentInput = {
            ...original,
            get id(): EventId {
                idReads += 1;
                return idReads === 1 ? original.id : substitutedId;
            }
        };
        const authenticated = authenticator.authenticate(
            getterIntent,
            authenticator.evidence(original)
        );
        expect(idReads).toBe(1);
        expect(authenticated.intent.id.equals(original.id)).toBe(true);

        expect(() =>
            Reflect.construct(AuthenticatedEventIntent, [Symbol("forged-intent"), original])
        ).toThrow(/construction is host-only/);

        const forged = Object.create(AuthenticatedEventIntent.prototype);
        expectAuthorityDenied(() => requireAuthenticatedEventIntent(forged));
        expectAuthorityDenied(() => requireAuthenticatedEventIntent(Object.create(null)));
    });
});

describe("subscriptions", () => {
    test("[C13-SUBSCRIPTION-AUTHORITY] copies values, revises immutably, and supports both authority cases", { tags: "p1" }, () => {
        const initial = subscription("initial");
        const revised = initial.revise({
            source: new EventPattern("other.*", ["owner"], "facet.*"),
            target: new OperationRef("facet.coverage:other"),
            mapping: new PayloadMapping([new FieldMove("", { literal: { accepted: true } })]),
            dedupe: "payload",
            authority: { kind: "delegated", binding: new BindingName("binding.delegated") }
        });
        expect(initial.revision.value).toBe(0);
        expect(revised.revision.value).toBe(1);
        expect(revised.id.equals(initial.id)).toBe(true);
        expect(revised.authority.kind).toBe("delegated");
        expect(Object.isFrozen(revised)).toBe(true);
        expect(Object.isFrozen(revised.source)).toBe(true);
        expect(Object.isFrozen(revised.mapping)).toBe(true);
        expect(Object.isFrozen(revised.authority)).toBe(true);
        expectUniformCodec(initial, Subscription);
        expectUniformCodec(subscription("delegated", "delegated"), Subscription);
    });

    test("supports every dedupe value and absent or present source patterns", { tags: "p1" }, () => {
        const base = subscription("dedupe");
        const payload = recordPayload(Subscription.encode(base));
        for (const dedupe of [
            "none",
            "event",
            "causation",
            "payload"
        ] satisfies readonly JsonValue[]) {
            const decoded = Subscription.decode(
                recordBytes(Subscription.codec.kind, { ...payload, dedupe })
            );
            expect(decoded.dedupe).toBe(dedupe);
        }
        const withoutSource = new Subscription({
            id: new SubscriptionId("subscription-no-source"),
            revision: Revision.initial(),
            source: new EventPattern("coverage.*", ["external"]),
            target: new OperationRef("facet.coverage:operation"),
            mapping: new PayloadMapping([new FieldMove("", { from: "" })]),
            dedupe: "none",
            authority: { kind: "initiator", binding: new BindingName("binding.coverage") }
        });
        expect(
            Subscription.decode(Subscription.encode(withoutSource)).source.source
        ).toBeUndefined();
    });

    test("rejects overlapping mappings and malformed Subscription payloads", { tags: "p2" }, () => {
        expect(
            () =>
                new Subscription({
                    id: new SubscriptionId("subscription-overlap"),
                    revision: Revision.initial(),
                    source: new EventPattern("coverage.*", ["authenticated"]),
                    target: new OperationRef("facet.coverage:operation"),
                    mapping: new PayloadMapping([
                        new FieldMove("/parent", { literal: {} }),
                        new FieldMove("/parent/child", { literal: true })
                    ]),
                    dedupe: "event",
                    authority: { kind: "initiator", binding: new BindingName("binding.coverage") }
                })
        ).toThrow(/duplicate or overlap/);

        const payload = recordPayload(Subscription.encode(subscription("codec")));
        const authority = payload["authority"];
        if (!isJsonObject(authority))
            throw new TypeError("Subscription authority fixture changed shape");
        const { target, ...missingTarget } = payload;
        expect(target).toBe("facet.coverage:operation");
        expectCodecInvalid(() => Subscription.decode(recordBytes(Subscription.codec.kind, null)));
        expectCodecInvalid(() =>
            Subscription.decode(recordBytes(Subscription.codec.kind, missingTarget))
        );
        expectCodecInvalid(() =>
            Subscription.decode(recordBytes(Subscription.codec.kind, { ...payload, extra: true }))
        );
        expectCodecInvalid(() =>
            Subscription.decode(recordBytes(Subscription.codec.kind, { ...payload, mapping: {} }))
        );
        expectCodecInvalid(() =>
            Subscription.decode(
                recordBytes(Subscription.codec.kind, { ...payload, dedupe: "unknown" })
            )
        );
        expectCodecInvalid(() =>
            Subscription.decode(
                recordBytes(Subscription.codec.kind, {
                    ...payload,
                    authority: { ...authority, kind: "unknown" }
                })
            )
        );
        expectCodecInvalid(() =>
            Subscription.decode(
                recordBytes(Subscription.codec.kind, {
                    ...payload,
                    authority: { ...authority, binding: false }
                })
            )
        );
        expectCodecInvalid(() =>
            Subscription.decode(
                recordBytes(Subscription.codec.kind, {
                    ...payload,
                    authority: { ...authority, extra: true }
                })
            )
        );
        expectCodecInvalid(() => Subscription.decode(recordBytes("workspace.other", payload)));
        expect(() =>
            Subscription.decode(
                recordBytes(Subscription.codec.kind, payload, { major: 2, minor: 0 })
            )
        ).toThrow(expect.objectContaining({ code: "codec.unknown-major" }));
    });
});

describe("retention and inbox records", () => {
    test("models and round-trips every retained record kind", { tags: "p1" }, () => {
        const kinds = [
            RetainedRecordKind.event(),
            RetainedRecordKind.routeReservation(),
            RetainedRecordKind.routeProjection(),
            RetainedRecordKind.view(),
            RetainedRecordKind.viewDelta()
        ];
        for (const kind of kinds) {
            expect(kind.equals(kind)).toBe(true);
            expect(Object.isFrozen(kind)).toBe(true);
            const reference = retention(kind);
            const decoded = ContentRetentionReference.decode(
                ContentRetentionReference.encode(reference)
            );
            expect(decoded.recordKind.equals(kind)).toBe(true);
            expect(decoded.content.digest.equals(decoded.digest)).toBe(true);
            expect(Object.isFrozen(decoded)).toBe(true);
            expect(Object.isFrozen(decoded.init)).toBe(true);
        }
        expect(RetainedRecordKind.event().equals(RetainedRecordKind.view())).toBe(false);
        expectUniformCodec(
            retention(RetainedRecordKind.event(), "uniform"),
            ContentRetentionReference
        );
    });

    test("rejects mismatched content and malformed retained kinds or fields", { tags: "p2" }, () => {
        const retained = content("coverage-retention-mismatch");
        const other = content("coverage-retention-other");
        expect(
            () =>
                new ContentRetentionReference({
                    id: new ContentRetentionId("retention-mismatch"),
                    tenant,
                    actor: sourceActor,
                    recordKind: RetainedRecordKind.event(),
                    record: new RetainedRecordRef("event-mismatch"),
                    content: retained.ref,
                    digest: other.digest
                })
        ).toThrow(/ContentRef and digest must match/);

        const payload = recordPayload(
            ContentRetentionReference.encode(retention(RetainedRecordKind.event(), "codec"))
        );
        const { record, ...missingRecord } = payload;
        expect(record).toBe("record-coverage-codec");
        expectCodecInvalid(() =>
            ContentRetentionReference.decode(recordBytes(ContentRetentionReference.codec.kind, []))
        );
        expectCodecInvalid(() =>
            ContentRetentionReference.decode(
                recordBytes(ContentRetentionReference.codec.kind, missingRecord)
            )
        );
        expectCodecInvalid(() =>
            ContentRetentionReference.decode(
                recordBytes(ContentRetentionReference.codec.kind, { ...payload, unknown: true })
            )
        );
        expectCodecInvalid(() =>
            ContentRetentionReference.decode(
                recordBytes(ContentRetentionReference.codec.kind, {
                    ...payload,
                    recordKind: "unknown"
                })
            )
        );
        expectCodecInvalid(() =>
            ContentRetentionReference.decode(
                recordBytes(ContentRetentionReference.codec.kind, { ...payload, tenant: false })
            )
        );
        expectCodecInvalid(() =>
            ContentRetentionReference.decode(recordBytes("workspace.other", payload))
        );
        expect(() =>
            ContentRetentionReference.decode(
                recordBytes(ContentRetentionReference.codec.kind, payload, { major: 2, minor: 0 })
            )
        ).toThrow(expect.objectContaining({ code: "codec.unknown-major" }));
    });

    test("accepts boundary inbox counters and rejects every invalid counter shape", { tags: "p2" }, () => {
        expect(inbox(0, Number.MAX_SAFE_INTEGER).leaseEpoch).toBe(Number.MAX_SAFE_INTEGER);
        for (const sequence of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => inbox(sequence, 0)).toThrow(/non-negative safe integers/);
        }
        for (const leaseEpoch of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => inbox(0, leaseEpoch)).toThrow(/non-negative safe integers/);
        }
        const reference = inbox(2, 4);
        expect(Object.isFrozen(reference)).toBe(true);
        expect(Object.isFrozen(reference.init)).toBe(true);
        expectUniformCodec(reference, InboxEventReference);
    });

    test("rejects malformed Inbox payload fields and envelope versions", { tags: "p2" }, () => {
        const payload = recordPayload(InboxEventReference.encode(inbox(2, 4)));
        const { turn, ...missingTurn } = payload;
        expect(turn).toBe("turn-coverage");
        expectCodecInvalid(() =>
            InboxEventReference.decode(recordBytes(InboxEventReference.codec.kind, false))
        );
        expectCodecInvalid(() =>
            InboxEventReference.decode(recordBytes(InboxEventReference.codec.kind, missingTurn))
        );
        expectCodecInvalid(() =>
            InboxEventReference.decode(
                recordBytes(InboxEventReference.codec.kind, { ...payload, unknown: true })
            )
        );
        expectCodecInvalid(() =>
            InboxEventReference.decode(
                recordBytes(InboxEventReference.codec.kind, { ...payload, sequence: "2" })
            )
        );
        expectCodecInvalid(() =>
            InboxEventReference.decode(
                recordBytes(InboxEventReference.codec.kind, { ...payload, leaseEpoch: -1 })
            )
        );
        expectCodecInvalid(() =>
            InboxEventReference.decode(recordBytes("workspace.other", payload))
        );
        expect(() =>
            InboxEventReference.decode(
                recordBytes(InboxEventReference.codec.kind, payload, { major: 2, minor: 0 })
            )
        ).toThrow(expect.objectContaining({ code: "codec.unknown-major" }));
    });
});

describe("views and deltas", () => {
    test("validates action text, copies optional schemas, and rejects duplicate IDs", { tags: "p1" }, () => {
        for (const id of ["", " padded", "padded "]) {
            expect(() => action(id)).toThrow(/Action ID must be a nonblank canonical string/);
        }
        for (const label of ["", " padded", "padded "]) {
            expect(
                () =>
                    new ActionDescriptor({
                        id: new ActionId("action"),
                        label,
                        emits: new EventKind("coverage.action")
                    })
            ).toThrow(/Action label must be a nonblank canonical string/);
        }

        const schemaDocument = {
            type: "object",
            properties: { value: { type: "string" } }
        } satisfies JsonSchemaDocument;
        const schema = new JsonSchema(schemaDocument);
        const withArguments = action("with-arguments", schema);
        schemaDocument.properties.value.type = "number";
        expect(withArguments.arguments?.document).toEqual({
            properties: { value: { type: "string" } },
            type: "object"
        });
        expect(withArguments.arguments).not.toBe(schema);
        expect(Object.isFrozen(withArguments)).toBe(true);
        expect(action("without-arguments").arguments).toBeUndefined();

        expect(() => view({}, [action("duplicate"), action("duplicate")])).toThrow(
            /action IDs must be unique/
        );
    });

    test("round-trips scalar, array, and object View bodies with optional action schemas", { tags: "p1" }, () => {
        const bodies = [
            null,
            false,
            7,
            "body",
            [1, { nested: true }],
            { nested: [1, false] }
        ] satisfies readonly JsonValue[];
        for (const body of bodies) {
            const value = view(body, [
                action("without-schema"),
                action("with-schema", new JsonSchema(false))
            ]);
            const decoded = View.decode(View.encode(value));
            expect(decoded.body).toEqual(body);
            expect(decoded.actions[0]?.arguments).toBeUndefined();
            expect(decoded.actions[1]?.arguments?.document).toBe(false);
            const decodedBody = decoded.body;
            const composite = Array.isArray(decodedBody) || isJsonObject(decodedBody);
            expect(!composite || Object.isFrozen(decodedBody)).toBe(true);
        }
        expectUniformCodec(view(), View);
    });

    test("requires an immediate delta revision and deeply copies patch JSON", { tags: "p1" }, () => {
        const previous = view();
        expect(
            () =>
                new ViewDelta({
                    surface: previous.surface,
                    baseRevision: previous.revision,
                    revision: new Revision(2),
                    patch: [],
                    cursor: new EventCursor("cursor-invalid")
                })
        ).toThrow(/immediately follow/);

        const patch = [{ op: "replace", path: "/body", value: [{ nested: true }] }];
        const value = new ViewDelta({
            surface: previous.surface,
            baseRevision: previous.revision,
            revision: previous.revision.next(),
            patch,
            cursor: new EventCursor("cursor-next")
        });
        patch[0]!.path = "/forged";
        patch[0]!.value[0]!.nested = false;
        expect(value.patch).toEqual([
            {
                op: "replace",
                path: "/body",
                value: [{ nested: true }]
            }
        ]);
        expect(Object.isFrozen(value.patch)).toBe(true);
        expect(Object.isFrozen(value.patch[0])).toBe(true);
        expectUniformCodec(value, ViewDelta);
    });

    test("rebuilds a View document and rejects malformed or mismatched documents", { tags: "p1" }, () => {
        const previous = view({ ready: true }, [action("old")]);
        const next = delta(previous);
        expect(viewDocument(previous)).toEqual({
            actions: [{ arguments: null, emits: "coverage.submitted", id: "old", label: "Submit" }],
            body: { ready: true }
        });
        const rebuilt = viewFromDocument(previous, next, {
            actions: [
                {
                    arguments: { type: "string" },
                    emits: "coverage.renamed",
                    id: "renamed",
                    label: "Renamed"
                }
            ],
            body: ["next"]
        });
        expect(rebuilt.revision.equals(next.revision)).toBe(true);
        expect(rebuilt.cursor.equals(next.cursor)).toBe(true);
        expect(rebuilt.body).toEqual(["next"]);
        expect(rebuilt.actions[0]?.arguments?.document).toEqual({ type: "string" });

        const wrongSurface = new ViewDelta({
            surface: new SurfaceId("surface-other"),
            baseRevision: previous.revision,
            revision: previous.revision.next(),
            patch: [],
            cursor: next.cursor
        });
        expect(() => viewFromDocument(previous, wrongSurface, viewDocument(previous))).toThrow(
            expect.objectContaining({ code: "protocol.revision-conflict" })
        );

        const advanced = new View({
            surface: previous.surface,
            revision: previous.revision.next(),
            body: previous.body,
            actions: previous.actions,
            cursor: previous.cursor
        });
        expect(() => viewFromDocument(advanced, next, viewDocument(previous))).toThrow(
            expect.objectContaining({ code: "protocol.revision-conflict" })
        );

        expect(() => viewFromDocument(previous, next, [])).toThrow(/must be an object/);
        expect(() => viewFromDocument(previous, next, { body: {} })).toThrow(
            /missing or unknown fields/
        );
        expect(() =>
            viewFromDocument(previous, next, { actions: [], body: {}, unknown: true })
        ).toThrow(/missing or unknown fields/);
        expect(() => viewFromDocument(previous, next, { actions: {}, body: {} })).toThrow(
            /must be an array/
        );
        expect(() =>
            viewFromDocument(previous, next, {
                actions: [
                    { arguments: null, emits: "coverage.action", id: "same", label: "First" },
                    {
                        arguments: null,
                        emits: "coverage.action",
                        id: "same",
                        label: "Second"
                    }
                ],
                body: {}
            })
        ).toThrow(/action IDs must be unique/);
    });

    test("rejects malformed View and ViewDelta codec fields and discriminants", { tags: "p2" }, () => {
        const previous = view();
        const viewPayload = recordPayload(View.encode(previous));
        const viewActions = viewPayload["actions"];
        if (!Array.isArray(viewActions) || !isJsonObject(viewActions[0])) {
            throw new TypeError("View action fixture changed shape");
        }
        const validAction = viewActions[0];
        const { cursor, ...missingCursor } = viewPayload;
        expect(cursor).toBe("cursor-coverage-0");
        expectCodecInvalid(() => View.decode(recordBytes(View.codec.kind, "view")));
        expectCodecInvalid(() => View.decode(recordBytes(View.codec.kind, missingCursor)));
        expectCodecInvalid(() =>
            View.decode(recordBytes(View.codec.kind, { ...viewPayload, unknown: true }))
        );
        expectCodecInvalid(() =>
            View.decode(recordBytes(View.codec.kind, { ...viewPayload, actions: {} }))
        );
        expectCodecInvalid(() =>
            View.decode(
                recordBytes(View.codec.kind, {
                    ...viewPayload,
                    actions: [{ ...validAction, unknown: true }]
                })
            )
        );
        expectCodecInvalid(() =>
            View.decode(
                recordBytes(View.codec.kind, {
                    ...viewPayload,
                    actions: [{ ...validAction, arguments: [] }]
                })
            )
        );
        expectCodecInvalid(() => View.decode(recordBytes("workspace.other", viewPayload)));
        expect(() =>
            View.decode(recordBytes(View.codec.kind, viewPayload, { major: 2, minor: 0 }))
        ).toThrow(expect.objectContaining({ code: "codec.unknown-major" }));

        const viewDelta = delta(previous);
        const deltaPayload = recordPayload(ViewDelta.encode(viewDelta));
        const baseRevision = requireInteger(
            deltaPayload["baseRevision"],
            "View delta base revision"
        );
        const { patch, ...missingPatch } = deltaPayload;
        expect(Array.isArray(patch)).toBe(true);
        expectCodecInvalid(() => ViewDelta.decode(recordBytes(ViewDelta.codec.kind, null)));
        expectCodecInvalid(() => ViewDelta.decode(recordBytes(ViewDelta.codec.kind, missingPatch)));
        expectCodecInvalid(() =>
            ViewDelta.decode(recordBytes(ViewDelta.codec.kind, { ...deltaPayload, unknown: true }))
        );
        expectCodecInvalid(() =>
            ViewDelta.decode(recordBytes(ViewDelta.codec.kind, { ...deltaPayload, patch: {} }))
        );
        expectCodecInvalid(() =>
            ViewDelta.decode(
                recordBytes(ViewDelta.codec.kind, { ...deltaPayload, revision: baseRevision })
            )
        );
        expectCodecInvalid(() => ViewDelta.decode(recordBytes("workspace.other", deltaPayload)));
        expect(() =>
            ViewDelta.decode(
                recordBytes(ViewDelta.codec.kind, deltaPayload, { major: 2, minor: 0 })
            )
        ).toThrow(expect.objectContaining({ code: "codec.unknown-major" }));
    });
});

describe("workspace identifiers", () => {
    test("constructs every identifier and preserves nominal equality", { tags: "p2" }, () => {
        const identifiers = [
            new ActionId("action-id"),
            new ContentRetentionId("retention-id"),
            new EventCursor("cursor-id"),
            new InboxReferenceId("inbox-id"),
            new RetainedRecordRef("record-id")
        ];
        expect(identifiers.map((identifier) => identifier.value)).toEqual([
            "action-id",
            "retention-id",
            "cursor-id",
            "inbox-id",
            "record-id"
        ]);
        expect(new ActionId("same").equals(new ActionId("same"))).toBe(true);
        expect(new ActionId("same").equals(new EventCursor("same"))).toBe(false);
        expect(identifiers.every(Object.isFrozen)).toBe(true);
    });

    test("rejects empty and oversized values for every identifier", { tags: "p2" }, () => {
        const constructors = [
            ActionId,
            ContentRetentionId,
            EventCursor,
            InboxReferenceId,
            RetainedRecordRef
        ];
        for (const Identifier of constructors) {
            expect(() => new Identifier("")).toThrow(TypeError);
            expect(() => new Identifier("x".repeat(257))).toThrow(TypeError);
        }
    });
});

test("all W7 records expose uniform static encode/decode entry points", { tags: "p1" }, () => {
    const event = new Event(eventInit("uniform"));
    const subscribed = subscription("uniform");
    const retained = retention(RetainedRecordKind.view(), "uniform-all");
    const inboxReference = inbox(3, 9);
    const rendered = view();
    const renderedDelta = delta(rendered);

    expectUniformCodec(event, Event);
    expectUniformCodec(subscribed, Subscription);
    expectUniformCodec(retained, ContentRetentionReference);
    expectUniformCodec(inboxReference, InboxEventReference);
    expectUniformCodec(rendered, View);
    expectUniformCodec(renderedDelta, ViewDelta);
});

test("runtime failures preserve typed AgentCore errors", { tags: "p2" }, () => {
    const error = new AgentCoreError("authority.denied", "denied");
    expect(error).toMatchObject({ code: "authority.denied", message: "denied" });
    expect(new ContentRef(content("content-ref").ref.value).digest).toEqual(
        content("content-ref").digest
    );
    expect(ScopeRef.workspace(new TenantId("tenant"), new WorkspaceId("workspace")).kind).toBe(
        "workspace"
    );
});
