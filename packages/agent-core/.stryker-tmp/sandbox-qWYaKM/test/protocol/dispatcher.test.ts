// @ts-nocheck
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ActorCommitUnknownError } from "../../src/actors";
import { Digest, encodeBase64 } from "../../src/core";
import {
    CommandCommitUnknownError,
    CommandPreparationUnavailableError
} from "../../src/protocol/dispatcher";
import { CommandEnvelopeCodec } from "../../src/protocol/envelope";
import {
    CommandPayloadMalformedError,
    PayloadLeaseBinding,
    issueLeasedCommandPayload
} from "../../src/protocol/payload";
import { WriteRecordCodec, type CommandOutcome } from "../../src/protocol/write";
import { FileSqlite } from "../helpers/sqlite";
import { CounterAuthenticator, CounterHarness } from "./counter-fixture";
import { counterDispatcherContract } from "./dispatcher-contract";
import { expectAgentCoreErrorValue } from "./error-assertion";
import { SqliteCounterHarness } from "./sqlite-counter-fixture";

counterDispatcherContract("memory", (options) => new CounterHarness(options));
counterDispatcherContract("SQLite", (options) => new SqliteCounterHarness(options));

test("rejects a local store without Actor activation capability", () => {
    expect(() => new CounterHarness({ activatingStore: false })).toThrow(TypeError);
});

test("protocol dependency errors retain stable defaults", () => {
    expect(new CommandCommitUnknownError()).toMatchObject({
        code: "actor.closed",
        retrySameKey: false,
        message: "The command transaction commit result is unknown"
    });
    expect(new CommandCommitUnknownError()).toBeInstanceOf(ActorCommitUnknownError);
    expect(new CommandPreparationUnavailableError()).toMatchObject({
        code: "protocol.invalid-state",
        message: "Prepared command content is unavailable"
    });
    expect(new CommandPayloadMalformedError()).toMatchObject({
        code: "protocol.invalid-envelope",
        message: "Command payload is malformed"
    });
});

test("canonical unknown commit poisons direct and already queued dispatcher work", async () => {
    const harness = new CounterHarness();
    const raw = harness.envelope({ key: "direct-queued-unknown" });
    const envelope = CommandEnvelopeCodec.decode(raw);
    const authentication = await new CounterAuthenticator(harness.tenant).authenticate(
        harness.caller,
        envelope,
        Digest.sha256(raw)
    );
    const admissions = await Promise.all([
        harness.dispatcher.admit(raw, authentication),
        harness.dispatcher.admit(raw, authentication)
    ]);
    const binding = new PayloadLeaseBinding(
        harness.tenant,
        harness.actor,
        Digest.sha256(raw),
        envelope.payload,
        envelope.payloadDigest,
        new Date(CounterHarness.now.getTime() + 60_000)
    );
    const leases = await Promise.all([
        harness.content.acquire(binding),
        harness.content.acquire(binding)
    ]);
    if (
        admissions.some((admission) => admission.kind !== "prepare") ||
        leases.some((lease) => lease === undefined)
    ) {
        throw new TypeError("Expected prepared direct dispatcher fixtures");
    }
    const prepared = leases.map((lease) => issueLeasedCommandPayload(lease!, binding));
    harness.setFault("unknownAck");

    const results = await Promise.allSettled([
        admissions[0]!.kind === "prepare" && admissions[0]!.dispatch(prepared[0]!),
        admissions[1]!.kind === "prepare" && admissions[1]!.dispatch(prepared[1]!)
    ]);

    expect(results[0]).toMatchObject({
        status: "rejected",
        reason: expect.any(CommandCommitUnknownError)
    });
    expect(results[1]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ code: "actor.closed" })
    });
    await expect(harness.dispatcher.admit(raw, authentication)).rejects.toMatchObject({
        code: "actor.closed"
    });
    await Promise.all(leases.map((lease) => lease?.close()));
});

