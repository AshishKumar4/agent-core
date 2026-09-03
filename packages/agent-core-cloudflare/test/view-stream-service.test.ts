import { AgentCoreError, isJsonObject, type JsonValue } from "@agent-core/core";
import {
    DurableViewRevisionLog,
    HibernatingViewSocketAdapter,
    decodeViewStreamFrame,
    type HibernatingWebSocketLike,
    type SqliteRow,
    type SqliteValue,
    type ViewSocketAttachment,
    type ViewStreamFrame
} from "../src/index.js";
import { FakeRuntimeSqlite, FakeWebSocket, FakeWebSocketContext, fakeErrors } from "./fakes.js";
import {
    CONTRACT_CHANNEL,
    CONTRACT_CURRENT_REVISION,
    CONTRACT_FULL_REPLAY_LENGTH,
    CONTRACT_SNAPSHOT_REVISION,
    VIEW_STREAM_ATTACHMENT_LIMIT_BYTES,
    VIEW_STREAM_FRAME_KINDS,
    VIEW_STREAM_OPERATIONS,
    VIEW_STREAM_VERSION,
    attachmentBytes,
    contractPayload,
    persistedAttachment,
    viewStreamContract,
    type ViewStreamFailure,
    type ViewStreamImplementation,
    type ViewStreamScenario,
    type ViewStreamSession
} from "./view-stream-contract.js";

/**
 * The `view.stream` contract, run against both implementations the repository admits: a
 * reference frame sink that speaks the declared grammar over an in-memory log, and the
 * real `HibernatingViewSocketAdapter` over `DurableViewRevisionLog`.
 *
 * What is real and what is a double, precisely. Real in the adapter row: every line of
 * `websocket.ts` — the attach-before-accept ordering, the size checks, the persisted
 * attachment decode, the acknowledgement range guard, the write guard, and the frame
 * construction — plus every line of `revision-log.ts` that serves a replay. Doubles: the
 * platform surfaces only — `HibernatingWebSocketLike` and
 * `HibernatingWebSocketContextLike` stand in for a hibernating `WebSocket` and its Durable
 * Object state, and `FakeRuntimeSqlite` for the object's SQLite. Both rows run in the
 * structural lane; the workerd lane's own view-socket coverage lives in
 * `test/cloudflare/worker.ts` and is not what this contract measures.
 *
 * The reference row is the control: it is what the contract would look like if the
 * transport were perfect, so a case only the adapter fails is a fact about the adapter
 * rather than about the suite.
 *
 * `src/websocket.ts` is byte-frozen by the live-evidence manifest and nothing here edits
 * it. Two of the cases below are findings stated as assertions rather than repairs.
 */

/**
 * What a Durable Object's SQLite throws when a read fails: a platform value, and neither
 * `revision-log.ts` nor `websocket.ts` wraps a read, so it reaches the peer-facing seam
 * unclassified.
 */

/** A JSON string is exactly the value that is its own string rendering. */
function isText(value: JsonValue | undefined): value is string {
    return String(value) === value;
}

/** A revision is a safe integer, and narrowing it here is what lets it be read as one. */
function isRevision(value: JsonValue | undefined): value is number {
    return Number.isSafeInteger(value);
}

const STORAGE_FAILURE: unknown = Object.freeze({ storage: "unavailable" });

/** The object's SQLite, armable so a read fails after the log has been built. */
class ContractViewSqlite extends FakeRuntimeSqlite {
    public armed = false;

    public override all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (this.armed) throw STORAGE_FAILURE;
        return super.all(statement, bindings);
    }
}

/**
 * The hibernating socket. `FakeWebSocket` already carries the attachment round-trip and
 * the text-only send discipline `websocket.test.ts` relies on; this adds the write count
 * the contract needs and the three transport failures it declares.
 */
class ContractViewSocket extends FakeWebSocket {
    public writes = 0;
    /** How many sends land before the transport refuses; undefined means all of them do. */
    public sendsBeforeFailure: number | undefined;

    public constructor(
        private readonly failure: ViewStreamFailure | undefined,
        seeded: JsonValue | undefined
    ) {
        super();
        if (seeded !== undefined) this.attachmentValue = seeded;
        if (failure === "send-failed") this.sendsBeforeFailure = 0;
    }

    public override serializeAttachment(value: JsonValue): void {
        if (this.failure === "serialize-failed") {
            throw new TypeError("Cloudflare rejected the attachment");
        }
        this.writes += 1;
        super.serializeAttachment(value);
    }

    public override deserializeAttachment(): JsonValue {
        if (this.failure === "deserialize-failed") {
            throw new TypeError("Cloudflare could not read the attachment back");
        }
        return super.deserializeAttachment();
    }

