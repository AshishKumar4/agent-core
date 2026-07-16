// @ts-nocheck
import type { ActorRef } from "../actors";
import { Digest, Revision } from "../core";
import type { TenantId } from "../identity";
import type { DeploymentId } from "./id";
import type { ManagedStateRecord } from "./generation";
import { compareText } from "./order";
import { invalidDefinitionState } from "./error";

export type PinEvidenceKind = "clear" | "blocked" | "unknown" | "stale" | "partial";

export class RunPinEvidence {
    public readonly blockers: readonly string[];

    public constructor(
        public readonly kind: PinEvidenceKind,
        blockers: readonly string[] = []
    ) {
        const canonical = [...blockers].sort(compareText);
        if (new Set(canonical).size !== canonical.length) {
            throw new TypeError("RunPins blockers must be unique");
        }
        if ((kind === "clear") !== (canonical.length === 0)) {
            throw new TypeError(
                "Clear RunPins evidence has no blockers and all other evidence must explain why"
            );
        }
        this.blockers = Object.freeze(canonical);
        Object.freeze(this);
    }

    public static clear(): RunPinEvidence {
        return clearPinEvidence;
    }

    public get permitsChange(): boolean {
        return this.kind === "clear";
    }
}

export interface ManagedResourceOwner {
    readonly tenantId: TenantId;
    readonly deploymentId: DeploymentId;
    readonly actor: ActorRef;
}

export interface ManagedResourceSnapshot extends ManagedResourceOwner {
    readonly resourceId: Digest;
    readonly logicalKey: string;
    readonly recordKind: string;
    readonly desiredDigest: Digest;
    readonly revision: Revision;
}

export type ManagedResourceChange =
    | {
          readonly kind: "update";
          readonly current: ManagedResourceSnapshot;
          readonly desired: ManagedStateRecord;
      }
    | { readonly kind: "remove"; readonly current: ManagedResourceSnapshot };

export abstract class ManagedResourcePort<Transaction> {
    public abstract get(
        transaction: Transaction,
        resourceId: Digest
    ): ManagedResourceSnapshot | undefined;

    public abstract list(
        transaction: Transaction,
        owner: ManagedResourceOwner
    ): readonly ManagedResourceSnapshot[];

    public abstract pinEvidence(
        transaction: Transaction,
        change: ManagedResourceChange
    ): RunPinEvidence;

    public abstract create(
        transaction: Transaction,
        desired: ManagedStateRecord
    ): ManagedResourceSnapshot;

    public abstract update(
        transaction: Transaction,
        current: ManagedResourceSnapshot,
        desired: ManagedStateRecord
    ): ManagedResourceSnapshot;

    public abstract remove(transaction: Transaction, current: ManagedResourceSnapshot): void;
}

export type ReconciliationAction =
    | { readonly kind: "create"; readonly desired: ManagedStateRecord }
    | {
          readonly kind: "update";
          readonly current: ManagedResourceSnapshot;
          readonly desired: ManagedStateRecord;
      }
    | { readonly kind: "remove"; readonly current: ManagedResourceSnapshot }
    | {
          readonly kind: "noop";
          readonly current: ManagedResourceSnapshot;
          readonly desired: ManagedStateRecord;
      };

export interface ReconciliationPlan {
    readonly actions: readonly ReconciliationAction[];
    readonly blockers: readonly string[];
}

export function planReconciliation<Transaction>(
    transaction: Transaction,
    resources: ManagedResourcePort<Transaction>,
    owner: ManagedResourceOwner,
    previous: readonly ManagedStateRecord[],
    desired: readonly ManagedStateRecord[]
): ReconciliationPlan {
    const previousByResource = uniqueRecords(previous, "previous generation");
    const desiredByResource = uniqueRecords(desired, "desired generation");
    const currentByResource = uniqueSnapshots(resources.list(transaction, owner));
    const actions: ReconciliationAction[] = [];
    const blockers = new Set<string>();

    for (const record of desiredByResource.values()) {
        const current = resources.get(transaction, record.resourceId);
        const expected = previousByResource.get(record.resourceId.value);
        if (current === undefined) {
            if (expected !== undefined) {
                throw invalidDefinitionState(
                    `Managed resource ${record.resourceId.value} drifted missing`
                );
            }
            actions.push({ kind: "create", desired: record });
            continue;
        }
        requireSnapshotIdentity(current, record, owner);
        if (expected === undefined) {
            throw invalidDefinitionState(
                `Managed resource ${record.resourceId.value} is occupied outside the active generation`
            );
        }
        if (!current.desiredDigest.equals(expected.desiredDigest)) {
            throw invalidDefinitionState(
                `Managed resource ${record.resourceId.value} drifted from its active generation`
            );
        }
        if (current.desiredDigest.equals(record.desiredDigest)) {
            actions.push({ kind: "noop", current, desired: record });
            continue;
        }
        const change = { kind: "update", current, desired: record } as const;
        collectBlockers(resources.pinEvidence(transaction, change), blockers);
        actions.push(change);
    }

    for (const expected of previousByResource.values()) {
        if (desiredByResource.has(expected.resourceId.value)) continue;
        const current = resources.get(transaction, expected.resourceId);
        if (current === undefined) {
            throw invalidDefinitionState(
                `Managed resource ${expected.resourceId.value} drifted missing before removal`
            );
        }
        requireSnapshotIdentity(current, expected, owner);
        if (!current.desiredDigest.equals(expected.desiredDigest)) {
            throw invalidDefinitionState(
                `Managed resource ${current.resourceId.value} cannot be removed after drift`
            );
        }
        const change = { kind: "remove", current } as const;
        collectBlockers(resources.pinEvidence(transaction, change), blockers);
        actions.push(change);
    }
    for (const current of currentByResource.values()) {
        if (
            !previousByResource.has(current.resourceId.value) &&
            !desiredByResource.has(current.resourceId.value)
        ) {
            throw invalidDefinitionState(
                `Managed resource ${current.resourceId.value} is absent from generation closure`
            );
        }
    }

    actions.sort(compareActions);
    return Object.freeze({
        actions: Object.freeze(actions),
        blockers: Object.freeze([...blockers].sort(compareText))
    });
}

