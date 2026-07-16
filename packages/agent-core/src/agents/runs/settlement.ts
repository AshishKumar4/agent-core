import { requireSynchronousResult } from "../../actors";
import { RecordCodec, type JsonValue } from "../../core";
import { RunCommitId, TurnId } from "../../execution-references";
import { ApprovalId, EffectAttemptId } from "../../invocation-references";
import { InvocationId, RouteReservationId } from "../../interaction-references";
import {
    CodecRecord,
    requireArray,
    requireExactFields,
    requireInteger,
    requireObject,
    requireString,
    requireTimestamp
} from "../record-data";
import {
    copyRunObligation,
    decodeRunObligation,
    runObligationData,
    runObligationKey,
    type RunObligation
} from "./admission";
import { RunId } from "./id";
import { requireTerminalOutcome, type TerminalOutcome } from "./outcome";

export type SettlementAuditObligation =
    | {
          readonly kind: "receipt";
          readonly invocation: InvocationId;
          readonly itemIndex: number;
          readonly itemKey: string;
      }
    | { readonly kind: "delivery"; readonly reservation: RouteReservationId }
    | { readonly kind: "commit"; readonly commit: RunCommitId };

export interface SettlementObligationInit {
    readonly registryEpoch: number;
    readonly obligations: readonly RunObligation[];
}

export class SettlementObligation extends CodecRecord {
    public static get codec(): RecordCodec<SettlementObligation> {
        return SettlementObligationCodec;
    }

    public readonly registryEpoch: number;
    public readonly obligations: readonly RunObligation[];
    public readonly requiredAudits: readonly SettlementAuditObligation[];

    public constructor(init: SettlementObligationInit) {
        super();
        if (!Number.isSafeInteger(init.registryEpoch) || init.registryEpoch < 0) {
            throw new TypeError("Settlement registry epoch must be a non-negative safe integer");
        }
        const obligations = [...init.obligations]
            .map(copyRunObligation)
            .sort((left, right) => runObligationKey(left).localeCompare(runObligationKey(right)));
        if (new Set(obligations.map(runObligationKey)).size !== obligations.length) {
            throw new TypeError("Settlement obligations must have unique canonical identities");
        }
        this.registryEpoch = init.registryEpoch;
        this.obligations = Object.freeze(obligations);
        this.requiredAudits = deriveRequiredAudits(obligations);
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            obligations: this.obligations.map(runObligationData),
            registryEpoch: this.registryEpoch
        };
    }

    public static fromData(value: JsonValue): SettlementObligation {
        const object = requireObject(value, "Settlement obligation");
        requireExactFields(
            object,
            ["obligations", "registryEpoch"],
            [],
            "Settlement obligation"
        );
        return new SettlementObligation({
            registryEpoch: requireInteger(object["registryEpoch"], "Settlement registry epoch"),
            obligations: requireArray(object["obligations"], "Settlement obligations").map(
                decodeRunObligation
            )
        });
    }
}

class SettlementObligationRecordCodec extends RecordCodec<SettlementObligation> {
    public constructor() {
        super("run.settlement-obligation", { major: 2, minor: 0 });
    }
    protected encodePayload(value: SettlementObligation): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): SettlementObligation {
        return SettlementObligation.fromData(value);
    }
}

export const SettlementObligationCodec: RecordCodec<SettlementObligation> =
    new SettlementObligationRecordCodec();

export type RunOutcome = TerminalOutcome;

export class TerminalSnapshot extends CodecRecord {
    public static get codec(): RecordCodec<TerminalSnapshot> {
        return TerminalSnapshotCodec;
    }
    readonly #recordedAt: number;

    public constructor(
        public readonly run: RunId,
        public readonly turn: TurnId,
        public readonly preterminal: RunCommitId,
        public readonly terminalCommit: RunCommitId,
        public readonly outcome: RunOutcome,
        public readonly obligation: SettlementObligation,
        recordedAt: Date
    ) {
        super();
        if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "cancelled") {
            throw new TypeError("Run outcome is invalid");
        }
        if (!Number.isFinite(recordedAt.getTime())) throw new TypeError("Terminal time is invalid");
        this.#recordedAt = recordedAt.getTime();
        Object.freeze(this);
    }

    public get recordedAt(): Date {
        return new Date(this.#recordedAt);
    }

    public toData(): JsonValue {
        return {
            obligation: this.obligation.toData(),
            outcome: this.outcome,
            preterminal: this.preterminal.value,
            recordedAt: this.#recordedAt,
            run: this.run.value,
            terminalCommit: this.terminalCommit.value,
            turn: this.turn.value
        };
    }

    public static fromData(value: JsonValue): TerminalSnapshot {
        const object = requireObject(value, "Terminal snapshot");
        requireExactFields(
            object,
            ["obligation", "outcome", "preterminal", "recordedAt", "run", "terminalCommit", "turn"],
            [],
            "Terminal snapshot"
        );
        return new TerminalSnapshot(
            new RunId(requireString(object["run"], "Terminal Run")),
            new TurnId(requireString(object["turn"], "Terminal Turn")),
            new RunCommitId(requireString(object["preterminal"], "Preterminal commit")),
            new RunCommitId(requireString(object["terminalCommit"], "Terminal commit")),
            requireTerminalOutcome(object["outcome"], "Run outcome"),
            SettlementObligation.fromData(object["obligation"]!),
            requireTimestamp(object["recordedAt"], "Terminal timestamp")
        );
    }
}

