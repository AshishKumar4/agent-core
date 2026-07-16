// @ts-nocheck
import {
    ActorActivation,
    ActorId,
    ActorRecoveryState,
    ActorRef,
    requireSynchronousResult,
    type ActorActivationStore,
    type ActorLocalStore,
    type ActorStartOperation,
    type SynchronousResultGuard
} from "../../src/actors";
import { ContentRef, Digest, Revision, encodeCanonicalJson } from "../../src/core";
import {
    ActorPlan,
    DeploymentId,
    DeploymentKey,
    DesiredProjection,
    ManagedOrigin,
    ManagedStateRecord,
    MaterializationGeneration,
    MaterializationGenerationPointer,
    MaterializationPlan,
    PolicySet,
    policyProjection
} from "../../src/definition";
import { LocalMaterializer } from "../../src/definition/materializer";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    CommandDispatcher,
    CommandAuthenticator,
    CommandEnvelope,
    CommandEnvelopeCodec,
    CommandIngress,
    MATERIALIZATION_COMMANDS,
    MaterializationApplyLocalCommand,
    MaterializationCommandPayload,
    MemoryProtocolPersistence,
    MemoryProtocolRecords,
    type CommandCaller,
    type CommandDispatchResult,
    type MaterializationCommandBackend
} from "../../src/protocol";
import { CounterContentStore, CounterIds } from "../protocol/counter-fixture";
import {
    MemoryManagedResourcePort,
    cloneManagedResources,
    type MemoryManagedResourceState
} from "./managed-resource-port";

export type FakeRunUsage = "empty" | "nonempty" | "unknown";

export interface MaterializationHarnessState extends MemoryManagedResourceState {
    readonly records: MemoryProtocolRecords;
    readonly recovery: Map<string, ActorRecoveryState>;
    readonly plans: Map<string, MaterializationPlan>;
    readonly applyPlans: Map<string, MaterializationPlan>;
    readonly generations: Map<string, MaterializationGeneration>;
    readonly managedState: Map<string, ManagedStateRecord>;
    readonly pointers: Map<string, MaterializationGenerationPointer>;
    nextId: number;
    applyCount: number;
    applyAt: Date | undefined;
    fault: boolean;
    revisionAvailable: boolean;
    runUsage: FakeRunUsage;
}

export interface MaterializationEnvelopeInit {
    readonly caller?: CommandCaller;
    readonly key?: string;
    readonly revision?: Revision;
    readonly omitRevision?: boolean;
    readonly lease?: NonNullable<CommandEnvelope["lease"]>;
}

