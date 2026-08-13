import { describe, expect, test, vi } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    AcceptanceId,
    RunId,
    RunRuntime,
    SpawnReservation,
    SpawnAttenuation,
    TurnId,
    TurnInboxEntry,
    TurnInboxEntryId,
    type AcceptanceReceiptEvidence
} from "../../src/agents";
import {
    CanonicalRunEvidencePort,
    CanonicalRunMergePort,
    CanonicalRunSourceRevisionPort,
    CanonicalRunSpawnPort,
    CanonicalSettlementEvidencePort,
    InvocationInteractionAuditPort,
    type InteractionAuditMetadataPort,
    PackageFacetRuntime,
    ProvenanceFacetSlotBackend,
    RoutedInvocationAdmissionPort,
    RuntimeRunInboxPort,
    type CanonicalSettlementSource,
    type RoutedInvocationProjection
} from "../../src/composition";
import { SpawnReservationId } from "../../src/agents";
import { CompatRange, ContentRef, Digest, JsonSchema, Revision, SemVer, isJsonValue, jsonDataParser } from "../../src/core";
import {
    PackageId,
    PackageInstallationProvenancePort,
    type Blueprint,
    type BlueprintLoader,
    type LoadedBlueprint,
    type PackageRelease,
    type ValidatedBlueprint
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
import { forwarded, reaching, type Assembled } from "./fixture";
import type { CommandEnvelope } from "../../src/protocol";
import {
    AuditRecord,
    AuditRecordId,
    CorrelationId,
    InvocationPlacementPin,
    OperationPin,
    PreparedInvocation,
    ReceiptId,
    type PreparedInvocationHeaderInit,
    type AuditEvidenceResolver,
    type InvocationLedger,
    type InvocationPersistence,
    type RouteAuditEvidence
} from "../../src/invocations";
import {
    InvocationId,
    RouteProjectionId,
    RouteReservationId
} from "../../src/interaction-references";
import { EventId, RouteReservation, SubscriptionId } from "../../src/workspaces";
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

const recordData = jsonDataParser((message) => new TypeError(message));

describe("W9 composition behavior branches", () => {
    test(
        "rejects every substituted routed identity and replays only byte-stable intent",
        { tags: "p0" },
        () => {
            const reservation = reservationFixture("composed-admission");
            const projection = projectionFixture(reservation);
            const bridgeAudit = new AuditRecordId("bridge-audit");
            const input = { reservation, projection, bridgeAudit };

            for (const substitution of [
                "invocation",
                "route",
                "routeAbsent",
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

            const missingBridge = routedAdmissionHarness(
                (payload) => routedEvidence(payload),
                false
            );
            expect(() => missingBridge.port.admit(missingBridge.state, input)).toThrow(
                /exact route projection audit is unavailable/
            );
            expect(missingBridge.preparations).toBe(0);

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
        }
    );

    test(
        "a delegated route pinning no Principal still binds every other routed identity",
        { tags: "p0" },
        () => {
            const projectionContent = content("projection-delegated");
            const bridgeAudit = new AuditRecordId("delegated-bridge-audit");
            const reservation = new RouteReservation({
                id: new RouteReservationId("reservation-delegated"),
                invocation: new InvocationId("invocation-delegated"),
                event: new EventId("event-delegated"),
                sourceAuditCause: new AuditRecordId("audit-event-delegated"),
                sourceActor: new ActorRef("workspace", new ActorId("delegated-source")),
                targetActor: new ActorRef("workspace", new ActorId("delegated-target")),
                tenants: { kind: "same", tenant },
                subscription: new SubscriptionId("subscription-delegated"),
                dedupeKey: "event:event-delegated",
                operation: new OperationRef("facet.test:consume"),
                authority: { kind: "delegated", binding: new BindingName("binding.route") },
                projection: new RouteProjectionId("projection-delegated"),
                projectionRef: projectionContent.ref,
                projectionDigest: projectionContent.digest,
                trust: "authenticated"
            });
            const projection = projectionFixture(reservation);
            const harness = routedAdmissionHarness((payload) => ({
                invocation: routedPrepared(
                    payload.reservation.invocation,
                    payload.reservation.id,
                    payload.projection.digest,
                    payload.bridgeAudit,
                    { changed: false },
                    {
                        operation: payload.reservation.operation.value,
                        actor: payload.reservation.targetActor,
                        binding: payload.reservation.authority.binding.value,
                        tenant: tenant.value,
                        principal: "delegated-unpinned-principal"
                    }
                ),
                audit: auditRecord(payload.bridgeAudit, undefined, {
                    kind: "routeProjected",
                    projection: payload.projection.id,
                    reservation: payload.reservation.id
                })
            }));

            expect(reservation.initiator).toBeUndefined();
            expect(
                harness.port.admit(harness.state, { reservation, projection, bridgeAudit })
            ).toEqual({ kind: "accepted", invocation: reservation.invocation });
            expect(harness.preparations).toBe(1);
        }
    );

    test(
        "builds the target-local audit chain and fails closed when reservation evidence is absent",
        { tags: "p0" },
        () => {
            const event = eventFixture("composed-audit");
            const reservation = reservationFixture("composed-audit");
            const projection = authenticatedProjectionFixture(reservation);
            const delivery = deliveryFixture(reservation);
            const sourceCause = auditRecord(reservation.sourceAuditCause, undefined, {
                kind: "event",
                id: event.id
            });
            const appended: AppendedAudit[] = [];
            let routeEvidence: RouteAuditEvidence | undefined = {
                event: reservation.event,
                invocation: reservation.invocation,
                projection: reservation.projection
            };
            let causeEvidence: AuditRecord | undefined = sourceCause;
            const port = new InvocationInteractionAuditPort({
                actor: reservation.targetActor,
                tenant,
                records: () => ({ get: () => causeEvidence }),
                evidence: () => routeOnlyEvidence(() => routeEvidence),
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

            routeEvidence = undefined;
            expect(() =>
                port.appendReservation({}, reservation, new AuditRecordId("missing-route"))
            ).toThrow(
                new AgentCoreError(
                    "invocation.invalid",
                    "Route reservation audit evidence is unavailable"
                )
            );
            routeEvidence = {
                event: reservation.event,
                invocation: reservation.invocation,
                projection: reservation.projection
            };
            causeEvidence = undefined;
            let missingCause: unknown;
            try {
                port.appendReservation({}, reservation, new AuditRecordId("missing-cause"));
            } catch (error) {
                missingCause = error;
            }
            expect(missingCause).toBeInstanceOf(AgentCoreError);
            expect(missingCause).toMatchObject({
                code: "invocation.invalid",
                message: "Route reservation audit evidence is unavailable"
            });
        }
    );

    test(
        "maps Run inbox conflicts, duplicates, lease rejection, and lifecycle rejection",
        { tags: "p1" },
        () => {
            const turn = new TurnId("composed-inbox-turn");
            const reference = inboxFixture("composed-inbox", 2, 4, turn);
            const token = {
                turn,
                holder: new PrincipalRef(tenant, new PrincipalId("composed-inbox-holder")),
                epoch: 4
            };
            const expected = inboxEntry(reference, "expected");
            let material = expected;
            let existing: TurnInboxEntry | undefined;
            let failure: AgentCoreError | undefined;
            const runtime = reaching<RunRuntime<object>>({
                repository: reaching<RunRuntime<object>["repository"]>({
                    loadInbox: () => existing
                }),
                deliverEventInTransaction: () => {
                    if (failure !== undefined) throw failure;
                    existing = material;
                }
            });
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
            expect(port.append({}, reference, token)).toEqual({
                kind: "rejected",
                reason: "conflict"
            });
            // Same encoded byte length, differing content: only an exact byte-for-byte comparison
            // separates a replay from a substituted entry.
            existing = inboxEntry(reference, "expecteD");
            expect(port.append({}, reference, token)).toEqual({
                kind: "rejected",
                reason: "conflict"
            });

            existing = undefined;
            failure = new AgentCoreError("lease.invalid", "stale lease");
            expect(port.append({}, reference, token)).toEqual({
                kind: "rejected",
                reason: "lease"
            });
            failure = new AgentCoreError("turn.invalid-state", "terminal Turn");
            expect(port.append({}, reference, token)).toEqual({
                kind: "rejected",
                reason: "lifecycle"
            });
            failure = new AgentCoreError("invocation.invalid", "unexpected");
            expect(() => port.append({}, reference, token)).toThrow("unexpected");
        }
    );

    test(
        "owns loaded package handles, rejects double activation, and preserves cleanup failures",
        { tags: "p1" },
        async () => {
            const manifest = emptyManifest("composition.runtime");
            const stops: string[] = [];
            const loaded = loadedBlueprint(
                manifest,
                vi.fn(async () => void stops.push("module"))
            );
            const runtime = new PackageFacetRuntime(loaderReturning(loaded), {
                roots: () => [
                    new LifecycleFacet(manifest, undefined, async () => {
                        stops.push("facet");
                    })
                ]
            });

            expect(runtime.host).toBeUndefined();
            await runtime.activate(reaching<Blueprint>({}));
            expect(runtime.host).toBeDefined();
            await expect(runtime.activate(reaching<Blueprint>({}))).rejects.toMatchObject({
                code: "facet.inactive",
                message: "Package Facet runtime is already active"
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
            await expect(failedActivation.activate(reaching<Blueprint>({}))).rejects.toThrow(
                "start failed"
            );
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
            await failedCleanup.activate(reaching<Blueprint>({}));
            await expect(failedCleanup.dispose()).rejects.toThrow(/Facet stop hook/);
            await expect(failedCleanup.dispose()).resolves.toBeUndefined();

            // A module cleanup failure alone still surfaces: it is the only recorded failure.
            const moduleCleanupFailure = new TypeError("module cleanup failed alone");
            const failedModuleCleanup = new PackageFacetRuntime(
                loaderReturning(
                    loadedBlueprint(manifest, async () => {
                        throw moduleCleanupFailure;
                    })
                ),
                { roots: () => [new LifecycleFacet(manifest, undefined)] }
            );
            await failedModuleCleanup.activate(reaching<Blueprint>({}));
            await expect(failedModuleCleanup.dispose()).rejects.toBe(moduleCleanupFailure);
            await expect(failedModuleCleanup.dispose()).resolves.toBeUndefined();
        }
    );

    test(
        "treats slot installation and contribution as byte-stable append-only provenance",
        { tags: "p0" },
        () => {
            const state = {
                revision: Revision.initial(),
                slots: new Map<string, SlotDeclaration>(),
                entries: new Map<string, SlotEntry>()
            };
            const store = reaching<WorkspaceSlotStore<typeof state>>({
                loadRevision: () => state.revision,
                saveRevision: (_transaction: typeof state, revision: Revision) =>
                    (state.revision = revision),
                loadSlot: (_transaction: typeof state, name: SlotName) =>
                    state.slots.get(name.value),
                insertSlot: (_transaction: typeof state, value: SlotDeclaration) =>
                    state.slots.set(value.name.value, value),
                loadEntry: (_transaction: typeof state, id: SlotEntry["id"]) =>
                    state.entries.get(id.value),
                insertEntry: (_transaction: typeof state, value: SlotEntry) =>
                    state.entries.set(value.id.value, value)
            });
            const declaration = slotDeclaration({ type: "object" });
            const conflictingDeclaration = slotDeclaration({ type: "string" });
            const entry = SlotEntry.create(declaration.name, "workspace:facet", 0, { value: 1 });
            const packageFacet = new FacetPackageId("composition.slot-package");
            const expectedInstallation = new PackageInstallationRef(
                entry.contributor,
                packageFacet
            );
            // applyContribution passes the envelope straight to the provenance port, which the
            // stand-in above answers without reading it.
            const commandEnvelope = reaching<CommandEnvelope>({});
            let installation: PackageInstallationRef | undefined = expectedInstallation;
            let contributionAllowed = true;
            const backend = new ProvenanceFacetSlotBackend(
                store,
                reaching<PackageInstallationProvenancePort<typeof state, CommandEnvelope>>({
                    prepareContribution: () => undefined,
                    resolveContributionForApply: () => installation
                }),
                {
                    permitsInstall: () => true,
                    permitsContribution: () => contributionAllowed
                },
                {
                    revision: () => state.revision,
                    slot: (_read, name) => state.slots.get(name.value)
                }
            );

            installation = undefined;
            expect(() => backend.applyContribution(state, commandEnvelope, {}, entry)).toThrow(
                new AgentCoreError(
                    "authority.denied",
                    "Slot contributor installation provenance changed before apply"
                )
            );
            installation = new PackageInstallationRef(
                new FacetRef("workspace:substituted"),
                packageFacet
            );
            expect(() => backend.applyContribution(state, commandEnvelope, {}, entry)).toThrow(
                new AgentCoreError(
                    "authority.denied",
                    "Slot contributor installation provenance changed before apply"
                )
            );
            installation = expectedInstallation;
            contributionAllowed = false;
            expect(() => backend.applyContribution(state, commandEnvelope, {}, entry)).toThrow(
                new AgentCoreError(
                    "authority.denied",
                    "Current authority does not admit the Slot contributor"
                )
            );
            contributionAllowed = true;
            expect(() => backend.applyContribution(state, commandEnvelope, {}, entry)).toThrow(
                new AgentCoreError(
                    "facet.inactive",
                    `Slot ${declaration.name.value} is not installed`
                )
            );
            expect(backend.install(state, declaration)).toBe(true);
            expect(backend.install(state, declaration)).toBe(false);
            expect(() => backend.install(state, conflictingDeclaration)).toThrow(
                new AgentCoreError(
                    "protocol.invalid-state",
                    "Slot declaration conflicts with installed provenance"
                )
            );
            const invalidEntry = SlotEntry.create(
                declaration.name,
                entry.contributor.value,
                1,
                "invalid"
            );
            expect(() =>
                backend.applyContribution(state, commandEnvelope, {}, invalidEntry)
            ).toThrow(
                new AgentCoreError(
                    "operation.invalid-input",
                    `Slot entry ${invalidEntry.id.value} does not match the entry schema`
                )
            );
            const appliedEntry = SlotEntry.create(declaration.name, entry.contributor.value, 2, {
                applied: true
            });
            expect(backend.applyContribution(state, commandEnvelope, {}, appliedEntry)).toBe(true);
            expect(backend.contribute(state, entry)).toBe(true);
            expect(backend.contribute(state, entry)).toBe(false);
            state.entries.set(
                entry.id.value,
                SlotEntry.create(declaration.name, "workspace:substituted", 0, { value: 2 })
            );
            expect(() => backend.contribute(state, entry)).toThrow(
                new AgentCoreError(
                    "protocol.invalid-state",
                    "Slot contribution conflicts with authenticated installation provenance"
                )
            );
            expect(() => backend.advanceRevision(state, new Revision(1))).toThrow(
                new AgentCoreError("protocol.revision-conflict", "Slot revision changed")
            );
            expect(backend.advanceRevision(state, Revision.initial()).value).toBe(1);
            expect(backend.currentRevision(state).value).toBe(1);
            expect(backend.permitsInstall(state, declaration)).toBe(true);
            expect(backend.permitsContribution(state, entry)).toBe(true);
            expect(backend.slot(state, declaration.name)).toBe(declaration);
        }
    );

    test(
        "delegates canonical run evidence without reconstructing cross-domain identities",
        { tags: "p1" },
        () => {
            const calls: string[] = [];
            const receipt = new CanonicalRunEvidencePort({
                receipt: () => (calls.push("receipt"), undefined),
                delivery: () => (calls.push("delivery"), undefined),
                control: () => (calls.push("control"), undefined),
                synthesis: () => (calls.push("synthesis"), undefined),
                administer: () => (calls.push("administer"), undefined),
                forcedCancellation: () => (calls.push("forced-cancellation"), undefined)
            });
            receipt.receipt({}, forwarded(), forwarded());
            receipt.delivery({}, forwarded(), forwarded());
            receipt.control({}, forwarded(), forwarded());
            receipt.synthesis({}, forwarded());
            receipt.administer({}, forwarded(), forwarded());
            receipt.forcedCancellation({}, forwarded(), forwarded());

            const merge = new CanonicalRunMergePort({
                concat: () => (calls.push("concat"), true),
                tree: () => (calls.push("tree"), true)
            });
            expect(merge.verifyConcat({}, forwarded(), forwarded(), forwarded())).toBe(true);
            expect(merge.verifyTree({}, forwarded(), forwarded(), forwarded())).toBe(true);

            const source = new CanonicalRunSourceRevisionPort({
                verify: () => (calls.push("source"), true),
                verifyPackageClosure: () => (calls.push("closure"), true)
            });
            expect(source.verify({}, forwarded())).toBe(true);
            expect(source.verifyPackageClosure({}, forwarded())).toBe(true);

            const delegate = vi.fn(() => true);
            const attenuation = vi.fn(() => true);
            const spawn = new CanonicalRunSpawnPort({
                successfulDelegateReceipt: delegate,
                durableAttenuation: attenuation,
                attenuation: () => new SpawnAttenuation()
            });
            expect(spawn.verify({}, forwarded())).toBe(true);
            delegate.mockReturnValue(false);
            expect(spawn.verify({}, forwarded())).toBe(false);
            expect(attenuation).toHaveBeenCalledOnce();

            // administer and forcedCancellation are optional on the source: a source that omits
            // them reports no evidence rather than faulting.
            const partial = new CanonicalRunEvidencePort({
                receipt: () => undefined,
                delivery: () => undefined,
                control: () => undefined,
                synthesis: () => undefined
            });
            expect(partial.administer({}, forwarded(), forwarded())).toBeUndefined();
            expect(partial.forcedCancellation({}, forwarded(), forwarded())).toBeUndefined();

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
        }
    );

    test(
        "treats an unimplemented evidence source as absent evidence, never as satisfied",
        { tags: "p0" },
        () => {
            // Four of these source methods are optional, which means two different things
            // have to hold and only one of them is about not faulting.
            //
            // The evidence readers report *no evidence*: a source that cannot say whether
            // an acceptance Receipt exists must return undefined, and the reader that
            // dropped its optional call would fault on a source that is within contract.
            //
            // acceptanceSatisfied is the one that decides something. It answers a boolean,
            // so an absent source has to answer `false` — "this acceptance is not shown
            // satisfied" — and never `true`. Defaulting the other way would discharge every
            // acceptance criterion on a deployment whose source simply does not implement
            // the check, which is the settlement gate of §9 passing because nobody wired it.
            const receipt = new ReceiptId("acceptance-receipt");
            const acceptance = new AcceptanceId("acceptance-1");
            const evidence: AcceptanceReceiptEvidence = {
                kind: "acceptanceReceipt",
                receipt,
                outcome: "succeeded",
                operation: new OperationRef("memory:recall")
            };

            const absent = new CanonicalRunEvidencePort<object>({
                receipt: () => undefined,
                delivery: () => undefined,
                control: () => undefined,
                synthesis: () => undefined
            });
            expect(absent.acceptance({}, receipt)).toBeUndefined();

            const present = new CanonicalRunEvidencePort<object>({
                receipt: () => undefined,
                delivery: () => undefined,
                control: () => undefined,
                synthesis: () => undefined,
                acceptance: () => evidence
            });
            expect(present.acceptance({}, receipt)).toBe(evidence);

            const settlement = (
                acceptanceSatisfied?: CanonicalSettlementSource<object>["acceptanceSatisfied"]
            ) => {
                const source: CanonicalSettlementSource<object> = {
                    approvalResolved: () => true,
                    invocationItemTerminal: () => true,
                    routeTerminal: () => true,
                    reconciliationSuperseded: () => true,
                    commitExists: () => true,
                    auditSatisfied: () => true
                };
                if (acceptanceSatisfied !== undefined) {
                    source.acceptanceSatisfied = acceptanceSatisfied;
                }
                return new CanonicalSettlementEvidencePort<object>(source);
            };
            expect(settlement().acceptanceSatisfied({}, acceptance)).toBe(false);
            expect(settlement(() => false).acceptanceSatisfied({}, acceptance)).toBe(false);
            expect(settlement(() => true).acceptanceSatisfied({}, acceptance)).toBe(true);

            // The spawn port hands back the source's own attenuation. Returning nothing
            // would leave a delegated Run with no recorded narrowing at all.
            const attenuation = new SpawnAttenuation();
            const spawn = new CanonicalRunSpawnPort<object>({
                successfulDelegateReceipt: () => true,
                durableAttenuation: () => true,
                attenuation: () => attenuation
            });
            const parentTurn = new TurnId("spawn-turn");
            const reservation = new SpawnReservation(
                new SpawnReservationId("spawn-1"),
                new RunId("parent-run"),
                parentTurn,
                new RunId("child-run"),
                {
                    turn: parentTurn,
                    holder: new PrincipalRef(
                        new TenantId("spawn-tenant"),
                        new PrincipalId("spawn-principal")
                    ),
                    epoch: 0
                },
                new Digest("1".repeat(64)),
                new ContentRef(`sha256:${"2".repeat(64)}`),
                new InvocationId("spawn-invocation"),
                new ReceiptId("spawn-receipt"),
                new Digest("3".repeat(64)),
                new Date(1_000)
            );
            expect(spawn.attenuation({}, reservation)).toBe(attenuation);
        }
    );
});

function routedAdmissionHarness(
    prepare: (input: {
        reservation: ReturnType<typeof reservationFixture>;
        projection: ReturnType<typeof projectionFixture>;
        bridgeAudit: AuditRecordId;
    }) => ReturnType<typeof routedEvidence>,
    persistBridge = true
) {
    const state = {
        prepared: new Map<string, ReturnType<typeof routedPrepared>>(),
        audits: new Map<string, AuditRecord>()
    };
    let preparations = 0;
    const persistence = reaching<
        InvocationPersistence<typeof state, string, string, string, string, string>
    >({
        prepared: (_transaction, id) => state.prepared.get(id.value)
    });
    const requireAudit = (record: AuditRecord): void => {
        const persisted = state.audits.get(record.id.value);
        if (
            persisted === undefined ||
            !Buffer.from(AuditRecord.encode(persisted)).equals(
                Buffer.from(AuditRecord.encode(record))
            )
        ) {
            throw new TypeError("exact route projection audit is unavailable");
        }
    };
    const ledger = reaching<InvocationLedger<typeof state, string, string, string, string, string>>(
        {
            requirePreparedAudit: (_transaction, _record, audit) => requireAudit(audit),
            prepareWithAudit: (_transaction, record, audit) => {
                requireAudit(audit);
                preparations += 1;
                state.prepared.set(record.header.id.value, record);
            }
        }
    );
    const port = new RoutedInvocationAdmissionPort(
        ledger,
        persistence,
        {
            prepare(input) {
                if (persistBridge) {
                    state.audits.set(
                        input.bridgeAudit.value,
                        auditRecord(input.bridgeAudit, undefined, {
                            kind: "routeProjected",
                            projection: input.projection.id,
                            reservation: input.reservation.id
                        })
                    );
                }
                return prepare(input);
            }
        },
        routedProjection,
        {
            audit: (_transaction, id) => state.audits.get(id.value),
            findAuditByEvidence: () => undefined,
            appendAudit: () => {
                throw new TypeError("routed admission must not append its bridge root");
            }
        }
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
        const parsed: unknown = JSON.parse(header.authority);
        if (!isJsonValue(parsed)) throw new TypeError("Invocation authority is not JSON");
        const authority = recordData.object(parsed, "Invocation authority");
        return {
            operation: header.operation.operation,
            targetActor: header.actor,
            binding: new BindingName(recordData.string(authority["binding"], "Authority binding")),
            principal: new PrincipalRef(
                new TenantId(recordData.string(authority["tenant"], "Authority tenant")),
                new PrincipalId(recordData.string(authority["principal"], "Authority principal"))
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
        | "routeAbsent"
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
    const routeValue =
        substitution === "routeAbsent"
            ? undefined
            : substitution === "route"
              ? new RouteReservationId("substituted-route")
              : input.reservation.id;
    const invocation = routedPrepared(
        id,
        routeValue,
        routeValue === undefined
            ? undefined
            : substitution === "projection"
              ? new Digest("f".repeat(64))
              : input.projection.digest,
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
                substitution === "principal" ? "substituted-principal" : initiator.principalId.value
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
    route: RouteReservationId | undefined,
    projectionDigest: Digest | undefined,
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
    const header: Assembled<PreparedInvocationHeaderInit<string, string, string, string>> = {
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
        auditCause,
        idempotencySeed: `seed:${id.value}`
    };
    if (route !== undefined) header.route = route;
    if (projectionDigest !== undefined) header.projectionDigest = projectionDigest;
    return PreparedInvocation.create(
        header,
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

interface AppendedAudit {
    readonly record: AuditRecord;
    readonly admission?: RouteProjectionAdmission;
}

/** The projection admission the audit port passes alongside a routeProjected record. */
type RouteProjectionAdmission = Parameters<InteractionAuditMetadataPort<unknown>["append"]>[2];

/**
 * An evidence resolver that answers only the route lookup the reservation path makes. Every
 * other member throws rather than answering `undefined`, so a path that grows a new evidence
 * lookup fails here instead of quietly taking the absent-evidence branch.
 */
function routeOnlyEvidence(route: () => RouteAuditEvidence | undefined): AuditEvidenceResolver {
    const unreached = (member: string) => (): never => {
        throw new Error(`The reservation audit path resolves no ${member} evidence`);
    };
    return {
        route,
        approval: unreached("approval"),
        attempt: unreached("attempt"),
        receipt: unreached("receipt"),
        event: unreached("event"),
        projection: unreached("projection"),
        delivery: unreached("delivery"),
        commit: unreached("commit"),
        write: unreached("write")
    };
}

function auditRecord(
    id: AuditRecordId,
    cause: AuditRecordId | undefined,
    kind: ConstructorParameters<typeof AuditRecord>[0]["kind"]
): AuditRecord {
    const init: Assembled<ConstructorParameters<typeof AuditRecord>[0]> = {
        id,
        actor: new ActorRef("workspace", new ActorId("routed-target")),
        tenant: new TenantId("tenant-test"),
        correlation: new CorrelationId(`correlation:${id.value}`),
        kind
    };
    if (cause !== undefined) init.cause = cause;
    return new AuditRecord(init);
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
    dispose: () => Promise<void>
): LoadedBlueprint<unknown> {
    return {
        validated: reaching<ValidatedBlueprint>({
            releases: [reaching<PackageRelease>({ manifests: [manifest] })]
        }),
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
    return reaching<BlueprintLoader<unknown>>({ load: async () => value });
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
