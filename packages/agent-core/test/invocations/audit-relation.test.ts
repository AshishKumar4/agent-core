import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { RunCommitId } from "../../src/agents";
import { encodeCanonicalJson } from "../../src/core";
import { TenantId } from "../../src/identity";
import { EventId } from "../../src/workspaces";
import {
    ApprovalId,
    AuditRecord,
    AuditRecordId,
    CorrelationId,
    EffectAttemptId,
    InvocationId,
    ReceiptId,
    RouteProjectionId,
    RouteReservationId,
    WriteRecordId,
    validateAuditAppend,
    type ApprovalAuditPhase,
    type AuditEvidenceResolver,
    type AuditRecordLookup,
    type ReceiptAuditOutcome
} from "../../src/invocations";

describe("complete local AuditKind relation", () => {
    test("[C13-AUDIT-RECEIPT-OUTCOMES] admits the exact routed approval, effect, Receipt, Event, route, and commit graph", () => {
        const graph = fixture();
        const records = new Map<string, AuditRecord>();
        const lookup: AuditRecordLookup = { get: (id) => records.get(id.value) };
        const append = (
            record: AuditRecord,
            admission?: Parameters<typeof validateAuditAppend>[2]
        ) => {
            validateAuditAppend(record, lookup, admission, graph.evidence);
            records.set(record.id.value, record);
        };

        append(graph.projected, {
            kind: "routeProjection",
            projection: graph.projection,
            reservation: graph.reservation
        });
        append(graph.invocation);
        append(graph.delivery);
        append(graph.pending);
        append(graph.approved);
        append(graph.consumed);
        append(graph.attempt);
        append(graph.indeterminate);
        append(graph.finalReceipt);
        append(graph.superseded);
        append(graph.event);
        append(graph.routeReserved);
        append(graph.commit);
        append(graph.deliveryCommit);
        expect(records.size).toBe(14);
    });

    test("[C13-AUDIT-SETTLED-OBLIGATION] admits only evidence-backed route projection roots", () => {
        const graph = fixture();
        const lookup: AuditRecordLookup = { get: () => undefined };
        const eventRoot = record("event-root", { kind: "event", id: graph.eventId });
        expect(() => validateAuditAppend(eventRoot, lookup)).toThrow(/not an admitted root/);
        expect(() =>
            validateAuditAppend(
                graph.projected,
                lookup,
                {
                    kind: "routeProjection",
                    projection: new RouteProjectionId("wrong"),
                    reservation: graph.reservation
                },
                graph.evidence
            )
        ).toThrow(/not an admitted root/);
        expect(() =>
            validateAuditAppend(
                graph.projected,
                lookup,
                {
                    kind: "routeProjection",
                    projection: graph.projection,
                    reservation: graph.reservation
                },
                { ...graph.evidence, projection: () => undefined }
            )
        ).toThrow(/not an admitted root/);
    });

    test("[C13-PREPARED-NO-TURN-AUDIT] requires exact Write evidence when an evidence resolver is supplied", () => {
        const graph = fixture();
        const invocation = record("write-invocation", {
            kind: "invocation",
            id: new InvocationId("write-invocation")
        });
        const writeId = new WriteRecordId("write-evidence");
        const write = record(
            "write-audit",
            {
                kind: "write",
                id: writeId,
                outcome: "committed"
            },
            invocation.id
        );
        const lookup: AuditRecordLookup = {
            get: (id) => (id.equals(invocation.id) ? invocation : undefined)
        };
        expect(() => validateAuditAppend(write, lookup, undefined, graph.evidence)).toThrow(
            /not permitted/
        );
        expect(() =>
            validateAuditAppend(write, lookup, undefined, {
                ...graph.evidence,
                write: (id) =>
                    id.equals(writeId)
                        ? { invocation: new InvocationId("write-invocation"), outcome: "committed" }
                        : undefined
            })
        ).not.toThrow();
    });

    test("[C13-AUDIT-SYSTEM-WRITER] admits direct, denied, expired, and Receipt-caused local edges", () => {
        const graph = fixture();
        const invocationId = new InvocationId("local-edge-invocation");
        const attemptId = new EffectAttemptId("local-edge-attempt");
        const successId = new ReceiptId("local-edge-success");
        const deniedApprovalId = new ApprovalId("local-edge-denied-approval");
        const expiredApprovalId = new ApprovalId("local-edge-expired-approval");
        const deniedId = new ReceiptId("local-edge-denied");
        const cancelledId = new ReceiptId("local-edge-cancelled");
        const eventId = new EventId("local-edge-event");
        const commitId = new RunCommitId("local-edge-commit");
        const invocation = record("local-edge-root", { kind: "invocation", id: invocationId });
        const attempt = record(
            "local-edge-attempt-audit",
            { kind: "attempt", id: attemptId },
            invocation.id
        );
        const success = record(
            "local-edge-success-audit",
            { kind: "receipt", id: successId, outcome: "succeeded" },
            attempt.id
        );
        const deniedApproval = record(
            "local-edge-denied-approval-audit",
            { kind: "approval", id: deniedApprovalId, phase: "denied" },
            invocation.id
        );
        const expiredApproval = record(
            "local-edge-expired-approval-audit",
            { kind: "approval", id: expiredApprovalId, phase: "expired" },
            invocation.id
        );
        const denied = record(
            "local-edge-denied-audit",
            { kind: "receipt", id: deniedId, outcome: "deniedPreEffect" },
            deniedApproval.id
        );
        const cancelled = record(
            "local-edge-cancelled-audit",
            { kind: "receipt", id: cancelledId, outcome: "cancelledPreEffect" },
            expiredApproval.id
        );
        const directDenied = record(
            "local-edge-direct-denied",
            {
                kind: "receipt",
                id: new ReceiptId("local-edge-direct-denied-id"),
                outcome: "deniedPreEffect"
            },
            invocation.id
        );
        const event = record("local-edge-event-audit", { kind: "event", id: eventId }, success.id);
        const commit = record(
            "local-edge-commit-audit",
            { kind: "commit", id: commitId },
            success.id
        );
        const records = new Map<string, AuditRecord>();
        const evidence: AuditEvidenceResolver = {
            ...graph.evidence,
            approval(id, phase) {
                return (id.equals(deniedApprovalId) && phase === "denied") ||
                    (id.equals(expiredApprovalId) && phase === "expired")
                    ? { invocation: invocationId, phase }
                    : graph.evidence.approval(id, phase);
            },
            attempt(id) {
                return id.equals(attemptId)
                    ? { invocation: invocationId, auditCause: invocation.id }
                    : graph.evidence.attempt(id);
            },
            receipt(id) {
                if (id.equals(successId))
                    return { invocation: invocationId, attempt: attemptId, outcome: "succeeded" };
                if (id.equals(deniedId))
                    return { invocation: invocationId, outcome: "deniedPreEffect" };
                if (id.equals(cancelledId))
                    return { invocation: invocationId, outcome: "cancelledPreEffect" };
                if (id.value === "local-edge-direct-denied-id") {
                    return { invocation: invocationId, outcome: "deniedPreEffect" };
                }
                return graph.evidence.receipt(id);
            },
            event(id) {
                return id.equals(eventId) ? { receipt: successId } : graph.evidence.event(id);
            },
            commit(id) {
                return id.equals(commitId) ? { receipt: successId } : graph.evidence.commit(id);
            }
        };
        const append = (entry: AuditRecord) => {
            validateAuditAppend(entry, { get: (id) => records.get(id.value) }, undefined, evidence);
            records.set(entry.id.value, entry);
        };
        for (const entry of [
            invocation,
            attempt,
            success,
            deniedApproval,
            expiredApproval,
            denied,
            cancelled,
            directDenied,
            event,
            commit
        ])
            append(entry);
        expect(records.size).toBe(10);
    });

    test("[C13-AUDIT-EDGE-RELATION] fails closed for evidence substitutions across every mediation edge", () => {
        const graph = fixture();
        const noEvidence: AuditEvidenceResolver = {
            approval: () => undefined,
            attempt: () => undefined,
            receipt: () => undefined,
            event: () => undefined,
            route: () => undefined,
            projection: () => undefined,
            delivery: () => undefined,
            commit: () => undefined,
            write: () => undefined
        };
        expect(() =>
            validateAuditAppend(
                graph.projected,
                { get: () => undefined },
                {
                    kind: "routeProjection",
                    projection: graph.projection,
                    reservation: graph.reservation
                },
                noEvidence
            )
        ).toThrow();

        const invocationId = new InvocationId("wrong-attempt-cause-invocation");
        const attemptId = new EffectAttemptId("wrong-attempt-cause");
        const invocation = record("wrong-attempt-cause-root", {
            kind: "invocation",
            id: invocationId
        });
        const attempt = record(
            "wrong-attempt-cause-audit",
            { kind: "attempt", id: attemptId },
            invocation.id
        );
        expect(() =>
            validateAuditAppend(
                attempt,
                { get: (id) => (id.equals(invocation.id) ? invocation : undefined) },
                undefined,
                {
                    ...noEvidence,
                    attempt: (id) =>
                        id.equals(attemptId)
                            ? {
                                  invocation: invocationId,
                                  auditCause: new AuditRecordId("substituted-cause")
                              }
                            : undefined
                }
            )
        ).toThrow(/not permitted/);
    });

    test("rejects malformed audit codec vocabularies and fields", () => {
        const payload = (evidence: unknown, overrides: Record<string, unknown> = {}) =>
            encodeCanonicalJson({
                kind: "audit-record",
                version: { major: 1, minor: 0 },
                payload: {
                    actor: { id: "codec-actor", kind: "run" },
                    cause: null,
                    correlation: "codec-correlation",
                    evidence: evidence as never,
                    id: "codec-audit",
                    tenant: "codec-tenant",
                    ...overrides
                }
            });
        const rejects = [
            payload({ id: "invocation", kind: "invocation" }, { cause: false }),
            payload({ id: "unknown", kind: "unknown" }),
            payload(null),
            payload({ id: "invocation", kind: "invocation" }, { id: 1 }),
            payload(
                { id: "invocation", kind: "invocation" },
                {
                    actor: { id: "codec-actor", kind: "unknown" }
                }
            ),
            payload({ id: "approval", kind: "approval", phase: "unknown" }),
            payload({ id: "receipt", kind: "receipt", outcome: "unknown" }),
            payload({ id: "write", kind: "write", outcome: "unknown" })
        ];
        for (const bytes of rejects) expect(() => AuditRecord.decode(bytes)).toThrow();
    });

    test("[C13-EFFECT-WRITE-AHEAD] rejects structurally permitted edges with substituted domain evidence", () => {
        const graph = fixture();
        const lookup: AuditRecordLookup = {
            get: (id) => (id.equals(graph.projected.id) ? graph.projected : undefined)
        };
        const substituted = record(
            "substituted-delivery",
            { kind: "delivery", reservation: new RouteReservationId("another") },
            graph.projected.id
        );
        expect(() => validateAuditAppend(substituted, lookup, undefined, graph.evidence)).toThrow(
            /not permitted/
        );
    });

    test("[C13-AUDIT-ROUTE-BRIDGE] rejects Invocation roots nested below the route projection bridge", () => {
        const graph = fixture();
        expect(() =>
            record(
                "nested-invocation",
                { kind: "invocation", id: new InvocationId("nested-invocation") },
                graph.projected.id
            )
        ).toThrow("Invocation audit roots cannot have a cause");
    });
});

