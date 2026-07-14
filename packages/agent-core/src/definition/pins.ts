import { Digest, Revision, SemVer } from "../core";
import type { ActorRef } from "../actors";
import type { RunCommitId } from "../agents";
import type { AuditRecordId, ReceiptId } from "../invocations";
import type { PackagePin } from "./package-lock";
import type { MaterializationPlan } from "./plan";
import { RunPinEvidence } from "./reconciliation";
import { invalidDefinitionState } from "./error";

export interface BlueprintPinReference {
    readonly version: SemVer;
    readonly digest: Digest;
}

export interface DefinitionPinSet {
    readonly blueprint: BlueprintPinReference;
    readonly packages: readonly PackagePin[];
}

export interface RunPinReservationRequest {
    readonly holder: ActorRef;
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
        return new RunPinEvidence("unknown", ["runpins-integration-unavailable"]);
    }

    public verifyMigration(): boolean {
        return false;
    }
}
