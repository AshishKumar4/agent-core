import { describe, expect, test } from "vitest";
import { ActorRef, type ActorKind } from "../../src/actors";
import { Digest, Revision } from "../../src/core";
import { BindingName, EventKind, EventPattern, FacetPackageId } from "../../src/facets";
import { TenantId } from "../../src/identity";
import {
    CommandCallerPolicy,
    CommandEnvelope,
    type ProtocolValueCodec
} from "../../src/protocol";
import {
    AuditRecordId,
    CorrelationId,
    EventId,
    InvocationId,
    RouteProjectionId,
    RouteReservationId
} from "../../src/interaction-references";
import { Event, type EventInit } from "../../src/workspaces/event";
import { MemoryWorkspaceRecords } from "../../src/workspaces/memory";
import {
    AuthenticatedEventIntent,
    EventIntentAuthenticator,
    eventIntentBytes
} from "../../src/workspaces/origin";
import { WorkspacePersistence } from "../../src/workspaces/persistence";
import type {
    EventPayloadPort,
    InteractionAuditPort,
    InteractionIdPort,
    PreparedRouteMaterial,
    RouteMaterialPreparation,
    SourceRouteDecision,
    SourceRoutePort
} from "../../src/workspaces/ports";
import {
    ContentRetentionReference,
    RetainedRecordKind,
    type ContentRetentionPort
} from "../../src/workspaces/retention";
import {
    PreparedEventRouting,
    SOURCE_EVENT_COMMAND,
    SourceEventCommandPort,
    SourceEventProtocol,
    createSourceEventProtocolCommand,
    type EventAcceptanceResult,
    type EventDraft
} from "../../src/workspaces/source-protocol";
import { Subscription } from "../../src/workspaces/subscription";
import {
    EventProvenance,
    EventVerification,
    type DerivedEventTrust
} from "../../src/workspaces/value";
import { ContentRetentionId, RetainedRecordRef } from "../../src/workspaces/id";
import { content, principal, scope, sourceActor, subscriptionFixture, targetActor, tenant } from "./fixtures";

interface State {
    readonly records: MemoryWorkspaceRecords;
    readonly audit: string[];
}

class SequenceIds implements InteractionIdPort {
    #next = 0;

    public reservation(): RouteReservationId {
        return new RouteReservationId(this.id("reservation"));
    }
    public projection(): RouteProjectionId {
        return new RouteProjectionId(this.id("projection"));
    }
    public invocation(): InvocationId {
        return new InvocationId(this.id("invocation"));
    }
    public eventAudit(): AuditRecordId {
        return new AuditRecordId(this.id("event-audit"));
    }
    public reservationAudit(): AuditRecordId {
        return new AuditRecordId(this.id("reservation-audit"));
    }
    public projectionAudit(): AuditRecordId {
        return new AuditRecordId(this.id("projection-audit"));
    }
    public deliveryAudit(): AuditRecordId {
        return new AuditRecordId(this.id("delivery-audit"));
    }
    public logicalDelivery(): string {
        return this.id("logical-delivery");
    }

    private id(prefix: string): string {
        this.#next += 1;
        return `${prefix}-${this.#next}`;
    }
}

class MutableRetention implements ContentRetentionPort<State> {
    public durable = true;
    public readonly discarded: string[] = [];

    public verify(): boolean {
        return this.durable;
    }
    public release(): void {}
    public discard(reference: ContentRetentionReference): void {
        this.discarded.push(reference.id.value);
    }
}

class CountingAudit implements InteractionAuditPort<State> {
    public appendEvent(state: State): void {
        state.audit.push("event");
    }
    public appendReservation(state: State): void {
        state.audit.push("reservation");
    }
    public appendProjectionRoot(state: State): void {
        state.audit.push("projection");
    }
    public appendDelivery(state: State): void {
        state.audit.push("delivery");
    }
}

class MutableTrust {
    public current: DerivedEventTrust = { tier: "authenticated", initiator: principal };

    public derive(): DerivedEventTrust {
        return this.current;
    }
}

