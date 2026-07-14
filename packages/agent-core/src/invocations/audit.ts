import { ActorId, ActorRef, type ActorKind } from "../actors";
import { RecordCodec, hasExactJsonKeys, type JsonValue, type RecordVersion } from "../core";
import { TenantId } from "../identity";
import { RunCommitId } from "../execution-references";
import {
    AuditRecordId,
    CorrelationId,
    EventId,
    InvocationId,
    RouteProjectionId,
    RouteReservationId
} from "../interaction-references";
import { ApprovalId, EffectAttemptId, ReceiptId, WriteRecordId } from "./id";
import type { AttemptReceiptOutcome, PreEffectReceiptOutcome } from "./receipt";
import type { CommandOutcome } from "../protocol";
import { invocationError } from "./error";

export type ApprovalAuditPhase = "pending" | "approved" | "denied" | "expired" | "consumed";
export type ReceiptAuditOutcome = PreEffectReceiptOutcome | AttemptReceiptOutcome;
export type WriteAuditOutcome = CommandOutcome;

export type AuditKind =
    | { readonly kind: "invocation"; readonly id: InvocationId }
    | { readonly kind: "approval"; readonly id: ApprovalId; readonly phase: ApprovalAuditPhase }
    | { readonly kind: "attempt"; readonly id: EffectAttemptId }
    | { readonly kind: "receipt"; readonly id: ReceiptId; readonly outcome: ReceiptAuditOutcome }
    | { readonly kind: "receiptSuperseded"; readonly previous: ReceiptId; readonly next: ReceiptId }
    | { readonly kind: "write"; readonly id: WriteRecordId; readonly outcome: WriteAuditOutcome }
    | { readonly kind: "event"; readonly id: EventId }
    | { readonly kind: "routeReserved"; readonly id: RouteReservationId }
    | {
          readonly kind: "routeProjected";
          readonly projection: RouteProjectionId;
          readonly reservation: RouteReservationId;
      }
    | { readonly kind: "delivery"; readonly reservation: RouteReservationId }
    | { readonly kind: "commit"; readonly id: RunCommitId };

export interface AuditRecordInit {
    readonly id: AuditRecordId;
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    readonly correlation: CorrelationId;
    readonly cause?: AuditRecordId;
    readonly kind: AuditKind;
}

class AuditRecordCodecV1 extends RecordCodec<AuditRecord> {
    public constructor() {
        super("audit-record", { major: 1, minor: 0 });
    }

    protected encodePayload(record: AuditRecord): JsonValue {
        return {
            id: record.id.value,
            actor: { kind: record.actor.kind, id: record.actor.id.value },
            tenant: record.tenant.value,
            correlation: record.correlation.value,
            cause: record.cause?.value ?? null,
            evidence: encodeKind(record.kind)
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): AuditRecord {
        const object = requireObject(payload, "Audit record payload");
        const actor = requireObject(object["actor"], "Audit actor");
        if (
            !hasExactJsonKeys(object, [
                "actor",
                "cause",
                "correlation",
                "evidence",
                "id",
                "tenant"
            ]) ||
            !hasExactJsonKeys(actor, ["id", "kind"])
        ) {
            throw new TypeError("Audit record payload contains missing or unknown fields");
        }
        const cause = object["cause"];
        if (cause !== null && typeof cause !== "string") {
            throw new TypeError("Audit cause must be a string or null");
        }
        return new AuditRecord({
            id: new AuditRecordId(requireString(object, "id")),
            actor: new ActorRef(
                requireActorKind(actor["kind"]),
                new ActorId(requireString(actor, "id"))
            ),
            tenant: new TenantId(requireString(object, "tenant")),
            correlation: new CorrelationId(requireString(object, "correlation")),
            ...(cause === null ? {} : { cause: new AuditRecordId(cause) }),
            kind: decodeKind(object["evidence"])
        });
    }
}

export class AuditRecord {
    public static readonly codec: RecordCodec<AuditRecord> = new AuditRecordCodecV1();
    public static encode(record: AuditRecord): Uint8Array {
        return AuditRecord.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): AuditRecord {
        return AuditRecord.codec.decode(bytes);
    }

    public readonly id: AuditRecordId;
    public readonly actor: ActorRef;
    public readonly tenant: TenantId;
    public readonly correlation: CorrelationId;
    public readonly cause: AuditRecordId | undefined;
    public readonly kind: AuditKind;