class TerminalSnapshotRecordCodec extends RecordCodec<TerminalSnapshot> {
    public constructor() {
        super("run.terminal-snapshot", { major: 2, minor: 0 });
    }
    protected encodePayload(value: TerminalSnapshot): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): TerminalSnapshot {
        return TerminalSnapshot.fromData(value);
    }
}

export const TerminalSnapshotCodec: RecordCodec<TerminalSnapshot> =
    new TerminalSnapshotRecordCodec();

export abstract class SettlementEvidencePort<Transaction> {
    public abstract approvalResolved(transaction: Transaction, approval: ApprovalId): boolean;
    public abstract invocationItemTerminal(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number,
        itemKey: string
    ): boolean;
    public abstract routeTerminal(transaction: Transaction, route: RouteReservationId): boolean;
    public abstract reconciliationSuperseded(
        transaction: Transaction,
        attempt: EffectAttemptId
    ): boolean;
    public abstract commitExists(transaction: Transaction, commit: RunCommitId): boolean;
    public abstract auditSatisfied(
        transaction: Transaction,
        obligation: SettlementAuditObligation
    ): boolean;
}

export function isSettled<Transaction>(
    transaction: Transaction,
    obligation: SettlementObligation,
    evidence: SettlementEvidencePort<Transaction>
): boolean {
    return (
        obligation.obligations.every((value) => {
            switch (value.kind) {
                case "approval":
                    return (
                        requireSynchronousResult(
                            evidence.approvalResolved(transaction, value.approval)
                        ) === true
                    );
                case "invocationItem":
                    return (
                        requireSynchronousResult(
                            evidence.invocationItemTerminal(
                                transaction,
                                value.invocation,
                                value.itemIndex,
                                value.itemKey
                            )
                        ) === true
                    );
                case "route":
                    return (
                        requireSynchronousResult(
                            evidence.routeTerminal(transaction, value.reservation)
                        ) === true
                    );
                case "reconciliation":
                    return (
                        requireSynchronousResult(
                            evidence.reconciliationSuperseded(transaction, value.attempt)
                        ) === true
                    );
                case "systemCommit":
                    return (
                        requireSynchronousResult(
                            evidence.commitExists(transaction, value.commit)
                        ) === true
                    );
            }
        }) &&
        obligation.requiredAudits.every(
            (value) =>
                requireSynchronousResult(evidence.auditSatisfied(transaction, value)) === true
        )
    );
}

/**
 * The required-audit set is a structural projection of the closed registry frontier: every
 * captured obligation that terminates in a Receipt, route delivery, or system commit implies
 * exactly one audit obligation. Deriving it here — rather than accepting it from the caller —
 * makes an incomplete audit set unrepresentable, so a Run can never settle with an
 * audit-bearing obligation left unaudited. Async evidence arriving later is fine: the derived
 * obligation simply stays unsatisfied until `isSettled` re-evaluates it against the port.
 */
function deriveRequiredAudits(
    obligations: readonly RunObligation[]
): readonly SettlementAuditObligation[] {
    const audits = obligations.flatMap((obligation): SettlementAuditObligation[] => {
        switch (obligation.kind) {
            case "invocationItem":
                return [
                    Object.freeze({
                        kind: "receipt" as const,
                        invocation: obligation.invocation,
                        itemIndex: obligation.itemIndex,
                        itemKey: obligation.itemKey
                    })
                ];
            case "route":
                return [
                    Object.freeze({ kind: "delivery" as const, reservation: obligation.reservation })
                ];
            case "systemCommit":
                return [Object.freeze({ kind: "commit" as const, commit: obligation.commit })];
            default:
                return [];
        }
    });
    return Object.freeze(
        audits.sort((left, right) =>
            auditObligationKey(left).localeCompare(auditObligationKey(right))
        )
    );
}

function auditObligationKey(audit: SettlementAuditObligation): string {
    switch (audit.kind) {
        case "receipt":
            return JSON.stringify([
                audit.kind,
                audit.invocation.value,
                audit.itemIndex,
                audit.itemKey
            ]);
        case "delivery":
            return JSON.stringify([audit.kind, audit.reservation.value]);
        case "commit":
            return JSON.stringify([audit.kind, audit.commit.value]);
    }
}
