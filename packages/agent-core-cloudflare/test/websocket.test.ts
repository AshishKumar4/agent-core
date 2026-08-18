import { AgentCoreError } from "@agent-core/core";
import {
    DurableViewRevisionLog,
    HibernatingViewSocketAdapter,
    decodeViewStreamFrame,
    type HibernatingWebSocketContextLike
} from "../src/index.js";
import { FakeRuntimeSqlite, FakeWebSocket, FakeWebSocketContext, fakeErrors } from "./fakes.js";
import { expectOperationalFailure } from "./assertions.js";

describe("HibernatingViewSocketAdapter", () => {
    test("stores the bounded attachment and replays snapshot plus deltas", () => {
        const log = new DurableViewRevisionLog(new FakeRuntimeSqlite(), fakeErrors);
        log.append("channel", 1, new Uint8Array([1]));
        log.compact("channel", 1, new Uint8Array([9]));
        log.append("channel", 2, new Uint8Array([2]));
        const context = new FakeWebSocketContext();
        const socket = new FakeWebSocket();
        const adapter = new HibernatingViewSocketAdapter(context, log, fakeErrors);

        adapter.accept(socket, "channel", 0);
        expect(context.accepted).toEqual([socket]);
        expect(adapter.attachment(socket)).toEqual({
            version: 1,
            channel: "channel",
            ackedRevision: 0
        });
        expect(socket.sentText().map((message) => decodeViewStreamFrame(message))).toMatchObject([
            { kind: "snapshot", revision: 1, payload: "CQ==" },
            { kind: "delta", revision: 2, payload: "Ag==" }
        ]);
    });

    test("persists only monotonic acknowledgements across hibernation", () => {
        const log = new DurableViewRevisionLog(new FakeRuntimeSqlite(), fakeErrors);
        log.append("channel", 1, new Uint8Array([1]));
        const socket = new FakeWebSocket();
        const adapter = new HibernatingViewSocketAdapter(
            new FakeWebSocketContext(),
            log,
            fakeErrors
        );
        adapter.accept(socket, "channel", 0);
        adapter.acknowledge(socket, 1);
        expect(adapter.attachment(socket).ackedRevision).toBe(1);
        adapter.acknowledge(socket, 1);
        expectOperationalFailure(
            () => adapter.acknowledge(socket, 0),
            "protocol.revision-conflict"
        );
        expectOperationalFailure(
            () => adapter.acknowledge(socket, 2),
            "protocol.revision-conflict"
        );
    });

    test("never accepts a socket that could not keep its attachment", { tags: "p1" }, () => {
        const log = new DurableViewRevisionLog(new FakeRuntimeSqlite(), fakeErrors);
        log.append("channel", 1, new Uint8Array([1]));
        const observed: unknown[] = [];
        const context: HibernatingWebSocketContextLike = {
            acceptWebSocket: (socket) => {
                observed.push(socket.deserializeAttachment());
            }
        };
        const adapter = new HibernatingViewSocketAdapter(context, log, fakeErrors);

        adapter.accept(new FakeWebSocket(), "channel", 1);
        // The attachment is already durable when the platform accepts the socket; a
        // socket accepted without one fails every later message and cannot be repaired.
        expect(observed).toEqual([{ version: 1, channel: "channel", ackedRevision: 1 }]);

        const rejected = new FakeWebSocket();
        rejected.serializeAttachment = () => {
            throw new TypeError("attachment rejected");
        };
        expectOperationalFailure(
            () => adapter.accept(rejected, "channel", 0),
            "protocol.invalid-state"
        );
        expect(observed).toHaveLength(1);
    });

    test("replays a payload larger than the argument limit", { tags: "p2" }, () => {
        const log = new DurableViewRevisionLog(new FakeRuntimeSqlite(), fakeErrors);
        const payload = new Uint8Array(200_000).map((_value, index) => index % 256);
        log.append("channel", 1, payload);
        const socket = new FakeWebSocket();
        new HibernatingViewSocketAdapter(new FakeWebSocketContext(), log, fakeErrors).accept(
            socket,
            "channel",
            0
        );

        const frame = decodeViewStreamFrame(socket.sentTextAt(0));
        expect(
            Uint8Array.from(atob(frame.payload), (character) => character.charCodeAt(0))
        ).toEqual(payload);
    });

    test("rejects oversized or malformed attachments and frames", () => {
        const adapter = new HibernatingViewSocketAdapter(
            new FakeWebSocketContext(),
            new DurableViewRevisionLog(new FakeRuntimeSqlite(), fakeErrors),
            fakeErrors
        );
        expectOperationalFailure(
            () => adapter.accept(new FakeWebSocket(), "x".repeat(16_384), 0),
            "operation.invalid-input"
        );
        const malformed = new FakeWebSocket();
        malformed.attachmentValue = { version: 2, channel: "x", ackedRevision: 0 };
        expectOperationalFailure(() => adapter.attachment(malformed), "codec.invalid");
        malformed.attachmentValue = {
            version: 1,
            channel: "x".repeat(16_384),
            ackedRevision: 0
        };
        expectOperationalFailure(() => adapter.attachment(malformed), "codec.invalid");
        expectOperationalFailure(
            () => adapter.acknowledge(new FakeWebSocket(), -1),
            "operation.invalid-input"
        );
        expect(() => decodeViewStreamFrame("not-json")).toThrow(AgentCoreError);
        expect(() => decodeViewStreamFrame("{}")).toThrow(AgentCoreError);
    });

    test("names the distinct reason a view stream frame is refused", { tags: "p2" }, () => {
        // An escaped lone surrogate parses as a string but is not a Unicode scalar value,
        // so the text is well-formed JSON syntax carrying something that is not JSON data.
        const surrogate = refusedFrame(
            '{"version":1,"kind":"snapshot","channel":"c","revision":1,"payload":"\\ud800"}'
        );
        expect(surrogate.code).toBe("codec.invalid");
        expect(surrogate.message).toBe("View stream frame must be JSON");
        expect(causeOf(surrogate).message).toBe("View stream frame must be JSON data");

        for (const value of [
            "[]",
            "3",
            '{"version":2,"kind":"snapshot","channel":"c","revision":1,"payload":""}',
            '{"version":1,"kind":"patch","channel":"c","revision":1,"payload":""}'
        ]) {
            const refused = refusedFrame(value);
            expect(refused.code).toBe("codec.invalid");
            expect(refused.message).toBe("View stream frame has an invalid shape");
            expect(refused.cause).toBeUndefined();
        }
    });

    test("names the field that made a persisted attachment unreadable", { tags: "p1" }, () => {
        const adapter = new HibernatingViewSocketAdapter(
            new FakeWebSocketContext(),
            new DurableViewRevisionLog(new FakeRuntimeSqlite(), fakeErrors),
            fakeErrors
        );
        const socket = new FakeWebSocket();

        // A socket that hibernated before the adapter attached anything, and one whose
        // attachment is not a record at all: neither carries a field to name.
        for (const value of [null, 7, ["c", 0]]) {
            socket.attachmentValue = value;
            const refused = refusedAttachment(adapter, socket);
            expect(refused.code).toBe("codec.invalid");
            expect(refused.message).toBe("WebSocket attachment has an invalid shape");
            expect(refused.cause).toBeUndefined();
        }

        socket.attachmentValue = { version: 1, channel: "", ackedRevision: 0 };
        const unreadable = refusedAttachment(adapter, socket);
        expect(unreadable.message).toBe("WebSocket attachment has an invalid shape");
        expect(causeOf(unreadable).message).toContain("WebSocket attachment channel");
    });
});

function refusedFrame(value: string): AgentCoreError {
    try {
        decodeViewStreamFrame(value);
    } catch (error) {
        if (error instanceof AgentCoreError) return error;
        throw error;
    }
    throw new TypeError(`Expected ${value} to be refused as a view stream frame`);
}

function refusedAttachment(
    adapter: HibernatingViewSocketAdapter,
    socket: FakeWebSocket
): AgentCoreError {
    try {
        adapter.attachment(socket);
    } catch (error) {
        if (error instanceof AgentCoreError) return error;
        throw error;
    }
    throw new TypeError("Expected the persisted attachment to be refused");
}

/** The captured cause a decode failure carries, as the failure it was raised from. */
function causeOf(error: AgentCoreError): AgentCoreError {
    const cause = error.cause;
    if (cause instanceof AgentCoreError) return cause;
    throw new TypeError("Expected the refusal to carry the failure it was raised from");
}
