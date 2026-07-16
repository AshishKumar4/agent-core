import { describe, expect, test, vi } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { RunRuntime, TurnId, TurnInboxEntry, TurnInboxEntryId } from "../../src/agents";
import {
    CanonicalRunEvidencePort,
    CanonicalRunMergePort,
    CanonicalRunSourceRevisionPort,
    CanonicalRunSpawnPort,
    InvocationInteractionAuditPort,
    PackageFacetRuntime,
    ProvenanceFacetSlotBackend,
    RoutedInvocationAdmissionPort,
    RuntimeRunInboxPort,
    type RoutedInvocationProjection
} from "../../src/composition";
import { CompatRange, Digest, JsonSchema, Revision, SemVer } from "../../src/core";
import {
    PackageId,
    type Blueprint,
    type BlueprintLoader,
    type LoadedBlueprint
} from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import {
    BindingName,
    Contributions,
    Facet,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    OperationRef,
    PackageInstallationRef,
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotEntry,
    SlotName,
    type FacetLifecycleContext,
    type Interceptor,
    type InterceptorDeclaration,
    type Operation,
    type OperationName,
    type Surface,
    type SurfaceId,
    type WorkspaceSlotStore
} from "../../src/facets";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    AuditRecord,
    AuditRecordId,
    CorrelationId,
    InvocationPlacementPin,
    OperationPin,
    PreparedInvocation,
    type InvocationLedger,
    type InvocationPersistence
} from "../../src/invocations";
import { InvocationId, RouteReservationId } from "../../src/interaction-references";
import {
    authenticatedProjectionFixture,
    content,
    deliveryFixture,
    eventFixture,
    projectionFixture,
    reservationFixture,
    inboxFixture,
    tenant
} from "../workspaces/fixtures";
import { preparedReferenceCodecs } from "../invocations/fixture";