export class MaterializationHarnessStore
    implements
        ActorLocalStore<MaterializationHarnessState>,
        ActorActivationStore<MaterializationHarnessState>
{
    public readonly owner: ActorRef;
    public state: MaterializationHarnessState = createState();
    #actor: ActorRef | undefined;
    public readonly resourcePort = new MemoryManagedResourcePort<MaterializationHarnessState>();

    public constructor(owner: ActorRef) {
        this.owner = owner;
    }

    public bindActor(actor: ActorRef): void {
        if (this.#actor !== undefined && !this.#actor.equals(actor)) {
            throw new TypeError("Materialization harness store is already bound");
        }
        this.#actor = actor;
    }

    public transaction<Result>(
        operation: (transaction: MaterializationHarnessState) => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        const draft = cloneState(this.state);
        const result = requireSynchronousResult(operation(draft));
        this.state = draft;
        return result;
    }

    public activateActor(
        actor: ActorRef,
        start: ActorStartOperation<MaterializationHarnessState>
    ): ActorRecoveryState {
        const existing = this.#actor !== undefined;
        const previousActor = this.#actor;
        try {
            return this.transaction((transaction) => {
                this.bindActor(actor);
                const previous = this.loadRecoveryState(transaction, actor);
                if (existing && previous === undefined) {
                    throw new TypeError("Materialization harness Actor recovery state is missing");
                }
                const next =
                    previous === undefined ? ActorRecoveryState.initial(actor) : previous.recover();
                this.saveRecoveryState(transaction, next);
                requireSynchronousResult(
                    start(
                        transaction,
                        previous === undefined
                            ? ActorActivation.created(next)
                            : ActorActivation.recovered(next)
                    )
                );
                return next;
            });
        } catch (error) {
            this.#actor = previousActor;
            throw error;
        }
    }

    public read<Result>(
        transaction: MaterializationHarnessState,
        operation: (read: MaterializationHarnessState) => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return requireSynchronousResult(operation(cloneState(transaction)));
    }

    public loadRecoveryState(
        transaction: MaterializationHarnessState,
        actor: ActorRef
    ): ActorRecoveryState | undefined {
        return transaction.recovery.get(actorKey(actor));
    }

    public saveRecoveryState(
        transaction: MaterializationHarnessState,
        state: ActorRecoveryState
    ): void {
        transaction.recovery.set(actorKey(state.actor), state);
    }

    public loadGeneration(
        transaction: MaterializationHarnessState,
        id: Digest
    ): MaterializationGeneration | undefined {
        return transaction.generations.get(id.value);
    }

    public insertGeneration(
        transaction: MaterializationHarnessState,
        generation: MaterializationGeneration
    ): void {
        if (transaction.generations.has(generation.id.value)) {
            throw new TypeError("Materialization generation already exists");
        }
        transaction.generations.set(generation.id.value, generation);
    }

    public loadManagedState(
        transaction: MaterializationHarnessState,
        id: Digest
    ): ManagedStateRecord | undefined {
        return transaction.managedState.get(id.value);
    }

    public insertManagedState(
        transaction: MaterializationHarnessState,
        record: ManagedStateRecord
    ): void {
        if (transaction.managedState.has(record.id.value)) {
            throw new TypeError("Managed state already exists");
        }
        transaction.managedState.set(record.id.value, record);
    }

    public loadGenerationPointer(
        transaction: MaterializationHarnessState,
        actor: ActorRef,
        deploymentId: DeploymentId
    ): MaterializationGenerationPointer | undefined {
        return transaction.pointers.get(pointerKey(actor, deploymentId));
    }

    public compareAndSetGenerationPointer(
        transaction: MaterializationHarnessState,
        actor: ActorRef,
        deploymentId: DeploymentId,
        expectedRevision: Revision | undefined,
        next: MaterializationGenerationPointer
    ): boolean {
        const key = pointerKey(actor, deploymentId);
        const current = transaction.pointers.get(key);
        const matches =
            expectedRevision === undefined
                ? current === undefined
                : current?.revision.equals(expectedRevision) === true;
        if (!matches) return false;
        transaction.pointers.set(key, next);
        return true;
    }
}

class HarnessMaterializationBackend implements MaterializationCommandBackend<
    MaterializationHarnessState,
    MaterializationHarnessState
> {
    public constructor(
        private readonly materializer: LocalMaterializer<MaterializationHarnessState>
    ) {}

    public loadPlan(
        read: MaterializationHarnessState,
        planId: Digest
    ): MaterializationPlan | undefined {
        return read.plans.get(planId.value);
    }

    public loadPlanForApply(
        transaction: MaterializationHarnessState,
        planId: Digest
    ): MaterializationPlan | undefined {
        return transaction.applyPlans.get(planId.value) ?? transaction.plans.get(planId.value);
    }

    public currentRevision(
        read: MaterializationHarnessState,
        target: ActorRef,
        plan: MaterializationPlan
    ): Revision | undefined {
        if (!read.revisionAvailable) return undefined;
        return (
            read.pointers.get(pointerKey(target, plan.origin.deploymentId))?.revision.next() ??
            Revision.initial()
        );
    }

    public permitsApply(
        read: MaterializationHarnessState,
        target: ActorRef,
        plan: MaterializationPlan
    ): boolean {
        const pointer = read.pointers.get(pointerKey(target, plan.origin.deploymentId));
        if (pointer === undefined) return true;
        const active = read.generations.get(pointer.generationId.value);
        if (active === undefined) return false;
        const desired = MaterializationGeneration.fromActorPlan(plan.actors[0]!);
        return (
            desired.id.equals(pointer.generationId) ||
            desired.origin.generation > active.origin.generation
        );
    }

    public applyLocal(
        transaction: MaterializationHarnessState,
        _target: ActorRef,
        plan: MaterializationPlan,
        at: Date
    ): Uint8Array {
        const result = this.materializer.applyInTransaction(transaction, plan);
        transaction.applyCount += 1;
        transaction.applyAt = new Date(at);
        if (transaction.fault) {
            throw new TypeError("injected local materialization fault");
        }
        return encodeCanonicalJson({
            insertedRecords: result.insertedRecords.length,
            pointerChanged: result.pointerChanged,
            revision: result.pointer.revision.value
        });
    }
}

