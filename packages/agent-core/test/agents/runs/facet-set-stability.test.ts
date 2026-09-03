import { describe, expect, it } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import {
    PlacementPin,
    RunRepository,
    RunRuntime,
    TurnBoundOperation,
    TurnExecutor,
    TurnExecutorHost,
    TurnInvocationPort,
    TurnPlacementSnapshot,
    type LeaseToken,
    type RunTransaction,
    type TurnContext,
    type TurnInvocationRequest,
    type TurnInvocationResult,
    type TurnOutcome
} from "../../../src/agents/runs";
import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityMutationService,
    Binding,
    BindingValidationRequest,
    Grant,
    GrantId,
    MemoryTenantControlStore,
    TenantAuthorityRuntime
} from "../../../src/authority";
import {
    FacetInvocationDrainPort,
    FacetWithdrawal,
    type FacetWithdrawalOutcome,
    type FacetWithdrawalResult
} from "../../../src/composition";
import {
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    encodeCanonicalJson,
    type JsonValue
} from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import {
    BindingName,
    CapabilitySpec,
    FacetRef,
    OperationDescriptor,
    OperationName,
    OperationRef,
    ProtectionDomain,
    PromptSection,
    SlotName
} from "../../../src/facets";
import { ScopeRef, SubjectRef, Workspace, WorkspaceId } from "../../../src/identity";
import { AuditRecordId, type InvocationId } from "../../../src/interaction-references";
import { OperationRequestKey } from "../../../src/operations";
import {
    SqliteWorkspaceRecords,
    SqliteWorkspaceSlotStore,
    type TransactionalSqlite
} from "../../../src/substrates";
import {
    WorkspacePersistence,
    WorkspaceRoutingWithdrawal,
    type ContentRetentionPort
} from "../../../src/workspaces";
import { TestSqlite } from "../../helpers/sqlite";
import { attribution, declarerSlot, entry } from "../../w3/slot-store-contract";
import { UncontributedCutPoints, harness, ids, seedRunningTurn } from "./fixture";

const tenantId = ids.holder.tenantId;
const workspaceId = new WorkspaceId("facet-set-workspace");
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const subject = SubjectRef.principal(ids.holder);
const tenantActor = new ActorRef("tenant", new ActorId("facet-set-tenant-actor"));
const workspaceActor = new ActorRef("workspace", new ActorId("facet-set-workspace-actor"));
const memberDomain = new ProtectionDomain("backend", "facet-set", "may-hold-secrets");
const slotName = new SlotName("dashboard.card");
const objectSchema = new JsonSchema({ type: "object" });

/** Inside the Turn's lease window, so every plane reads and writes as one mid-Turn moment. */
const NOW = new Date(2_000);

/** Captured by the Turn; the Grant behind it is revoked mid-Turn. */
const keeperFacet = new FacetRef("memory:primary");
/** Captured by the Turn; its Workspace contribution is withdrawn mid-Turn. */
const withdrawnFacet = new FacetRef("mail:primary");
/** Installed mid-Turn; the capture omits it, so this Turn never composes it. */
const installedFacet = new FacetRef("notes:primary");

const keeperGrantId = new GrantId("facet-set-keeper-grant");
const useArguments = { folder: "inbox" } satisfies Record<string, JsonValue>;
const keeperOperation = boundOperation(keeperFacet, "memory");
const withdrawnOperation = boundOperation(withdrawnFacet, "mail");
const installedOperation = boundOperation(installedFacet, "notes");

