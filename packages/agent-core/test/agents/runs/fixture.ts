import { ActorId, ActorRef } from "../../../src/actors";
import {
    ContentRef,
    Digest,
    isJsonObject,
    Revision,
    SemVer,
    type JsonValue
} from "../../../src/core";
import { PackageId, PackagePin } from "../../../src/definition";
import { PrincipalId, PrincipalRef, TenantId } from "../../../src/identity";
import { AgentId, AgentPolicyId, AgentProfileId, ModelPolicyId } from "../../../src/agents/id";
import {
    AgentPolicyRevisionRecord,
    AgentRevisionRecord,
    ModelPolicyRevisionRecord,
    RunSourceRevisionPort
} from "../../../src/agents/source";
import { EnvironmentId } from "../../../src/environments";
import { ApprovalId, EffectAttemptId, ReceiptId, type Receipt } from "../../../src/invocations";
import {
    AuditRecordId,
    EventId,
    InvocationId,
    RouteReservationId
} from "../../../src/interaction-references";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { TurnCutPointPort, type TurnInterceptionResult } from "../../../src/operations";
import type { FacetData, TurnBoundCutPoint } from "../../../src/facets";
import { RunCommit } from "../../../src/agents/runs/commit";
import {
    RunEvidencePort,
    type AbandonedRewriteEvidence,
    type AcceptanceReceiptEvidence,
    type AdministerControlEvidence,
    type ControlCommitEvidence,
    type DeliveryCommitEvidence,
    type ForcedCancellationEvidence,
    type ReceiptCommitEvidence,
    type SynthesisCommitEvidence,
    RunMergePort
} from "../../../src/agents/runs/evidence";
import { runObligationKey } from "../../../src/agents/runs/admission";
import type { TurnAdmissionHandle } from "../../../src/agents/runs/handle";
import { MemoryRunStorage, type MemoryRunStorageSnapshot } from "../../../src/agents/runs/memory";
import { BlueprintPin, RunConfigurationSnapshot, RunPins } from "../../../src/agents/runs/pins";
import { Run, RunBranch } from "../../../src/agents/runs/run";
import { RunSpawnPort, type SpawnReservation } from "../../../src/agents/runs/spawn";
import { SpawnAttenuation } from "../../../src/agents/runs/ceiling";
import { RunRuntime } from "../../../src/agents/runs/runtime";
import {
    SettlementEvidencePort,
    type SettlementAuditObligation
} from "../../../src/agents/runs/settlement";
import { RunRepository } from "../../../src/agents/runs/store";
import { AcceptanceId, RunBranchId, RunId } from "../../../src/agents/runs/id";
import { Turn, type TurnInit } from "../../../src/agents/runs/turn";
import { type PlacementPin, TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import type { RunStoragePort } from "../../../src/agents/runs/store";

export const ids = Object.freeze({
    actor: new ActorRef("workspace", new ActorId("workspace-1")),
    agent: new AgentId("agent-1"),
    profile: new AgentProfileId("profile-1"),
    policy: new AgentPolicyId("policy-1"),
    model: new ModelPolicyId("model-1"),
    environment: new EnvironmentId("environment-1"),
    run: new RunId("run-1"),
    branch: new RunBranchId("branch-main"),
    root: new RunCommitId("commit-root"),
    turn: new TurnId("turn-1"),
    holder: new PrincipalRef(new TenantId("tenant-1"), new PrincipalId("principal-1"))
});

const FIXTURE_CONTENT_KEYS = Object.freeze([
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f"
]);

function fixtureContentBytes(character: string): Uint8Array {
    if (!FIXTURE_CONTENT_KEYS.includes(character)) {
        throw new TypeError("Run fixture content key must be one hexadecimal character");
    }
    return new TextEncoder().encode(`run-fixture:${character}`);
}

export function fixtureContentEntries(): readonly {
    readonly bytes: Uint8Array;
    readonly digest: Digest;
    readonly ref: ContentRef;
}[] {
    return FIXTURE_CONTENT_KEYS.map((character) => {
        const bytes = fixtureContentBytes(character);
        const digest = Digest.sha256(bytes);
        return Object.freeze({ bytes, digest, ref: ContentRef.fromDigest(digest) });
    });
}

export function digest(character: string): Digest {
    return Digest.sha256(fixtureContentBytes(character));
}

export function content(character: string): ContentRef {
    return ContentRef.fromDigest(digest(character));
}

export function sourceRecords() {
    const revision = new Revision(3);
    return {
        agent: new AgentRevisionRecord({
            id: ids.agent,
            revision,
            content: content("a"),
            digest: digest("a"),
            profile: ids.profile,
            policy: ids.policy,
            model: ids.model,
            environment: ids.environment
        }),
        policy: new AgentPolicyRevisionRecord({
            id: ids.policy,
            revision,
            content: content("b"),
            digest: digest("b")
        }),
        model: new ModelPolicyRevisionRecord({
            id: ids.model,
            revision,
            content: content("c"),
            digest: digest("c")
        })
    };
}

export function pins(): RunPins {
    const revision = new Revision(3);
    return new RunPins({
        blueprint: new BlueprintPin("blueprint", new SemVer("1.2.3"), digest("e")),
        packages: [
            new PackagePin(new PackageId("zeta"), new SemVer("2.0.0"), digest("f"), digest("1")),
            new PackagePin(new PackageId("alpha"), new SemVer("1.0.0"), digest("2"), digest("3"))
        ],
        agent: { id: ids.agent, revision, digest: digest("a") },
        effectivePolicy: { id: ids.policy, revision, digest: digest("b") },
        modelPolicy: { id: ids.model, revision, digest: digest("c") },
        environment: { id: ids.environment, revision, digest: digest("d") }
    });
}

export function configuration(): RunConfigurationSnapshot {
    return new RunConfigurationSnapshot({ pins: pins() });
}

export function genesis() {
    const snapshot = configuration();
    const root = new RunCommit({
        id: ids.root,
        run: ids.run,
        branch: ids.branch,
        kind: "root",
        parents: [],
        pins: snapshot.pins,
        writer: { kind: "root" },
        content: content("4"),
        treeCheckpoint: content("e")
    });
    const run = new Run({
        id: ids.run,
        agent: ids.agent,
        configuration: snapshot.id,
        root: root.id,
        initialBranch: ids.branch,
        revision: new Revision(0)
    });
    const branch = new RunBranch(ids.branch, ids.run, "main", root.id, new Revision(0));
    return { run, configuration: snapshot, branch, root };
}

export class TestEvidencePort<Transaction = object> extends RunEvidencePort<Transaction> {
    public readonly receipts = new Map<string, ReceiptCommitEvidence>();
    public readonly deliveries = new Map<string, DeliveryCommitEvidence>();
    public readonly controls = new Map<string, ControlCommitEvidence>();
    public readonly abandonedRewrites = new Map<string, AbandonedRewriteEvidence>();
    public readonly syntheses = new Map<string, SynthesisCommitEvidence>();
    public readonly administers = new Map<string, AdministerControlEvidence>();
    public readonly cancellations = new Map<string, ForcedCancellationEvidence>();
    public readonly acceptances = new Map<string, AcceptanceReceiptEvidence>();
    /** The §7.4 Receipt records a commit's evidence is read against, keyed by ReceiptId. */
    public readonly storedReceipts = new Map<string, Receipt>();
    /** The handles Turns published, keyed by the item each one names (SPEC §5.6). */
    public readonly publishedHandles = new Map<string, TurnAdmissionHandle>();

    public receipt(_tx: Transaction, receipt: ReceiptId, audit: AuditRecordId) {
        return this.receipts.get(`${receipt.value}:${audit.value}`);
    }
    public delivery(_tx: Transaction, reservation: RouteReservationId, audit: AuditRecordId) {
        return this.deliveries.get(`${reservation.value}:${audit.value}`);
    }
    public control(_tx: Transaction, receipt: ReceiptId, audit: AuditRecordId) {
        return this.controls.get(`${receipt.value}:${audit.value}`);
    }
    public abandonedRewrite(_tx: Transaction, receipt: ReceiptId, audit: AuditRecordId) {
        return this.abandonedRewrites.get(`${receipt.value}:${audit.value}`);
    }
    public storedReceipt(_tx: Transaction, receipt: ReceiptId) {
        return this.storedReceipts.get(receipt.value);
    }
    public publishedHandle(
        _tx: Transaction,
        invocation: InvocationId,
        itemIndex: number,
        itemKey: string
    ) {
        return this.publishedHandles.get(
            runObligationKey({ kind: "invocationItem", invocation, itemIndex, itemKey })
        );
    }
    public synthesis(_tx: Transaction, receipt: ReceiptId) {
        return this.syntheses.get(receipt.value);
    }
    public administer(_tx: Transaction, receipt: ReceiptId, audit: AuditRecordId) {
        return this.administers.get(`${receipt.value}:${audit.value}`);
    }
    public forcedCancellation(_tx: Transaction, event: EventId, audit: AuditRecordId) {
        return this.cancellations.get(`${event.value}:${audit.value}`);
    }
    public acceptance(_tx: Transaction, receipt: ReceiptId) {
        return this.acceptances.get(receipt.value);
    }
}

export class TestSourcePort<Transaction = object> extends RunSourceRevisionPort<
    Transaction,
    RunConfigurationSnapshot
> {
    public accepts = true;
    public acceptsClosure = true;
    public verify(_transaction: Transaction, _snapshot: RunConfigurationSnapshot): boolean {
        return this.accepts;
    }
    public verifyPackageClosure(
        _transaction: Transaction,
        snapshot: RunConfigurationSnapshot
    ): boolean {
        return this.acceptsClosure && snapshot.pins.packages.length > 0;
    }
}

export class TestSpawnPort<Transaction = object> extends RunSpawnPort<Transaction> {
    public accepts = true;
    // Keyed by reservation id; a reservation with no entry presents an empty attenuation.
    public attenuations = new Map<string, SpawnAttenuation>();
    public verify(_transaction: Transaction, _reservation: SpawnReservation): boolean {
        return this.accepts;
    }
    public attenuation(_transaction: Transaction, reservation: SpawnReservation): SpawnAttenuation {
        return this.attenuations.get(reservation.id.value) ?? new SpawnAttenuation();
    }
}

export function attenuationDigest(attenuation: SpawnAttenuation): Digest {
    return Digest.sha256(SpawnAttenuation.codec.encode(attenuation));
}

export class TestMergePort<Transaction = object> extends RunMergePort<Transaction> {
    public acceptsConcat = true;
    public acceptsTree = true;
    public verifyConcat(): boolean {
        return this.acceptsConcat;
    }
    public verifyTree(): boolean {
        return this.acceptsTree;
    }
}

export class TestSettlementPort<Transaction = object> extends SettlementEvidencePort<Transaction> {
    public approvals = new Set<string>();
    public terminalItems = new Set<string>();
    public terminalRoutes = new Set<string>();
    public reconciliations = new Set<string>();
    public commits = new Set<string>();
    public acceptances = new Set<string>();
    public audits = new Set<string>();
    public approvalResolved(_tx: Transaction, value: ApprovalId): boolean {
        return this.approvals.has(value.value);
    }
    public invocationItemTerminal(
        _tx: Transaction,
        value: InvocationId,
        itemIndex: number,
        itemKey: string
    ): boolean {
        return this.terminalItems.has(`${value.value}:${itemIndex}:${itemKey}`);
    }
    public routeTerminal(_tx: Transaction, value: RouteReservationId): boolean {
        return this.terminalRoutes.has(value.value);
    }
    public reconciliationSuperseded(_tx: Transaction, value: EffectAttemptId): boolean {
        return this.reconciliations.has(value.value);
    }
    public commitExists(_tx: Transaction, value: RunCommitId): boolean {
        return this.commits.has(value.value);
    }
    public acceptanceSatisfied(_tx: Transaction, value: AcceptanceId): boolean {
        return this.acceptances.has(value.value);
    }
    public auditSatisfied(_tx: Transaction, value: SettlementAuditObligation): boolean {
        return this.audits.has(settlementAuditKey(value));
    }
}

export function settlementAuditKey(audit: SettlementAuditObligation): string {
    switch (audit.kind) {
        case "receipt":
            return `receipt:${audit.invocation.value}:${audit.itemIndex}:${audit.itemKey}`;
        case "delivery":
            return `delivery:${audit.reservation.value}`;
        case "commit":
            return `commit:${audit.commit.value}`;
    }
}

/**
 * A Turn-bound cut-point schedule with no contributions: every value passes through and no
 * gate can refuse it. This is what a Run whose Facets contribute no Interceptor actually
 * looks like, so tests about anything else get the same behaviour without standing a Facet
 * runtime up beside them.
 */
export class UncontributedCutPoints extends TurnCutPointPort {
    public override run(
        _cutPoint: TurnBoundCutPoint,
        _turn: TurnId,
        value: FacetData
    ): TurnInterceptionResult {
        return Object.freeze({ value, traces: Object.freeze([]), stop: undefined });
    }
}

export function harness(
    snapshot?: ReturnType<MemoryRunStorage["snapshot"]>,
    cutPoints: TurnCutPointPort = new UncontributedCutPoints()
) {
    const storage = memoryRunStorage(snapshot);
    const repository = testRunRepository(storage);
    const sources = new TestSourcePort();
    const evidence = new TestEvidencePort();
    const settlement = new TestSettlementPort();
    const spawn = new TestSpawnPort();
    const merge = new TestMergePort();
    const runtime = new RunRuntime(
        repository,
        sources,
        evidence,
        settlement,
        spawn,
        merge,
        cutPoints
    );
    return {
        storage,
        repository,
        sources,
        evidence,
        settlement,
        spawn,
        merge,
        runtime
    };
}

export function memoryRunStorage(snapshot?: ReturnType<MemoryRunStorage["snapshot"]>) {
    return new MemoryRunStorage(
        ids.holder.tenantId,
        ids.actor,
        snapshot ?? fixtureMemoryRunSnapshot(),
        () => new Date(0)
    );
}

export function testRunRepository<Transaction>(
    storage: RunStoragePort<Transaction>
): RunRepository<Transaction> {
    return new RunRepository(storage);
}

export function fixtureMemoryRunSnapshot(): MemoryRunStorageSnapshot {
    return {
        version: 2,
        records: [],
        parents: [],
        content: {
            version: 1,
            binding: {
                tenant: ids.holder.tenantId.value,
                actor: { kind: ids.actor.kind, id: ids.actor.id.value }
            },
            content: fixtureContentEntries().map(({ bytes, digest, ref }) => ({
                ref: ref.value,
                digest: digest.value,
                bytes,
                mediaType: null
            })),
            edges: [],
            relations: [],
            leases: []
        }
    };
}

export function seedRunningTurn(
    value = harness(),
    init: Partial<TurnInit> = {},
    placements: readonly PlacementPin[] = []
) {
    if (value.repository.transaction((tx) => value.repository.loadRun(tx, ids.run)) === undefined) {
        value.runtime.createRun(genesis());
    }
    const turnId = init.id ?? ids.turn;
    const placement = new TurnPlacementSnapshot(turnId, init.pins ?? pins(), placements);
    const queued = new Turn({
        id: turnId,
        run: init.run ?? ids.run,
        branch: init.branch ?? ids.branch,
        startHead: init.startHead ?? ids.root,
        effectiveInput: init.effectiveInput ?? ids.root,
        pins: init.pins ?? pins(),
        placement: placement.digest,
        input: init.input ?? content("a"),
        revision: new Revision(0)
    });
    value.runtime.createTurn({ turn: queued, placement }, new Revision(0));
    const holder = init.lease?.holder ?? ids.holder;
    if (holder === undefined) throw new TypeError("Running Turn fixture requires a holder");
    const running = value.runtime.claimTurn(
        turnId,
        new Revision(0),
        holder,
        new Date(1000),
        new Date(5000)
    );
    return {
        ...value,
        running,
        token: Object.freeze({ turn: turnId, holder, epoch: 1 })
    };
}

export const refs = Object.freeze({
    audit: new AuditRecordId("audit-1"),
    invocation: new InvocationId("invocation-1"),
    receipt: new ReceiptId("receipt-1"),
    route: new RouteReservationId("route-1")
});

/**
 * Runs an operation that must fail and hands back the failure as the named error class,
 * so a test reads `code` and `message` off a real error instead of asserting one into
 * existence. A success, or a failure of another class, fails here rather than at the
 * caller's field comparison.
 */
export function thrownBy<Failure extends Error>(
    kind: abstract new (...parameters: never[]) => Failure,
    operation: () => void,
    label = "operation"
): Failure {
    try {
        operation();
    } catch (error) {
        if (error instanceof kind) return error;
        throw new TypeError(`${label}: expected ${kind.name}, caught ${String(error)}`, {
            cause: error
        });
    }
    throw new TypeError(`${label}: expected ${kind.name}, but the operation returned`);
}

/**
 * A record's own fields, writable, so a test can assemble an init one field at a time and
 * add an optional field only when it is present. Writing an absent field as `undefined` is
 * not the same thing under `exactOptionalPropertyTypes`.
 */
export type Assembled<Fields> = { -readonly [Field in keyof Fields]: Fields[Field] };

/** Turn fields a test overrides on the shared queued-Turn builders. */
export type TurnOverrides = Assembled<Partial<TurnInit>>;

/**
 * Builds a Run commit record that RunCommit's own constructor would refuse: a root writer on
 * a message commit, a commit kind that contradicts its writer cause, a missing own reference.
 * Nothing produced here could have come from the class, which is exactly what lets a test
 * reach the checks that run downstream of the constructor and confirm they re-derive the
 * invariant rather than trusting the record they are handed.
 */
export function forgedCommit(base: RunCommit, overrides: Partial<RunCommit>): RunCommit {
    // SAFETY: the result is deliberately not a record the constructor would produce; that is
    // the point of every caller. Nothing downstream may assume it satisfies RunCommit's own
    // invariants — only the one the caller is about to assert on.
    return { ...base, ...overrides } as RunCommit;
}

/**
 * Overrides one field of stored port evidence with a value its interface does not admit — an
 * administer record claiming to be a control, a cancellation naming another event kind. The
 * port contracts pin these fields to single literals, so only a forged record can prove the
 * runtime reads the field rather than trusting the map the evidence came from.
 */
export function forgedEvidence<Evidence, Field extends keyof Evidence>(
    stored: Evidence,
    field: Field,
    value: string
): Evidence {
    // SAFETY: the value is deliberately outside the literal type the port pins to this field.
    // That is what the caller is proving the runtime rejects; nothing else may read it.
    return { ...stored, [field]: value } as Evidence;
}

/**
 * Builds a Turn record carrying a lease its own constructor refuses: held with no expiration,
 * unheld past epoch zero, or unheld yet expiring. A queued Turn cannot hold any of these, so
 * only a forged record can prove the runtime re-checks the lease it is handed instead of
 * trusting the Turn it arrives on.
 */
export function turnWithForgedLease(base: Turn, lease: ForgedLease): Turn {
    // SAFETY: the lease is deliberately one TurnLease refuses to construct, so the result is
    // not a Turn the constructor would produce. Only the lease check under test may read it.
    return { ...base, lease } as never;
}

export interface ForgedLease {
    readonly turn: TurnId;
    readonly holder: PrincipalRef | undefined;
    readonly epoch: number;
    readonly expiresAt: Date | undefined;
}

/** The encoded form of a record, owned by the test that is about to corrupt it. */
export type MutableRecordData = { [field: string]: JsonValue };

/**
 * Structured-clones a record's encoded form so a test may corrupt named fields in place
 * and watch the decoder reject the result. The clone is owned by the caller, so writing
 * through it cannot reach the record it was taken from.
 */
export function mutableData(value: JsonValue): MutableRecordData {
    return objectAt(structuredClone(value), "record");
}

/** Reads a nested object on a corruption path, keeping the caller's write in place. */
export function objectAt(value: JsonValue | undefined, field: string): MutableRecordData {
    if (!isJsonObject(value)) {
        throw new TypeError(`Corruption path field ${field} is not an object`);
    }
    return value;
}