class RecordedRoutes implements SourceRoutePort<State> {
    public decision: SourceRouteDecision | undefined;
    public preparedTenants: PreparedRouteMaterial["tenants"] = { kind: "same", tenant };
    public readonly preparations: RouteMaterialPreparation[] = [];

    public async prepare(input: RouteMaterialPreparation): Promise<PreparedRouteMaterial> {
        this.preparations.push(input);
        const projected = content(`prepared-${input.reservation.value}`);
        return {
            targetActor,
            tenants: this.preparedTenants,
            content: projected.ref,
            digest: projected.digest,
            retention: new ContentRetentionReference({
                id: new ContentRetentionId(`retention-${input.reservation.value}`),
                tenant,
                actor: sourceActor,
                recordKind: RetainedRecordKind.routeReservation(),
                record: new RetainedRecordRef(input.reservation.value),
                content: projected.ref,
                digest: projected.digest
            }),
            evidence: "prepared-evidence"
        };
    }

    public authorize(
        _state: State,
        subscription: Subscription,
        _event: Event,
        material: PreparedRouteMaterial
    ): SourceRouteDecision {
        return (
            this.decision ?? {
                kind: "accepted",
                targetActor: material.targetActor,
                tenants: material.tenants,
                operation: subscription.target
            }
        );
    }
}

class ExactIntentAuthenticator extends EventIntentAuthenticator {
    public evidence(intent: EventDraft): Uint8Array {
        return intentEvidence(eventIntentBytes(intent));
    }

    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        const expected = intentEvidence(message);
        return (
            expected.length === evidence.length &&
            expected.every((byte, index) => byte === evidence[index])
        );
    }
}

class DelegatingCommandPort extends SourceEventCommandPort<object> {
    public readonly caller = CommandCallerPolicy.actor("workspace");
    public readonly expectedRevision = "forbidden" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload = new ReferenceCodec<PreparedEventRouting>();
    public readonly resultCodec: ProtocolValueCodec<EventAcceptanceResult> =
        new ReferenceCodec<EventAcceptanceResult>();

    public authorize(): boolean {
        return true;
    }
    public permitsLifecycle(): boolean {
        return true;
    }
    public currentRevision(): Revision {
        return new Revision(3);
    }
    public currentLease(): undefined {
        return undefined;
    }
}

class ReferenceCodec<Value> implements ProtocolValueCodec<Value> {
    readonly #values = new Map<string, Value>();
    #next = 0;

    public encode(value: Value): Uint8Array {
        this.#next += 1;
        const key = `reference-${this.#next}`;
        this.#values.set(key, value);
        return new TextEncoder().encode(key);
    }

    public decode(bytes: Uint8Array): Value {
        const value = this.#values.get(new TextDecoder().decode(bytes));
        if (value === undefined) throw new TypeError("Unknown test command reference");
        return value;
    }
}

