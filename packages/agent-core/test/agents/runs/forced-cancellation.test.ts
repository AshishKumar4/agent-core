import { describe, expect, it } from "vitest";
import { decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { TurnId } from "../../../src/execution-references";
import {
    ForcedTurnCancellation,
    ForcedTurnCancellationCodec
} from "../../../src/agents/runs/forced-cancellation";
import { MemoryRunStorage } from "../../../src/agents/runs/memory";
import { RunRepository } from "../../../src/agents/runs/store";
import { ReceiptId } from "../../../src/invocation-references";
import { AuditRecordId, EventId } from "../../../src/interaction-references";
import { ids } from "./fixture";

function cancellation(overrides: { readonly audit?: string } = {}): ForcedTurnCancellation {
    return new ForcedTurnCancellation({
        run: ids.run,
        terminalTurn: ids.turn,
        turn: new TurnId("forced-sibling"),
        priorLeaseEpoch: 4,
        fencedLeaseEpoch: 5,
        controlReceipt: new ReceiptId("forced-control-receipt"),
        controlAudit: new AuditRecordId("forced-control-audit"),
        cancellationEvent: new EventId("forced-cancellation-event"),
        cancellationAudit: new AuditRecordId(overrides.audit ?? "forced-cancellation-audit")
    });
}

function expectCode(operation: () => unknown, code: AgentCoreError["code"]): void {
    try {
        operation();
        throw new Error("Expected operation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code).toBe(code);
    }
}

describe("ForcedTurnCancellation record", () => {
    it("[run.forced-turn-cancellation] round-trips every exact evidence identity and fence epoch", () => {
        const record = cancellation();
        const decoded = ForcedTurnCancellationCodec.decode(
            ForcedTurnCancellationCodec.encode(record)
        );

        expect(decoded).toEqual(record);
        expect(Object.isFrozen(decoded)).toBe(true);
        expect(decoded.priorLeaseEpoch).toBe(4);
        expect(decoded.fencedLeaseEpoch).toBe(5);
        expect(decoded.controlReceipt.value).toBe("forced-control-receipt");
        expect(decoded.controlAudit.value).toBe("forced-control-audit");
        expect(decoded.cancellationEvent.value).toBe("forced-cancellation-event");
        expect(decoded.cancellationAudit.value).toBe("forced-cancellation-audit");
    });

    it("rejects same-Turn, nonincrementing fences, unknown fields, and unknown codec majors", () => {
        expect(
            () =>
                new ForcedTurnCancellation({
                    run: ids.run,
                    terminalTurn: ids.turn,
                    turn: ids.turn,
                    priorLeaseEpoch: 0,
                    fencedLeaseEpoch: 1,
                    controlReceipt: new ReceiptId("receipt"),
                    controlAudit: new AuditRecordId("control"),
                    cancellationEvent: new EventId("event"),
                    cancellationAudit: new AuditRecordId("audit")
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new ForcedTurnCancellation({
                    run: ids.run,
                    terminalTurn: ids.turn,
                    turn: new TurnId("sibling"),
                    priorLeaseEpoch: 2,
                    fencedLeaseEpoch: 4,
                    controlReceipt: new ReceiptId("receipt"),
                    controlAudit: new AuditRecordId("control"),
                    cancellationEvent: new EventId("event"),
                    cancellationAudit: new AuditRecordId("audit")
                })
        ).toThrow(TypeError);

        const envelope = decodeCanonicalJson(
            ForcedTurnCancellationCodec.encode(cancellation())
        ) as {
            readonly kind: string;
            readonly version: { readonly major: number; readonly minor: number };
            readonly payload: { readonly [key: string]: JsonValue };
        };
        expectCode(
            () =>
                ForcedTurnCancellationCodec.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: { ...envelope.payload, extra: true }
                    })
                ),
            "codec.invalid"
        );
        expectCode(
            () =>
                ForcedTurnCancellationCodec.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        version: { major: 2, minor: 0 }
                    })
                ),
            "codec.unknown-major"
        );
    });

    it("[run.forced-turn-cancellation] persists immutably through memory snapshot restart and rejects identity conflict", () => {
        const storage = new MemoryRunStorage();
        const repository = new RunRepository(storage);
        const record = cancellation();
        repository.transaction((tx) => repository.insertForcedCancellation(tx, record));

        const restarted = new RunRepository(new MemoryRunStorage(storage.snapshot()));
        expect(
            restarted.transaction((tx) => restarted.loadForcedCancellation(tx, record.turn))
        ).toEqual(record);
        expect(
            restarted.transaction((tx) => restarted.listForcedCancellations(tx, ids.run))
        ).toEqual([record]);
        expectCode(
            () =>
                restarted.transaction((tx) =>
                    restarted.insertForcedCancellation(
                        tx,
                        cancellation({ audit: "conflicting-cancellation-audit" })
                    )
                ),
            "run.invalid-state"
        );
    });
});
