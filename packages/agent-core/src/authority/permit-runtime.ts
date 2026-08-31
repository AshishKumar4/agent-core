import {
    type ActorActivationStore,
    type ActorLocalStore,
    type ActorRecoveryState,
    type ActorRef,
    type ActorStartOperation,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../actors";
import type { TargetLeaseEvidence, TargetLeaseEvidenceReference } from "./target-lease-evidence";
import type { AuthorityPermit } from "./permit";
import {
    MemoryAuthorityPermitStore,
    type AuthorityPermitIssueStore,
    type MemoryAuthorityPermitSnapshot,
    type MemoryAuthorityPermitTransaction
} from "./permit-store";
import { MemoryTenantControlStore, type MemoryTenantControlSnapshot } from "./memory";
import type { TenantAuthorityReadStore } from "./runtime";

export abstract class TenantAuthorityTransactionPort<Transaction> {
    public abstract authority(transaction: Transaction): TenantAuthorityReadStore;
}

/** One Tenant-owned store spanning current authority reads and durable permit issuance. */
export type TenantAuthorityPermitStore<Transaction> = TenantAuthorityTransactionPort<Transaction> &
    AuthorityPermitIssueStore<Transaction>;

export interface MemoryTenantAuthorityPermitState<State> {
    authority(state: State): MemoryTenantControlSnapshot;
    permits(state: State): MemoryAuthorityPermitSnapshot;
    savePermits(state: State, snapshot: MemoryAuthorityPermitSnapshot): void;
}

/** Reference adapter keeping authority reads and permit writes in one Memory Actor span. */
export class MemoryTenantAuthorityPermitStore<State extends object>
    extends TenantAuthorityTransactionPort<State>
    implements ActorLocalStore<State>, ActorActivationStore<State>, AuthorityPermitIssueStore<State>
{
    public constructor(
        private readonly actors: ActorLocalStore<State> & ActorActivationStore<State>,
        public readonly owner: ActorRef,
        private readonly state: MemoryTenantAuthorityPermitState<State>
    ) {
        super();
        if (owner.kind !== "tenant") {
            throw new TypeError("Memory Tenant authority permit store requires a Tenant Actor");
        }
    }

    public bindActor(actor: ActorRef): void {
        this.actors.bindActor(actor);
    }

    public activateActor(actor: ActorRef, start: ActorStartOperation<State>): ActorRecoveryState {
        return this.actors.activateActor(actor, start);
    }

    public loadRecoveryState(state: State, actor: ActorRef): ActorRecoveryState | undefined {
        return this.actors.loadRecoveryState(state, actor);
    }

    public saveRecoveryState(state: State, recovery: ActorRecoveryState): void {
        this.actors.saveRecoveryState(state, recovery);
    }

    public loadRecordSetDeclaration(state: State, actor: ActorRef): Uint8Array | undefined {
        return this.actors.loadRecordSetDeclaration(state, actor);
    }

    public saveRecordSetDeclaration(
        state: State,
        actor: ActorRef,
        declaration: Uint8Array
    ): void {
        this.actors.saveRecordSetDeclaration(state, actor, declaration);
    }

    public transaction<Result>(
        operation: TransactionOperation<State, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.actors.transaction(operation, ...guard);
    }

    public read<Result>(
        transaction: State,
        operation: TransactionOperation<State, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.actors.read(transaction, operation, ...guard);
    }

    public authority(transaction: State): TenantAuthorityReadStore {
        const snapshot = this.actors.read(transaction, (read) =>
            MemoryTenantControlStore.restore(this.state.authority(read)).snapshot()
        );
        return MemoryTenantControlStore.restore(snapshot);
    }

    public issued(transaction: State, nonce: string): AuthorityPermit | undefined {
        return this.readPermits(transaction, (store, permitTransaction) =>
            store.issued(permitTransaction, nonce)
        );
    }

    public issue(transaction: State, permit: AuthorityPermit): AuthorityPermit {
        const permits = this.permitStore(transaction);
        const issued = permits.transaction((permitTransaction) =>
            permits.issue(permitTransaction, permit)
        );
        this.state.savePermits(transaction, permits.snapshot());
        return issued;
    }

    public projectedEvidence(
        transaction: State,
        reference: TargetLeaseEvidenceReference
    ): TargetLeaseEvidence | undefined {
        return this.readPermits(transaction, (store, permitTransaction) =>
            store.projectedEvidence(permitTransaction, reference)
        );
    }

    public projectEvidence(transaction: State, evidence: TargetLeaseEvidence): TargetLeaseEvidence {
        const permits = this.permitStore(transaction);
        const projected = permits.transaction((permitTransaction) =>
            permits.projectEvidence(permitTransaction, evidence)
        );
        this.state.savePermits(transaction, permits.snapshot());
        return projected;
    }

    private readPermits<Result>(
        transaction: State,
        operation: (
            store: MemoryAuthorityPermitStore,
            transaction: MemoryAuthorityPermitTransaction
        ) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        const permits = this.permitStore(transaction);
        return permits.transaction(
            (permitTransaction) => operation(permits, permitTransaction),
            ...guard
        );
    }

    private permitStore(transaction: State): MemoryAuthorityPermitStore {
        const snapshot = this.actors.read(transaction, (read) =>
            new MemoryAuthorityPermitStore(this.owner, this.state.permits(read)).snapshot()
        );
        return new MemoryAuthorityPermitStore(this.owner, snapshot);
    }
}