describe("a Turn's captured FacetSet under a mid-Turn install, withdrawal, and Grant revocation", () => {
    it(
        "[C13-TURN-FACET-SET-STABLE] keeps the captured membership byte-identical across a mid-Turn install and withdrawal while a Grant revoked mid-Turn denies the next use of a member it still composes",
        { tags: "p0" },
        async () => {
            const fixture = await exerciseFixture();
            const captured = capturedPlacement(fixture);
            const capturedBytes = TurnPlacementSnapshot.codec.encode(captured);
            expect(captured.facetSet.map((ref) => ref.value)).toEqual([
                withdrawnFacet.value,
                keeperFacet.value
            ]);

            const observed: MidTurnObservations = {
                catalog: [],
                facetSet: [],
                placement: undefined,
                composesWithdrawn: undefined,
                composesInstalled: undefined,
                withdrawal: undefined
            };

            const denial = await deniedBy(
                executorHost(
                    fixture,
                    [keeperOperation, withdrawnOperation],
                    new ScriptedTurnExecutor(async (context) => {
                        observed.catalog = context.operations.map(
                            (operation) => operation.facet.value
                        );
                        const keeper = composedMember(context, keeperFacet);

                        // The member is usable before anything moves, so the refusal below is
                        // the revocation's doing rather than a Binding that never worked.
                        await expect(
                            context.invocation.invoke(
                                keeper,
                                new OperationRequestKey("use-before"),
                                useArguments
                            )
                        ).resolves.toEqual({
                            tier: "direct",
                            output: { read: keeperFacet.value }
                        });

                        // Mid-Turn in the Workspace plane: one install and one withdrawal,
                        // both committed while this Turn runs.
                        fixture.workspace.slots.contribute(
                            entry(installedFacet.value, 20, { title: "Notes" })
                        );
                        contributePromptSection(fixture.workspace, installedFacet, 1);
                        observed.withdrawal = fixture.workspace.withdrawal.withdraw(
                            attribution(withdrawnFacet.value)
                        );

                        // Mid-Turn in the authority plane: the Grant behind a member this
                        // Turn still composes.
                        fixture.authority.service.revokeGrant(keeperGrantId);

                        const during = capturedPlacement(fixture);
                        observed.facetSet = during.facetSet.map((ref) => ref.value);
                        observed.placement = TurnPlacementSnapshot.codec.encode(during);
                        observed.composesWithdrawn = during.composes(withdrawnFacet);
                        observed.composesInstalled = during.composes(installedFacet);

                        // The next use of that still-composed member.
                        await context.invocation.invoke(
                            keeper,
                            new OperationRequestKey("use-after"),
                            useArguments
                        );
                        throw new TypeError(
                            "A revoked Grant must deny the next use of the member it backs"
                        );
                    })
                ).execute(fixture.token)
            );

            // Both planes really moved under the running Turn: a membership assertion over a
            // Scope nothing changed would prove nothing.
            expect(retired(observed.withdrawal).slots.entries).toHaveLength(1);
            expect(
                fixture.workspace.slots
                    .entries(slotName)
                    .map((slotEntry) => slotEntry.attribution.contributor.value)
            ).toEqual([installedFacet.value]);
            expect(
                fixture.workspace.persistence
                    .listPromptSections(fixture.workspace.database)
                    .map((section) => section.attribution.contributor.value)
            ).toEqual([installedFacet.value]);
            expect(fixture.authority.store.grant(keeperGrantId)?.isLive).toBe(false);

            // Membership is unchanged: the same bytes, the withdrawn ref still composed, and
            // the installed ref still absent from a set that captured it nowhere.
            expect(observed.catalog).toEqual([keeperFacet.value, withdrawnFacet.value]);
            expect(observed.facetSet).toEqual([withdrawnFacet.value, keeperFacet.value]);
            expect(observed.placement).toEqual(capturedBytes);
            expect(observed.composesWithdrawn).toBe(true);
            expect(observed.composesInstalled).toBe(false);

            // Authority was not frozen with it: the first use was authorized, the next one was
            // denied by the Tenant authority plane, and only the first reached the Facet.
            expect(denial.code).toBe("authority.denied");
            expect(denial.message).toBe(
                "Binding requires a live allow Grant reaching its Workspace"
            );
            expect(fixture.port.authorized).toEqual(["use-before"]);

            // ...and the set the Turn composes is still the captured one after the denial, so
            // neither half was traded for the other.
            const after = capturedPlacement(fixture);
            expect(TurnPlacementSnapshot.codec.encode(after)).toEqual(capturedBytes);
            expect([
                after.composes(keeperFacet),
                after.composes(withdrawnFacet),
                after.composes(installedFacet)
            ]).toEqual([true, true, false]);
        }
    );

    it(
        "[C13-TURN-FACET-SET-STABLE] still admits the withdrawn member's Operation at the executor seam and refuses one bound to the Facet installed after capture",
        { tags: "p1" },
        async () => {
            const fixture = await exerciseFixture();
            fixture.workspace.slots.contribute(entry(installedFacet.value, 20, { title: "Notes" }));
            contributePromptSection(fixture.workspace, installedFacet, 1);
            expect(
                retired(fixture.workspace.withdrawal.withdraw(attribution(withdrawnFacet.value)))
                    .slots.entries
            ).toHaveLength(1);

            // The withdrawn member is still this Turn's to compose: the executor validates the
            // offered Operation against the capture, not against the Scope's current installs.
            const catalog: string[] = [];
            const stop = new TypeError("The exercise reads the catalog and stops the Turn");
            await expect(
                executorHost(
                    fixture,
                    [withdrawnOperation],
                    new ScriptedTurnExecutor(async (context) => {
                        catalog.push(...context.operations.map((operation) => operation.facet.value));
                        throw stop;
                    })
                ).execute(fixture.token)
            ).rejects.toBe(stop);
            expect(catalog).toEqual([withdrawnFacet.value]);

            // The installed ref stays unavailable to this Turn however the Scope changed.
            const refused = await deniedBy(
                executorHost(
                    fixture,
                    [installedOperation],
                    new ScriptedTurnExecutor(async () => {
                        throw new TypeError("A Facet the capture omits reaches no executor");
                    })
                ).execute(fixture.token)
            );
            expect(refused.code).toBe("turn.invalid-state");
            expect(refused.message).toBe(
                "Turn Operation is absent from the immutable placement snapshot"
            );
        }
    );
});