describe("W9 composition behavior branches", () => {
    test("rejects every substituted routed identity and replays only byte-stable intent", () => {
        const reservation = reservationFixture("composed-admission");
        const projection = projectionFixture(reservation);
        const bridgeAudit = new AuditRecordId("bridge-audit");
        const input = { reservation, projection, bridgeAudit };

        for (const substitution of [
            "invocation",
            "route",
            "projection",
            "auditCause",
            "auditKind",
            "auditProjection",
            "auditReservation",
            "bridgeIdentity",
            "bridgeCause",
            "operation",
            "targetActor",
            "authority",
            "principal"
        ] as const) {
            const harness = routedAdmissionHarness((payload) =>
                routedEvidence(payload, substitution)
            );
            expect(harness.port.admit(harness.state, input)).toEqual({
                kind: "rejected",
                reason: "routed invocation evidence was substituted"
            });
            expect(harness.preparations).toBe(0);
        }

        const bound = routedAdmissionHarness((payload) => routedEvidence(payload));
        expect(bound.port.admit(bound.state, input)).toEqual({
            kind: "accepted",
            invocation: reservation.invocation
        });
        expect(bound.preparations).toBe(1);

        let changedPayload = false;
        const harness = routedAdmissionHarness((payload) =>
            routedEvidence(
                payload,
                undefined,
                changedPayload ? { changed: true } : { changed: false }
            )
        );
        expect(harness.port.admit(harness.state, input)).toEqual({
            kind: "accepted",
            invocation: reservation.invocation
        });
        expect(harness.port.admit(harness.state, input)).toEqual({
            kind: "accepted",
            invocation: reservation.invocation
        });
        changedPayload = true;
        expect(harness.port.admit(harness.state, input)).toEqual({
            kind: "rejected",
            reason: "stable routed invocation identity conflicts"
        });
        expect(harness.preparations).toBe(1);
    });

    test("builds the target-local audit chain and fails closed when reservation evidence is absent", () => {
        const event = eventFixture("composed-audit");
        const reservation = reservationFixture("composed-audit");
        const projection = authenticatedProjectionFixture(reservation);
        const delivery = deliveryFixture(reservation);
        const sourceCause = auditRecord(reservation.sourceAuditCause, undefined, {
            kind: "event",
            id: event.id
        });
        const appended: Array<{ record: AuditRecord; admission?: unknown }> = [];
        let routeEvidence = event;
        let causeEvidence: AuditRecord | undefined = sourceCause;
        const port = new InvocationInteractionAuditPort({
            actor: reservation.targetActor,
            tenant,
            records: () => ({ get: () => causeEvidence }) as never,
            evidence: () => ({ route: () => routeEvidence }) as never,
            eventCause: () => sourceCause.id,
            correlationForProjection: () => new CorrelationId("projection-correlation"),
            correlationForDelivery: () => new CorrelationId("delivery-correlation"),
            append: (_transaction, record, admission) => appended.push({ record, admission })
        });

        port.appendEvent({}, event, new AuditRecordId("event-audit"));
        port.appendReservation({}, reservation, new AuditRecordId("reservation-audit"));
        port.appendProjectionRoot({}, projection, new AuditRecordId("projection-audit"));
        port.appendDelivery(
            {},
            delivery,
            new AuditRecordId("projection-audit"),
            new AuditRecordId("delivery-audit")
        );
        expect(appended.map(({ record }) => record.kind.kind)).toEqual([
            "event",
            "routeReserved",
            "routeProjected",
            "delivery"
        ]);
        expect(appended[2]!.record.cause).toBeUndefined();
        expect(appended[2]!.admission).toEqual({
            kind: "routeProjection",
            projection: reservation.projection,
            reservation: reservation.id
        });

        routeEvidence = undefined as never;
        expect(() =>
            port.appendReservation({}, reservation, new AuditRecordId("missing-route"))
        ).toThrow(/unavailable/);
        routeEvidence = event;
        causeEvidence = undefined;
        expect(() =>
            port.appendReservation({}, reservation, new AuditRecordId("missing-cause"))
        ).toThrow(/unavailable/);
    });

    test("maps Run inbox conflicts, duplicates, lease rejection, and lifecycle rejection", () => {
        const turn = new TurnId("composed-inbox-turn");
        const reference = inboxFixture("composed-inbox", 2, 4, turn);
        const token = { turn, holder: new PrincipalId("composed-inbox-holder"), epoch: 4 };
        const expected = inboxEntry(reference, "expected");
        let material = expected;
        let existing: TurnInboxEntry | undefined;
        let failure: unknown;
        const runtime = {
            repository: { loadInbox: () => existing },
            deliverEventInTransaction: () => {
                if (failure !== undefined) throw failure;
                existing = material;
            }
        } as unknown as RunRuntime<object>;
        const port = new RuntimeRunInboxPort(runtime, {
            materialize: () => ({
                entry: material,
                expectedTurnRevision: Revision.initial(),
                now: new Date(10)
            })
        });

        for (const substituted of [
            new TurnInboxEntry(
                new TurnInboxEntryId("wrong-turn"),
                new TurnId("wrong-turn"),
                reference.sequence,
                reference.event.value,
                expected.payload,
                expected.payloadDigest,
                "wrong-turn",
                undefined,
                new Date(1)
            ),
            new TurnInboxEntry(
                new TurnInboxEntryId("wrong-sequence"),
                turn,
                reference.sequence + 1,
                reference.event.value,
                expected.payload,
                expected.payloadDigest,
                "wrong-sequence",
                undefined,
                new Date(1)
            ),
            new TurnInboxEntry(
                new TurnInboxEntryId("wrong-event"),
                turn,
                reference.sequence,
                "other-event",
                expected.payload,
                expected.payloadDigest,
                "wrong-event",
                undefined,
                new Date(1)
            )
        ]) {
            material = substituted;
            expect(port.append({}, reference, token)).toEqual({
                kind: "rejected",
                reason: "conflict"
            });
        }

        material = expected;
        existing = undefined;
        expect(port.append({}, reference, token)).toEqual({ kind: "appended" });
        expect(port.append({}, reference, token)).toEqual({ kind: "duplicate" });
        existing = inboxEntry(reference, "substituted-persisted");
        expect(port.append({}, reference, token)).toEqual({ kind: "rejected", reason: "conflict" });

        existing = undefined;
        failure = new AgentCoreError("lease.invalid", "stale lease");
        expect(port.append({}, reference, token)).toEqual({ kind: "rejected", reason: "lease" });
        failure = new AgentCoreError("turn.invalid-state", "terminal Turn");
        expect(port.append({}, reference, token)).toEqual({
            kind: "rejected",
            reason: "lifecycle"
        });
        failure = new AgentCoreError("invocation.invalid", "unexpected");
        expect(() => port.append({}, reference, token)).toThrow("unexpected");
    });

    test("owns loaded package handles, rejects double activation, and preserves cleanup failures", async () => {
        const manifest = emptyManifest("composition.runtime");
        const stops: string[] = [];
        const loaded = loadedBlueprint(
            manifest,
            vi.fn(async () => stops.push("module"))
        );
        const runtime = new PackageFacetRuntime(loaderReturning(loaded), {
            roots: () => [
                new LifecycleFacet(manifest, undefined, async () => {
                    stops.push("facet");
                })
            ]
        });

        expect(runtime.host).toBeUndefined();
        await runtime.activate({} as Blueprint);
        expect(runtime.host).toBeDefined();
        await expect(runtime.activate({} as Blueprint)).rejects.toMatchObject({
            code: "facet.inactive"
        });
        await runtime[Symbol.asyncDispose]();
        expect(runtime.host).toBeUndefined();
        expect(stops).toEqual(["facet", "module"]);

        const activationCleanup = vi.fn(async () => undefined);
        const failedActivation = new PackageFacetRuntime(
            loaderReturning(loadedBlueprint(manifest, activationCleanup)),
            {
                roots: () => [
                    new LifecycleFacet(manifest, async () => {
                        throw new TypeError("start failed");
                    })
                ]
            }
        );
        await expect(failedActivation.activate({} as Blueprint)).rejects.toThrow("start failed");
        expect(activationCleanup).toHaveBeenCalledOnce();

        const failedCleanup = new PackageFacetRuntime(
            loaderReturning(
                loadedBlueprint(manifest, async () => {
                    throw new TypeError("module cleanup failed");
                })
            ),
            {
                roots: () => [
                    new LifecycleFacet(manifest, undefined, async () => {
                        throw new TypeError("facet cleanup failed");
                    })
                ]
            }
        );
        await failedCleanup.activate({} as Blueprint);
        await expect(failedCleanup.dispose()).rejects.toThrow(/Facet stop hook/);
        await expect(failedCleanup.dispose()).resolves.toBeUndefined();
    });

    test("treats slot installation and contribution as byte-stable append-only provenance", () => {
        const state = {
            revision: Revision.initial(),
            slots: new Map<string, SlotDeclaration>(),
            entries: new Map<string, SlotEntry>()
        };
        const store = {
            loadRevision: () => state.revision,
            saveRevision: (_transaction: typeof state, revision: Revision) =>
                (state.revision = revision),
            loadSlot: (_transaction: typeof state, name: SlotName) => state.slots.get(name.value),
            insertSlot: (_transaction: typeof state, value: SlotDeclaration) =>
                state.slots.set(value.name.value, value),
            loadEntry: (_transaction: typeof state, id: SlotEntry["id"]) =>
                state.entries.get(id.value),
            insertEntry: (_transaction: typeof state, value: SlotEntry) =>
                state.entries.set(value.id.value, value)
        } as unknown as WorkspaceSlotStore<typeof state>;
        const declaration = slotDeclaration({ type: "object" });
        const conflictingDeclaration = slotDeclaration({ type: "string" });
        const entry = SlotEntry.create(declaration.name, "workspace:facet", 0, { value: 1 });
        const packageFacet = new FacetPackageId("composition.slot-package");
        const expectedInstallation = new PackageInstallationRef(entry.contributor, packageFacet);
        let installation: PackageInstallationRef | undefined = expectedInstallation;
        let contributionAllowed = true;
        const backend = new ProvenanceFacetSlotBackend(
            store,
            {
                prepareContribution: () => undefined,
                resolveContributionForApply: () => installation
            } as never,
            {
                permitsInstall: () => true,
                permitsContribution: () => contributionAllowed
            },
            { revision: () => state.revision, slot: (_read, name) => state.slots.get(name.value) }
        );

        installation = undefined;
        expect(() => backend.applyContribution(state, {} as never, {}, entry)).toThrow(
            /provenance changed/
        );
        installation = new PackageInstallationRef(
            new FacetRef("workspace:substituted"),
            packageFacet
        );
        expect(() => backend.applyContribution(state, {} as never, {}, entry)).toThrow(
            /provenance changed/
        );
        installation = expectedInstallation;
        contributionAllowed = false;
        expect(() => backend.applyContribution(state, {} as never, {}, entry)).toThrow(
            /Current authority/
        );
        contributionAllowed = true;
        expect(() => backend.applyContribution(state, {} as never, {}, entry)).toThrow(
            /is not installed/
        );
        expect(backend.install(state, declaration)).toBe(true);
        expect(backend.install(state, declaration)).toBe(false);
        expect(() => backend.install(state, conflictingDeclaration)).toThrow(/conflicts/);
        const invalidEntry = SlotEntry.create(
            declaration.name,
            entry.contributor.value,
            1,
            "invalid"
        );
        expect(() => backend.applyContribution(state, {} as never, {}, invalidEntry)).toThrow(
            /does not match/
        );
        const appliedEntry = SlotEntry.create(declaration.name, entry.contributor.value, 2, {
            applied: true
        });
        expect(backend.applyContribution(state, {} as never, {}, appliedEntry)).toBe(true);
        expect(backend.contribute(state, entry)).toBe(true);
        expect(backend.contribute(state, entry)).toBe(false);
        state.entries.set(
            entry.id.value,
            SlotEntry.create(declaration.name, "workspace:substituted", 0, { value: 2 })
        );
        expect(() => backend.contribute(state, entry)).toThrow(/conflicts/);
        expect(() => backend.advanceRevision(state, new Revision(1))).toThrow(/changed/);
        expect(backend.advanceRevision(state, Revision.initial()).value).toBe(1);
        expect(backend.currentRevision(state).value).toBe(1);
        expect(backend.permitsInstall(state, declaration)).toBe(true);
        expect(backend.permitsContribution(state, entry)).toBe(true);
        expect(backend.slot(state, declaration.name)).toBe(declaration);
    });

    test("delegates canonical run evidence without reconstructing cross-domain identities", () => {
        const calls: string[] = [];
        const receipt = new CanonicalRunEvidencePort({
            receipt: () => (calls.push("receipt"), undefined),
            delivery: () => (calls.push("delivery"), undefined),
            control: () => (calls.push("control"), undefined),
            synthesis: () => (calls.push("synthesis"), undefined),
            administer: () => (calls.push("administer"), undefined),
            forcedCancellation: () => (calls.push("forced-cancellation"), undefined)
        });
        receipt.receipt({}, {} as never, {} as never);
        receipt.delivery({}, {} as never, {} as never);
        receipt.control({}, {} as never, {} as never);
        receipt.synthesis({}, {} as never);
        receipt.administer({}, {} as never, {} as never);
        receipt.forcedCancellation({}, {} as never, {} as never);

        const merge = new CanonicalRunMergePort({
            concat: () => (calls.push("concat"), true),
            tree: () => (calls.push("tree"), true)
        });
        expect(merge.verifyConcat({}, {} as never, {} as never, {} as never)).toBe(true);
        expect(merge.verifyTree({}, {} as never, {} as never, {} as never)).toBe(true);

        const source = new CanonicalRunSourceRevisionPort({
            verify: () => (calls.push("source"), true),
            verifyPackageClosure: () => (calls.push("closure"), true)
        });
        expect(source.verify({}, {} as never)).toBe(true);
        expect(source.verifyPackageClosure({}, {} as never)).toBe(true);

        const delegate = vi.fn(() => true);
        const attenuation = vi.fn(() => true);
        const spawn = new CanonicalRunSpawnPort({
            successfulDelegateReceipt: delegate,
            durableAttenuation: attenuation
        });
        expect(spawn.verify({}, {} as never)).toBe(true);
        delegate.mockReturnValue(false);
        expect(spawn.verify({}, {} as never)).toBe(false);
        expect(attenuation).toHaveBeenCalledOnce();
        expect(calls).toEqual([
            "receipt",
            "delivery",
            "control",
            "synthesis",
            "administer",
            "forced-cancellation",
            "concat",
            "tree",
            "source",
            "closure"
        ]);
    });
});

