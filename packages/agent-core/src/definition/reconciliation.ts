import type { ActorRef } from "../actors";
import { Digest, Revision, canonicalTupleKey } from "../core";
import type { FacetRef } from "../facets";
import type { TenantId } from "../identity";
import type { InvocationId, RouteReservationId } from "../interaction-references";
import type { DeploymentId } from "./id";
import type { ManagedStateRecord } from "./generation";
import type { PackagePin } from "./package-lock";
import { compareText } from "./order";
import { invalidDefinitionState } from "./error";

/**
 * SPEC §5.2: every Package release stays resolvable while any Run, Turn, Session, tree
 * checkpoint, or Snapshot pins it. The five are the whole vocabulary and each defers a
 * removal on its own: a Session and a Snapshot outlive the Run that created them, so an
 * implementation that consulted Runs alone would licence a removal §5.2 forbids. The
 * identity stays a canonical token beside its kind because the five holders are records
 * of five different planes; pairing kind with token is what keeps a Turn's pin from being
 * answered by a Run-shaped check.
 */
export type PinHolderKind = "run" | "turn" | "session" | "tree-checkpoint" | "snapshot";

const PIN_HOLDER_KINDS: Readonly<Record<PinHolderKind, true>> = Object.freeze({
    run: true,
    turn: true,
    session: true,
    "tree-checkpoint": true,
    snapshot: true
});

export class PackagePinHolder {
    public readonly kind: PinHolderKind;
    public readonly id: string;

    public constructor(kind: PinHolderKind, id: string) {
        if (PIN_HOLDER_KINDS[kind] !== true) {
            throw new TypeError("A Package pin holder must be one of the SPEC 5.2 pin holders");
        }
        if (id.length === 0 || id !== id.trim()) {
            throw new TypeError("A Package pin holder requires a nonblank canonical identity");
        }
        this.kind = kind;
        this.id = id;
        Object.freeze(this);
    }

    public get key(): string {
        return canonicalTupleKey("definition.package-pin-holder.v1", [this.kind, this.id]);
    }

    public equals(other: PackagePinHolder): boolean {
        return other.constructor === PackagePinHolder && other.key === this.key;
    }
}

export type PinEvidenceKind = "clear" | "blocked" | "unknown" | "stale" | "partial";

/**
 * What the pin-holding planes answer about one Package release. Three shapes for three
 * answers, because a release nothing pins, a release named holders retain, and a question
 * the integration could not answer have three different consequences: the first proceeds,
 * the second defers as a §9.3 pending obligation naming each holder, and the third is a
 * divergence no obligation expresses — a rejected reconciliation rather than a removal
 * left pending on an unstated reason.
 */
export abstract class RunPinEvidence {
    public static clear(): RunPinEvidence {
        return clearPinEvidence;
    }

    /** The exact holders retaining the release, which is why the removal defers. */
    public static retained(holders: readonly PackagePinHolder[]): RunPinEvidence {
        return new RetainedPinEvidence(holders);
    }

    /** An answer the integration could not complete, which states no obligation at all. */
    public static inconclusive(
        kind: Exclude<PinEvidenceKind, "clear" | "blocked">,
        reason: string
    ): RunPinEvidence {
        return new InconclusivePinEvidence(kind, reason);
    }

    public abstract get kind(): PinEvidenceKind;

    public abstract get holders(): readonly PackagePinHolder[];

    /** Whether this answer decides the question at all, either way. */
    public abstract get conclusive(): boolean;

    public get permitsChange(): boolean {
        return this.kind === "clear";
    }

    /**
     * SPEC §9.3: the deferral this evidence states for one held managed record. Retained
     * evidence becomes one obligation per holder, so each of the five holders defers the
     * removal on its own.
     */
    public abstract deferral(
        held: DeferredManagedRecord,
        release: PackagePin
    ): ReconciliationDeferral;
}

class ClearPinEvidence extends RunPinEvidence {
    public get kind(): "clear" {
        return "clear";
    }

    public get holders(): readonly PackagePinHolder[] {
        return noPinHolders;
    }

    public get conclusive(): true {
        return true;
    }

    public deferral(): ReconciliationDeferral {
        return ReconciliationDeferral.clear();
    }
}

class RetainedPinEvidence extends RunPinEvidence {
    public readonly holders: readonly PackagePinHolder[];