describe("source protocol mutation kills", () => {
    test(
        "snapshot keeps deduped route keys empty for no-dedupe and unreserved subscriptions",
        { tags: "p0" },
        () => {
            const none = sourceSetup(
                "dedupe-none",
                subscriptionFixture("dedupe-none", { dedupe: "none" })
            );
            const noneSnapshot = none.protocol.snapshot(
                none.state,
                authenticateIntent(draft("dedupe-none"))
            );
            expect(noneSnapshot.dedupedRouteKeys).toEqual([]);

            const fresh = sourceSetup("dedupe-fresh");
            const freshSnapshot = fresh.protocol.snapshot(
                fresh.state,
                authenticateIntent(draft("dedupe-fresh"))
            );
            expect(freshSnapshot.dedupedRouteKeys).toEqual([]);
        }
    );

    test(
        "duplicate snapshot cites the length-prefixed route identity and prepare skips payload reload",
        { tags: "p0" },
        async () => {
            const setup = sourceSetup("duplicate-route-key");
            const first = await setup.protocol.prepare(
                setup.protocol.snapshot(
                    setup.state,
                    authenticateIntent(draft("duplicate-route-key"))
                )
            );
            setup.protocol.commit(setup.state, first);
            expect(setup.payloadLoads()).toBe(1);

            const replay = setup.protocol.snapshot(
                setup.state,
                authenticateIntent(draft("duplicate-route-key"))
            );
            const id = setup.subscription.id.value;
            expect(replay.dedupedRouteKeys).toEqual([
                `${id.length}:${id}event:event-duplicate-route-key`
            ]);

            const replayPrepared = await setup.protocol.prepare(replay);
            expect(setup.payloadLoads()).toBe(1);
            expect(setup.routes.preparations).toHaveLength(1);

            const result = setup.protocol.commit(setup.state, replayPrepared);
            expect(result.duplicate).toBe(true);
            expect(result.reservations).toHaveLength(1);
        }
    );

    test(
        "route preparation consumes logical delivery identifiers only for no-dedupe subscriptions",
        { tags: "p1" },
        async () => {
            const setup = sourceSetup("logical-ids");
            const prepared = await setup.protocol.prepare(
                setup.protocol.snapshot(setup.state, authenticateIntent(draft("logical-ids")))
            );
            const result = setup.protocol.commit(setup.state, prepared);
            expect(result.reservations[0]?.dedupeKey).toBe("event:event-logical-ids");
            expect(result.reservations[0]?.invocation.value).toBe("invocation-4");
        }
    );

    test(
        "commit rejects a same-length idempotency conflict recorded after preparation",
        { tags: "p0" },
        async () => {
            const setup = sourceSetup("commit-conflict");
            const snapshot = setup.protocol.snapshot(
                setup.state,
                authenticateIntent(draft("commit-conflict"))
            );
            const prepared = await setup.protocol.prepare(snapshot);
            const other = content("draft-commit-conflict-other");
            const conflictingInit: EventInit = {
                id: snapshot.event.id,
                scope: snapshot.event.scope,
                source: snapshot.event.source,
                kind: snapshot.event.kind,
                payload: other.ref,
                payloadDigest: other.digest,
                idempotencyKey: snapshot.event.idempotencyKey,
                correlation: snapshot.event.correlation,
                provenance: snapshot.event.provenance,
                trust: snapshot.event.trust,
                visibility: snapshot.event.visibility
            };
            const conflicting = new Event(
                snapshot.event.initiator === undefined
                    ? conflictingInit
                    : { ...conflictingInit, initiator: snapshot.event.initiator }
            );
            expect(Event.encode(conflicting).byteLength).toBe(
                Event.encode(snapshot.event).byteLength
            );
            setup.persistence.appendEvent(
                setup.state,
                conflicting,
                new ContentRetentionReference({
                    id: new ContentRetentionId("retention-event-commit-conflict-other"),
                    tenant,
                    actor: sourceActor,
                    recordKind: RetainedRecordKind.event(),
                    record: new RetainedRecordRef(conflicting.id.value),
                    content: other.ref,
                    digest: other.digest
                })
            );

            expect(() => setup.protocol.commit(setup.state, prepared)).toThrow(
                expect.objectContaining({
                    code: "protocol.duplicate",
                    message: "Event idempotency key conflicts with another authenticated intent"
                })
            );
        }
    );

    test("commit detects a subscription set that shrank after snapshot", { tags: "p0" }, async () => {
        const subA = subscriptionFixture("shrink-a");
        const subB = subscriptionFixture("shrink-b");
        const setup = sourceSetup("shrink-a", subA);
        setup.persistence.saveSubscription(setup.state, subB, undefined);
        const prepared = await setup.protocol.prepare(
            setup.protocol.snapshot(setup.state, authenticateIntent(draft("shrink")))
        );

        const shrunken = emptyState();
        setup.persistence.saveSubscription(shrunken, subA, undefined);
        expect(() => setup.protocol.commit(shrunken, prepared)).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Subscription snapshot changed during Event preparation"
            })
        );
    });

    test(
        "commit detects a subscription replaced by an equal-revision stranger",
        { tags: "p0" },
        async () => {
            const setup = sourceSetup("swap-a", subscriptionFixture("swap-a"));
            const prepared = await setup.protocol.prepare(
                setup.protocol.snapshot(setup.state, authenticateIntent(draft("swap")))
            );

            const swapped = emptyState();
            setup.persistence.saveSubscription(swapped, subscriptionFixture("swap-b"), undefined);
            expect(() => setup.protocol.commit(swapped, prepared)).toThrow(
                expect.objectContaining({
                    code: "protocol.revision-conflict",
                    message: "Subscription snapshot changed during Event preparation"
                })
            );
        }
    );

    test(
        "commit detects a single revised subscription among matching peers",
        { tags: "p0" },
        async () => {
            const subA = subscriptionFixture("revise-a");
            const subB = subscriptionFixture("revise-b");
            const setup = sourceSetup("revise-a", subA);
            setup.persistence.saveSubscription(setup.state, subB, undefined);
            const prepared = await setup.protocol.prepare(
                setup.protocol.snapshot(setup.state, authenticateIntent(draft("revise")))
            );

            setup.persistence.saveSubscription(
                setup.state,
                subB.revise({
                    source: subB.source,
                    target: subB.target,
                    mapping: subB.mapping,
                    dedupe: "payload",
                    authority: subB.authority
                }),
                subB.revision
            );
            expect(() => setup.protocol.commit(setup.state, prepared)).toThrow(
                expect.objectContaining({
                    code: "protocol.revision-conflict",
                    message: "Subscription snapshot changed during Event preparation"
                })
            );
        }
    );

    test(
        "commit rejects a tier-only trust change with an unchanged initiator",
        { tags: "p0" },
        async () => {
            const setup = sourceSetup("tier-drift");
            const prepared = await setup.protocol.prepare(
                setup.protocol.snapshot(setup.state, authenticateIntent(draft("tier-drift")))
            );
            setup.trust.current = { tier: "owner", initiator: principal };
            expect(() => setup.protocol.commit(setup.state, prepared)).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "Event trust changed during asynchronous preparation"
                })
            );
        }
    );

    test(
        "commit accepts unchanged trust for authenticated and external tiers",
        { tags: "p0" },
        async () => {
            const stable = sourceSetup("trust-stable");
            const stableResult = stable.protocol.commit(
                stable.state,
                await stable.protocol.prepare(
                    stable.protocol.snapshot(
                        stable.state,
                        authenticateIntent(draft("trust-stable"))
                    )
                )
            );
            expect(stableResult.duplicate).toBe(false);
            expect(stableResult.reservations).toHaveLength(1);
            expect(stableResult.reservations[0]?.initiator?.equals(principal)).toBe(true);

            const base = subscriptionFixture("external-stable");
            const externalSubscription = new Subscription({
                id: base.id,
                revision: base.revision,
                source: new EventPattern("task.*", ["external"], "facet.*"),
                target: base.target,
                mapping: base.mapping,
                dedupe: base.dedupe,
                authority: { kind: "delegated", binding: base.authority.binding }
            });
            const external = sourceSetup("external-stable", externalSubscription);
            external.trust.current = { tier: "external" };
            const externalResult = external.protocol.commit(
                external.state,
                await external.protocol.prepare(
                    external.protocol.snapshot(
                        external.state,
                        authenticateIntent(draft("external-stable"))
                    )
                )
            );
            const reservation = externalResult.reservations[0];
            if (reservation === undefined) {
                throw new TypeError("External route reservation is missing");
            }
            expect(reservation.initiator).toBeUndefined();
            expect(Object.hasOwn(reservation.init, "initiator")).toBe(false);
        }
    );

    test(
        "commit reports nondurable payload retention with its exact invalid-state diagnostic",
        { tags: "p2" },
        async () => {
            const setup = sourceSetup("not-durable");
            const prepared = await setup.protocol.prepare(
                setup.protocol.snapshot(setup.state, authenticateIntent(draft("not-durable")))
            );
            setup.retention.durable = false;
            expect(() => setup.protocol.commit(setup.state, prepared)).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Event payload retention is not durable"
                })
            );
        }
    );

    test(
        "commit refuses prepared work when the accepting actor identity drifts",
        { tags: "p0" },
        async () => {
            const setup = sourceSetup(
                "actor-drift",
                subscriptionFixture("actor-drift"),
                driftingActor(sourceActor)
            );
            const prepared = await setup.protocol.prepare(
                setup.protocol.snapshot(setup.state, authenticateIntent(draft("actor-drift")))
            );
            expect(() => setup.protocol.commit(setup.state, prepared)).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "Prepared Event belongs to another Actor"
                })
            );
            expect(setup.retention.discarded).toEqual([
                "retention-event-actor-drift",
                `retention-${setup.routes.preparations[0]?.reservation.value}`
            ]);
        }
    );

    test(
        "source command delegates authorization, lifecycle, and revision decisions to its port",
        { tags: "p1" },
        async () => {
            const setup = sourceSetup("command-port");
            const prepared = await setup.protocol.prepare(
                setup.protocol.snapshot(setup.state, authenticateIntent(draft("command-port")))
            );
            const port = new DelegatingCommandPort();
            const command = createSourceEventProtocolCommand(setup.protocol, port);
            const envelopeContent = content("command-envelope");
            const envelope = new CommandEnvelope({
                command: SOURCE_EVENT_COMMAND,
                caller: { kind: "actor", actor: sourceActor },
                idempotencyKey: "command-envelope-key",
                payload: envelopeContent.ref,
                payloadDigest: envelopeContent.digest
            });
            const at = new Date("2026-07-24T12:00:00.000Z");

            expect(command.command).toBe(SOURCE_EVENT_COMMAND);
            expect(command.caller).toBe(port.caller);
            expect(command.expectedRevision).toBe("forbidden");
            expect(command.lease).toBe("forbidden");
            expect(command.payload).toBe(port.payload);
            expect(command.replyCodec).toBe(port.resultCodec);
            expect(command.observationCodec).toBe(port.resultCodec);
            expect(command.authorize({}, envelope, prepared)).toBe(true);
            expect(command.permitsLifecycle({}, envelope, prepared)).toBe(true);
            expect(command.currentRevision({}, envelope, prepared)).toEqual(new Revision(3));
            expect(command.currentLease({}, envelope, prepared, at)).toBeUndefined();

            const execution = command.execute(setup.state, envelope, prepared, at);
            if (execution instanceof Uint8Array) throw new TypeError("Expected typed execution");
            expect(execution.reply.duplicate).toBe(false);
            expect(execution.observation).toBe(execution.reply);
        }
    );
});

