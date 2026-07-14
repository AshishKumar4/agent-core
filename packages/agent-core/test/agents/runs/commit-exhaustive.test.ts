import { describe, expect, it } from "vitest";
import { AgentCoreError } from "../../../src/errors";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import {
    RunCommit,
    validateCommitWriter,
    type CommitWriter,
    type RunCommitInit
} from "../../../src/agents/runs/commit";
import { ReceiptId } from "../../../src/invocations";
import {
    AuditRecordId,
    InvocationId,
    RouteReservationId
} from "../../../src/interaction-references";
import { RunId } from "../../../src/agents/runs/id";
import { content, harness, ids, pins, refs } from "./fixture";

function expectCode(operation: () => unknown, code: AgentCoreError["code"]): void {
    try {
        operation();
        throw new Error("Expected operation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code).toBe(code);
    }
}

function turnWriter(): CommitWriter {
    return {
        kind: "turn",
        token: { turn: ids.turn, holder: ids.holder, epoch: 1 }
    };
}

function message(id = "message"): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "message",
        parents: [ids.root],
        pins: pins(),
        writer: turnWriter(),
        subjectTurn: ids.turn,
        content: content("1")
    });
}

function invocation(id = "invocation"): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "invocation",
        parents: [ids.root],
        pins: pins(),
        writer: {
            kind: "system",
            cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
        },
        invocation: refs.invocation,
        receipt: refs.receipt
    });
}

function delivery(id = "delivery"): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "eventDelivery",
        parents: [ids.root],
        pins: pins(),
        writer: {
            kind: "system",
            cause: { kind: "delivery", audit: refs.audit, reservation: refs.route }
        },
        reservation: refs.route
    });
}

function control(id = "undo"): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "undo",
        parents: [ids.root],
        pins: pins(),
        writer: {
            kind: "system",
            cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
        },
        selects: ids.root,
        receipt: refs.receipt
    });
}

function synthesize(id = "synthesize"): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "merge",
        parents: [ids.root, new RunCommitId("source")],
        pins: pins(),
        writer: {
            kind: "system",
            cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
        },
        subjectTurn: ids.turn,
        content: content("2"),
        resolution: {
            kind: "synthesize",
            token: { turn: ids.turn, holder: ids.holder, epoch: 1 },
            receipt: new ReceiptId("synthesis-receipt")
        },
        receipt: refs.receipt
    });
}