test("[C13-PROTOCOL-DUPLICATE] rejects a forged prepared payload without running command mutation", async () => {
    const harness = new CounterHarness();
    const raw = harness.envelope({ key: "forged-prepared-payload" });
    const envelope = CommandEnvelopeCodec.decode(raw);
    const authentication = await new CounterAuthenticator(harness.tenant).authenticate(
        harness.caller,
        envelope,
        Digest.sha256(raw)
    );
    const admission = await harness.dispatcher.admit(raw, authentication);
    if (admission.kind !== "prepare") throw new TypeError("Expected command preparation");

    const result = await admission.dispatch({} as never);

    expect(result.outcome).toBe("rejectedMalformed");
    expect(harness.snapshot()).toMatchObject({ value: 0, identityCount: 1 });
});

test.each([
    ["empty", { commandName: "" }],
    ["duplicate", { duplicateCommand: true }]
] as const)("rejects %s registered command names", (_case, options) => {
    expect(() => new CounterHarness(options)).toThrow("non-empty and unique");
});

test.each([
    ["envelope", { envelopeBytes: 0, payloadBytes: 1024 }],
    ["payload", { envelopeBytes: 4096, payloadBytes: 1.5 }]
] as const)("rejects invalid %s byte limits", (_case, limits) => {
    expect(() => new CounterHarness({ limits })).toThrow("positive safe integer");
});

test("supports the default clock and rolls back an invalid injected timestamp", async () => {
    const defaultClock = new CounterHarness({ useDefaultNow: true });
    expect(
        (await defaultClock.dispatch(defaultClock.envelope({ key: "default-clock" }))).outcome
    ).toBe("committed");

    const invalidClock = new CounterHarness({ now: () => new Date(NaN) });
    const invalid = await invalidClock.accept(invalidClock.envelope({ key: "invalid-clock" }));
    expect(invalid).toMatchObject({
        kind: "preDispatchFailure",
        phase: "dispatch",
        commit: "rolledBack",
        cause: expect.objectContaining({ message: "Command timestamp must be valid" })
    });
    if (invalid.kind === "preDispatchFailure") {
        expectAgentCoreErrorValue(invalid.cause, "protocol.invalid-state");
    }
});

test("fails closed when an appended invocation audit is unreadable", async () => {
    const harness = new CounterHarness();
    harness.setFault("unreadableInvocationAudit");

    const result = await harness.accept(harness.envelope({ key: "unreadable-audit" }));

    expect(result).toMatchObject({
        kind: "preDispatchFailure",
        phase: "dispatch",
        commit: "rolledBack"
    });
    if (result.kind === "preDispatchFailure") {
        expectAgentCoreErrorValue(result.cause, "protocol.invalid-state");
    }
    expect(harness.snapshot()).toMatchObject({ value: 0, writes: [] });
});

test("[C13-PROTOCOL-OUTCOMES] [actor-local-store] [protocol-persistence] memory and SQLite Actor/protocol persistence compositions expose identical outcomes", async () => {
    const memory = new CounterHarness();
    const sqlite = new SqliteCounterHarness();
    const memoryRaw = memory.envelope({ key: "parity", amount: 4 });
    const sqliteRaw = sqlite.envelope({ key: "parity", amount: 4 });

    const memoryCommitted = await memory.dispatch(memoryRaw);
    const sqliteCommitted = await sqlite.dispatch(sqliteRaw);
    const memoryDuplicate = await memory.dispatch(memoryRaw);
    const sqliteDuplicate = await sqlite.dispatch(sqliteRaw);

    expect(sqliteCommitted).toEqual(memoryCommitted);
    expect(sqliteDuplicate).toEqual(memoryDuplicate);
    expect(sqlite.snapshot()).toEqual(memory.snapshot());
});

test("SQLite restart fences a callback prepared by the prior dispatcher", async () => {
    const original = new SqliteCounterHarness();
    const raw = original.envelope({ key: "stale-prepared" });
    const barrier = original.pauseNextPayloadGet();
    const pending = original.accept(raw);
    await barrier.started;
    const restarted = original.restart();
    await restarted.dispatch(Uint8Array.of(0xff));
    barrier.release();

    const stale = await pending;

    expect(stale.kind).toBe("preDispatchFailure");
    if (stale.kind !== "preDispatchFailure") throw new TypeError("Expected stale callback failure");
    expect(stale).toMatchObject({ phase: "dispatch", commit: "rolledBack" });
    expect(stale.cause).toMatchObject({ code: "actor.stale-callback" });
});