    public constructor(init: AuditRecordInit) {
        if (init.kind.kind === "invocation" && init.cause !== undefined) {
            throw new TypeError("Invocation audit roots cannot have a cause");
        }
        this.id = init.id;
        this.actor = new ActorRef(init.actor.kind, new ActorId(init.actor.id.value));
        this.tenant = new TenantId(init.tenant.value);
        this.correlation = init.correlation;
        this.cause = init.cause;
        this.kind = copyKind(init.kind);
        Object.freeze(this);
    }
}

export type AuditRootAdmission =
    | { readonly kind: "commandRejection" }
    | {
          readonly kind: "routeProjection";
          readonly projection: RouteProjectionId;
          readonly reservation: RouteReservationId;
      };

export interface AuditRecordLookup {
    get(id: AuditRecordId): AuditRecord | undefined;
}

export interface ApprovalAuditEvidence {
    readonly invocation: InvocationId;
    readonly phase: ApprovalAuditPhase;
}

export interface AttemptAuditEvidence {
    readonly invocation: InvocationId;
    readonly auditCause: AuditRecordId;
}

export interface ReceiptAuditEvidence {
    readonly invocation: InvocationId;
    readonly attempt?: EffectAttemptId;
    readonly outcome: ReceiptAuditOutcome;
    readonly previous?: ReceiptId;
}

export interface EventAuditEvidence {
    readonly receipt?: ReceiptId;
}

export interface RouteAuditEvidence {
    readonly event: EventId;
    readonly invocation: InvocationId;
    readonly projection: RouteProjectionId;
}

export interface DeliveryAuditEvidence {
    readonly reservation: RouteReservationId;
}

export interface CommitAuditEvidence {
    readonly receipt?: ReceiptId;
    readonly reservation?: RouteReservationId;
}

export interface ProjectionAuditEvidence {
    readonly actor: ActorRef;
    readonly tenant: TenantId;
}

export interface WriteAuditEvidence {
    readonly invocation: InvocationId;
    readonly outcome: WriteAuditOutcome;
}

export interface AuditEvidenceResolver {
    approval(id: ApprovalId, phase: ApprovalAuditPhase): ApprovalAuditEvidence | undefined;
    attempt(id: EffectAttemptId): AttemptAuditEvidence | undefined;
    receipt(id: ReceiptId): ReceiptAuditEvidence | undefined;
    event(id: EventId): EventAuditEvidence | undefined;
    route(id: RouteReservationId): RouteAuditEvidence | undefined;
    projection(
        projection: RouteProjectionId,
        reservation: RouteReservationId
    ): ProjectionAuditEvidence | undefined;
    delivery(id: RouteReservationId): DeliveryAuditEvidence | undefined;
    commit(id: RunCommitId): CommitAuditEvidence | undefined;
    write(id: WriteRecordId): WriteAuditEvidence | undefined;
}

export function validateAuditAppend(
    record: AuditRecord,
    records: AuditRecordLookup,
    rootAdmission?: AuditRootAdmission,
    evidence?: AuditEvidenceResolver
): void {
    if (records.get(record.id) !== undefined) {
        throw invocationError("audit.append-conflict", "Audit records are append-only");
    }

    if (record.cause === undefined) {
        validateRoot(record, rootAdmission, evidence);
        return;
    }

    if (rootAdmission !== undefined) {
        throw invocationError(
            "audit.invalid-root",
            "Audit root admission is invalid for a caused record"
        );
    }

    const cause = records.get(record.cause);
    if (cause === undefined) {
        throw invocationError("audit.missing-cause", "Audit cause must exist before append");
    }
    if (
        !record.actor.equals(cause.actor) ||
        !record.tenant.equals(cause.tenant) ||
        !record.correlation.equals(cause.correlation)
    ) {
        throw invocationError(
            "audit.cause-mismatch",
            "Audit cause must share actor, tenant, and correlation"
        );
    }
    if (
        !isPermittedEdge(cause.kind, record.kind) ||
        !isSubstantiatedEdge(cause.kind, record.kind, evidence, cause.id)
    ) {
        throw invocationError(
            "audit.evidence-mismatch",
            `Audit edge ${cause.kind.kind} -> ${record.kind.kind} is not permitted`
        );
    }
}

function validateRoot(
    record: AuditRecord,
    admission: AuditRootAdmission | undefined,
    evidence: AuditEvidenceResolver | undefined
): void {
    if (record.kind.kind === "invocation" && admission === undefined) {
        return;
    }
    if (
        record.kind.kind === "write" &&
        record.kind.outcome.startsWith("rejected") &&
        admission?.kind === "commandRejection"
    ) {
        return;
    }
    if (
        record.kind.kind === "routeProjected" &&
        admission?.kind === "routeProjection" &&
        record.kind.projection.equals(admission.projection) &&
        record.kind.reservation.equals(admission.reservation) &&
        projectionMatches(record, evidence)
    ) {
        return;
    }
    throw invocationError("audit.invalid-root", "Audit record is not an admitted root");
}

function isPermittedEdge(cause: AuditKind, next: AuditKind): boolean {
    if (cause.kind === "routeProjected") {
        return next.kind === "delivery";
    }
    if (cause.kind === "invocation") {
        return (
            next.kind === "approval" ||
            next.kind === "attempt" ||
            next.kind === "receipt" ||
            next.kind === "write"
        );
    }
    if (cause.kind === "approval") {
        if (cause.phase === "approved") return next.kind === "attempt";
        if (cause.phase === "denied" || cause.phase === "expired") return next.kind === "receipt";
        return false;
    }
    if (cause.kind === "attempt") return next.kind === "receipt";
    if (cause.kind === "receipt") {
        return next.kind === "receiptSuperseded" || next.kind === "event" || next.kind === "commit";
    }
    if (cause.kind === "receiptSuperseded") return next.kind === "event" || next.kind === "commit";
    if (cause.kind === "event") return next.kind === "routeReserved";
    return cause.kind === "delivery" && next.kind === "commit";
}

function isSubstantiatedEdge(
    cause: AuditKind,
    next: AuditKind,
    evidence: AuditEvidenceResolver | undefined,
    causeId: AuditRecordId
): boolean {
    if (cause.kind === "invocation" && next.kind === "write") {
        const write = evidence?.write(next.id);
        return write === undefined
            ? evidence === undefined
            : write.invocation.equals(cause.id) && write.outcome === next.outcome;
    }
    if (evidence === undefined) return false;
    if (cause.kind === "routeProjected" && next.kind === "delivery") {
        const delivery = evidence.delivery(next.reservation);
        return (
            cause.reservation.equals(next.reservation) &&
            delivery?.reservation.equals(next.reservation) === true
        );
    }
    if (cause.kind === "invocation" && next.kind === "approval") {
        const approval = evidence.approval(next.id, next.phase);
        return approval?.phase === next.phase && approval.invocation.equals(cause.id);
    }
    if (cause.kind === "invocation" && next.kind === "attempt") {
        const attempt = evidence.attempt(next.id);
        return attempt?.invocation.equals(cause.id) === true && attempt.auditCause.equals(causeId);
    }
    if (cause.kind === "invocation" && next.kind === "receipt") {
        const receipt = evidence.receipt(next.id);
        return (
            isPreEffect(next.outcome) &&
            receipt?.outcome === next.outcome &&
            receipt.invocation.equals(cause.id) &&
            receipt.attempt === undefined
        );
    }
    if (cause.kind === "approval" && next.kind === "attempt") {
        const approval = evidence.approval(cause.id, cause.phase);
        const attempt = evidence.attempt(next.id);
        return (
            cause.phase === "approved" &&
            approval?.phase === cause.phase &&
            attempt !== undefined &&
            attempt.auditCause.equals(causeId) &&
            approval.invocation.equals(attempt.invocation)
        );
    }
    if (cause.kind === "approval" && next.kind === "receipt") {
        const approval = evidence.approval(cause.id, cause.phase);
        const receipt = evidence.receipt(next.id);
        const expected = cause.phase === "denied" ? "deniedPreEffect" : "cancelledPreEffect";
        return (
            next.outcome === expected &&
            approval?.phase === cause.phase &&
            receipt?.outcome === expected &&
            receipt.attempt === undefined &&
            approval?.invocation.equals(receipt.invocation) === true
        );
    }
    if (cause.kind === "attempt" && next.kind === "receipt") {
        const receipt = evidence.receipt(next.id);
        return (
            !isPreEffect(next.outcome) &&
            receipt?.attempt?.equals(cause.id) === true &&
            receipt.outcome === next.outcome
        );
    }
    if (cause.kind === "receipt" && next.kind === "receiptSuperseded") {
        const previous = evidence.receipt(next.previous);
        const current = evidence.receipt(next.next);
        return (
            cause.id.equals(next.previous) &&
            cause.outcome === "indeterminate" &&
            previous?.outcome === "indeterminate" &&
            previous !== undefined &&
            current !== undefined &&
            current.previous?.equals(next.previous) === true &&
            previous.attempt !== undefined &&
            current.attempt?.equals(previous.attempt) === true &&
            (current.outcome === "succeeded" || current.outcome === "failed")
        );
    }
    if ((cause.kind === "receipt" || cause.kind === "receiptSuperseded") && next.kind === "event") {
        const receipt = cause.kind === "receipt" ? cause.id : cause.next;
        return evidence.event(next.id)?.receipt?.equals(receipt) === true;
    }
    if (
        (cause.kind === "receipt" || cause.kind === "receiptSuperseded") &&
        next.kind === "commit"
    ) {
        const receipt = cause.kind === "receipt" ? cause.id : cause.next;
        return evidence.commit(next.id)?.receipt?.equals(receipt) === true;
    }
    if (cause.kind === "event" && next.kind === "routeReserved") {
        return evidence.route(next.id)?.event.equals(cause.id) === true;
    }
    return (
        cause.kind === "delivery" &&
        next.kind === "commit" &&
        evidence.commit(next.id)?.reservation?.equals(cause.reservation) === true
    );
}

function isPreEffect(outcome: ReceiptAuditOutcome): outcome is PreEffectReceiptOutcome {
    return outcome === "deniedPreEffect" || outcome === "cancelledPreEffect";
}

function projectionMatches(
    record: AuditRecord,
    evidence: AuditEvidenceResolver | undefined
): boolean {
    if (record.kind.kind !== "routeProjected" || evidence === undefined) return false;
    const projection = evidence.projection(record.kind.projection, record.kind.reservation);
    return (
        projection !== undefined &&
        projection.actor.equals(record.actor) &&
        projection.tenant.equals(record.tenant)
    );
}

export const AuditRecordCodec: RecordCodec<AuditRecord> = AuditRecord.codec;

function copyKind(kind: AuditKind): AuditKind {
    switch (kind.kind) {
        case "approval":
            return Object.freeze({
                kind: kind.kind,
                id: new ApprovalId(kind.id.value),
                phase: kind.phase
            });
        case "receipt":
            return Object.freeze({
                kind: kind.kind,
                id: new ReceiptId(kind.id.value),
                outcome: kind.outcome
            });
        case "receiptSuperseded":
            return Object.freeze({
                kind: kind.kind,
                previous: new ReceiptId(kind.previous.value),
                next: new ReceiptId(kind.next.value)
            });
        case "write":
            return Object.freeze({
                kind: kind.kind,
                id: new WriteRecordId(kind.id.value),
                outcome: kind.outcome
            });
        case "routeProjected":
            return Object.freeze({
                kind: kind.kind,
                projection: kind.projection,
                reservation: kind.reservation
            });
        case "delivery":
            return Object.freeze({
                kind: kind.kind,
                reservation: kind.reservation
            });
        case "invocation":
            return Object.freeze({ kind: kind.kind, id: kind.id });
        case "attempt":
            return Object.freeze({ kind: kind.kind, id: new EffectAttemptId(kind.id.value) });
        case "routeReserved":
            return Object.freeze({ kind: kind.kind, id: kind.id });
        case "event":
            return Object.freeze({ kind: kind.kind, id: kind.id });
        case "commit":
            return Object.freeze({ kind: kind.kind, id: new RunCommitId(kind.id.value) });
    }
}

function encodeKind(kind: AuditKind): JsonValue {
    switch (kind.kind) {
        case "approval":
            return { kind: kind.kind, id: kind.id.value, phase: kind.phase };
        case "receipt":
            return { kind: kind.kind, id: kind.id.value, outcome: kind.outcome };
        case "receiptSuperseded":
            return { kind: kind.kind, previous: kind.previous.value, next: kind.next.value };
        case "write":
            return { kind: kind.kind, id: kind.id.value, outcome: kind.outcome };
        case "routeProjected":
            return {
                kind: kind.kind,
                projection: kind.projection.value,
                reservation: kind.reservation.value
            };
        case "delivery":
            return { kind: kind.kind, reservation: kind.reservation.value };
        default:
            return { kind: kind.kind, id: kind.id.value };
    }
}

function decodeKind(value: JsonValue | undefined): AuditKind {
    const object = requireObject(value, "Audit evidence");
    const kind = requireString(object, "kind");
    switch (kind) {
        case "invocation":
            requireEvidenceKeys(object, ["id", "kind"]);
            return { kind, id: new InvocationId(requireString(object, "id")) };
        case "approval":
            requireEvidenceKeys(object, ["id", "kind", "phase"]);
            return {
                kind,
                id: new ApprovalId(requireString(object, "id")),
                phase: requireApprovalPhase(object["phase"])
            };
        case "attempt":
            requireEvidenceKeys(object, ["id", "kind"]);
            return { kind, id: new EffectAttemptId(requireString(object, "id")) };
        case "routeReserved":
            requireEvidenceKeys(object, ["id", "kind"]);
            return { kind, id: new RouteReservationId(requireString(object, "id")) };
        case "receipt":
            requireEvidenceKeys(object, ["id", "kind", "outcome"]);
            return {
                kind,
                id: new ReceiptId(requireString(object, "id")),
                outcome: requireReceiptOutcome(object["outcome"])
            };
        case "receiptSuperseded":
            requireEvidenceKeys(object, ["kind", "next", "previous"]);
            return {
                kind,
                previous: new ReceiptId(requireString(object, "previous")),
                next: new ReceiptId(requireString(object, "next"))
            };
        case "write":
            requireEvidenceKeys(object, ["id", "kind", "outcome"]);
            return {
                kind,
                id: new WriteRecordId(requireString(object, "id")),
                outcome: requireWriteOutcome(object["outcome"])
            };
        case "event":
            requireEvidenceKeys(object, ["id", "kind"]);
            return { kind, id: new EventId(requireString(object, "id")) };
        case "routeProjected":
            requireEvidenceKeys(object, ["kind", "projection", "reservation"]);
            return {
                kind,
                projection: new RouteProjectionId(requireString(object, "projection")),
                reservation: new RouteReservationId(requireString(object, "reservation"))
            };
        case "delivery":
            requireEvidenceKeys(object, ["kind", "reservation"]);
            return {
                kind,
                reservation: new RouteReservationId(requireString(object, "reservation"))
            };
        case "commit":
            requireEvidenceKeys(object, ["id", "kind"]);
            return { kind, id: new RunCommitId(requireString(object, "id")) };
        default:
            throw new TypeError(`Unknown audit evidence kind ${kind}`);
    }
}

function requireEvidenceKeys(
    object: { readonly [key: string]: JsonValue },
    expected: readonly string[]
): void {
    if (!hasExactJsonKeys(object, expected)) {
        throw new TypeError("Audit evidence contains missing or unknown fields");
    }
}

function requireObject(
    value: JsonValue | undefined,
    name: string
): { readonly [key: string]: JsonValue } {
    if (
        value === undefined ||
        value === null ||
        Array.isArray(value) ||
        typeof value !== "object"
    ) {
        throw new TypeError(`${name} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

function requireString(object: { readonly [key: string]: JsonValue }, key: string): string {
    const value = object[key];
    if (typeof value !== "string") {
        throw new TypeError(`${key} must be a string`);
    }
    return value;
}

function requireActorKind(value: JsonValue | undefined): ActorKind {
    if (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    ) {
        return value;
    }
    throw new TypeError("Audit actor kind is invalid");
}

function requireApprovalPhase(value: JsonValue | undefined): ApprovalAuditPhase {
    if (
        value === "pending" ||
        value === "approved" ||
        value === "denied" ||
        value === "expired" ||
        value === "consumed"
    ) {
        return value;
    }
    throw new TypeError("Audit approval phase is invalid");
}

function requireReceiptOutcome(value: JsonValue | undefined): ReceiptAuditOutcome {
    if (
        value === "deniedPreEffect" ||
        value === "cancelledPreEffect" ||
        value === "succeeded" ||
        value === "failed" ||
        value === "indeterminate"
    ) {
        return value;
    }
    throw new TypeError("Audit receipt outcome is invalid");
}

function requireWriteOutcome(value: JsonValue | undefined): WriteAuditOutcome {
    if (
        value === "committed" ||
        value === "rejectedMalformed" ||
        value === "rejectedAuthentication" ||
        value === "rejectedAuthority" ||
        value === "rejectedLifecycle" ||
        value === "rejectedRevision" ||
        value === "rejectedLease" ||
        value === "duplicate"
    ) {
        return value;
    }
    throw new TypeError("Audit write outcome is invalid");
}