interface MidTurnObservations {
    catalog: readonly string[];
    facetSet: readonly string[];
    placement: Uint8Array | undefined;
    composesWithdrawn: boolean | undefined;
    composesInstalled: boolean | undefined;
    withdrawal: FacetWithdrawalOutcome | undefined;
}

interface AuthorityPlane {
    readonly store: MemoryTenantControlStore;
    readonly service: AuthorityMutationService;
    readonly runtime: TenantAuthorityRuntime;
}

interface WorkspacePlane {
    readonly database: TestSqlite;
    readonly slots: SqliteWorkspaceSlotStore;
    readonly persistence: WorkspacePersistence<TransactionalSqlite>;
    readonly withdrawal: FacetWithdrawal<TransactionalSqlite>;
}

interface ExerciseFixture {
    readonly authority: AuthorityPlane;
    readonly workspace: WorkspacePlane;
    readonly runtime: RunRuntime<object>;
    readonly repository: RunRepository<RunTransaction>;
    readonly token: LeaseToken;
    readonly port: ReauthorizingInvocationPort;
    readonly prompt: ContentRef;
}

/**
 * The three planes this rule spans, wired to their real implementations: the Tenant authority
 * records a use re-authorizes against, the Workspace Actor's own store that an install and a
 * withdrawal commit into, and a running Turn whose immutable placement snapshot captured the
 * two members. No plane shares a transaction with another, which is what makes "mid-Turn"
 * mean anything here.
 */
async function exerciseFixture(): Promise<ExerciseFixture> {
    const authority = authorityPlane();
    const workspace = workspacePlane();
    const runs = seedRunningTurn(harness(), {}, [
        new PlacementPin({
            facet: keeperFacet,
            manifest: ["dynamic"],
            policy: ["dynamic"],
            substrate: ["dynamic"],
            trust: ["dynamic"],
            selected: "dynamic"
        }),
        new PlacementPin({
            facet: withdrawnFacet,
            manifest: ["dynamic"],
            policy: ["dynamic"],
            substrate: ["dynamic"],
            trust: ["dynamic"],
            selected: "dynamic"
        })
    ]);
    const prompt = (await runs.repository.content.put(new TextEncoder().encode("facet-set prompt")))
        .ref;
    // The Workspace state the Turn was captured against: the withdrawing Facet's contribution.
    workspace.slots.contribute(entry(withdrawnFacet.value, 10, { title: "Mail" }));
    contributePromptSection(workspace, withdrawnFacet, 0);
    return {
        authority,
        workspace,
        runtime: runs.runtime,
        repository: runs.repository,
        token: runs.token,
        port: new ReauthorizingInvocationPort(new TurnMemberAuthority(authority)),
        prompt
    };
}