describe("closed commit writer matrix", () => {
    it("[C13-TURN-RUN-COMMIT-WRITER] accepts root and exact Turn writers and rejects forged writer pairs", () => {
        const value = harness();
        const root = new RunCommit({
            id: ids.root,
            run: ids.run,
            branch: ids.branch,
            kind: "root",
            parents: [],
            pins: pins(),
            writer: { kind: "root" }
        });
        value.repository.transaction((tx) => validateCommitWriter(tx, root, value.evidence));
        value.repository.transaction((tx) => validateCommitWriter(tx, message(), value.evidence));
        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(
                        tx,
                        { ...message("forged-root"), writer: { kind: "root" } } as RunCommit,
                        value.evidence
                    )
                ),
            "run.invalid-state"
        );
        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(
                        tx,
                        {
                            ...message("forged-turn"),
                            subjectTurn: new TurnId("other")
                        } as RunCommit,
                        value.evidence
                    )
                ),
            "run.invalid-state"
        );
    });

    it("[C13-WRITER-MATRIX] rejects every Receipt evidence mismatch", () => {
        const variants = [
            undefined,
            {
                kind: "receipt" as const,
                run: new RunId("other"),
                receipt: refs.receipt,
                audit: refs.audit,
                invocation: refs.invocation
            },
            {
                kind: "receipt" as const,
                run: ids.run,
                receipt: new ReceiptId("other"),
                audit: refs.audit,
                invocation: refs.invocation
            },
            {
                kind: "receipt" as const,
                run: ids.run,
                receipt: refs.receipt,
                audit: new AuditRecordId("other-audit"),
                invocation: refs.invocation
            },
            {
                kind: "receipt" as const,
                run: ids.run,
                receipt: refs.receipt,
                audit: refs.audit,
                invocation: new InvocationId("other")
            },
            {
                kind: "receipt" as const,
                run: ids.run,
                receipt: refs.receipt,
                audit: refs.audit,
                invocation: refs.invocation,
                subjectTurn: ids.turn
            }
        ];
        for (const [index, evidence] of variants.entries()) {
            const value = harness();
            if (evidence !== undefined) {
                value.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, evidence);
            }
            expectCode(
                () =>
                    value.repository.transaction((tx) =>
                        validateCommitWriter(
                            tx,
                            invocation(`receipt-mismatch-${index}`),
                            value.evidence
                        )
                    ),
                "authority.denied"
            );
        }
        const value = harness();
        value.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "receipt",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            invocation: refs.invocation
        });
        value.repository.transaction((tx) =>
            validateCommitWriter(tx, invocation("receipt-ok"), value.evidence)
        );
    });

    it("[C13-WRITER-POST-FENCE-EVIDENCE] rejects every delivery and control evidence mismatch", () => {
        const value = harness();
        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(tx, delivery(), value.evidence)
                ),
            "authority.denied"
        );
        value.evidence.deliveries.set(`${refs.route.value}:${refs.audit.value}`, {
            kind: "delivery",
            run: ids.run,
            reservation: new RouteReservationId("other"),
            audit: refs.audit
        });
        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(tx, delivery("delivery-wrong"), value.evidence)
                ),
            "authority.denied"
        );
        value.evidence.deliveries.set(`${refs.route.value}:${refs.audit.value}`, {
            kind: "delivery",
            run: ids.run,
            reservation: refs.route,
            audit: new AuditRecordId("other-audit")
        });
        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(tx, delivery("delivery-audit"), value.evidence)
                ),
            "authority.denied"
        );
        value.evidence.deliveries.set(`${refs.route.value}:${refs.audit.value}`, {
            kind: "delivery",
            run: ids.run,
            reservation: refs.route,
            audit: refs.audit
        });
        value.repository.transaction((tx) =>
            validateCommitWriter(tx, delivery("delivery-ok"), value.evidence)
        );

        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(tx, control(), value.evidence)
                ),
            "authority.denied"
        );
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: "wrong"
        });
        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(tx, control("control-wrong"), value.evidence)
                ),
            "authority.denied"
        );
        const auditMismatch = control("control-audit");
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: new AuditRecordId("other-audit"),
            proposalDigest: auditMismatch.proposalDigest.value
        });
        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(tx, auditMismatch, value.evidence)
                ),
            "authority.denied"
        );
        const exact = control("control-ok");
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: exact.proposalDigest.value
        });
        value.repository.transaction((tx) => validateCommitWriter(tx, exact, value.evidence));
    });

    it("[C13-ADV-UNAUTHORIZED-WRITER] rejects substitution between SystemCause and returned evidence IDs", () => {
        const value = harness();
        const returned = new ReceiptId("returned-receipt");
        const substituted = new RunCommit({
            id: new RunCommitId("substituted-receipt"),
            run: ids.run,
            branch: ids.branch,
            kind: "invocation",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
            },
            invocation: refs.invocation,
            receipt: returned
        });
        value.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "receipt",
            run: ids.run,
            receipt: returned,
            audit: refs.audit,
            invocation: refs.invocation
        });
        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(tx, substituted, value.evidence)
                ),
            "authority.denied"
        );

        const returnedRoute = new RouteReservationId("returned-route");
        const substitutedDelivery = new RunCommit({
            id: new RunCommitId("substituted-delivery"),
            run: ids.run,
            branch: ids.branch,
            kind: "eventDelivery",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "delivery", audit: refs.audit, reservation: refs.route }
            },
            reservation: returnedRoute
        });
        value.evidence.deliveries.set(`${refs.route.value}:${refs.audit.value}`, {
            kind: "delivery",
            run: ids.run,
            reservation: returnedRoute,
            audit: refs.audit
        });
        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(tx, substitutedDelivery, value.evidence)
                ),
            "authority.denied"
        );

        const substitutedControl = new RunCommit({
            id: new RunCommitId("substituted-control"),
            run: ids.run,
            branch: ids.branch,
            kind: "undo",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            selects: ids.root,
            receipt: returned
        });
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: returned,
            audit: refs.audit,
            proposalDigest: substitutedControl.proposalDigest.value
        });
        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(tx, substitutedControl, value.evidence)
                ),
            "authority.denied"
        );
    });

    it("[C13-WRITER-SYNTHESIS] requires exact synthesis Run, token, and content evidence", () => {
        const variants = [
            undefined,
            {
                kind: "synthesis" as const,
                run: new RunId("other"),
                receipt: new ReceiptId("synthesis-receipt"),
                token: { turn: ids.turn, holder: ids.holder, epoch: 1 },
                content: content("2")
            },
            {
                kind: "synthesis" as const,
                run: ids.run,
                receipt: new ReceiptId("synthesis-receipt"),
                token: { turn: ids.turn, holder: ids.holder, epoch: 2 },
                content: content("2")
            },
            {
                kind: "synthesis" as const,
                run: ids.run,
                receipt: new ReceiptId("other-receipt"),
                token: { turn: ids.turn, holder: ids.holder, epoch: 1 },
                content: content("2")
            },
            {
                kind: "synthesis" as const,
                run: ids.run,
                receipt: new ReceiptId("synthesis-receipt"),
                token: { turn: ids.turn, holder: ids.holder, epoch: 1 },
                content: content("3")
            }
        ];
        for (const [index, evidence] of variants.entries()) {
            const value = harness();
            const commit = synthesize(`synthesis-${index}`);
            value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
                kind: "control",
                run: ids.run,
                receipt: refs.receipt,
                audit: refs.audit,
                proposalDigest: commit.proposalDigest.value
            });
            if (evidence !== undefined) value.evidence.syntheses.set("synthesis-receipt", evidence);
            expectCode(
                () =>
                    value.repository.transaction((tx) =>
                        validateCommitWriter(tx, commit, value.evidence)
                    ),
                "authority.denied"
            );
        }
    });
});