function routedAdmissionHarness(
    prepare: (input: {
        reservation: ReturnType<typeof reservationFixture>;
        projection: ReturnType<typeof projectionFixture>;
        bridgeAudit: AuditRecordId;
    }) => ReturnType<typeof routedEvidence>
) {
    const state = { prepared: new Map<string, ReturnType<typeof routedPrepared>>() };
    let preparations = 0;
    const persistence = {
        prepared: (_transaction: typeof state, id: InvocationId) => state.prepared.get(id.value)
    } as unknown as InvocationPersistence<typeof state, string, string, string, string, string>;
    const ledger = {
        prepare: (_transaction: typeof state, record: ReturnType<typeof routedPrepared>) => {
            preparations += 1;
            state.prepared.set(record.header.id.value, record);
        }
    } as unknown as InvocationLedger<typeof state, string, string, string, string, string>;
    const port = new RoutedInvocationAdmissionPort(
        ledger,
        persistence,
        { prepare },
        routedProjection
    );
    return {
        state,
        port,
        get preparations() {
            return preparations;
        }
    };
}

/**
 * Honest projection: reads the authority-relevant identity from whatever header the factory
 * produced. It is deliberately independent of the (adversarial) `prepare` above so that a
 * substituted header surfaces its substitution rather than being masked.
 */