interface SourceSetup {
    readonly state: State;
    readonly persistence: WorkspacePersistence<State>;
    readonly retention: MutableRetention;
    readonly trust: MutableTrust;
    readonly routes: RecordedRoutes;
    readonly subscription: Subscription;
    readonly protocol: SourceEventProtocol<State>;
    payloadLoads(): number;
}

function emptyState(): State {
    return { records: new MemoryWorkspaceRecords(), audit: [] };
}

function sourceSetup(
    suffix: string,
    subscription: Subscription = subscriptionFixture(suffix),
    actor: ActorRef = sourceActor
): SourceSetup {
    const state = emptyState();
    const retention = new MutableRetention();
    const persistence = new WorkspacePersistence<State>(
        (current) => current.records,
        retention,
        sourceActor,
        tenant
    );
    persistence.saveSubscription(state, subscription, undefined);
    const trust = new MutableTrust();
    const routes = new RecordedRoutes();
    let loads = 0;
    const payloads: EventPayloadPort = {
        load: async () => {
            loads += 1;
            return { value: 7 };
        }
    };
    return {
        state,
        persistence,
        retention,
        trust,
        routes,
        subscription,
        protocol: new SourceEventProtocol(
            actor,
            persistence,
            trust,
            payloads,
            routes,
            retention,
            new CountingAudit(),
            new SequenceIds()
        ),
        payloadLoads: () => loads
    };
}

