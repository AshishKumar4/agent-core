import { describe, expect, test } from "vitest";
import type { JsonValue } from "../../../src/core";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { ApprovalId, EffectAttemptId, ReceiptId } from "../../../src/invocation-references";
import {
    AuditRecordId,
    EventId,
    InvocationId,
    RouteReservationId
} from "../../../src/interaction-references";
import {
    RunAdmissionRegistry,
    copyRunObligation,
    decodeRunObligation,
    runObligationData,
    runObligationKey,
    type RunObligation
} from "../../../src/agents/runs/admission";
import {
    ForcedTurnCancellation,
    type ForcedTurnCancellationInit
} from "../../../src/agents/runs/forced-cancellation";
import { SettlementObligation, TerminalSnapshot } from "../../../src/agents/runs/settlement";
import { ids, mutableData, settlementAuditKey, thrownBy, type MutableRecordData } from "./fixture";

const invocation = new InvocationId("asm-invocation");
const route = new RouteReservationId("asm-route");
const approval = new ApprovalId("asm-approval");
const attempt = new EffectAttemptId("asm-attempt");
const systemCommit = new RunCommitId("asm-system-commit");
const item: RunObligation = Object.freeze({
    kind: "invocationItem",
    invocation,
    itemIndex: 2,
    itemKey: "asm-item"
});

function expectTypeError(label: string, operation: () => void, message: string): void {
    expect(thrownBy(TypeError, operation, label).message, label).toBe(message);
}

function mutated(data: JsonValue, update: (object: MutableRecordData) => void): MutableRecordData {
    const clone = mutableData(data);
    update(clone);
    return clone;
}