test("SQLite restart fences the prior dispatcher even when its first command rolls back", async () => {
    const original = new SqliteCounterHarness();
    await original.dispatch(original.envelope({ key: "before-restart" }));
    original.setFault("writeRecord");
    const restarted = original.restart();

    const failed = await restarted.accept(restarted.envelope({ key: "failed-after-restart" }));
    expect(failed).toMatchObject({
        kind: "preDispatchFailure",
        phase: "dispatch",
        commit: "rolledBack"
    });
    restarted.setFault(undefined);
    const stale = await original.accept(original.envelope({ key: "old-dispatcher" }));

    expect(stale).toMatchObject({
        kind: "preDispatchFailure",
        phase: "admissionPreflight",
        commit: "rolledBack"
    });
    if (stale.kind !== "preDispatchFailure") throw new TypeError("Expected stale dispatcher");
    expect(stale.cause).toMatchObject({ code: "actor.stale-callback" });
});

test("file-backed SQLite reconciles unknown acknowledgement after full composition restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-core-dispatcher-restart-"));
    const path = join(directory, "dispatcher.sqlite");
    let database: FileSqlite | undefined;
    try {
        const memory = new CounterHarness();
        const memoryRaw = memory.envelope({ key: "file-restart-unknown", amount: 2 });
        memory.setFault("unknownAck");
        const memoryUnknown = await memory.accept(memoryRaw);
        expect(memoryUnknown).toMatchObject({
            kind: "preDispatchFailure",
            phase: "dispatch",
            commit: "unknown",
            retry: "retrySameKey"
        });
        const restartedMemory = memory.restart();
        restartedMemory.setFault(undefined);
        const memoryDuplicate = await restartedMemory.dispatch(memoryRaw);

        database = new FileSqlite(path);
        const sqlite = new SqliteCounterHarness({}, database);
        const sqliteRaw = sqlite.envelope({ key: "file-restart-unknown", amount: 2 });
        sqlite.setFault("unknownAck");
        const sqliteUnknown = await sqlite.accept(sqliteRaw);
        expect(sqliteUnknown).toMatchObject({
            kind: "preDispatchFailure",
            phase: "dispatch",
            commit: "unknown",
            retry: "retrySameKey"
        });
        database.close();
        database = undefined;
        database = new FileSqlite(path);
        const restartedSqlite = new SqliteCounterHarness({}, database);
        restartedSqlite.setFault(undefined);
        const sqliteDuplicate = await restartedSqlite.dispatch(sqliteRaw);

        expect(sqliteDuplicate).toEqual(memoryDuplicate);
        expect(restartedSqlite.snapshot()).toEqual(restartedMemory.snapshot());
        expect(restartedSqlite.snapshot()).toMatchObject({ value: 2, identityCount: 1 });
        expect(restartedSqlite.snapshot().writes.map((write) => write.outcome)).toEqual([
            "committed",
            "duplicate"
        ]);
    } finally {
        database?.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test.each([
    ["invalid padding", "A==="],
    ["non-canonical trailing bits", "AB=="]
])("rejects %s in persisted reply base64", async (_case, reply) => {
    const harness = new CounterHarness();
    const write = (await harness.dispatch(harness.envelope())).write;
    const encoded = new TextDecoder().decode(WriteRecordCodec.encode(write));
    const canonicalReply = encodeBase64(write.reply);
    const malformed = new TextEncoder().encode(
        encoded.replace(`"reply":"${canonicalReply}"`, `"reply":"${reply}"`)
    );

    expect(() => WriteRecordCodec.decode(malformed)).toThrow(/canonical RFC 4648/);
});

const commandOutcomes: Record<CommandOutcome, true> = {
    committed: true,
    rejectedMalformed: true,
    rejectedAuthentication: true,
    rejectedAuthority: true,
    rejectedLifecycle: true,
    rejectedRevision: true,
    rejectedLease: true,
    duplicate: true
};

void commandOutcomes;