function authorityPlane(): AuthorityPlane {
    const anchor = {
        actorId: tenantActor.id,
        tenantId,
        principalId: ids.holder.principalId,
        trustAnchor: Uint8Array.of(3, 1, 4)
    };
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    service.createWorkspace(new Workspace(workspaceId, tenantId, undefined, Revision.initial()));
    service.createGrant(
        new Grant(
            keeperGrantId,
            workspaceScope,
            subject,
            "allow",
            new CapabilitySpec({
                facetPattern: "memory:*",
                operations: ["read"],
                impacts: ["observe"]
            }),
            { kind: "direct" }
        )
    );
    service.createBinding(
        Binding.active(
            workspaceScope,
            subject,
            memberDomain,
            keeperOperation.binding,
            keeperGrantId,
            keeperFacet
        )
    );
    return { store, service, runtime: new TenantAuthorityRuntime(store, tenantActor) };
}

function workspacePlane(): WorkspacePlane {
    const database = new TestSqlite();
    const records = new SqliteWorkspaceRecords(database);
    const persistence = new WorkspacePersistence<TransactionalSqlite>(
        () => records,
        new UnretainedContent(),
        workspaceActor,
        tenantId
    );
    const slots = new SqliteWorkspaceSlotStore(workspaceId, database);
    slots.install(declarerSlot(slotName.value));
    return {
        database,
        slots,
        persistence,
        withdrawal: new FacetWithdrawal(
            slots,
            new WorkspaceRoutingWithdrawal(persistence, {
                deliveryAudit: () => new AuditRecordId("facet-set-withdrawal-audit")
            }),
            persistence,
            (operation, ...guard) => database.transaction(() => operation(database), ...guard),
            { reliedUponBy: () => [] },
            new NoAdmittedInvocations()
        )
    };
}

/**
 * The §3.4 re-authorization one use performs, over the Tenant authority plane's current
 * records. It holds no verdict of its own: the Binding is read back, revalidated for a live
 * backing Grant, and checked against the path epochs that validation just derived, so a Grant
 * revoked between two uses is observed by the authority runtime at the second one rather than
 * by a rule this test wrote beside it.
 */
class TurnMemberAuthority {
    public constructor(private readonly plane: AuthorityPlane) {}

    public authorize(operation: TurnBoundOperation): AuthorityCheckEvidence {
        const binding = this.plane.store.binding(
            Binding.keyFor(workspaceScope, subject, memberDomain, operation.binding)
        );
        if (binding === undefined) {
            throw new AgentCoreError(
                "binding.invalid",
                `No Binding named ${operation.binding.value} exists for this Principal`
            );
        }
        const validated = this.plane.runtime.validateBinding(
            new BindingValidationRequest({
                ownerTenant: tenantId,
                workspaceActor,
                workspaceFence: 1,
                scope: workspaceScope,
                domain: memberDomain,
                name: binding.name,
                grantId: binding.grantId,
                facet: binding.facet,
                nonce: `validate:${operation.binding.value}`
            }),
            NOW
        );
        const evidence = this.plane.runtime.check(
            new AuthorityCheckRequest({
                ownerTenant: tenantId,
                owner: workspaceActor,
                ownerFence: 1,
                principal: ids.holder,
                binding,
                intent: {
                    facet: operation.facet,
                    operation: operation.descriptor.name.value,
                    impact: operation.descriptor.impact,
                    arguments: useArguments,
                    argumentsDigest: Digest.sha256(encodeCanonicalJson(useArguments))
                },
                expectedPath: validated.pathEpochs,
                invocationDigest: Digest.sha256(
                    encodeCanonicalJson({ use: operation.binding.value })
                ),
                itemIndex: 0,
                attemptOrdinal: 0,
                nonce: `use:${operation.binding.value}`
            }),
            NOW
        );
        if (!evidence.allowed) {
            throw new AgentCoreError(
                "authority.denied",
                `Authority refused ${operation.binding.value}: ${evidence.reason}`
            );
        }
        return evidence;
    }
}

/**
 * The executor's invocation seam, served by that re-authorization. A `direct` result carries
 * no durable evidence (SPEC §7.2), which is exactly what an authorized observe call produces,
 * so nothing here has to invent an Invocation record to answer a use.
 */
class ReauthorizingInvocationPort extends TurnInvocationPort {
    public readonly authorized: string[] = [];