const routedProjection: RoutedInvocationProjection<string, string, string, string> = {
    identify(header) {
        const authority = JSON.parse(header.authority) as {
            readonly binding: string;
            readonly tenant: string;
            readonly principal: string;
        };
        return {
            operation: header.operation.operation,
            targetActor: header.actor,
            binding: new BindingName(authority.binding),
            principal: new PrincipalRef(
                new TenantId(authority.tenant),
                new PrincipalId(authority.principal)
            )
        };
    }
};

function routedEvidence(
    input: {
        reservation: ReturnType<typeof reservationFixture>;
        projection: ReturnType<typeof projectionFixture>;
        bridgeAudit: AuditRecordId;
    },
    substitution?:
        | "invocation"
        | "route"
        | "projection"
        | "auditCause"
        | "auditKind"
        | "auditProjection"
        | "auditReservation"
        | "bridgeIdentity"
        | "bridgeCause"
        | "operation"
        | "targetActor"
        | "authority"
        | "principal",
    payload: Record<string, boolean> = { changed: false }
) {
    const id =
        substitution === "invocation"
            ? new InvocationId("substituted-invocation")
            : input.reservation.invocation;
    const auditId =
        substitution === "bridgeIdentity"
            ? new AuditRecordId("substituted-bridge-identity")
            : input.bridgeAudit;
    const initiator = input.reservation.initiator;
    if (initiator === undefined) {
        throw new Error("Routed admission fixture requires an authenticated initiator");
    }
    const invocation = routedPrepared(
        id,
        substitution === "route"
            ? new RouteReservationId("substituted-route")
            : input.reservation.id,
        substitution === "projection" ? new Digest("f".repeat(64)) : input.projection.digest,
        substitution === "auditCause" ? new AuditRecordId("substituted-audit") : input.bridgeAudit,
        payload,
        {
            operation:
                substitution === "operation"
                    ? "facet.test:substituted"
                    : input.reservation.operation.value,
            actor:
                substitution === "targetActor"
                    ? new ActorRef("workspace", new ActorId("substituted-target"))
                    : input.reservation.targetActor,
            binding:
                substitution === "authority"
                    ? "binding.substituted"
                    : input.reservation.authority.binding.value,
            tenant: initiator.tenantId.value,
            principal:
                substitution === "principal"
                    ? "substituted-principal"
                    : initiator.principalId.value
        }
    );
    return {
        invocation,
        audit: auditRecord(
            auditId,
            substitution === "bridgeCause" ? new AuditRecordId("substituted-bridge") : undefined,
            substitution === "auditKind"
                ? { kind: "event", id: input.reservation.event }
                : {
                      kind: "routeProjected",
                      projection:
                          substitution === "auditProjection"
                              ? reservationFixture("other-projection").projection
                              : input.projection.id,
                      reservation:
                          substitution === "auditReservation"
                              ? new RouteReservationId("other-reservation")
                              : input.reservation.id
                  }
        )
    };
}