describe("closed RunCommit shapes", () => {
    const expectShapeError = (init: RunCommitInit): void => {
        expect(() => new RunCommit(init)).toThrow(TypeError);
    };

    it("[C13-RUN-BINARY-MERGE] rejects invalid root, merge, and unary arities", () => {
        expectShapeError({
            id: new RunCommitId("bad-root"),
            run: ids.run,
            branch: ids.branch,
            kind: "root",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "root" }
        });
        expectShapeError({
            id: new RunCommitId("bad-merge"),
            run: ids.run,
            branch: ids.branch,
            kind: "merge",
            parents: [ids.root],
            pins: pins(),
            writer: turnWriter()
        });
        expectShapeError({
            id: new RunCommitId("bad-unary"),
            run: ids.run,
            branch: ids.branch,
            kind: "message",
            parents: [],
            pins: pins(),
            writer: turnWriter(),
            subjectTurn: ids.turn,
            content: content("4")
        });
    });

    it("[C13-TURN-INVOCATION-WRITER] rejects incomplete invocation, delivery, undo, migration, and Turn commits", () => {
        const cases: RunCommitInit[] = [
            {
                id: new RunCommitId("bad-invocation"),
                run: ids.run,
                branch: ids.branch,
                kind: "invocation",
                parents: [ids.root],
                pins: pins(),
                writer: turnWriter()
            },
            {
                id: new RunCommitId("bad-delivery"),
                run: ids.run,
                branch: ids.branch,
                kind: "eventDelivery",
                parents: [ids.root],
                pins: pins(),
                writer: turnWriter()
            },
            {
                id: new RunCommitId("bad-undo"),
                run: ids.run,
                branch: ids.branch,
                kind: "undo",
                parents: [ids.root],
                pins: pins(),
                writer: turnWriter()
            },
            {
                id: new RunCommitId("bad-migration"),
                run: ids.run,
                branch: ids.branch,
                kind: "migration",
                parents: [ids.root],
                pins: pins(),
                writer: turnWriter()
            },
            {
                id: new RunCommitId("bad-turn"),
                run: ids.run,
                branch: ids.branch,
                kind: "message",
                parents: [ids.root],
                pins: pins(),
                writer: turnWriter(),
                content: content("4")
            }
        ];
        cases.forEach(expectShapeError);
    });

    it("rejects malformed serialized writer and resolution variants", () => {
        const mutate = (base: RunCommit, update: (data: Record<string, unknown>) => void): void => {
            const data = structuredClone(base.toData()) as Record<string, unknown>;
            update(data);
            expect(() => RunCommit.fromData(data as never)).toThrow(TypeError);
        };
        mutate(message("serialized-writer"), (data) => {
            data["writer"] = { kind: "unknown" };
        });
        mutate(invocation("serialized-cause"), (data) => {
            data["writer"] = { kind: "system", cause: { kind: "unknown" } };
        });
        mutate(synthesize("serialized-resolution"), (data) => {
            data["resolution"] = { kind: "unknown" };
        });
        mutate(synthesize("serialized-kind"), (data) => {
            data["kind"] = "unknown";
        });
        mutate(message("serialized-token"), (data) => {
            data["writer"] = {
                kind: "turn",
                token: { turn: ids.turn.value, holder: ids.holder.value, epoch: -1 }
            };
        });
        expect(
            () =>
                new RunCommit({
                    id: new RunCommitId("negative-token"),
                    run: ids.run,
                    branch: ids.branch,
                    kind: "message",
                    parents: [ids.root],
                    pins: pins(),
                    writer: {
                        kind: "turn",
                        token: { turn: ids.turn, holder: ids.holder, epoch: -1 }
                    },
                    subjectTurn: ids.turn,
                    content: content("5")
                })
        ).toThrow(/epoch/);
    });
});
