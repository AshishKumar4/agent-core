import { requireSynchronousResult } from "../../actors";
import { RecordCodec, type JsonValue } from "../../core";
import { RunCommitId, TurnId } from "../../execution-references";
import { ApprovalId, EffectAttemptId, ReceiptId } from "../../invocation-references";
import { AuditRecordId, InvocationId, RouteReservationId } from "../../interaction-references";
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

export interface SettlementAuditObligation {
    readonly audit: AuditRecordId;
    readonly evidence:
        | {
              readonly kind: "receipt";
              readonly invocation: InvocationId;
              readonly receipt: ReceiptId;
          }
        | { readonly kind: "delivery"; readonly reservation: RouteReservationId }
        | { readonly kind: "commit"; readonly id: RunCommitId };
}

export interface SettlementObligationInit {
    readonly registryEpoch: number;
    readonly obligations: readonly RunObligation[];
    readonly requiredAudits: readonly SettlementAuditObligation[];
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
        const audits = [...init.requiredAudits]
            .map(copyAuditObligation)
            .sort((left, right) => left.audit.value.localeCompare(right.audit.value));
        if (new Set(audits.map((audit) => audit.audit.value)).size !== audits.length) {
            throw new TypeError("Settlement audit obligations must be unique");
        }
        audits.forEach((audit) => requireCapturedAuditTarget(audit, obligations));
        this.registryEpoch = init.registryEpoch;
        this.obligations = Object.freeze(obligations);
        this.requiredAudits = Object.freeze(audits);
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            obligations: this.obligations.map(runObligationData),
            registryEpoch: this.registryEpoch,
            requiredAudits: this.requiredAudits.map(auditData)
        };
    }

    public static fromData(value: JsonValue): SettlementObligation {
        const object = requireObject(value, "Settlement obligation");
        requireExactFields(
            object,
            ["obligations", "registryEpoch", "requiredAudits"],
            [],
            "Settlement obligation"
        );
        return new SettlementObligation({
            registryEpoch: requireInteger(object["registryEpoch"], "Settlement registry epoch"),
            obligations: requireArray(object["obligations"], "Settlement obligations").map(
                decodeRunObligation
            ),
            requiredAudits: requireArray(object["requiredAudits"], "Required audits").map(
                requireAuditObligation
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

function copyAuditObligation(value: SettlementAuditObligation): SettlementAuditObligation {
    const evidence = value.evidence;
    if (value.audit.constructor !== AuditRecordId) {
        throw new TypeError("Settlement audit requires an exact Audit ID");
    }
    switch (evidence.kind) {
        case "receipt":
            if (
                evidence.invocation.constructor !== InvocationId ||
                evidence.receipt.constructor !== ReceiptId
            ) {
                throw new TypeError("Receipt audit evidence requires canonical IDs");
            }
            return Object.freeze({
                audit: value.audit,
                evidence: Object.freeze({ ...evidence })
            });
        case "delivery":
            if (evidence.reservation.constructor !== RouteReservationId) {
                throw new TypeError("Delivery audit evidence requires a canonical reservation ID");
            }
            return Object.freeze({
                audit: value.audit,
                evidence: Object.freeze({ ...evidence })
            });
        case "commit":
            if (evidence.id.constructor !== RunCommitId) {
                throw new TypeError("Commit audit evidence requires a canonical commit ID");
            }
            return Object.freeze({
                audit: value.audit,
                evidence: Object.freeze({ ...evidence })
            });
        default:
            throw new TypeError("Settlement audit evidence kind is invalid");
    }
}

function requireCapturedAuditTarget(
    audit: SettlementAuditObligation,
    obligations: readonly RunObligation[]
): void {
    const evidence = audit.evidence;
    const captured =
        evidence.kind === "receipt"
            ? obligations.some(
                  (value) =>
                      value.kind === "invocationItem" &&
                      value.invocation.equals(evidence.invocation)
              )
            : evidence.kind === "delivery"
              ? obligations.some(
                    (value) =>
                        value.kind === "route" && value.reservation.equals(evidence.reservation)
                )
              : obligations.some(
                    (value) => value.kind === "systemCommit" && value.commit.equals(evidence.id)
                );
    if (!captured) {
        throw new TypeError("Settlement audit evidence must target a captured obligation");
    }
}

function auditData(value: SettlementAuditObligation): JsonValue {
    const evidence = value.evidence;
    return {
        audit: value.audit.value,
        evidence:
            evidence.kind === "receipt"
                ? {
                      kind: evidence.kind,
                      invocation: evidence.invocation.value,
                      receipt: evidence.receipt.value
                  }
                : evidence.kind === "delivery"
                  ? { kind: evidence.kind, reservation: evidence.reservation.value }
                  : { kind: evidence.kind, id: evidence.id.value }
    };
}

function requireAuditObligation(value: JsonValue): SettlementAuditObligation {
    const object = requireObject(value, "Settlement audit obligation");
    requireExactFields(object, ["audit", "evidence"], [], "Settlement audit obligation");
    const evidence = requireObject(object["evidence"]!, "Settlement audit evidence");
    const kind = requireString(evidence["kind"], "Settlement audit evidence kind");
    if (kind === "receipt") {
        requireExactFields(
            evidence,
            ["invocation", "kind", "receipt"],
            [],
            "Receipt audit evidence"
        );
        return copyAuditObligation({
            audit: new AuditRecordId(requireString(object["audit"], "Settlement audit")),
            evidence: {
                kind,
                invocation: new InvocationId(
                    requireString(evidence["invocation"], "Audit Invocation")
                ),
                receipt: new ReceiptId(requireString(evidence["receipt"], "Audit Receipt"))
            }
        });
    }
    if (kind === "delivery") {
        requireExactFields(evidence, ["kind", "reservation"], [], "Delivery audit evidence");
        return copyAuditObligation({
            audit: new AuditRecordId(requireString(object["audit"], "Settlement audit")),
            evidence: {
                kind,
                reservation: new RouteReservationId(
                    requireString(evidence["reservation"], "Audit reservation")
                )
            }
        });
    }
    if (kind !== "commit") throw new TypeError("Settlement audit evidence kind is invalid");
    requireExactFields(evidence, ["id", "kind"], [], "Commit audit evidence");
    return copyAuditObligation({
        audit: new AuditRecordId(requireString(object["audit"], "Settlement audit")),
        evidence: {
            kind,
            id: new RunCommitId(requireString(evidence["id"], "Audit commit"))
        }
    });
}