export function applyReconciliation<Transaction>(
    transaction: Transaction,
    resources: ManagedResourcePort<Transaction>,
    plan: ReconciliationPlan
): void {
    if (plan.blockers.length > 0) return;
    for (const action of plan.actions) {
        if (action.kind === "noop") continue;
        if (action.kind === "create") {
            resources.create(transaction, action.desired);
            requireAppliedSnapshot(
                requirePersisted(
                    resources.get(transaction, action.desired.resourceId),
                    action.desired
                ),
                action.desired
            );
        } else if (action.kind === "update") {
            resources.update(transaction, action.current, action.desired);
            requireAppliedSnapshot(
                requirePersisted(
                    resources.get(transaction, action.desired.resourceId),
                    action.desired
                ),
                action.desired
            );
        } else {
            resources.remove(transaction, action.current);
            if (resources.get(transaction, action.current.resourceId) !== undefined) {
                throw invalidDefinitionState(
                    `Managed resource ${action.current.resourceId.value} removal did not persist`
                );
            }
        }
    }
}

function requirePersisted(
    snapshot: ManagedResourceSnapshot | undefined,
    desired: ManagedStateRecord
): ManagedResourceSnapshot {
    if (snapshot === undefined) {
        throw invalidDefinitionState(
            `Managed resource ${desired.resourceId.value} mutation did not persist`
        );
    }
    return snapshot;
}

function uniqueRecords(
    records: readonly ManagedStateRecord[],
    subject: string
): ReadonlyMap<string, ManagedStateRecord> {
    const result = new Map<string, ManagedStateRecord>();
    for (const record of records) {
        if (result.has(record.resourceId.value)) {
            throw invalidDefinitionState(`${subject} contains duplicate managed resource identity`);
        }
        result.set(record.resourceId.value, record);
    }
    return result;
}

function uniqueSnapshots(
    snapshots: readonly ManagedResourceSnapshot[]
): ReadonlyMap<string, ManagedResourceSnapshot> {
    const result = new Map<string, ManagedResourceSnapshot>();
    for (const snapshot of snapshots) {
        if (result.has(snapshot.resourceId.value)) {
            throw invalidDefinitionState("Managed resource port returned duplicate identity");
        }
        result.set(snapshot.resourceId.value, snapshot);
    }
    return result;
}

function requireSnapshotIdentity(
    snapshot: ManagedResourceSnapshot,
    desired: ManagedStateRecord,
    owner: ManagedResourceOwner
): void {
    if (
        !snapshot.resourceId.equals(desired.resourceId) ||
        !snapshot.actor.equals(owner.actor) ||
        !snapshot.tenantId.equals(owner.tenantId) ||
        !snapshot.deploymentId.equals(owner.deploymentId) ||
        snapshot.logicalKey !== desired.logicalKey ||
        snapshot.recordKind !== desired.recordKind
    ) {
        throw invalidDefinitionState(
            `Managed resource ${desired.resourceId.value} has foreign ownership or identity`
        );
    }
}

function requireAppliedSnapshot(
    snapshot: ManagedResourceSnapshot,
    desired: ManagedStateRecord
): void {
    requireSnapshotIdentity(snapshot, desired, {
        actor: desired.actor,
        tenantId: desired.origin.tenantId,
        deploymentId: desired.origin.deploymentId
    });
    if (!snapshot.desiredDigest.equals(desired.desiredDigest)) {
        throw invalidDefinitionState(
            `Managed resource ${desired.resourceId.value} did not persist desired state`
        );
    }
}

function collectBlockers(evidence: RunPinEvidence, blockers: Set<string>): void {
    if (!(evidence instanceof RunPinEvidence)) {
        throw invalidDefinitionState("Managed resource port returned malformed RunPins evidence");
    }
    for (const blocker of evidence.blockers) blockers.add(`${evidence.kind}:${blocker}`);
}

function compareActions(left: ReconciliationAction, right: ReconciliationAction): number {
    const order = { create: 0, update: 1, noop: 2, remove: 3 } as const;
    return order[left.kind] - order[right.kind] || compareText(actionId(left), actionId(right));
}

function actionId(action: ReconciliationAction): string {
    return action.kind === "create"
        ? action.desired.resourceId.value
        : action.current.resourceId.value;
}

const clearPinEvidence = new RunPinEvidence("clear");
