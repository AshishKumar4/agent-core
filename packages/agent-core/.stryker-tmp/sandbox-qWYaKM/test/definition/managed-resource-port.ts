// @ts-nocheck
import { Revision } from "../../src/core";
import type { ManagedStateRecord } from "../../src/definition";
import {
    ManagedResourcePort,
    RunPinEvidence,
    type ManagedResourceChange,
    type ManagedResourceOwner,
    type ManagedResourceSnapshot
} from "../../src/definition/reconciliation";

export interface MemoryManagedResourceState {
    readonly resources: Map<string, ManagedResourceSnapshot>;
}

export class MemoryManagedResourcePort<
    Transaction extends MemoryManagedResourceState
> extends ManagedResourcePort<Transaction> {
    public evidence: (change: ManagedResourceChange) => RunPinEvidence = () =>
        RunPinEvidence.clear();
    public failAfterMutation = false;

    public get(
        transaction: Transaction,
        resourceId: import("../../src/core").Digest
    ): ManagedResourceSnapshot | undefined {
        return transaction.resources.get(resourceId.value);
    }

    public list(
        transaction: Transaction,
        owner: ManagedResourceOwner
    ): readonly ManagedResourceSnapshot[] {
        return [...transaction.resources.values()].filter(
            (resource) =>
                resource.actor.equals(owner.actor) &&
                resource.tenantId.equals(owner.tenantId) &&
                resource.deploymentId.equals(owner.deploymentId)
        );
    }

    public pinEvidence(_transaction: Transaction, change: ManagedResourceChange): RunPinEvidence {
        return this.evidence(change);
    }

    public create(transaction: Transaction, desired: ManagedStateRecord): ManagedResourceSnapshot {
        if (transaction.resources.has(desired.resourceId.value)) {
            throw new TypeError("Managed resource already exists");
        }
        const snapshot = snapshotOf(desired, Revision.initial());
        transaction.resources.set(desired.resourceId.value, snapshot);
        this.maybeFail();
        return snapshot;
    }

    public update(
        transaction: Transaction,
        current: ManagedResourceSnapshot,
        desired: ManagedStateRecord
    ): ManagedResourceSnapshot {
        const snapshot = snapshotOf(desired, current.revision.next());
        transaction.resources.set(desired.resourceId.value, snapshot);
        this.maybeFail();
        return snapshot;
    }

    public remove(transaction: Transaction, current: ManagedResourceSnapshot): void {
        transaction.resources.delete(current.resourceId.value);
        this.maybeFail();
    }

    private maybeFail(): void {
        if (this.failAfterMutation) throw new TypeError("injected managed-resource fault");
    }
}

export function cloneManagedResources(
    resources: ReadonlyMap<string, ManagedResourceSnapshot>
): Map<string, ManagedResourceSnapshot> {
    return new Map(resources);
}

function snapshotOf(desired: ManagedStateRecord, revision: Revision): ManagedResourceSnapshot {
    return Object.freeze({
        actor: desired.actor,
        tenantId: desired.origin.tenantId,
        deploymentId: desired.origin.deploymentId,
        resourceId: desired.resourceId,
        logicalKey: desired.logicalKey,
        recordKind: desired.recordKind,
        desiredDigest: desired.desiredDigest,
        revision
    });
}