    public override send(message: string | ArrayBuffer | ArrayBufferView): void {
        if (this.sendsBeforeFailure !== undefined && this.sent.length >= this.sendsBeforeFailure) {
            throw new TypeError("Cloudflare WebSocket send failed");
        }
        super.send(message);
    }
}

/** The Durable Object state that admits a socket into the hibernation protocol. */
class ContractViewContext extends FakeWebSocketContext {
    public readonly observed: JsonValue[] = [];

    public constructor(private readonly failure: ViewStreamFailure | undefined) {
        super();
    }

    public override acceptWebSocket(socket: HibernatingWebSocketLike): void {
        if (this.failure === "accept-failed") {
            throw new TypeError("Cloudflare refused the socket");
        }
        // What the platform could read off the socket at the instant it admitted it. If the
        // cursor is not already there, it never will be.
        this.observed.push(socket.deserializeAttachment());
        super.acceptWebSocket(socket);
    }
}

/**
 * The contract's log: one snapshot at `CONTRACT_SNAPSHOT_REVISION` and a contiguous delta
 * tail up to `CONTRACT_CURRENT_REVISION`. Built through the real `DurableViewRevisionLog`
 * so the adapter row replays what a Durable Object would actually hold, then armed for the
 * `faults` scenario once it is populated.
 */
function contractLog(scenario: ViewStreamScenario): DurableViewRevisionLog {
    const database = new ContractViewSqlite();
    const log = new DurableViewRevisionLog(database, fakeErrors);
    for (let revision = 1; revision <= CONTRACT_SNAPSHOT_REVISION; revision += 1) {
        log.append(CONTRACT_CHANNEL, revision, contractPayload(revision).bytes);
    }
    log.compact(
        CONTRACT_CHANNEL,
        CONTRACT_SNAPSHOT_REVISION,
        contractPayload(CONTRACT_SNAPSHOT_REVISION).bytes
    );
    for (
        let revision = CONTRACT_SNAPSHOT_REVISION + 1;
        revision <= CONTRACT_CURRENT_REVISION;
        revision += 1
    ) {
        log.append(CONTRACT_CHANNEL, revision, contractPayload(revision).bytes);
    }
    database.armed = scenario.kind === "faults";
    return log;
}

/** The real adapter, driven over the platform doubles. */
class AdapterViewStreamSession implements ViewStreamSession {
    readonly #adapter: HibernatingViewSocketAdapter;
    readonly #socket: ContractViewSocket;
    readonly #context: ContractViewContext;

    public constructor(scenario: ViewStreamScenario) {
        const failure = scenario.kind === "refuses" ? scenario.failure : undefined;
        this.#socket = new ContractViewSocket(failure, persistedAttachment(scenario));
        this.#context = new ContractViewContext(failure);
        this.#adapter = new HibernatingViewSocketAdapter(
            this.#context,
            contractLog(scenario),
            fakeErrors
        );
    }

    public open(channel: string, ackedRevision: number): void {
        this.#adapter.accept(this.#socket, channel, ackedRevision);
    }

    public replay(): void {
        this.#adapter.replay(this.#socket);
    }

    public acknowledge(revision: number): void {
        this.#adapter.acknowledge(this.#socket, revision);
    }

    public attachment(): ViewSocketAttachment {
        return this.#adapter.attachment(this.#socket);
    }

    public acceptedWith(): readonly JsonValue[] {
        return this.#context.observed;
    }

    public sent(): readonly string[] {
        return this.#socket.sentText();
    }

    public writes(): number {
        return this.#socket.writes;
    }
}

/**
 * The declared protocol, implemented directly over the contract's fixed log. Every refusal
 * it raises is raised because the condition holds, and its ordering is the ordering the
 * grammar declares rather than the one the adapter happens to have.
 */
class ReferenceViewStreamSession implements ViewStreamSession {
    #attachment: JsonValue = null;
    #writes = 0;
    readonly #observed: JsonValue[] = [];
    readonly #sent: string[] = [];

    public constructor(private readonly scenario: ViewStreamScenario) {
        const seeded = persistedAttachment(scenario);
        if (seeded !== undefined) this.#attachment = seeded;
    }