export class MaterializationHarness {
    public static readonly now = new Date("2026-07-07T12:00:00.000Z");
    public readonly actor = new ActorRef("tenant", new ActorId("materialization-target"));
    public readonly tenant = new TenantId("materialization-tenant");
    public readonly principal = new PrincipalRef(
        this.tenant,
        new PrincipalId("materialization-principal")
    );
    public readonly caller: CommandCaller = { kind: "actor", actor: this.actor };
    public readonly store: MaterializationHarnessStore;
    readonly #content = new CounterContentStore(() => undefined);
    readonly #ingress: CommandIngress<MaterializationHarnessState, MaterializationHarnessState>;

    public constructor(
        store = new MaterializationHarnessStore(
            new ActorRef("tenant", new ActorId("materialization-target"))
        )
    ) {
        this.store = store;
        const materializer = new LocalMaterializer({
            actor: this.actor,
            store,
            resources: store.resourcePort
        });
        const backend = new HarnessMaterializationBackend(materializer);
        const dispatcher = new CommandDispatcher<
            MaterializationHarnessState,
            MaterializationHarnessState,
            MaterializationHarnessState
        >({
            store: this.store,
            persistence: new MemoryProtocolPersistence((transaction) => transaction.records),
            ids: new CounterIds((transaction: MaterializationHarnessState, prefix) => {
                transaction.nextId += 1;
                return `${prefix}-${transaction.nextId}`;
            }),
            actor: this.actor,
            tenant: this.tenant,
            readOnly: (transaction) => transaction,
            commands: [
                new MaterializationApplyLocalCommand(backend, this.actor, this.actor, this.tenant)
            ],
            limits: { envelopeBytes: 64_000, payloadBytes: 64_000 },
            now: () => MaterializationHarness.now
        });
        this.#ingress = new CommandIngress({
            dispatcher,
            content: this.#content,
            authenticator: new MaterializationAuthenticator(this.tenant),
            leaseForMilliseconds: 60_000,
            now: () => MaterializationHarness.now
        });
    }

    public plan(
        actor = this.actor,
        projections: readonly DesiredProjection[] = [projection("new-resource")],
        generation = 1
    ): MaterializationPlan {
        return materializationPlan([actor], projections, generation);
    }

    public multiActorPlan(other: ActorRef): MaterializationPlan {
        const origin = testOrigin(1);
        return new MaterializationPlan({
            origin,
            actors: [
                actorPlan(this.actor, origin, [projection("target-resource")]),
                actorPlan(other, origin, [projection("other-resource")])
            ]
        });
    }

    public envelope(plan: MaterializationPlan, init: MaterializationEnvelopeInit = {}): Uint8Array {
        this.persistPlan(plan);
        return this.envelopeWithPayload(MaterializationCommandPayload.applyLocal(plan.id), init);
    }

    public persistPlan(plan: MaterializationPlan): void {
        this.store.state.plans.set(plan.id.value, plan);
    }

    public persistApplyPlan(planId: Digest, plan: MaterializationPlan): void {
        this.store.state.applyPlans.set(planId.value, plan);
    }

    public envelopeWithPayload(
        payload: Uint8Array,
        init: MaterializationEnvelopeInit = {}
    ): Uint8Array {
        const caller = init.caller ?? this.caller;
        const digest = Digest.sha256(payload);
        const ref = ContentRef.fromDigest(digest);
        this.#content.install(ref.value, payload);
        const revision = init.revision ?? currentPlanRevision(this.store.state, this.actor);
        return CommandEnvelopeCodec.encode(
            new CommandEnvelope({
                command: MATERIALIZATION_COMMANDS.applyLocal,
                caller,
                idempotencyKey: init.key ?? "materialization-key",
                ...(init.omitRevision === true ? {} : { expectedRevision: revision }),
                ...(init.lease === undefined ? {} : { lease: init.lease }),
                payload: ref,
                payloadDigest: digest
            })
        );
    }

    public async dispatch(
        envelope: Uint8Array,
        authenticatedCaller?: CommandCaller
    ): Promise<CommandDispatchResult> {
        const decoded = CommandEnvelopeCodec.decode(envelope);
        const result = await this.#ingress.accept(envelope, authenticatedCaller ?? decoded.caller);
        if (result.kind === "preDispatchFailure") throw result.cause;
        return result;
    }

    public setPlanRevision(value: Revision | undefined): void {
        this.store.state.revisionAvailable = value !== undefined;
    }

    public setFault(value: boolean): void {
        this.store.state.fault = value;
    }

    public setRunUsage(value: FakeRunUsage): void {
        this.store.state.runUsage = value;
    }

    public managedLogicalKeys(): readonly string[] {
        return [...this.store.state.managedState.values()]
            .map((record) => record.logicalKey)
            .sort();
    }

    public planRevision(): Revision {
        return currentPlanRevision(this.store.state, this.actor);
    }
}