function routedPrepared(
    id: InvocationId,
    route: RouteReservationId,
    projectionDigest: Digest,
    auditCause: AuditRecordId,
    payload: Record<string, boolean>,
    identity: {
        readonly operation: string;
        readonly actor: ActorRef;
        readonly binding: string;
        readonly tenant: string;
        readonly principal: string;
    }
) {
    return PreparedInvocation.create(
        {
            id,
            operation: routedOperationPin(identity.operation),
            domain: `domain:${id.value}`,
            actor: identity.actor,
            authority: JSON.stringify({
                binding: identity.binding,
                tenant: identity.tenant,
                principal: identity.principal
            }),
            pathEpochs: `epochs:${id.value}`,
            route,
            projectionDigest,
            auditCause,
            idempotencySeed: `seed:${id.value}`
        },
        { kind: "single", item: payload },
        preparedReferenceCodecs
    );
}

function routedOperationPin(operation: string): OperationPin {
    return OperationPin.create({
        operation: new OperationRef(operation),
        target: "target:routed",
        package: new PackageId("package:routed"),
        version: new SemVer("1.0.0"),
        manifestDigest: routedDigest("manifest"),
        descriptorDigest: routedDigest("descriptor"),
        configurationDigest: routedDigest("configuration"),
        runtimeDigest: routedDigest("runtime"),
        activationGeneration: "generation:routed",
        registration: "registration:routed",
        impact: "observe",
        approvalRequired: false,
        placement: new InvocationPlacementPin({
            manifest: ["bundled", "provider"],
            policy: ["bundled", "provider"],
            substrate: ["bundled", "provider"],
            trust: ["bundled", "provider"],
            selected: "provider"
        })
    });
}