    public open(channel: string, ackedRevision: number): void {
        if (channel.length === 0) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "WebSocket view channel must be non-empty"
            );
        }
        if (!Number.isSafeInteger(ackedRevision) || ackedRevision < 0) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "WebSocket revision must be a non-negative safe integer"
            );
        }
        const attachment: ViewSocketAttachment = {
            version: VIEW_STREAM_VERSION,
            channel,
            ackedRevision
        };
        if (attachmentBytes(attachment) > VIEW_STREAM_ATTACHMENT_LIMIT_BYTES) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "WebSocket attachment exceeds the platform ceiling"
            );
        }
        // Attach before admitting: a socket admitted without its cursor hibernates and
        // then fails every later message, and nothing can repair it.
        this.store(attachment);
        if (this.failing("accept-failed")) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Cloudflare failed to accept a hibernating WebSocket"
            );
        }
        this.#observed.push(this.#attachment);
        this.replay();
    }

    public replay(): void {
        const attachment = this.read();
        const current = this.current(attachment.channel);
        if (attachment.ackedRevision > current) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Acknowledged revision exceeds the current revision"
            );
        }
        const snapshot =
            attachment.channel === CONTRACT_CHANNEL &&
            CONTRACT_SNAPSHOT_REVISION > attachment.ackedRevision
                ? CONTRACT_SNAPSHOT_REVISION
                : undefined;
        // Snapshot first, then every delta after it in ascending order: a peer that
        // applied a delta before the snapshot it rebases on would corrupt its view.
        if (snapshot !== undefined) this.emit("snapshot", attachment.channel, snapshot);
        for (
            let revision = (snapshot ?? attachment.ackedRevision) + 1;
            revision <= current;
            revision += 1
        ) {
            this.emit("delta", attachment.channel, revision);
        }
    }

    public acknowledge(revision: number): void {
        if (!Number.isSafeInteger(revision) || revision < 0) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "WebSocket revision must be a non-negative safe integer"
            );
        }
        const attachment = this.read();
        const current = this.current(attachment.channel);
        if (revision < attachment.ackedRevision || revision > current) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                `WebSocket acknowledgement ${revision} is outside ${attachment.ackedRevision}..${current}`
            );
        }
        if (revision !== attachment.ackedRevision) {
            this.store({ ...attachment, ackedRevision: revision });
        }
    }

    public attachment(): ViewSocketAttachment {
        return this.read();
    }

    public acceptedWith(): readonly JsonValue[] {
        return this.#observed;
    }

    public sent(): readonly string[] {
        return this.#sent;
    }

    public writes(): number {
        return this.#writes;
    }

    private failing(failure: ViewStreamFailure): boolean {
        return this.scenario.kind === "refuses" && this.scenario.failure === failure;
    }

    private current(channel: string): number {
        if (this.scenario.kind === "faults") throw STORAGE_FAILURE;
        return channel === CONTRACT_CHANNEL ? CONTRACT_CURRENT_REVISION : 0;
    }

    private emit(kind: "snapshot" | "delta", channel: string, revision: number): void {
        const frame: ViewStreamFrame = {
            version: VIEW_STREAM_VERSION,
            kind,
            channel,
            revision,
            payload: contractPayload(revision).text
        };
        if (this.failing("send-failed")) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Cloudflare WebSocket replay send failed"
            );
        }
        this.#sent.push(JSON.stringify(frame));
    }

    private store(attachment: ViewSocketAttachment): void {
        if (attachmentBytes(attachment) > VIEW_STREAM_ATTACHMENT_LIMIT_BYTES) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "WebSocket attachment exceeds the platform ceiling"
            );
        }
        if (this.failing("serialize-failed")) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Cloudflare WebSocket attachment serialization failed"
            );
        }
        this.#writes += 1;
        this.#attachment = attachment;
    }

    private read(): ViewSocketAttachment {
        if (this.failing("deserialize-failed")) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Cloudflare WebSocket attachment deserialization failed"
            );
        }
        const value = this.#attachment;
        if (!isJsonObject(value)) {
            throw new AgentCoreError("codec.invalid", "WebSocket attachment has an invalid shape");
        }
        const version = value["version"];
        const channel = value["channel"];
        const ackedRevision = value["ackedRevision"];
        if (
            version !== VIEW_STREAM_VERSION ||
            !isText(channel) ||
            channel.length === 0 ||
            !isRevision(ackedRevision)
        ) {
            throw new AgentCoreError("codec.invalid", "WebSocket attachment has an invalid shape");
        }
        // The unknown keys survive, exactly as `decodePersistedAttachment` keeps them.
        const attachment: ViewSocketAttachment = { ...value, version, channel, ackedRevision };
        if (attachmentBytes(attachment) > VIEW_STREAM_ATTACHMENT_LIMIT_BYTES) {
            throw new AgentCoreError("codec.invalid", "WebSocket attachment has an invalid shape");
        }
        return attachment;
    }
}

const reference: ViewStreamImplementation = {
    session(scenario): ViewStreamSession {
        return new ReferenceViewStreamSession(scenario);
    }
};

const adapter: ViewStreamImplementation = {
    session(scenario): ViewStreamSession {
        return new AdapterViewStreamSession(scenario);
    }
};

viewStreamContract("reference", reference);
viewStreamContract("HibernatingViewSocketAdapter", adapter);