    public constructor(holders: readonly PackagePinHolder[]) {
        super();
        if (holders.length === 0) {
            throw new TypeError("Blocked RunPins evidence must name the holders that retain it");
        }
        const keys = new Set<string>();
        for (const holder of holders) {
            if (holder.constructor !== PackagePinHolder) {
                throw new TypeError("RunPins evidence requires exact Package pin holders");
            }
            if (keys.has(holder.key)) throw new TypeError("RunPins holders must be unique");
            keys.add(holder.key);
        }
        this.holders = Object.freeze(
            [...holders].sort((left, right) => compareText(left.key, right.key))
        );
        Object.freeze(this);
    }

    public get kind(): "blocked" {
        return "blocked";
    }

    public get conclusive(): true {
        return true;
    }

    public deferral(held: DeferredManagedRecord, release: PackagePin): ReconciliationDeferral {
        return ReconciliationDeferral.holding(
            this.holders.map((holder) => new PackageRetentionObligation(held, release, holder))
        );
    }
}

class InconclusivePinEvidence extends RunPinEvidence {
    public readonly kind: Exclude<PinEvidenceKind, "clear" | "blocked">;

    public constructor(
        kind: Exclude<PinEvidenceKind, "clear" | "blocked">,
        public readonly reason: string
    ) {
        super();
        if (kind !== "unknown" && kind !== "stale" && kind !== "partial") {
            throw new TypeError("Inconclusive RunPins evidence has its own evidence kinds");
        }
        if (reason.length === 0 || reason !== reason.trim()) {
            throw new TypeError("Inconclusive RunPins evidence must explain why");
        }
        this.kind = kind;
        Object.freeze(this);
    }

    public get holders(): readonly PackagePinHolder[] {
        return noPinHolders;
    }

    public get conclusive(): false {
        return false;
    }

