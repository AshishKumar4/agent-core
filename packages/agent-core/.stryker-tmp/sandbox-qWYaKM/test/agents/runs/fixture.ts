// @ts-nocheck
import { ActorId, ActorRef } from "../../../src/actors";
import { ContentRef, Digest, Revision, SemVer } from "../../../src/core";
import { PackageId, PackagePin } from "../../../src/definition";
import { PrincipalId } from "../../../src/identity";
import { AgentId, AgentPolicyId, AgentProfileId, ModelPolicyId } from "../../../src/agents/id";
import {
    AgentPolicyRevisionRecord,
    AgentRevisionRecord,
    ModelPolicyRevisionRecord,
    RunSourceRevisionPort
} from "../../../src/agents/source";
import { EnvironmentId } from "../../../src/environments";
import { ApprovalId, EffectAttemptId, ReceiptId } from "../../../src/invocations";
import {
    AuditRecordId,
    EventId,
    InvocationId,
    RouteReservationId
} from "../../../src/interaction-references";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { RunCommit } from "../../../src/agents/runs/commit";
import {
    RunEvidencePort,
    type AdministerControlEvidence,
    type ControlCommitEvidence,
    type DeliveryCommitEvidence,
    type ForcedCancellationEvidence,
    type ReceiptCommitEvidence,
    type SynthesisCommitEvidence,
    RunMergePort
} from "../../../src/agents/runs/evidence";
import { MemoryRunStorage } from "../../../src/agents/runs/memory";
import { BlueprintPin, RunConfigurationSnapshot, RunPins } from "../../../src/agents/runs/pins";
import { Run, RunBranch } from "../../../src/agents/runs/run";
import { RunSpawnPort, type SpawnReservation } from "../../../src/agents/runs/spawn";
import { RunRuntime } from "../../../src/agents/runs/runtime";
import {
    SettlementEvidencePort,
    type SettlementAuditObligation
} from "../../../src/agents/runs/settlement";
import { RunRepository } from "../../../src/agents/runs/store";
import { RunBranchId, RunId } from "../../../src/agents/runs/id";
import { Turn, type TurnInit } from "../../../src/agents/runs/turn";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";

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
    holder: new PrincipalId("principal-1")
});

export function digest(character: string): Digest {
    return new Digest(character.repeat(64));
}

export function content(character: string): ContentRef {
    return new ContentRef(`sha256:${character.repeat(64)}`);
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
    public readonly syntheses = new Map<string, SynthesisCommitEvidence>();
    public readonly administers = new Map<string, AdministerControlEvidence>();
    public readonly cancellations = new Map<string, ForcedCancellationEvidence>();

    public receipt(_tx: Transaction, receipt: ReceiptId, audit: AuditRecordId) {
        return this.receipts.get(`${receipt.value}:${audit.value}`);
    }
    public delivery(_tx: Transaction, reservation: RouteReservationId, audit: AuditRecordId) {
        return this.deliveries.get(`${reservation.value}:${audit.value}`);
    }
    public control(_tx: Transaction, receipt: ReceiptId, audit: AuditRecordId) {
        return this.controls.get(`${receipt.value}:${audit.value}`);
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
    public verify(_transaction: Transaction, _reservation: SpawnReservation): boolean {
        return this.accepts;
    }
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

export function harness(snapshot?: ReturnType<MemoryRunStorage["snapshot"]>) {
    const storage = new MemoryRunStorage(snapshot);
    const repository = new RunRepository(storage);
    const sources = new TestSourcePort();
    const evidence = new TestEvidencePort();
    const settlement = new TestSettlementPort();
    const spawn = new TestSpawnPort();
    const merge = new TestMergePort();
    const runtime = new RunRuntime(repository, sources, evidence, settlement, spawn, merge);
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

export function seedRunningTurn(value = harness(), init: Partial<TurnInit> = {}) {
    if (value.repository.transaction((tx) => value.repository.loadRun(tx, ids.run)) === undefined) {
        value.runtime.createRun(genesis());
    }
    const turnId = init.id ?? ids.turn;
    const placement = new TurnPlacementSnapshot(turnId, init.pins ?? pins(), []);
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