function fixture() {
    const invocationId = new InvocationId("audit-invocation");
    const approvalId = new ApprovalId("audit-approval");
    const attemptId = new EffectAttemptId("audit-attempt");
    const indeterminateId = new ReceiptId("audit-indeterminate");
    const finalId = new ReceiptId("audit-final");
    const eventId = new EventId("audit-event");
    const reservation = new RouteReservationId("audit-reservation");
    const projection = new RouteProjectionId("audit-projection");
    const commitId = new RunCommitId("audit-commit");
    const deliveryCommitId = new RunCommitId("audit-delivery-commit");
    const projected = record("projected", { kind: "routeProjected", projection, reservation });
    const invocation = record("invocation", { kind: "invocation", id: invocationId });
    const delivery = record("delivery", { kind: "delivery", reservation }, projected.id);
    const pending = record(
        "pending",
        { kind: "approval", id: approvalId, phase: "pending" },
        invocation.id
    );
    const approved = record(
        "approved",
        { kind: "approval", id: approvalId, phase: "approved" },
        invocation.id
    );
    const consumed = record(
        "consumed",
        { kind: "approval", id: approvalId, phase: "consumed" },
        invocation.id
    );
    const attempt = record("attempt", { kind: "attempt", id: attemptId }, approved.id);
    const indeterminate = record(
        "indeterminate",
        { kind: "receipt", id: indeterminateId, outcome: "indeterminate" },
        attempt.id
    );
    const finalReceipt = record(
        "final",
        { kind: "receipt", id: finalId, outcome: "succeeded" },
        attempt.id
    );
    const superseded = record(
        "superseded",
        { kind: "receiptSuperseded", previous: indeterminateId, next: finalId },
        indeterminate.id
    );
    const event = record("event", { kind: "event", id: eventId }, superseded.id);
    const routeReserved = record("route", { kind: "routeReserved", id: reservation }, event.id);
    const commit = record("commit", { kind: "commit", id: commitId }, superseded.id);
    const deliveryCommit = record(
        "delivery-commit",
        { kind: "commit", id: deliveryCommitId },
        delivery.id
    );
    const approvalPhases = new Set<ApprovalAuditPhase>(["pending", "approved", "consumed"]);
    const receipts = new Map<
        string,
        {
            invocation: InvocationId;
            attempt: EffectAttemptId;
            outcome: ReceiptAuditOutcome;
            previous?: ReceiptId;
        }
    >([
        [
            indeterminateId.value,
            { invocation: invocationId, attempt: attemptId, outcome: "indeterminate" }
        ],
        [
            finalId.value,
            {
                invocation: invocationId,
                attempt: attemptId,
                outcome: "succeeded",
                previous: indeterminateId
            }
        ]
    ]);
    const evidence: AuditEvidenceResolver = {
        approval(id, phase) {
            return id.equals(approvalId) && approvalPhases.has(phase)
                ? { invocation: invocationId, phase }
                : undefined;
        },
        attempt(id) {
            return id.equals(attemptId)
                ? { invocation: invocationId, auditCause: approved.id }
                : undefined;
        },
        receipt(id) {
            return receipts.get(id.value);
        },
        event(id) {
            return id.equals(eventId) ? { receipt: finalId } : undefined;
        },
        route(id) {
            return id.equals(reservation)
                ? { event: eventId, invocation: invocationId, projection }
                : undefined;
        },
        projection(projectionId, reservationId) {
            return projectionId.equals(projection) && reservationId.equals(reservation)
                ? {
                      actor: new ActorRef("run", new ActorId("audit-actor")),
                      tenant: new TenantId("audit-tenant")
                  }
                : undefined;
        },
        delivery(id) {
            return id.equals(reservation) ? { reservation } : undefined;
        },
        commit(id) {
            if (id.equals(commitId)) return { receipt: finalId };
            if (id.equals(deliveryCommitId)) return { reservation };
            return undefined;
        },
        write() {
            return undefined;
        }
    };
    return {
        projected,
        invocation,
        delivery,
        pending,
        approved,
        consumed,
        attempt,
        indeterminate,
        finalReceipt,
        superseded,
        event,
        routeReserved,
        commit,
        deliveryCommit,
        eventId,
        reservation,
        projection,
        evidence
    };
}

function record(
    id: string,
    kind: ConstructorParameters<typeof AuditRecord>[0]["kind"],
    cause?: AuditRecordId
): AuditRecord {
    return new AuditRecord({
        id: new AuditRecordId(id),
        actor: new ActorRef("run", new ActorId("audit-actor")),
        tenant: new TenantId("audit-tenant"),
        correlation: new CorrelationId("audit-correlation"),
        ...(cause === undefined ? {} : { cause }),
        kind
    });
}