    public deferral(): ReconciliationDeferral {
        return ReconciliationDeferral.unanswerable(`${this.kind} RunPins evidence: ${this.reason}`);
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

/**
 * SPEC §9.3: the exact Blueprint-managed record a deferral holds, and the change held
 * there. Every obligation names one, because the record it holds is the first of the
 * three facts a pending obligation states.
 */
export class DeferredManagedRecord {
    public readonly resourceId: Digest;
    public readonly logicalKey: string;
    public readonly recordKind: string;
    public readonly change: ManagedResourceChange["kind"];

    public constructor(change: ManagedResourceChange) {
        this.resourceId = change.current.resourceId;
        this.logicalKey = change.current.logicalKey;
        this.recordKind = change.current.recordKind;
        this.change = change.kind;
        Object.freeze(this);
    }

    public get key(): string {
        return canonicalTupleKey("definition.deferred-managed-record.v1", [
            this.change,
            this.resourceId.value
        ]);
    }
}

/**
 * SPEC §9.3 states four deferrals and no others, each with its own discharging condition,
 * so this set is closed: a host that would need a fifth has a divergence it cannot express
 * as a pending obligation, which is a rejected reconciliation rather than a new case here.
 */
export type ReconciliationObligationKind = "reliance" | "drain" | "reservation" | "retention";

export abstract class ReconciliationObligation {
    protected constructor(public readonly held: DeferredManagedRecord) {
        if (held.constructor !== DeferredManagedRecord) {
            throw new TypeError("A pending obligation must name the exact record it holds");
        }
    }

    public abstract get kind(): ReconciliationObligationKind;

    /** The exact record this obligation waits on. */
    public abstract get record(): string;

    /** The exact reason the change is held. */
    public abstract get reason(): string;

    /** The exact condition that discharges it. */
    public abstract get condition(): string;

    public get key(): string {
        return canonicalTupleKey("definition.reconciliation-obligation.v1", [
            this.kind,
            this.held.key,
            this.record
        ]);
    }
}

/** SPEC §4.1, §9.3: a withdrawal held by the reliance guard. */
export class RelianceHoldObligation extends ReconciliationObligation {
    public constructor(
        held: DeferredManagedRecord,
        public readonly dependent: FacetRef
    ) {
        super(held);
        Object.freeze(this);
    }

    public get kind(): "reliance" {
        return "reliance";
    }

    public get record(): string {
        return this.dependent.value;
    }

    public get reason(): string {
        return `active Facet ${this.dependent.value} relies on the withdrawing Facet`;
    }

    public get condition(): string {
        return "no active Facet relies on the withdrawing Facet";
    }
}

/** SPEC §4.1, §9.3: one admitted Invocation item draining against a withdrawing Facet. */
export class InvocationDrainObligation extends ReconciliationObligation {
    public constructor(
        held: DeferredManagedRecord,
        public readonly item: InvocationId
    ) {
        super(held);
        Object.freeze(this);
    }

    public get kind(): "drain" {
        return "drain";
    }

    public get record(): string {
        return this.item.value;
    }

    public get reason(): string {
        return `admitted Invocation item ${this.item.value} is draining against the withdrawing Facet`;
    }

    public get condition(): string {
        return "that item holds a terminal current Receipt";
    }
}

/** SPEC §4.1, §6.2, §9.3: one RouteReservation a retired Subscription leaves unadmitted. */
export class RouteReservationObligation extends ReconciliationObligation {
    public constructor(
        held: DeferredManagedRecord,
        public readonly reservation: RouteReservationId
    ) {
        super(held);
        Object.freeze(this);
    }

    public get kind(): "reservation" {
        return "reservation";
    }

    public get record(): string {
        return this.reservation.value;
    }

    public get reason(): string {
        return `retired Subscriptions leave RouteReservation ${this.reservation.value} unadmitted`;
    }

    public get condition(): string {
        return "its owning Actor has written its terminal rejected RouteDelivery";
    }
}

/** SPEC §5.2, §9.3: a Package release one named pin holder retains. */
export class PackageRetentionObligation extends ReconciliationObligation {
    public constructor(
        held: DeferredManagedRecord,
        public readonly release: PackagePin,
        public readonly holder: PackagePinHolder
    ) {
        super(held);
        if (holder.constructor !== PackagePinHolder) {
            throw new TypeError("A Package retention obligation names one exact pin holder");
        }
        Object.freeze(this);
    }

    public get kind(): "retention" {
        return "retention";
    }

    public get record(): string {
        return canonicalTupleKey("definition.package-retention-record.v1", [
            this.release.id.value,
            this.release.version.toString()
        ]);
    }

    public get reason(): string {
        return `${this.holder.key} pins that Package release`;
    }

    public get condition(): string {
        return "no Run, Turn, Session, tree checkpoint, or Snapshot pins that release or a Run explicitly migrates";
    }

    /**
     * SPEC §5.2 lists five holders and each retains the release on its own, so two holders
     * of one release are two pending obligations rather than one obligation deduplicated
     * down to whichever holder was seen first.
     */
    public override get key(): string {
        return canonicalTupleKey("definition.package-retention-obligation.v1", [
            this.kind,
            this.held.key,
            this.record,
            this.holder.key
        ]);
    }
}

/**
 * SPEC §9.3: what a managed-resource owner answers about one change. Clear proceeds,
 * holding defers under named obligations, and unanswerable is the divergence a host cannot
 * express — which `planReconciliation` rejects rather than admitting as pending work.
 */
export abstract class ReconciliationDeferral {
    public static clear(): ReconciliationDeferral {
        return clearDeferral;
    }

    public static holding(
        obligations: readonly ReconciliationObligation[]
    ): ReconciliationDeferral {
        return new HoldingDeferral(obligations);
    }

    public static unanswerable(reason: string): ReconciliationDeferral {
        return new UnanswerableDeferral(reason);
    }

    public abstract get obligations(): readonly ReconciliationObligation[];

    /** Whether the owner could state the pending set at all. */
    public abstract get answerable(): boolean;

    public abstract get reason(): string | undefined;
}

class ClearDeferral extends ReconciliationDeferral {
    public get obligations(): readonly ReconciliationObligation[] {
        return noObligations;
    }

    public get answerable(): true {
        return true;
    }

    public get reason(): undefined {
        return undefined;
    }
}

class HoldingDeferral extends ReconciliationDeferral {
    public readonly obligations: readonly ReconciliationObligation[];

    public constructor(obligations: readonly ReconciliationObligation[]) {
        super();
        if (obligations.length === 0) {
            throw new TypeError("A held reconciliation must name at least one obligation");
        }
        this.obligations = Object.freeze([...obligations]);
        Object.freeze(this);
    }

    public get answerable(): true {
        return true;
    }

    public get reason(): undefined {
        return undefined;
    }
}

class UnanswerableDeferral extends ReconciliationDeferral {
    public constructor(public readonly reason: string) {
        super();
        if (reason.length === 0 || reason !== reason.trim()) {
            throw new TypeError("An unanswerable reconciliation states what it could not answer");
        }
        Object.freeze(this);
    }

    public get obligations(): readonly ReconciliationObligation[] {
        return noObligations;
    }

    public get answerable(): false {
        return false;
    }
}

/**
 * SPEC §9.3: the pending set a reconciliation outcome carries. Convergence is that set
 * being empty and is derived here rather than reported beside it, so no host states a
 * converged Scope while an obligation stands.
 */
export class PendingObligationSet {
    public static get empty(): PendingObligationSet {
        return emptyPendingSet;
    }

    public readonly obligations: readonly ReconciliationObligation[];

    public constructor(obligations: readonly ReconciliationObligation[]) {
        const byKey = new Map<string, ReconciliationObligation>();
        for (const obligation of obligations) {
            if (!(obligation instanceof ReconciliationObligation)) {
                throw new TypeError("A pending set holds typed reconciliation obligations");
            }
            byKey.set(obligation.key, obligation);
        }
        this.obligations = Object.freeze(
            [...byKey.values()].sort((left, right) => compareText(left.key, right.key))
        );
        Object.freeze(this);
    }

    public get converged(): boolean {
        return this.obligations.length === 0;
    }

    public ofKind(kind: ReconciliationObligationKind): readonly ReconciliationObligation[] {
        return this.obligations.filter((obligation) => obligation.kind === kind);
    }
}

export abstract class ManagedResourcePort<Transaction> {
    public abstract get(
        transaction: Transaction,
        resourceId: Digest
    ): ManagedResourceSnapshot | undefined;

    public abstract list(
        transaction: Transaction,
        owner: ManagedResourceOwner
    ): readonly ManagedResourceSnapshot[];

    /**
     * SPEC §9.3: the deferrals this owner states for one change, each naming its record,
     * reason, and discharging condition.
     */
    public abstract deferrals(
        transaction: Transaction,
        change: ManagedResourceChange
    ): ReconciliationDeferral;

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
          readonly kind: "adopt";
          readonly current: ManagedResourceSnapshot;
          readonly desired: ManagedStateRecord;
      }
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

/**
 * SPEC §9.3: one manually created resource the operator explicitly adopted. A manual edit
 * is adopted only as a change to the Blueprint, so the adopted record names the declaring
 * record's identity and the exact state the operator inspected; an adoption the desired
 * generation does not declare would mark an unattributed record Blueprint-managed and is
 * rejected instead.
 */
export class AdoptedManagedRecord {
    public constructor(
        public readonly resourceId: Digest,
        public readonly observed: Digest
    ) {
        if (resourceId.constructor !== Digest || observed.constructor !== Digest) {
            throw new TypeError("A managed record adoption requires exact digests");
        }
        Object.freeze(this);
    }
}

/**
 * SPEC §9.3: the reconciliation outcome. It carries its own pending set, so `converged` is
 * that set being empty rather than a second answer a host supplies beside it.
 */
export class ReconciliationPlan {
    public readonly actions: readonly ReconciliationAction[];

    public constructor(
        actions: readonly ReconciliationAction[],
        public readonly pending: PendingObligationSet
    ) {
        if (pending.constructor !== PendingObligationSet) {
            throw new TypeError("A reconciliation outcome carries its own pending set");
        }
        this.actions = Object.freeze([...actions]);
        Object.freeze(this);
    }

    public get converged(): boolean {
        return this.pending.converged;
    }
}

export function planReconciliation<Transaction>(
    transaction: Transaction,
    resources: ManagedResourcePort<Transaction>,
    owner: ManagedResourceOwner,
    previous: readonly ManagedStateRecord[],
    desired: readonly ManagedStateRecord[],
    adoptions: readonly AdoptedManagedRecord[] = []
): ReconciliationPlan {
    const previousByResource = uniqueRecords(previous, "previous generation");
    const desiredByResource = uniqueRecords(desired, "desired generation");
    const currentByResource = uniqueSnapshots(resources.list(transaction, owner));
    const unclaimedAdoptions = uniqueAdoptions(adoptions, desiredByResource);
    const actions: ReconciliationAction[] = [];
    const obligations: ReconciliationObligation[] = [];

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
            const adoption = unclaimedAdoptions.get(record.resourceId.value);
            if (adoption === undefined) {
                throw invalidDefinitionState(
                    `Managed resource ${record.resourceId.value} is occupied outside the active generation`
                );
            }
            unclaimedAdoptions.delete(record.resourceId.value);
            if (!adoption.observed.equals(current.desiredDigest)) {
                throw invalidDefinitionState(
                    `Managed resource ${record.resourceId.value} adoption names a state it no longer holds`
                );
            }
            if (!current.desiredDigest.equals(record.desiredDigest)) {
                collectObligations(
                    resources,
                    transaction,
                    { kind: "update", current, desired: record },
                    obligations
                );
            }
            actions.push({ kind: "adopt", current, desired: record });
            continue;
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
        collectObligations(resources, transaction, change, obligations);
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
        collectObligations(resources, transaction, change, obligations);
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
    for (const orphan of unclaimedAdoptions.values()) {
        throw invalidDefinitionState(
            `Managed resource ${orphan.resourceId.value} holds no manual edit to adopt`
        );
    }

    actions.sort(compareActions);
    return new ReconciliationPlan(actions, new PendingObligationSet(obligations));
}

export function applyReconciliation<Transaction>(
    transaction: Transaction,
    resources: ManagedResourcePort<Transaction>,
    plan: ReconciliationPlan
): void {
    if (!plan.converged) return;
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
        } else if (action.kind === "update" || action.kind === "adopt") {
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

function uniqueAdoptions(
    adoptions: readonly AdoptedManagedRecord[],
    declared: ReadonlyMap<string, ManagedStateRecord>
): Map<string, AdoptedManagedRecord> {
    const result = new Map<string, AdoptedManagedRecord>();
    for (const adoption of adoptions) {
        if (adoption.constructor !== AdoptedManagedRecord) {
            throw invalidDefinitionState("A manual edit is adopted only by an exact adoption");
        }
        if (result.has(adoption.resourceId.value)) {
            throw invalidDefinitionState(
                `Managed resource ${adoption.resourceId.value} is adopted more than once`
            );
        }
        // SPEC §9.3: an adopted manual edit appears as a change to the Blueprint, so the
        // desired generation declares it or there is nothing to adopt it as.
        if (!declared.has(adoption.resourceId.value)) {
            throw invalidDefinitionState(
                `Managed resource ${adoption.resourceId.value} cannot be adopted without a declaring Blueprint`
            );
        }
        result.set(adoption.resourceId.value, adoption);
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

/**
 * SPEC §9.3: a deferral is admitted only as a pending obligation naming its record,
 * reason, and discharging condition. An owner that cannot state one has a divergence this
 * document gives no deferral for, so the reconciliation is rejected here rather than
 * accepted and left indefinitely pending.
 */
function collectObligations<Transaction>(
    resources: ManagedResourcePort<Transaction>,
    transaction: Transaction,
    change: ManagedResourceChange,
    obligations: ReconciliationObligation[]
): void {
    const deferral = resources.deferrals(transaction, change);
    if (!(deferral instanceof ReconciliationDeferral)) {
        throw invalidDefinitionState("Managed resource port returned a malformed deferral");
    }
    if (!deferral.answerable) {
        throw invalidDefinitionState(
            `Managed resource ${change.current.resourceId.value} divergence is not expressible as a pending obligation: ${deferral.reason ?? ""}`
        );
    }
    for (const obligation of deferral.obligations) {
        if (!obligation.held.resourceId.equals(change.current.resourceId)) {
            throw invalidDefinitionState(
                `Managed resource ${change.current.resourceId.value} deferral names another record`
            );
        }
        obligations.push(obligation);
    }
}

function compareActions(left: ReconciliationAction, right: ReconciliationAction): number {
    const order = { create: 0, adopt: 1, update: 2, noop: 3, remove: 4 } as const;
    return order[left.kind] - order[right.kind] || compareText(actionId(left), actionId(right));
}

function actionId(action: ReconciliationAction): string {
    return action.kind === "create"
        ? action.desired.resourceId.value
        : action.current.resourceId.value;
}

const noPinHolders: readonly PackagePinHolder[] = Object.freeze([]);
const noObligations: readonly ReconciliationObligation[] = Object.freeze([]);
const clearPinEvidence: RunPinEvidence = Object.freeze(new ClearPinEvidence());
const clearDeferral: ReconciliationDeferral = Object.freeze(new ClearDeferral());
const emptyPendingSet = new PendingObligationSet([]);