function routedDigest(label: string): Digest {
    return Digest.sha256(new TextEncoder().encode(`routed-${label}`));
}

function auditRecord(
    id: AuditRecordId,
    cause: AuditRecordId | undefined,
    kind: ConstructorParameters<typeof AuditRecord>[0]["kind"]
): AuditRecord {
    return new AuditRecord({
        id,
        actor: new ActorRef("workspace", new ActorId("routed-target")),
        tenant: new TenantId("tenant-test"),
        correlation: new CorrelationId(`correlation:${id.value}`),
        ...(cause === undefined ? {} : { cause }),
        kind
    });
}

function emptyManifest(id: string): FacetManifest {
    return new FacetManifest({
        id: new FacetPackageId(id),
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["bundled"],
        bindings: [],
        contributions: Contributions.empty()
    });
}

class LifecycleFacet extends Facet {
    public readonly ref = new FacetRef("workspace:composition-runtime");

    public constructor(
        public readonly manifest: FacetManifest,
        private readonly onStart: (() => Promise<void>) | undefined,
        private readonly onStop: () => Promise<void> = async () => undefined
    ) {
        super();
    }

    public operation(_name: OperationName): Operation | undefined {
        return undefined;
    }
    public surface(_id: SurfaceId): Surface | undefined {
        return undefined;
    }
    public interceptor(_id: InterceptorDeclaration["id"]): Interceptor | undefined {
        return undefined;
    }
    public children(): readonly Facet[] {
        return [];
    }
    public start(_context: FacetLifecycleContext): Promise<void> {
        return this.onStart?.() ?? Promise.resolve();
    }
    public stop(_context: FacetLifecycleContext): Promise<void> {
        return this.onStop();
    }
}

function loadedBlueprint(
    manifest: FacetManifest,
    dispose: () => Promise<unknown>
): LoadedBlueprint<unknown> {
    return {
        validated: { releases: [{ manifests: [manifest] }] } as never,
        modules: [],
        dispose: async () => {
            await dispose();
        },
        [Symbol.asyncDispose]: async () => {
            await dispose();
        }
    };
}

function loaderReturning(value: LoadedBlueprint<unknown>): BlueprintLoader<unknown> {
    return { load: async () => value } as unknown as BlueprintLoader<unknown>;
}

function slotDeclaration(schema: Record<string, string>): SlotDeclaration {
    return new SlotDeclaration(
        new SlotName("composition-slot"),
        new JsonSchema(schema),
        new SlotAuthorityPolicy(["workspace:*"], ["workspace:*"])
    );
}

function inboxEntry(reference: ReturnType<typeof inboxFixture>, suffix: string): TurnInboxEntry {
    const payload = content(`inbox:${suffix}`);
    return new TurnInboxEntry(
        new TurnInboxEntryId(`inbox-entry:${suffix}`),
        reference.turn,
        reference.sequence,
        reference.event.value,
        payload.ref,
        payload.digest,
        `inbox-key:${suffix}`,
        undefined,
        new Date(1)
    );
}