describe("Cloudflare view stream service protocol", () => {
    test("declares exactly the verbs a peer and the stream exchange", { tags: "p2" }, () => {
        expect([...VIEW_STREAM_OPERATIONS]).toEqual(["acknowledge", "snapshot", "delta"]);
        const offered = Object.getOwnPropertyNames(HibernatingViewSocketAdapter.prototype).filter(
            (name) => name !== "constructor"
        );

        // The peer's one inbound verb is a method it can reach; the two outbound kinds are
        // frame values produced by `accept` and `replay`, which no peer names.
        expect(offered).toContain("acknowledge");
        expect(VIEW_STREAM_FRAME_KINDS.some((kind) => offered.includes(kind))).toBe(false);
        expect(offered.sort()).toEqual([
            "accept",
            "acknowledge",
            "attachment",
            "readAttachment",
            "replay",
            "send",
            "storeAttachment"
        ]);
    });

    test("leaves a partly delivered replay behind when a send fails", { tags: "p1" }, () => {
        // FINDING, not a fix: `replay` sends frame by frame with no journal and no
        // rollback, so a send that fails midway refuses the whole call while the frames
        // before it are already at the peer, and the cursor never moved. Nothing in the
        // grammar lets the peer tell a refused replay from a truncated one.
        const socket = new ContractViewSocket(undefined, undefined);
        const adapterUnderTest = new HibernatingViewSocketAdapter(
            new ContractViewContext(undefined),
            contractLog({ kind: "streams" }),
            fakeErrors
        );
        adapterUnderTest.accept(socket, CONTRACT_CHANNEL, 0);
        expect(socket.sentText()).toHaveLength(CONTRACT_FULL_REPLAY_LENGTH);

        socket.sendsBeforeFailure = socket.sent.length + 1;
        let refused: unknown;
        try {
            adapterUnderTest.replay(socket);
        } catch (error) {
            refused = error;
        }

        expect(refused).toBeInstanceOf(AgentCoreError);
        expect(refused).toMatchObject({ code: "protocol.invalid-state" });
        // One more frame landed before the refusal, and the cursor is untouched.
        expect(socket.sentText()).toHaveLength(CONTRACT_FULL_REPLAY_LENGTH + 1);
        expect(adapterUnderTest.attachment(socket).ackedRevision).toBe(0);
    });

    test("declares a payload string without declaring its encoding", { tags: "p2" }, () => {
        // FINDING, not a fix: `ViewStreamFrame.payload` is a string and
        // `decodeViewStreamFrame` returns it undecoded, so the base64 the adapter writes is
        // knowledge a peer has to hold out of band. The grammar the runtime publishes to
        // untrusted clients does not carry it.
        const socket = new ContractViewSocket(undefined, undefined);
        new HibernatingViewSocketAdapter(
            new ContractViewContext(undefined),
            contractLog({ kind: "streams" }),
            fakeErrors
        ).accept(socket, CONTRACT_CHANNEL, CONTRACT_CURRENT_REVISION - 1);

        const frame = decodeViewStreamFrame(socket.sentTextAt(0));
        expect(typeof frame.payload).toBe("string");
        expect(frame.revision).toBe(CONTRACT_CURRENT_REVISION);
        expect(
            Uint8Array.from(atob(frame.payload), (character) => character.charCodeAt(0))
        ).toEqual(contractPayload(CONTRACT_CURRENT_REVISION).bytes);
    });

    test("names the site of each ceiling refusal the three codes share", { tags: "p2" }, () => {
        // One message, three codes: `requireAttachmentSize` takes its code from the caller,
        // so message plus code is what pins which caller refused. This is the evidence for
        // the `attachment-oversized-write` row of the taxonomy, whose caller is the private
        // `storeAttachment` and is otherwise indistinguishable from the other two.
        const message = `Cloudflare WebSocket attachment exceeds ${VIEW_STREAM_ATTACHMENT_LIMIT_BYTES} bytes`;

        const wrote = refused(() => {
            adapter
                .session({ kind: "refuses", failure: "attachment-oversized-write" })
                .acknowledge(CONTRACT_CURRENT_REVISION);
        });
        expect(wrote.code).toBe("protocol.invalid-state");
        expect(wrote.message).toBe(message);

        const read = refused(() => {
            adapter
                .session({ kind: "refuses", failure: "attachment-oversized-persisted" })
                .attachment();
        });
        expect(read.code).toBe("codec.invalid");
        expect(read.message).toBe(message);

        const opened = refused(() => {
            adapter
                .session({ kind: "streams" })
                .open("c".repeat(VIEW_STREAM_ATTACHMENT_LIMIT_BYTES), 0);
        });
        expect(opened.code).toBe("operation.invalid-input");
        expect(opened.message).toBe(message);
    });
});

/** The refusal one act produces, as the failure it was raised as. */
function refused(act: () => void): AgentCoreError {
    try {
        act();
    } catch (error) {
        if (error instanceof AgentCoreError) return error;
        throw error;
    }
    throw new TypeError("Expected the view stream to refuse");
}
