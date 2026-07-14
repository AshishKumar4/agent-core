import {
    DurableViewRevisionLog,
    HibernatingViewSocketAdapter,
    decodeViewStreamFrame
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
        expect(
            socket.sent.map((message) => decodeViewStreamFrame(message as string))
        ).toMatchObject([
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
});
import { AgentCoreError } from "@agent-core/core";
