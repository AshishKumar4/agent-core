import { Digest, Revision, SemVer, canonicalTupleKey } from "../core";
import type { ActorRef } from "../actors";
import type { RunCommitId } from "../agents";
import type { AuditRecordId, ReceiptId } from "../invocations";
import type { PackagePin } from "./package-lock";
import type { MaterializationPlan } from "./plan";
import { PackagePinHolder, RunPinEvidence } from "./reconciliation";
import { invalidDefinitionState } from "./error";

export interface BlueprintPinReference {
    readonly version: SemVer;
    readonly digest: Digest;
}

export interface DefinitionPinSet {
    readonly blueprint: BlueprintPinReference;
    readonly packages: readonly PackagePin[];
}

/**
 * SPEC §5.2: a reservation is held by one of the five pin holders, not by a Run alone. A
 * Turn, an Environment Session, a tree checkpoint, and a Snapshot each pin a release on
 * their own, and a Session and a Snapshot outlive the Run that created them, so the
 * holder is a `PackagePinHolder` rather than the Run's `ActorRef`.
 */
export interface RunPinReservationRequest {
    readonly holder: PackagePinHolder;
    readonly pins: DefinitionPinSet;
    readonly sourceRevision: Revision;
    readonly idempotencyKey: string;
}

export interface RunPinReservationReference {
    readonly id: Digest;
    readonly revision: Revision;
}

export interface RunMigrationEvidenceReference {
    readonly run: ActorRef;
    readonly commitId: RunCommitId;
    readonly receiptId: ReceiptId;
    readonly auditId: AuditRecordId;
    readonly fromPinsDigest: Digest;
    readonly toPinsDigest: Digest;
    readonly revision: Revision;
}

export abstract class RunPinsReservationPort<Transaction> {
    public abstract reserve(
        transaction: Transaction,
        request: RunPinReservationRequest
    ): RunPinReservationReference;

    public abstract release(
        transaction: Transaction,
        reservation: RunPinReservationReference,
        migration?: RunMigrationEvidenceReference
    ): boolean;

    public abstract removalEvidence(
        transaction: Transaction,
        pins: DefinitionPinSet
    ): RunPinEvidence;

    public abstract verifyMigration(
        transaction: Transaction,
        evidence: RunMigrationEvidenceReference
    ): boolean;
}

export abstract class DefinitionSourceRevisionPort<Transaction, Snapshot> {
    public abstract verifyDefinitionClosure(
        transaction: Transaction,
        snapshot: Snapshot,
        plan: MaterializationPlan
    ): boolean;
}

export class FailClosedRunPinsReservationPort<
    Transaction
> extends RunPinsReservationPort<Transaction> {
    public reserve(): RunPinReservationReference {
        throw invalidDefinitionState("RunPins reservation integration is unavailable");
    }

    public release(): boolean {
        return false;
    }

    public removalEvidence(): RunPinEvidence {
        return RunPinEvidence.inconclusive("unknown", "runpins-integration-unavailable");
    }

    public verifyMigration(): boolean {
        return false;
    }
}

interface RecordedPinReservation {
    readonly reference: RunPinReservationReference;
    readonly holder: PackagePinHolder;
    readonly releases: readonly string[];
}

/**
 * SPEC §5.2 and §9.3 retention, held in memory: a Package release stays resolvable while
 * any Run, Turn, Session, tree checkpoint, or Snapshot pins it, and removal proceeds only
 * once the last holder of any kind has released. The evidence names every retaining
 * holder, so a removal defers on a Turn, a Session, a tree checkpoint, or a Snapshot with
 * no Run in the picture at all.
 */
export class RecordedRunPinsReservationPort<
    Transaction
> extends RunPinsReservationPort<Transaction> {
    readonly #reservations = new Map<string, RecordedPinReservation>();
    readonly #byIdempotencyKey = new Map<string, string>();
    readonly #migrations = new Set<string>();

    public reserve(
        _transaction: Transaction,
        request: RunPinReservationRequest
    ): RunPinReservationReference {
        if (request.holder.constructor !== PackagePinHolder) {
            throw invalidDefinitionState("A RunPins reservation names one exact pin holder");
        }
        const recorded = this.#byIdempotencyKey.get(request.idempotencyKey);
        if (recorded !== undefined) {
            const existing = this.#reservations.get(recorded);
            if (existing === undefined || !existing.holder.equals(request.holder)) {
                throw invalidDefinitionState(
                    "A RunPins idempotency key belongs to another pin holder"
                );
            }
            return existing.reference;
        }
        const reference = {
            id: Digest.sha256(reservationKey(request.holder.key, request.idempotencyKey)),
            revision: request.sourceRevision
        };
        this.#reservations.set(reference.id.value, {
            reference,
            holder: request.holder,
            releases: Object.freeze(request.pins.packages.map(releaseKey))
        });
        this.#byIdempotencyKey.set(request.idempotencyKey, reference.id.value);
        return reference;
    }

    public release(
        _transaction: Transaction,
        reservation: RunPinReservationReference,
        migration?: RunMigrationEvidenceReference
    ): boolean {
        const recorded = this.#reservations.get(reservation.id.value);
        if (recorded === undefined) return false;
        if (migration !== undefined) {
            if (migration.fromPinsDigest.equals(migration.toPinsDigest)) return false;
            this.#migrations.add(migrationKey(migration));
        }
        this.#reservations.delete(reservation.id.value);
        for (const [key, id] of this.#byIdempotencyKey) {
            if (id === reservation.id.value) this.#byIdempotencyKey.delete(key);
        }
        return true;
    }

    public removalEvidence(_transaction: Transaction, pins: DefinitionPinSet): RunPinEvidence {
        const removed = new Set(pins.packages.map(releaseKey));
        const holders = new Map<string, PackagePinHolder>();
        for (const reservation of this.#reservations.values()) {
            if (!reservation.releases.some((release) => removed.has(release))) continue;
            holders.set(reservation.holder.key, reservation.holder);
        }
        return holders.size === 0
            ? RunPinEvidence.clear()
            : RunPinEvidence.retained([...holders.values()]);
    }

    public verifyMigration(
        _transaction: Transaction,
        evidence: RunMigrationEvidenceReference
    ): boolean {
        return this.#migrations.has(migrationKey(evidence));
    }
}

function reservationKey(holderKey: string, idempotencyKey: string): Uint8Array {
    return new TextEncoder().encode(
        canonicalTupleKey("definition.run-pin-reservation.v1", [holderKey, idempotencyKey])
    );
}

function releaseKey(pin: PackagePin): string {
    return canonicalTupleKey("definition.package-pin-release.v1", [
        pin.id.value,
        pin.version.toString(),
        pin.manifestDigest.value,
        pin.codeDigest.value
    ]);
}

function migrationKey(evidence: RunMigrationEvidenceReference): string {
    return canonicalTupleKey("definition.run-pin-migration.v1", [
        evidence.run.id.value,
        evidence.commitId.value,
        evidence.receiptId.value,
        evidence.auditId.value,
        evidence.fromPinsDigest.value,
        evidence.toPinsDigest.value,
        evidence.revision.value
    ]);
}