function driftingActor(base: ActorRef): ActorRef {
    let reads = 0;
    return {
        id: base.id,
        get kind(): ActorKind {
            reads += 1;
            return reads === 1 ? base.kind : "run";
        },
        equals(other: ActorRef): boolean {
            return this.kind === other.kind && this.id.equals(other.id);
        }
    };
}

function draft(suffix: string): EventDraft {
    const payload = content(`draft-${suffix}`);
    return {
        id: new EventId(`event-${suffix}`),
        scope,
        sourceActor,
        source: { kind: "facet", facet: new FacetPackageId("facet.test") },
        kind: new EventKind("task.created"),
        payload: payload.ref,
        payloadDigest: payload.digest,
        payloadRetention: new ContentRetentionReference({
            id: new ContentRetentionId(`retention-event-${suffix}`),
            tenant,
            actor: sourceActor,
            recordKind: RetainedRecordKind.event(),
            record: new RetainedRecordRef(`event-${suffix}`),
            content: payload.ref,
            digest: payload.digest
        }),
        idempotencyKey: `idempotency-${suffix}`,
        correlation: new CorrelationId(`correlation-${suffix}`),
        provenance: new EventProvenance({
            verification: EventVerification.verified(),
            principal,
            claims: { source: "mutation" }
        }),
        visibility: "workspace"
    };
}

