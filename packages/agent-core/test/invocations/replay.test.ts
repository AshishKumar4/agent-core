import { describe, expect, test } from "vitest";
import {
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    InvocationId,
    MediatedReplayRecord,
    ReceiptId,
    type InvocationInterceptorTrace,
    type MediatedReplayItem,
    type MediatedReplayShape
} from "../../src/invocations";

describe("W6 mediated replay record", () => {
    test("rejects Principal subclasses and blank reservation identity text", { tags: "p1" }, () => {
        class ForgedPrincipalRef extends PrincipalRef {}
        const reservation = replayReservation("identity-guards");
        expect(() =>
            MediatedReplayRecord.reserve({
                ...reservation,
                principal: new ForgedPrincipalRef(
                    new TenantId("replay-tenant"),
                    new PrincipalId("replay-principal")
                )
            })
        ).toThrow(/exact PrincipalRef class/);
        expect(() => MediatedReplayRecord.reserve({ ...reservation, operation: "" })).toThrow(
            /canonical/
        );
    });

    test("round-trips route execution identities", { tags: "p1" }, () => {
        const record = MediatedReplayRecord.reserve({
            ...replayReservation("route-execution"),
            execution: { kind: "route", digest: new Digest("c".repeat(64)) }
        });
        expect(record.execution.kind).toBe("route");
        const decoded = MediatedReplayRecord.decode(MediatedReplayRecord.encode(record));
        expect(decoded.execution.kind).toBe("route");
        expect(decoded.id.equals(record.id)).toBe(true);
    });

    test("requires items to match the nonempty payload shape exactly", { tags: "p1" }, () => {
        const invocation = new InvocationId("shape-guards");
        expect(() => directRecord({ kind: "single" }, [], invocation, 1)).toThrow(
            /nonempty payload shape/
        );
        expect(() => directRecord({ kind: "batch", itemCount: 0 }, [], invocation, 1)).toThrow(
            /nonempty payload shape/
        );
    });

    test("rejects items stored away from their own position", { tags: "p1" }, () => {
        expect(() => directRecord({ kind: "single" }, [reservedItem(1)], undefined, 0)).toThrow(
            /item index must equal its position/
        );
    });

    test("completes preparation for every reserved payload exactly once", { tags: "p1" }, () => {
        const reserved = MediatedReplayRecord.reserve(replayReservation("prepare-cardinality"));
        const invocation = new InvocationId("prepare-cardinality-invocation");
        expect(() => reserved.prepare(invocation, [{}, {}], [[]])).toThrow(/exactly once/);
        expect(() => reserved.prepare(invocation, [{}], [[], []])).toThrow(/exactly once/);
        let failure: unknown;
        try {
            reserved.prepare(invocation, [{}, {}], [[]]);
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({
            code: "invocation.invalid",
            failure: "state.invalid-transition",
            message: expect.stringMatching(/exactly once/u)
        });
    });

    test("keeps terminal items immutable against late effect outputs", { tags: "p0" }, () => {
        const terminal = MediatedReplayRecord.reserve(replayReservation("terminal-immutable"))
            .prepare(new InvocationId("terminal-immutable-invocation"), [{}], [[]])
            .recordTerminal(0, new ReceiptId("terminal-receipt"));
        expect(() => terminal.recordEffect(0, { late: true }, new ReceiptId("late"))).toThrow(
            /immutable/
        );
    });

    test("rejects effect transitions for out-of-range items", { tags: "p1" }, () => {
        const prepared = MediatedReplayRecord.reserve(
            replayReservation("out-of-range")
        ).prepare(new InvocationId("out-of-range-invocation"), [{}], [[]]);
        expect(() => prepared.recordEffect(1, { value: 1 }, new ReceiptId("late"))).toThrow(
            /has not completed preparation/
        );
    });

    test("reports completion only when every item is complete", { tags: "p0" }, () => {
        const prepared = MediatedReplayRecord.reserve({
            ...replayReservation("completion"),
            shape: { kind: "batch", itemCount: 2 },
            rawPayloadIdentities: [new Digest("e".repeat(64)), new Digest("f".repeat(64))]
        }).prepare(new InvocationId("completion-invocation"), [{}, {}], [[], []]);
        const firstTerminal = prepared.recordTerminal(0, new ReceiptId("terminal-0"));
        expect(firstTerminal.complete).toBe(false);
        expect(firstTerminal.recordTerminal(1, new ReceiptId("terminal-1")).complete).toBe(true);
        const effected = prepared
            .recordTerminal(0, new ReceiptId("terminal-0"))
            .recordEffect(1, { effect: 1 }, new ReceiptId("effect-1"));
        expect(effected.complete).toBe(false);
        expect(effected.present(1, [], { presented: 1 }).complete).toBe(true);
    });

    test("rejects records whose preparation phase is inconsistent", { tags: "p1" }, () => {
        const invocation = new InvocationId("phase-consistency");
        const argumentsOnly: MediatedReplayItem = {
            ...reservedItem(0),
            preparedArguments: {}
        };
        expect(() => directRecord({ kind: "single" }, [argumentsOnly], invocation, 1)).toThrow(
            /preparation phase is inconsistent/
        );
        const tracesOnly: MediatedReplayItem = {
            ...reservedItem(0),
            before: [trace("operation.before")]
        };
        expect(() => directRecord({ kind: "single" }, [tracesOnly], invocation, 1)).toThrow(
            /preparation phase is inconsistent/
        );
        expect(() => directRecord({ kind: "single" }, [reservedItem(0)], undefined, 1)).toThrow(
            /preparation phase is inconsistent/
        );
        expect(() =>
            directRecord(
                { kind: "batch", itemCount: 2 },
                [preparedItem(0), reservedItem(1)],
                invocation,
                1
            )
        ).toThrow(/preparation phase is inconsistent/);
    });

    test("rejects records whose item phases are inconsistent", { tags: "p1" }, () => {
        const invocation = new InvocationId("item-phase-consistency");
        const effectWithoutReceipt: MediatedReplayItem = {
            ...preparedItem(0),
            effectOutput: {}
        };
        expect(() =>
            directRecord({ kind: "single" }, [effectWithoutReceipt], invocation, 1)
        ).toThrow(/item phases are inconsistent/);
        const tracesWithoutPresentation: MediatedReplayItem = {
            ...preparedItem(0),
            after: [trace("operation.after")]
        };
        expect(() =>
            directRecord({ kind: "single" }, [tracesWithoutPresentation], invocation, 1)
        ).toThrow(/item phases are inconsistent/);
        const presentationWithoutEffect: MediatedReplayItem = {
            ...preparedItem(0),
            receipt: new ReceiptId("terminal-receipt"),
            after: [trace("operation.after")],
            presentation: {}
        };
        expect(() =>
            directRecord({ kind: "single" }, [presentationWithoutEffect], invocation, 1)
        ).toThrow(/item phases are inconsistent/);
    });

    test("keeps reserved items free of later phase keys", { tags: "p2" }, () => {
        const reserved = MediatedReplayRecord.reserve(replayReservation("reserved-keys"));
        expect(Object.keys(reserved.items[0] ?? {})).toEqual(["itemIndex", "rawPayloadIdentity"]);
    });

    test("round-trips every item phase through the codec", { tags: "p0" }, () => {
        const prepared = MediatedReplayRecord.reserve({
            ...replayReservation("lifecycle"),
            shape: { kind: "batch", itemCount: 2 },
            rawPayloadIdentities: [new Digest("e".repeat(64)), new Digest("f".repeat(64))]
        }).prepare(
            new InvocationId("lifecycle-invocation"),
            [{ item: 0 }, { item: 1 }],
            [[trace("operation.before")], []]
        );
        const effected = prepared.recordEffect(0, { effect: 0 }, new ReceiptId("effect-receipt"));
        const presented = effected
            .recordTerminal(1, new ReceiptId("terminal-receipt"))
            .present(0, [trace("operation.after")], { presented: 0 });
        for (const record of [prepared, effected, presented]) {
            const bytes = MediatedReplayRecord.encode(record);
            expect(MediatedReplayRecord.encode(MediatedReplayRecord.decode(bytes))).toEqual(bytes);
        }
        const decoded = MediatedReplayRecord.decode(MediatedReplayRecord.encode(presented));
        expect(decoded.items[1]?.receipt?.value).toBe("terminal-receipt");
        expect(decoded.items[0]?.presentation).toEqual({ presented: 0 });
        expect(decoded.complete).toBe(true);
    });

    test("rejects corrupted codec payloads with precise diagnostics", { tags: "p2" }, () => {
        const presented = MediatedReplayRecord.reserve({
            ...replayReservation("corruption"),
            shape: { kind: "batch", itemCount: 2 },
            rawPayloadIdentities: [new Digest("e".repeat(64)), new Digest("f".repeat(64))]
        })
            .prepare(
                new InvocationId("corruption-invocation"),
                [{ item: 0 }, { item: 1 }],
                [[trace("operation.before")], []]
            )
            .recordEffect(0, { effect: 0 }, new ReceiptId("effect-receipt"))
            .recordTerminal(1, new ReceiptId("terminal-receipt"))
            .present(0, [trace("operation.after")], { presented: 0 });
        const bytes = MediatedReplayRecord.encode(presented);
        const decode = (mutate: (payload: { [key: string]: JsonValue }) => void) => () =>
            MediatedReplayRecord.decode(mutateRecord(bytes, mutate));
        expect(decode((payload) => (payload["invocation"] = 42))).toThrow(
            /must be a string or null/
        );
        expect(decode((payload) => (payload["id"] = "0".repeat(64)))).toThrow(
            /does not match its canonical reservation identity/
        );
        expect(
            decode((payload) => (payloadItem(payload, 1)["receipt"] = 42))
        ).toThrow(/Replay Receipt is malformed/);
        expect(decode((payload) => (payloadItem(payload, 0)["phase"] = "bogus"))).toThrow(
            /item phase is invalid/
        );
        expect(
            decode((payload) => (payloadTrace(payloadItem(payload, 0))["cutPoint"] = "bogus"))
        ).toThrow(/interceptor trace is invalid/);
        expect(
            decode((payload) => (payloadTrace(payloadItem(payload, 0))["outcome"] = "bogus"))
        ).toThrow(/interceptor trace is invalid/);
        expect(
            decode((payload) => (payload["shape"] = { itemCount: 2, kind: "bogus" }))
        ).toThrow(/shape is invalid/);
        expect(
            decode((payload) => {
                const execution = payload["execution"] as { [key: string]: JsonValue };
                execution["kind"] = "substituted";
            })
        ).toThrow(/execution identity kind is invalid/);
    });
});

function replayReservation(id: string) {
    return {
        scope: id,
        requestKey: `request:${id}`,
        facet: "workspace:target",
        operation: "send",
        descriptorDigest: new Digest("d".repeat(64)),
        principal: new PrincipalRef(
            new TenantId("replay-tenant"),
            new PrincipalId("replay-principal")
        ),
        authorityIdentity: new Digest("a".repeat(64)),
        packageOperationPin: new Digest("b".repeat(64)),
        execution: { kind: "lease" as const, digest: new Digest("c".repeat(64)) },
        shape: { kind: "single" as const },
        rawPayloadIdentities: [new Digest("e".repeat(64))]
    };
}

function directRecord(
    shape: MediatedReplayShape,
    items: readonly MediatedReplayItem[],
    invocation: InvocationId | undefined,
    revision: number
): MediatedReplayRecord {
    const reservation = replayReservation("direct");
    return new MediatedReplayRecord(
        reservation.scope,
        reservation.requestKey,
        reservation.facet,
        reservation.operation,
        reservation.descriptorDigest,
        reservation.principal,
        reservation.authorityIdentity,
        reservation.packageOperationPin,
        reservation.execution,
        shape,
        items,
        invocation,
        new Revision(revision)
    );
}

function reservedItem(itemIndex: number): MediatedReplayItem {
    return { itemIndex, rawPayloadIdentity: new Digest("e".repeat(64)) };
}

function preparedItem(itemIndex: number): MediatedReplayItem {
    return {
        ...reservedItem(itemIndex),
        preparedArguments: {},
        before: [trace("operation.before")]
    };
}

function trace(cutPoint: "operation.before" | "operation.after"): InvocationInterceptorTrace {
    return Object.freeze({
        interceptor: cutPoint,
        contributor: "workspace:interceptor",
        cutPoint,
        before: new Digest("a".repeat(64)),
        after: new Digest("b".repeat(64)),
        outcome: "rewritten"
    });
}

function payloadItem(payload: { [key: string]: JsonValue }, itemIndex: number) {
    const items = payload["items"] as JsonValue[];
    return items[itemIndex] as { [key: string]: JsonValue };
}

function payloadTrace(item: { [key: string]: JsonValue }) {
    const traces = item["before"] as JsonValue[];
    return traces[0] as { [key: string]: JsonValue };
}

function mutateRecord(
    bytes: Uint8Array,
    mutate: (payload: { [key: string]: JsonValue }) => void
): Uint8Array {
    const envelope = decodeCanonicalJson(bytes) as {
        kind: string;
        version: { major: number; minor: number };
        payload: { [key: string]: JsonValue };
    };
    mutate(envelope.payload);
    return encodeCanonicalJson(envelope as unknown as JsonValue);
}