    public constructor(private readonly authority: TurnMemberAuthority) {
        super();
    }

    public async invoke(request: TurnInvocationRequest): Promise<TurnInvocationResult> {
        this.authority.authorize(request.operation);
        this.authorized.push(request.requestKey.value);
        return { tier: "direct", output: { read: request.operation.facet.value } };
    }
}

class ScriptedTurnExecutor extends TurnExecutor {
    public constructor(private readonly script: (context: TurnContext) => Promise<TurnOutcome>) {
        super();
    }

    public execute(context: TurnContext): Promise<TurnOutcome> {
        return this.script(context);
    }
}

/** No Invocation was admitted against these Facets, so a withdrawal has nothing to drain. */
class NoAdmittedInvocations extends FacetInvocationDrainPort<TransactionalSqlite> {
    public admitted(): readonly InvocationId[] {
        return [];
    }

    public terminal(): boolean {
        return true;
    }
}

/** No record this exercise writes names content, so no retention edge is ever owed. */
class UnretainedContent implements ContentRetentionPort<TransactionalSqlite> {
    public verify(): boolean {
        return true;
    }

    public retain(): void {}

    public release(): void {}

    public discard(): void {}
}

function executorHost(
    fixture: ExerciseFixture,
    offered: readonly TurnBoundOperation[],
    executor: TurnExecutor
) {
    return new TurnExecutorHost({
        runtime: fixture.runtime,
        cutPoints: new UncontributedCutPoints(),
        executor,
        content: fixture.repository.content,
        operations: { resolve: async () => offered },
        prompt: { assemble: async () => fixture.prompt },
        invocations: fixture.port,
        model: {
            call: async () => {
                throw new TypeError("This exercise makes no model call");
            }
        },
        stream: {
            publish: async () => {
                throw new TypeError("This exercise publishes no stream event");
            }
        },
        now: () => NOW
    });
}

/**
 * The Turn's composition view as the executor seam reads it: loaded from the Run store through
 * the production execution-scope read, so an assertion over it is an assertion over the record
 * the Turn actually composes from rather than over an object the test is still holding.
 */
function capturedPlacement(fixture: ExerciseFixture): TurnPlacementSnapshot {
    const repository = fixture.repository;
    return repository.transaction(
        (transaction) => repository.loadExecutionScope(transaction, fixture.token, NOW).placement
    );
}

function composedMember(context: TurnContext, facet: FacetRef): TurnBoundOperation {
    const member = context.operations.find((operation) => operation.facet.equals(facet));
    if (member === undefined) throw new TypeError(`The Turn does not compose ${facet.value}`);
    return member;
}

function boundOperation(facet: FacetRef, binding: string): TurnBoundOperation {
    const facetPackage = facet.value.slice(0, facet.value.indexOf(":"));
    return new TurnBoundOperation(
        new BindingName(binding),
        facet,
        new OperationRef(`${facetPackage}:read`),
        new OperationDescriptor(new OperationName("read"), "observe", objectSchema, objectSchema)
    );
}

/** One attributed Workspace record beside the Slot entry, so a withdrawal retires both. */
function contributePromptSection(plane: WorkspacePlane, facet: FacetRef, position: number): void {
    const section = new PromptSection(
        `Section ${facet.value}`,
        `Body ${facet.value}`,
        position,
        attribution(facet.value),
        position
    );
    plane.database.transaction(() => plane.persistence.putPromptSection(plane.database, section));
}

/**
 * The retired half of the withdrawal outcome union, so an assertion about what a withdrawal
 * removed cannot silently read a deferral that removed nothing.
 */
function retired(outcome: FacetWithdrawalOutcome | undefined): FacetWithdrawalResult {
    if (outcome?.kind !== "retired") {
        throw new TypeError(`Expected a retired withdrawal, observed ${outcome?.kind ?? "none"}`);
    }
    return outcome;
}

async function deniedBy(execution: Promise<unknown>): Promise<AgentCoreError> {
    try {
        await execution;
    } catch (error) {
        if (error instanceof AgentCoreError) return error;
        throw new TypeError(`Expected a typed AgentCoreError, caught ${String(error)}`, {
            cause: error
        });
    }
    throw new TypeError("Expected the Turn execution to be refused");
}