class MaterializationAuthenticator extends CommandAuthenticator<CommandCaller> {
    public constructor(tenant: TenantId) {
        super(tenant);
    }

    protected authenticateTransport(caller: CommandCaller): CommandCaller {
        return caller;
    }
}

export function projection(logicalKey: string): DesiredProjection {
    return policyProjection(
        logicalKey,
        new PolicySet({
            tiers: logicalKey.length % 2 === 0 ? { execute: "mediated" } : {}
        })
    );
}

function materializationPlan(
    actors: readonly ActorRef[],
    projections: readonly DesiredProjection[],
    generation: number
): MaterializationPlan {
    const origin = testOrigin(generation);
    return new MaterializationPlan({
        origin,
        actors: actors.map((actor) => actorPlan(actor, origin, projections)) as [
            ActorPlan,
            ...ActorPlan[]
        ]
    });
}

function actorPlan(
    actor: ActorRef,
    origin: ManagedOrigin,
    projections: readonly DesiredProjection[]
): ActorPlan {
    if (projections.length === 0) throw new TypeError("Test Actor plan requires a projection");
    return new ActorPlan({
        actor,
        origin,
        projections: projections as [DesiredProjection, ...DesiredProjection[]]
    });
}

function testOrigin(generation: number): ManagedOrigin {
    const tenantId = new TenantId("materialization-tenant");
    return new ManagedOrigin({
        tenantId,
        deploymentId: DeploymentId.derive(tenantId, new DeploymentKey("platform")),
        attestationDigest: Digest.sha256(new TextEncoder().encode("attestation")),
        blueprintDigest: Digest.sha256(new TextEncoder().encode("blueprint")),
        packageLockDigest: Digest.sha256(new TextEncoder().encode("package-lock")),
        configDigest: Digest.sha256(new TextEncoder().encode("config")),
        generation
    });
}

function createState(): MaterializationHarnessState {
    return {
        records: new MemoryProtocolRecords(),
        recovery: new Map(),
        plans: new Map(),
        applyPlans: new Map(),
        generations: new Map(),
        managedState: new Map(),
        pointers: new Map(),
        resources: new Map(),
        nextId: 0,
        applyCount: 0,
        applyAt: undefined,
        fault: false,
        revisionAvailable: true,
        runUsage: "empty"
    };
}

function cloneState(state: MaterializationHarnessState): MaterializationHarnessState {
    return {
        records: state.records.clone(),
        recovery: new Map(state.recovery),
        plans: new Map(state.plans),
        applyPlans: new Map(state.applyPlans),
        generations: new Map(state.generations),
        managedState: new Map(state.managedState),
        pointers: new Map(state.pointers),
        resources: cloneManagedResources(state.resources),
        nextId: state.nextId,
        applyCount: state.applyCount,
        applyAt: state.applyAt === undefined ? undefined : new Date(state.applyAt),
        fault: state.fault,
        revisionAvailable: state.revisionAvailable,
        runUsage: state.runUsage
    };
}

function currentPlanRevision(state: MaterializationHarnessState, actor: ActorRef): Revision {
    const plan = [...state.plans.values()].at(-1);
    return plan === undefined
        ? Revision.initial()
        : (state.pointers.get(pointerKey(actor, plan.origin.deploymentId))?.revision.next() ??
              Revision.initial());
}

function actorKey(actor: ActorRef): string {
    return `${actor.kind}:${actor.id.value}`;
}

function pointerKey(actor: ActorRef, deploymentId: DeploymentId): string {
    return `${actor.kind}:${actor.id.value}:${deploymentId.value}`;
}