function authenticateIntent(intent: EventDraft): AuthenticatedEventIntent {
    const authenticator = new ExactIntentAuthenticator();
    return authenticator.authenticate(intent, authenticator.evidence(intent));
}

function intentEvidence(message: Uint8Array): Uint8Array {
    return new TextEncoder().encode(Digest.sha256(message).value);
}

describe("source commit trust boundary kills", () => {
    test("commit rejects a routing handle this runtime did not prepare", { tags: "p0" }, () => {
        const setup = sourceSetup("forged-prepared");
        // SAFETY: Object.create returns a bare prototype instance this runtime never
        // prepared, so it passes `instanceof` while carrying none of the preparation
        // commit must recognise. That is exactly the handle this test rejects.
        const forged = Object.create(PreparedEventRouting.prototype) as PreparedEventRouting;
        expect(() => setup.protocol.commit(setup.state, forged)).toThrow(
            expect.objectContaining({ name: "AgentCoreError", code: "protocol.invalid-state" })
        );
    });

    test("commit rejects same-tenant relation drift after preparation", { tags: "p0" }, async () => {
        const setup = sourceSetup("tenant-drift");
        const prepared = await setup.protocol.prepare(
            setup.protocol.snapshot(setup.state, authenticateIntent(draft("tenant-drift")))
        );
        setup.routes.decision = {
            kind: "accepted",
            targetActor,
            tenants: { kind: "same", tenant: new TenantId("tenant-drifted") },
            operation: setup.subscription.target
        };
        expect(() => setup.protocol.commit(setup.state, prepared)).toThrow(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "protocol.invalid-state",
                message: "Prepared route target changed before source commit"
            })
        );
    });

    test("commit rejects cross-tenant relation drift after preparation", { tags: "p0" }, async () => {
        const setup = sourceSetup("tenant-cross-drift");
        setup.routes.preparedTenants = {
            kind: "cross",
            source: tenant,
            target: new TenantId("tenant-cross-target"),
            authority: new BindingName("binding.route")
        };
        const prepared = await setup.protocol.prepare(
            setup.protocol.snapshot(setup.state, authenticateIntent(draft("tenant-cross-drift")))
        );
        setup.routes.decision = {
            kind: "accepted",
            targetActor,
            tenants: {
                kind: "cross",
                source: tenant,
                target: new TenantId("tenant-cross-target"),
                authority: new BindingName("binding.other")
            },
            operation: setup.subscription.target
        };
        expect(() => setup.protocol.commit(setup.state, prepared)).toThrow(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "protocol.invalid-state",
                message: "Prepared route target changed before source commit"
            })
        );
    });
});
