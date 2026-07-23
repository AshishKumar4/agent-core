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
    type ReceiptAuditEvidence,
    type ReceiptAuditOutcome,
    type WriteAuditOutcome
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
        const noEvidence = emptyEvidence();
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

describe("audit evidence substantiation", () => {
    test("requires write evidence to match the causal invocation and outcome", { tags: "p1" }, () => {
        const invocationId = new InvocationId("write-substantiation-invocation");
        const writeId = new WriteRecordId("write-substantiation");
        const cause = record("write-substantiation-root", { kind: "invocation", id: invocationId });
        const next = record(
            "write-substantiation-audit",
            { kind: "write", id: writeId, outcome: "committed" },
            cause.id
        );
        const withWrite = (
            invocation: InvocationId,
            outcome: WriteAuditOutcome
        ): AuditEvidenceResolver => ({
            ...emptyEvidence(),
            write: (id) => (id.equals(writeId) ? { invocation, outcome } : undefined)
        });
        expectUnsubstantiated(
            cause,
            next,
            withWrite(new InvocationId("write-substantiation-other"), "committed")
        );
        expectUnsubstantiated(cause, next, withWrite(invocationId, "duplicate"));
        expectSubstantiated(cause, next, withWrite(invocationId, "committed"));
    });

    test("requires delivery evidence for the projected reservation", { tags: "p1" }, () => {
        const reservation = new RouteReservationId("delivery-substantiation");
        const cause = record("delivery-substantiation-root", {
            kind: "routeProjected",
            projection: new RouteProjectionId("delivery-substantiation-projection"),
            reservation
        });
        const next = record("delivery-substantiation-audit", { kind: "delivery", reservation }, cause.id);
        expectUnsubstantiated(cause, next, emptyEvidence());
        expectUnsubstantiated(cause, next, {
            ...emptyEvidence(),
            delivery: () => ({ reservation: new RouteReservationId("delivery-substantiation-other") })
        });
        expectSubstantiated(cause, next, { ...emptyEvidence(), delivery: () => ({ reservation }) });
    });

    test("requires approval evidence to match the invocation approval", { tags: "p1" }, () => {
        const invocationId = new InvocationId("approval-substantiation-invocation");
        const cause = record("approval-substantiation-root", { kind: "invocation", id: invocationId });
        const next = record(
            "approval-substantiation-audit",
            { kind: "approval", id: new ApprovalId("approval-substantiation"), phase: "pending" },
            cause.id
        );
        expectUnsubstantiated(cause, next, emptyEvidence());
        expectUnsubstantiated(cause, next, {
            ...emptyEvidence(),
            approval: () => ({
                invocation: new InvocationId("approval-substantiation-other"),
                phase: "pending"
            })
        });
        expectUnsubstantiated(cause, next, {
            ...emptyEvidence(),
            approval: () => ({ invocation: invocationId, phase: "consumed" })
        });
        expectSubstantiated(cause, next, {
            ...emptyEvidence(),
            approval: () => ({ invocation: invocationId, phase: "pending" })
        });
    });

    test("requires attempt evidence for direct invocation attempts", { tags: "p1" }, () => {
        const cause = record("attempt-substantiation-root", {
            kind: "invocation",
            id: new InvocationId("attempt-substantiation-invocation")
        });
        const next = record(
            "attempt-substantiation-audit",
            { kind: "attempt", id: new EffectAttemptId("attempt-substantiation") },
            cause.id
        );
        expectUnsubstantiated(cause, next, emptyEvidence());
    });

    test("requires pre-effect receipt evidence for direct invocation receipts", { tags: "p1" }, () => {
        const invocationId = new InvocationId("pre-effect-invocation");
        const receiptId = new ReceiptId("pre-effect-receipt");
        const cause = record("pre-effect-root", { kind: "invocation", id: invocationId });
        const denied = record(
            "pre-effect-denied",
            { kind: "receipt", id: receiptId, outcome: "deniedPreEffect" },
            cause.id
        );
        const cancelled = record(
            "pre-effect-cancelled",
            { kind: "receipt", id: receiptId, outcome: "cancelledPreEffect" },
            cause.id
        );
        const succeeded = record(
            "pre-effect-succeeded",
            { kind: "receipt", id: receiptId, outcome: "succeeded" },
            cause.id
        );
        const withReceipt = (evidence: ReceiptAuditEvidence): AuditEvidenceResolver => ({
            ...emptyEvidence(),
            receipt: (id) => (id.equals(receiptId) ? evidence : undefined)
        });
        expectUnsubstantiated(
            cause,
            succeeded,
            withReceipt({ invocation: invocationId, outcome: "succeeded" })
        );
        expectUnsubstantiated(cause, denied, emptyEvidence());
        expectUnsubstantiated(
            cause,
            denied,
            withReceipt({ invocation: invocationId, outcome: "cancelledPreEffect" })
        );
        expectUnsubstantiated(
            cause,
            denied,
            withReceipt({
                invocation: invocationId,
                outcome: "deniedPreEffect",
                attempt: new EffectAttemptId("pre-effect-attempt")
            })
        );
        expectSubstantiated(
            cause,
            denied,
            withReceipt({ invocation: invocationId, outcome: "deniedPreEffect" })
        );
        expectSubstantiated(
            cause,
            cancelled,
            withReceipt({ invocation: invocationId, outcome: "cancelledPreEffect" })
        );
    });

    test("requires consistent approval and attempt evidence for approved attempts", { tags: "p1" }, () => {
        const invocationId = new InvocationId("approved-attempt-invocation");
        const cause = record("approved-attempt-cause", {
            kind: "approval",
            id: new ApprovalId("approved-attempt-approval"),
            phase: "approved"
        });
        const next = record(
            "approved-attempt-audit",
            { kind: "attempt", id: new EffectAttemptId("approved-attempt") },
            cause.id
        );
        const attemptEvidence = { invocation: invocationId, auditCause: cause.id };
        const approvalEvidence = { invocation: invocationId, phase: "approved" as const };
        expectUnsubstantiated(cause, next, { ...emptyEvidence(), attempt: () => attemptEvidence });
        expectUnsubstantiated(cause, next, {
            ...emptyEvidence(),
            approval: () => ({ invocation: invocationId, phase: "pending" }),
            attempt: () => attemptEvidence
        });
        expectUnsubstantiated(cause, next, { ...emptyEvidence(), approval: () => approvalEvidence });
        expectSubstantiated(cause, next, {
            ...emptyEvidence(),
            approval: () => approvalEvidence,
            attempt: () => attemptEvidence
        });
    });

    test("requires consistent approval and receipt evidence for denied receipts", { tags: "p1" }, () => {
        const invocationId = new InvocationId("denied-receipt-invocation");
        const receiptId = new ReceiptId("denied-receipt");
        const cause = record("denied-receipt-cause", {
            kind: "approval",
            id: new ApprovalId("denied-receipt-approval"),
            phase: "denied"
        });
        const denied = record(
            "denied-receipt-audit",
            { kind: "receipt", id: receiptId, outcome: "deniedPreEffect" },
            cause.id
        );
        const cancelled = record(
            "denied-receipt-cancelled",
            { kind: "receipt", id: receiptId, outcome: "cancelledPreEffect" },
            cause.id
        );
        const approvalEvidence = { invocation: invocationId, phase: "denied" as const };
        const receiptEvidence = { invocation: invocationId, outcome: "deniedPreEffect" as const };
        expectUnsubstantiated(cause, cancelled, {
            ...emptyEvidence(),
            approval: () => approvalEvidence,
            receipt: () => receiptEvidence
        });
        expectUnsubstantiated(cause, denied, { ...emptyEvidence(), receipt: () => receiptEvidence });
        expectUnsubstantiated(cause, denied, {
            ...emptyEvidence(),
            approval: () => ({ invocation: invocationId, phase: "pending" }),
            receipt: () => receiptEvidence
        });
        expectUnsubstantiated(cause, denied, { ...emptyEvidence(), approval: () => approvalEvidence });
        expectUnsubstantiated(cause, denied, {
            ...emptyEvidence(),
            approval: () => approvalEvidence,
            receipt: () => ({ invocation: invocationId, outcome: "cancelledPreEffect" })
        });
        expectUnsubstantiated(cause, denied, {
            ...emptyEvidence(),
            approval: () => approvalEvidence,
            receipt: () => ({
                invocation: invocationId,
                outcome: "deniedPreEffect",
                attempt: new EffectAttemptId("denied-receipt-attempt")
            })
        });
        expectUnsubstantiated(cause, denied, {
            ...emptyEvidence(),
            approval: () => approvalEvidence,
            receipt: () => ({
                invocation: new InvocationId("denied-receipt-other"),
                outcome: "deniedPreEffect"
            })
        });
        expectSubstantiated(cause, denied, {
            ...emptyEvidence(),
            approval: () => approvalEvidence,
            receipt: () => receiptEvidence
        });
    });

    test("requires attempt-linked receipt evidence for effect receipts", { tags: "p1" }, () => {
        const attemptId = new EffectAttemptId("effect-receipt-attempt");
        const receiptId = new ReceiptId("effect-receipt");
        const invocationId = new InvocationId("effect-receipt-invocation");
        const cause = record("effect-receipt-cause", { kind: "attempt", id: attemptId });
        const succeeded = record(
            "effect-receipt-audit",
            { kind: "receipt", id: receiptId, outcome: "succeeded" },
            cause.id
        );
        const denied = record(
            "effect-receipt-denied",
            { kind: "receipt", id: receiptId, outcome: "deniedPreEffect" },
            cause.id
        );
        expectUnsubstantiated(cause, denied, {
            ...emptyEvidence(),
            receipt: () => ({ invocation: invocationId, attempt: attemptId, outcome: "deniedPreEffect" })
        });
        expectUnsubstantiated(cause, succeeded, emptyEvidence());
        expectUnsubstantiated(cause, succeeded, {
            ...emptyEvidence(),
            receipt: () => ({ invocation: invocationId, outcome: "succeeded" })
        });
        expectUnsubstantiated(cause, succeeded, {
            ...emptyEvidence(),
            receipt: () => ({
                invocation: invocationId,
                attempt: new EffectAttemptId("effect-receipt-other"),
                outcome: "succeeded"
            })
        });
        expectUnsubstantiated(cause, succeeded, {
            ...emptyEvidence(),
            receipt: () => ({ invocation: invocationId, attempt: attemptId, outcome: "failed" })
        });
        expectSubstantiated(cause, succeeded, {
            ...emptyEvidence(),
            receipt: () => ({ invocation: invocationId, attempt: attemptId, outcome: "succeeded" })
        });
    });

    test("requires linked indeterminate and settling receipts for supersession", { tags: "p1" }, () => {
        const invocationId = new InvocationId("supersession-invocation");
        const attemptId = new EffectAttemptId("supersession-attempt");
        const previousId = new ReceiptId("supersession-previous");
        const nextId = new ReceiptId("supersession-next");
        const cause = record("supersession-cause", {
            kind: "receipt",
            id: previousId,
            outcome: "indeterminate"
        });
        const unrelated = record("supersession-unrelated", {
            kind: "receipt",
            id: new ReceiptId("supersession-unrelated-receipt"),
            outcome: "indeterminate"
        });
        const settled = record("supersession-settled", {
            kind: "receipt",
            id: previousId,
            outcome: "succeeded"
        });
        const supersededBy = (causeRecord: AuditRecord, id: string) =>
            record(id, { kind: "receiptSuperseded", previous: previousId, next: nextId }, causeRecord.id);
        const previousEvidence = {
            invocation: invocationId,
            attempt: attemptId,
            outcome: "indeterminate" as const
        };
        const currentEvidence = {
            invocation: invocationId,
            attempt: attemptId,
            outcome: "succeeded" as const,
            previous: previousId
        };
        const withReceipts = (
            previous: ReceiptAuditEvidence | undefined,
            current: ReceiptAuditEvidence | undefined
        ): AuditEvidenceResolver => ({
            ...emptyEvidence(),
            receipt: (id) => {
                if (id.equals(previousId)) return previous;
                if (id.equals(nextId)) return current;
                return undefined;
            }
        });
        const next = supersededBy(cause, "supersession-audit");
        expectUnsubstantiated(
            unrelated,
            supersededBy(unrelated, "supersession-unrelated-audit"),
            withReceipts(previousEvidence, currentEvidence)
        );
        expectUnsubstantiated(
            settled,
            supersededBy(settled, "supersession-settled-audit"),
            withReceipts(previousEvidence, currentEvidence)
        );
        expectUnsubstantiated(
            cause,
            next,
            withReceipts({ ...previousEvidence, outcome: "succeeded" }, currentEvidence)
        );
        expectUnsubstantiated(cause, next, withReceipts(undefined, currentEvidence));
        expectUnsubstantiated(cause, next, withReceipts(previousEvidence, undefined));
        expectUnsubstantiated(
            cause,
            next,
            withReceipts(previousEvidence, {
                ...currentEvidence,
                previous: new ReceiptId("supersession-other")
            })
        );
        expectUnsubstantiated(
            cause,
            next,
            withReceipts(previousEvidence, {
                invocation: invocationId,
                attempt: attemptId,
                outcome: "succeeded"
            })
        );
        expectUnsubstantiated(
            cause,
            next,
            withReceipts({ invocation: invocationId, outcome: "indeterminate" }, currentEvidence)
        );
        expectUnsubstantiated(
            cause,
            next,
            withReceipts(previousEvidence, {
                ...currentEvidence,
                attempt: new EffectAttemptId("supersession-other-attempt")
            })
        );
        expectUnsubstantiated(
            cause,
            next,
            withReceipts(previousEvidence, {
                invocation: invocationId,
                outcome: "succeeded",
                previous: previousId
            })
        );
        expectUnsubstantiated(
            cause,
            next,
            withReceipts(previousEvidence, { ...currentEvidence, outcome: "indeterminate" })
        );
        expectSubstantiated(cause, next, withReceipts(previousEvidence, currentEvidence));
    });

    test("requires receipt-linked event and commit evidence", { tags: "p1" }, () => {
        const receiptId = new ReceiptId("linkage-receipt");
        const eventId = new EventId("linkage-event");
        const commitId = new RunCommitId("linkage-commit");
        const cause = record("linkage-cause", { kind: "receipt", id: receiptId, outcome: "succeeded" });
        const event = record("linkage-event-audit", { kind: "event", id: eventId }, cause.id);
        const commit = record("linkage-commit-audit", { kind: "commit", id: commitId }, cause.id);
        expectUnsubstantiated(cause, event, emptyEvidence());
        expectUnsubstantiated(cause, event, { ...emptyEvidence(), event: () => ({}) });
        expectUnsubstantiated(cause, event, {
            ...emptyEvidence(),
            event: () => ({ receipt: new ReceiptId("linkage-other-receipt") })
        });
        expectSubstantiated(cause, event, { ...emptyEvidence(), event: () => ({ receipt: receiptId }) });
        expectUnsubstantiated(cause, commit, emptyEvidence());
        expectUnsubstantiated(cause, commit, { ...emptyEvidence(), commit: () => ({}) });
        expectUnsubstantiated(cause, commit, {
            ...emptyEvidence(),
            commit: () => ({ receipt: new ReceiptId("linkage-other-receipt") })
        });
        expectSubstantiated(cause, commit, {
            ...emptyEvidence(),
            commit: () => ({ receipt: receiptId })
        });
    });

    test("requires route evidence bound to the causal event", { tags: "p1" }, () => {
        const eventId = new EventId("route-substantiation-event");
        const reservation = new RouteReservationId("route-substantiation-reservation");
        const projection = new RouteProjectionId("route-substantiation-projection");
        const invocationId = new InvocationId("route-substantiation-invocation");
        const cause = record("route-substantiation-cause", { kind: "event", id: eventId });
        const next = record(
            "route-substantiation-audit",
            { kind: "routeReserved", id: reservation },
            cause.id
        );
        expectUnsubstantiated(cause, next, emptyEvidence());
        expectUnsubstantiated(cause, next, {
            ...emptyEvidence(),
            route: () => ({
                event: new EventId("route-substantiation-other"),
                invocation: invocationId,
                projection
            })
        });
        expectSubstantiated(cause, next, {
            ...emptyEvidence(),
            route: () => ({ event: eventId, invocation: invocationId, projection })
        });
    });

    test("requires commit evidence bound to the delivered reservation", { tags: "p1" }, () => {
        const reservation = new RouteReservationId("delivered-commit-reservation");
        const cause = record("delivered-commit-cause", { kind: "delivery", reservation });
        const next = record(
            "delivered-commit-audit",
            { kind: "commit", id: new RunCommitId("delivered-commit") },
            cause.id
        );
        expectUnsubstantiated(cause, next, emptyEvidence());
        expectUnsubstantiated(cause, next, {
            ...emptyEvidence(),
            commit: () => ({ receipt: new ReceiptId("delivered-commit-receipt") })
        });
        expectUnsubstantiated(cause, next, {
            ...emptyEvidence(),
            commit: () => ({ reservation: new RouteReservationId("delivered-commit-other") })
        });
        expectSubstantiated(cause, next, { ...emptyEvidence(), commit: () => ({ reservation }) });
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

function emptyEvidence(): AuditEvidenceResolver {
    return {
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
}

function relationLookup(cause: AuditRecord): AuditRecordLookup {
    return { get: (id) => (id.equals(cause.id) ? cause : undefined) };
}

function expectSubstantiated(
    cause: AuditRecord,
    next: AuditRecord,
    evidence: AuditEvidenceResolver
): void {
    expect(() => validateAuditAppend(next, relationLookup(cause), undefined, evidence)).not.toThrow();
}

function expectUnsubstantiated(
    cause: AuditRecord,
    next: AuditRecord,
    evidence: AuditEvidenceResolver
): void {
    expect(() => validateAuditAppend(next, relationLookup(cause), undefined, evidence)).toThrow(
        /not permitted/
    );
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