describe("Run admission registry integrity", () => {
    test("propagates non-TypeError faults from obligation identity probes", { tags: "p0" }, () => {
        const registry = RunAdmissionRegistry.initial(ids.run);
        const poisoned = {
            get kind(): "approval" {
                throw new RangeError("obligation kind probe");
            }
        };

        expect(() =>
            registry.accepts({
                run: ids.run,
                registryEpoch: 0,
                // @ts-expect-error Runtime probing must preserve a hostile getter's original error.
                obligation: poisoned
            })
        ).toThrow(RangeError);
        expect(() =>
            registry.complete({
                run: ids.run,
                registryEpoch: 0,
                // @ts-expect-error Runtime completion must preserve a hostile getter's original error.
                obligation: poisoned
            })
        ).toThrow(RangeError);
    });

    test("requires exact canonical approval identities", { tags: "p0" }, () => {
        expectTypeError(
            "approval class",
            () =>
                RunAdmissionRegistry.initial(ids.run).reserve({
                    kind: "approval",
                    approval: ids.run
                }),
            "Approval obligation requires an exact canonical ID"
        );
    });

    test("rejects unknown obligation kinds in canonical copies", { tags: "p0" }, () => {
        expectTypeError(
            "unknown kind",
            // @ts-expect-error Runtime copying must reject an unknown closed-union discriminator.
            () => copyRunObligation({ kind: "unknown" }),
            "Run obligation kind is invalid"
        );
    });

    test("names reserved and completed obligation subjects", { tags: "p2" }, () => {
        expectTypeError(
            "reserved array",
            () =>
                new RunAdmissionRegistry({
                    run: ids.run,
                    epoch: 0,
                    open: true,
                    // @ts-expect-error Runtime validation must reject a non-array reserved list.
                    reserved: null,
                    completed: []
                }),
            "Reserved Run obligations must be an array"
        );
        expectTypeError(
            "completed array",
            () =>
                new RunAdmissionRegistry({
                    run: ids.run,
                    epoch: 0,
                    open: true,
                    reserved: [],
                    // @ts-expect-error Runtime validation must reject a non-array completed list.
                    completed: null
                }),
            "Completed Run obligations must be an array"
        );
    });

    test("validates the open flag before constructing", { tags: "p1" }, () => {
        expectTypeError(
            "open first",
            () =>
                RunAdmissionRegistry.fromData({
                    open: "yes",
                    completed: [],
                    epoch: -1,
                    reserved: [],
                    run: "asm-run"
                }),
            "Run admission registry open state is invalid"
        );
    });

    test("hands back the reservation that completes each obligation", { tags: "p0" }, () => {
        const registry = RunAdmissionRegistry.initial(ids.run)
            .reserve({ kind: "approval", approval })
            .registry.reserve(item).registry;

        for (const obligation of [{ kind: "approval", approval } as const, item]) {
            const found = registry.reservation(obligation);
            if (found === undefined) throw new TypeError(`${obligation.kind} must resolve`);
            expect(runObligationKey(found.obligation)).toBe(runObligationKey(obligation));
            expect(found.run).toEqual(ids.run);
            expect(found.registryEpoch).toBe(registry.epoch);
        }
        expect(registry.reservation({ kind: "route", reservation: route })).toBeUndefined();

        // Closing bumps the epoch, and everything reserved before the close still has to
        // complete afterwards. So the handle names the epoch the obligation was reserved
        // under, which is the one the closed registry's own completion check compares
        // against — an epoch on either side of it discharges nothing.
        const closed = registry.close();
        expect(closed.epoch).toBe(registry.epoch + 1);
        const afterClose = closed.reservation(item);
        if (afterClose === undefined) throw new TypeError("a closed registry still resolves");
        expect(afterClose.registryEpoch).toBe(registry.epoch);
        expect(closed.complete(afterClose).completed.map(runObligationKey)).toEqual([
            runObligationKey(item)
        ]);
    });

    test("names registry fields in decode errors", { tags: "p2" }, () => {
        expectTypeError(
            "registry run",
            () =>
                RunAdmissionRegistry.fromData({
                    open: true,
                    completed: [],
                    epoch: 0,
                    reserved: [],
                    run: 42
                }),
            "Run admission registry Run must be a non-empty string"
        );
    });

    test("rejects unknown registry and obligation fields", { tags: "p1" }, () => {
        expectTypeError(
            "registry extra field",
            () =>
                RunAdmissionRegistry.fromData(
                    mutated(RunAdmissionRegistry.initial(ids.run).toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Run admission registry contains missing or unknown fields"
        );
        const cases = [
            {
                label: "approval",
                obligation: { kind: "approval", approval } as const,
                message: "Approval obligation contains missing or unknown fields"
            },
            {
                label: "invocationItem",
                obligation: item,
                message: "Invocation item obligation contains missing or unknown fields"
            },
            {
                label: "route",
                obligation: { kind: "route", reservation: route } as const,
                message: "Route obligation contains missing or unknown fields"
            },
            {
                label: "reconciliation",
                obligation: { kind: "reconciliation", attempt } as const,
                message: "Reconciliation obligation contains missing or unknown fields"
            },
            {
                label: "systemCommit",
                obligation: { kind: "systemCommit", commit: systemCommit } as const,
                message: "System commit obligation contains missing or unknown fields"
            }
        ] as const;
        for (const { label, obligation, message } of cases) {
            expectTypeError(
                label,
                () =>
                    decodeRunObligation(
                        mutated(runObligationData(obligation), (object) => {
                            object["Stryker was here"] = true;
                        })
                    ),
                message
            );
        }
    });

    test("decodes each obligation kind exactly", { tags: "p1" }, () => {
        const obligations: readonly RunObligation[] = [
            { kind: "approval", approval },
            item,
            { kind: "route", reservation: route },
            { kind: "reconciliation", attempt },
            { kind: "systemCommit", commit: systemCommit }
        ];
        for (const obligation of obligations) {
            const decoded = decodeRunObligation(runObligationData(obligation));
            expect(decoded.kind, obligation.kind).toBe(obligation.kind);
            expect(runObligationKey(decoded), obligation.kind).toBe(runObligationKey(obligation));
        }
        expectTypeError(
            "kind string",
            () => decodeRunObligation({}),
            "Run obligation kind must be a non-empty string"
        );
    });

    test("names each obligation payload field in decode errors", { tags: "p2" }, () => {
        const cases = [
            {
                label: "approval",
                data: { approval: 42, kind: "approval" },
                message: "Approval obligation must be a non-empty string"
            },
            {
                label: "invocation",
                data: { invocation: 42, itemIndex: 2, itemKey: "asm-item", kind: "invocationItem" },
                message: "Invocation item obligation must be a non-empty string"
            },
            {
                label: "itemKey",
                data: {
                    invocation: invocation.value,
                    itemIndex: 2,
                    itemKey: 42,
                    kind: "invocationItem"
                },
                message: "Invocation item obligation key must be a non-empty string"
            },
            {
                label: "reservation",
                data: { kind: "route", reservation: 42 },
                message: "Route obligation must be a non-empty string"
            },
            {
                label: "attempt",
                data: { attempt: 42, kind: "reconciliation" },
                message: "Reconciliation obligation must be a non-empty string"
            },
            {
                label: "commit",
                data: { commit: 42, kind: "systemCommit" },
                message: "System commit obligation must be a non-empty string"
            }
        ] as const;
        for (const { label, data, message } of cases) {
            expectTypeError(label, () => decodeRunObligation(data), message);
        }
    });
});

describe("settlement obligation integrity", () => {
    test("accepts registry epoch zero", { tags: "p0" }, () => {
        const obligation = new SettlementObligation({ registryEpoch: 0, obligations: [] });

        expect(obligation.registryEpoch).toBe(0);
        expect(obligation.obligations).toEqual([]);
        expect(obligation.requiredAudits).toEqual([]);
        expect(Object.isFrozen(obligation)).toBe(true);
    });

    test("canonicalizes obligations by identity key", { tags: "p0" }, () => {
        const obligation = new SettlementObligation({
            registryEpoch: 1,
            obligations: [
                { kind: "route", reservation: route },
                { kind: "approval", approval }
            ]
        });

        expect(obligation.obligations.map((value) => value.kind)).toEqual(["approval", "route"]);
        expect(Object.isFrozen(obligation.obligations)).toBe(true);
    });

    test("derives the exact ordered audit projection", { tags: "p0" }, () => {
        const earlierItem: RunObligation = {
            kind: "invocationItem",
            invocation,
            itemIndex: 1,
            itemKey: "asm-earlier-item"
        };
        const obligation = new SettlementObligation({
            registryEpoch: 1,
            obligations: [
                { kind: "approval", approval },
                item,
                { kind: "route", reservation: route },
                { kind: "reconciliation", attempt },
                { kind: "systemCommit", commit: systemCommit },
                earlierItem
            ]
        });

        expect(obligation.requiredAudits.map(settlementAuditKey)).toEqual([
            "commit:asm-system-commit",
            "delivery:asm-route",
            "receipt:asm-invocation:1:asm-earlier-item",
            "receipt:asm-invocation:2:asm-item"
        ]);
    });

    test("names terminal snapshot fields in decode errors", { tags: "p2" }, () => {
        const snapshot = new TerminalSnapshot(
            ids.run,
            ids.turn,
            ids.root,
            new RunCommitId("asm-terminal"),
            "succeeded",
            new SettlementObligation({ registryEpoch: 1, obligations: [] }),
            new Date(1000)
        );
        const cases = [
            { label: "run", message: "Terminal Run must be a non-empty string" },
            { label: "turn", message: "Terminal Turn must be a non-empty string" },
            { label: "preterminal", message: "Preterminal commit must be a non-empty string" },
            { label: "terminalCommit", message: "Terminal commit must be a non-empty string" }
        ] as const;
        for (const { label, message } of cases) {
            expectTypeError(
                label,
                () =>
                    TerminalSnapshot.fromData(
                        mutated(snapshot.toData(), (object) => {
                            object[label] = 42;
                        })
                    ),
                message
            );
        }
    });

    test("rejects unknown settlement record fields", { tags: "p1" }, () => {
        const obligation = new SettlementObligation({ registryEpoch: 1, obligations: [item] });
        expectTypeError(
            "obligation extra field",
            () =>
                SettlementObligation.fromData(
                    mutated(obligation.toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Settlement obligation contains missing or unknown fields"
        );
        const snapshot = new TerminalSnapshot(
            ids.run,
            ids.turn,
            ids.root,
            new RunCommitId("asm-terminal-extra"),
            "failed",
            obligation,
            new Date(2000)
        );
        expectTypeError(
            "terminal extra field",
            () =>
                TerminalSnapshot.fromData(
                    mutated(snapshot.toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Terminal snapshot contains missing or unknown fields"
        );
    });

    test("binds an exhausted dimension to a cancelled outcome", { tags: "p0" }, () => {
        const obligation = new SettlementObligation({ registryEpoch: 1, obligations: [] });
        const cancelled = new TerminalSnapshot(
            ids.run,
            ids.turn,
            ids.root,
            new RunCommitId("asm-terminal-exhausted"),
            "cancelled",
            obligation,
            new Date(3000),
            "tokens"
        );
        expect(TerminalSnapshot.fromData(cancelled.toData()).exhausted).toBe("tokens");

        // SPEC §5.2 spends exhaustion through cancellation alone. A snapshot that recorded
        // a succeeded or failed Run as having run out of a resource would have the Run both
        // finish its work and be stopped for lack of it.
        for (const outcome of ["succeeded", "failed"] as const) {
            expectTypeError(
                `${outcome} exhaustion`,
                () =>
                    new TerminalSnapshot(
                        ids.run,
                        ids.turn,
                        ids.root,
                        new RunCommitId(`asm-terminal-${outcome}`),
                        outcome,
                        obligation,
                        new Date(3000),
                        "tokens"
                    ),
                "Resource exhaustion terminalizes a Run as cancelled"
            );
            expectTypeError(
                `${outcome} exhaustion decode`,
                () =>
                    TerminalSnapshot.fromData(
                        mutated(cancelled.toData(), (object) => {
                            object["outcome"] = outcome;
                        })
                    ),
                "Resource exhaustion terminalizes a Run as cancelled"
            );
        }

        // The dimension is drawn from the three SPEC §5.2 declares, and the subject names
        // where an undeclared one came from.
        expectTypeError(
            "undeclared dimension",
            () =>
                TerminalSnapshot.fromData(
                    mutated(cancelled.toData(), (object) => {
                        object["exhausted"] = "cpu";
                    })
                ),
            "Terminal exhausted dimension is not a declared resource dimension"
        );
    });
});

function cancellationInit(): ForcedTurnCancellationInit {
    return {
        run: ids.run,
        terminalTurn: ids.turn,
        turn: new TurnId("asm-forced-sibling"),
        priorLeaseEpoch: 4,
        fencedLeaseEpoch: 5,
        controlReceipt: new ReceiptId("asm-control-receipt"),
        controlAudit: new AuditRecordId("asm-control-audit"),
        cancellationEvent: new EventId("asm-cancellation-event"),
        cancellationAudit: new AuditRecordId("asm-cancellation-audit")
    };
}

describe("forced Turn cancellation integrity", () => {
    test("requires each identifier to use its exact context class", { tags: "p0" }, () => {
        const cases = [
            { label: "run", init: { ...cancellationInit(), run: ids.turn } },
            {
                label: "terminalTurn",
                init: { ...cancellationInit(), terminalTurn: ids.run }
            },
            { label: "turn", init: { ...cancellationInit(), turn: ids.run } },
            {
                label: "controlReceipt",
                init: {
                    ...cancellationInit(),
                    controlReceipt: new AuditRecordId("asm-wrong-receipt")
                }
            },
            {
                label: "controlAudit",
                init: {
                    ...cancellationInit(),
                    controlAudit: new ReceiptId("asm-wrong-audit")
                }
            },
            {
                label: "cancellationEvent",
                init: {
                    ...cancellationInit(),
                    cancellationEvent: new AuditRecordId("asm-wrong-event")
                }
            },
            {
                label: "cancellationAudit",
                init: {
                    ...cancellationInit(),
                    cancellationAudit: new EventId("asm-wrong-cancellation-audit")
                }
            }
        ] as const;
        for (const { label, init } of cases) {
            expectTypeError(
                label,
                () => new ForcedTurnCancellation(init),
                "Forced cancellation identifiers must use exact context classes"
            );
        }
    });

    test("requires exactly one lease fence increment", { tags: "p0" }, () => {
        const cases = [
            { label: "negative prior", priorLeaseEpoch: -1, fencedLeaseEpoch: 0 },
            { label: "double increment", priorLeaseEpoch: 4, fencedLeaseEpoch: 6 },
            { label: "fractional epochs", priorLeaseEpoch: 0.5, fencedLeaseEpoch: 1.5 }
        ] as const;
        for (const { label, priorLeaseEpoch, fencedLeaseEpoch } of cases) {
            expectTypeError(
                label,
                () =>
                    new ForcedTurnCancellation({
                        ...cancellationInit(),
                        priorLeaseEpoch,
                        fencedLeaseEpoch
                    }),
                "Forced cancellation requires one exact lease fence increment"
            );
        }
        const boundary = new ForcedTurnCancellation({
            ...cancellationInit(),
            priorLeaseEpoch: 0,
            fencedLeaseEpoch: 1
        });
        expect(boundary.priorLeaseEpoch).toBe(0);
        expect(boundary.fencedLeaseEpoch).toBe(1);
        expect(Object.isFrozen(boundary)).toBe(true);
    });

    test("round-trips through the static codec surface", { tags: "p0" }, () => {
        const record = new ForcedTurnCancellation(cancellationInit());
        const decoded = ForcedTurnCancellation.decode(ForcedTurnCancellation.encode(record));

        expect(decoded).toEqual(record);
        expect(decoded.run.value).toBe(ids.run.value);
        expect(decoded.terminalTurn.value).toBe(ids.turn.value);
        expect(decoded.turn.value).toBe("asm-forced-sibling");
        expect(decoded.controlReceipt.value).toBe("asm-control-receipt");
        expect(decoded.controlAudit.value).toBe("asm-control-audit");
        expect(decoded.cancellationEvent.value).toBe("asm-cancellation-event");
        expect(decoded.cancellationAudit.value).toBe("asm-cancellation-audit");
        expect(Object.isFrozen(decoded)).toBe(true);
    });

    test("names each cancellation field in decode errors", { tags: "p2" }, () => {
        const data = new ForcedTurnCancellation(cancellationInit()).toData();
        const cases = [
            { label: "run", message: "Forced cancellation Run must be a non-empty string" },
            {
                label: "terminalTurn",
                message: "Forced cancellation terminal Turn must be a non-empty string"
            },
            {
                label: "turn",
                message: "Forced cancellation sibling Turn must be a non-empty string"
            },
            {
                label: "controlReceipt",
                message: "Forced cancellation control Receipt must be a non-empty string"
            },
            {
                label: "controlAudit",
                message: "Forced cancellation control Audit must be a non-empty string"
            },
            {
                label: "cancellationEvent",
                message: "Forced cancellation Event must be a non-empty string"
            },
            {
                label: "cancellationAudit",
                message: "Forced cancellation Audit must be a non-empty string"
            }
        ] as const;
        for (const { label, message } of cases) {
            expectTypeError(
                label,
                () =>
                    ForcedTurnCancellation.fromData(
                        mutated(data, (object) => {
                            object[label] = 42;
                        })
                    ),
                message
            );
        }
    });

    test("rejects unknown cancellation fields", { tags: "p1" }, () => {
        expectTypeError(
            "cancellation extra field",
            () =>
                ForcedTurnCancellation.fromData(
                    mutated(new ForcedTurnCancellation(cancellationInit()).toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Forced Turn cancellation contains missing or unknown fields"
        );
    });
});
