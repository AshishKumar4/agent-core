import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
    ActorCommitUnknownError,
    ActorId,
    ActorRef,
    MemoryActorStore
} from "../../src/actors";
import {
    ContentRef,
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeBase64,
    encodeCanonicalJson
} from "../../src/core";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { CommandAuthenticator } from "../../src/protocol/authentication";
import {
    CommandCommitUnknownError,
    CommandDispatcher,
    CommandPreparationUnavailableError,
    type CommandDispatcherInit,
    type ProtocolPersistence
} from "../../src/protocol/dispatcher";
import {
    CommandEnvelope,
    CommandEnvelopeCodec,
    type CommandCaller
} from "../../src/protocol/envelope";
import { MemoryProtocolPersistence, MemoryProtocolRecords } from "../../src/protocol/memory";
import {
    CommandPayloadMalformedError,
    PayloadLeaseBinding,
    issueLeasedCommandPayload,
    issueMalformedCommandPayload,
    type PreparedCommandPayload
} from "../../src/protocol/payload";
import { CommandCallerPolicy } from "../../src/protocol/policy";
import type { ProtocolCommand } from "../../src/protocol/registration";
import { WriteRecordCodec, type CommandOutcome } from "../../src/protocol/write";
import { FileSqlite } from "../helpers/sqlite";
import {
    CounterAuthenticator,
    CounterContentStore,
    CounterHarness,
    CounterIds
} from "./counter-fixture";
import { counterDispatcherContract } from "./dispatcher-contract";
import { expectAgentCoreErrorValue } from "./error-assertion";
import { SqliteCounterHarness } from "./sqlite-counter-fixture";

counterDispatcherContract("memory", (options) => new CounterHarness(options));
counterDispatcherContract("SQLite", (options) => new SqliteCounterHarness(options));

test("rejects a local store without Actor activation capability", { tags: "p0" }, () => {
    expect(() => new CounterHarness({ activatingStore: false })).toThrow(TypeError);
});

test("protocol dependency errors retain stable defaults", { tags: "p1" }, () => {
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

test("canonical unknown commit poisons direct and already queued dispatcher work", { tags: "p0" }, async () => {
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

test("[C13-PROTOCOL-DUPLICATE] rejects a forged prepared payload without running command mutation", { tags: "p0" }, async () => {
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

    const result = await admission.dispatch(forgedPreparedPayload({}));

    expect(result.outcome).toBe("rejectedMalformed");
    expect(harness.snapshot()).toMatchObject({ value: 0, identityCount: 1 });
});

test.each([
    ["empty", { commandName: "" }],
    ["duplicate", { duplicateCommand: true }]
] as const)("rejects %s registered command names", { tags: "p1" }, (_case, options) => {
    expect(() => new CounterHarness(options)).toThrow("non-empty and unique");
});

test.each([
    ["envelope", { envelopeBytes: 0, payloadBytes: 1024 }],
    ["payload", { envelopeBytes: 4096, payloadBytes: 1.5 }]
] as const)("rejects invalid %s byte limits", { tags: "p1" }, (_case, limits) => {
    expect(() => new CounterHarness({ limits })).toThrow("positive safe integer");
});

test("supports the default clock and rolls back an invalid injected timestamp", { tags: "p1" }, async () => {
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

test("fails closed when an appended invocation audit is unreadable", { tags: "p0" }, async () => {
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

test("[C13-PROTOCOL-OUTCOMES] [actor-local-store] [protocol-persistence] memory and SQLite Actor/protocol persistence compositions expose identical outcomes", { tags: "p1" }, async () => {
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

test("SQLite restart fences a callback prepared by the prior dispatcher", { tags: "p0" }, async () => {
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

test("SQLite restart fences the prior dispatcher even when its first command rolls back", { tags: "p0" }, async () => {
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

test("file-backed SQLite reconciles unknown acknowledgement after full composition restart", { tags: "p0" }, async () => {
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
])("rejects %s in persisted reply base64", { tags: "p0" }, async (_case, reply) => {
    const harness = new CounterHarness();
    const write = (await harness.dispatch(harness.envelope())).write;
    const encoded = new TextDecoder().decode(WriteRecordCodec.encode(write));
    const canonicalReply = encodeBase64(write.reply);
    const malformed = new TextEncoder().encode(
        encoded.replace(`"reply":"${canonicalReply}"`, `"reply":"${reply}"`)
    );

    expect(() => WriteRecordCodec.decode(malformed)).toThrow(/canonical RFC 4648/);
});

test("admits envelopes and payloads exactly at their byte limits", { tags: "p0" }, async () => {
    const probe = new CounterHarness();
    const probeRaw = probe.envelope({ key: "exact-limits-a" });
    const payload = probe.payloadBytes();
    const harness = new CounterHarness({
        limits: { envelopeBytes: probeRaw.byteLength, payloadBytes: payload.byteLength }
    });

    const submittedRaw = harness.envelope({ key: "exact-limits-a" });
    expect(submittedRaw.byteLength).toBe(probeRaw.byteLength);
    const submitted = await harness.dispatch(submittedRaw, harness.caller, harness.payloadBytes());
    expect(submitted.outcome).toBe("committed");

    const stored = await harness.dispatch(harness.envelope({ key: "exact-limits-b" }));
    expect(stored.outcome).toBe("committed");
    expect(harness.snapshot().value).toBe(2);
});

test("rejects a lease expiring exactly at the decision time", { tags: "p0" }, async () => {
    const harness = new CounterHarness({ lease: "required" });
    const boundary = harness.setLease({ expiresAt: CounterHarness.now });

    expect(
        (await harness.dispatch(harness.envelope({ key: "lease-boundary", lease: boundary })))
            .outcome
    ).toBe("rejectedLease");

    const live = harness.setLease({ expiresAt: new Date(CounterHarness.now.getTime() + 1000) });
    expect(
        (await harness.dispatch(harness.envelope({ key: "lease-live", lease: live }))).outcome
    ).toBe("committed");
});

test("protocol dependency errors expose canonical own properties", { tags: "p1" }, () => {
    const unknown = new CommandCommitUnknownError("commit fate unknown", true);
    expect(unknown.name).toBe("CommandCommitUnknownError");
    expect(Object.getOwnPropertyDescriptor(unknown, "name")).toMatchObject({
        configurable: true,
        value: "CommandCommitUnknownError"
    });
    expect(Object.getOwnPropertyDescriptor(unknown, "retrySameKey")).toMatchObject({
        enumerable: true,
        value: true
    });
    expect(new CommandPreparationUnavailableError().name).toBe(
        "CommandPreparationUnavailableError"
    );
});

test("[C13-ADV-COMMAND-REJECTIONS] byte limit validation names the failing limit exactly", { tags: "p1" }, () => {
    expect(() => new CounterHarness({ limits: { envelopeBytes: 0, payloadBytes: 1024 } })).toThrow(
        "Command envelope byte limit must be a positive safe integer"
    );
    expect(
        () => new CounterHarness({ limits: { envelopeBytes: 4096, payloadBytes: 1.5 } })
    ).toThrow("Command payload byte limit must be a positive safe integer");
});

test("admit detaches the raw envelope before prepared dispatch", { tags: "p0" }, async () => {
    const harness = new CounterHarness();
    const raw = harness.envelope({ key: "detached-admit", amount: 2 });
    const envelope = CommandEnvelopeCodec.decode(raw);
    const authentication = await new CounterAuthenticator(harness.tenant).authenticate(
        harness.caller,
        envelope,
        Digest.sha256(raw)
    );
    const admission = await harness.dispatcher.admit(raw, authentication);
    if (admission.kind !== "prepare") throw new TypeError("Expected command preparation");
    const binding = new PayloadLeaseBinding(
        harness.tenant,
        harness.actor,
        Digest.sha256(raw),
        envelope.payload,
        envelope.payloadDigest,
        new Date(CounterHarness.now.getTime() + 60_000)
    );
    const lease = await harness.content.acquire(binding);
    if (lease === undefined) throw new TypeError("Expected a payload lease");
    raw.fill(0);

    const result = await admission.dispatch(issueLeasedCommandPayload(lease, binding));

    expect(result.outcome).toBe("committed");
    expect(harness.snapshot().value).toBe(2);
    await lease.close();
});

test("typed codec omissions surface exact preparation faults", { tags: "p1" }, async () => {
    const missingReply = new CounterHarness({ typedExecution: true, includeReplyCodec: false });
    const replyFailure = await missingReply.accept(
        missingReply.envelope({ key: "missing-reply-codec-message" })
    );
    if (replyFailure.kind !== "preDispatchFailure") {
        throw new TypeError("Expected a reply codec preparation failure");
    }
    expect(replyFailure.cause).toBeInstanceOf(TypeError);
    expect(replyFailure.cause).toMatchObject({
        message: "Typed command execution requires a reply codec"
    });

    const missingObservation = new CounterHarness({
        typedExecution: true,
        includeObservationCodec: false
    });
    const observationFailure = await missingObservation.accept(
        missingObservation.envelope({ key: "missing-observation-codec-message" })
    );
    if (observationFailure.kind !== "preDispatchFailure") {
        throw new TypeError("Expected an observation codec preparation failure");
    }
    expect(observationFailure.cause).toBeInstanceOf(TypeError);
    expect(observationFailure.cause).toMatchObject({
        message: "Typed command observation requires an observation codec"
    });
});

test("caller causes attach to committed and duplicate writes", { tags: "p0" }, async () => {
    const harness = new CounterHarness();
    const cause = harness.seedInvocationCause("direct-cause");

    const committed = await harness.dispatch(
        harness.envelope({ key: "direct-cause-key", callerCause: cause.id })
    );
    const afterCommit = harness.snapshot();
    expect(committed.outcome).toBe("committed");
    expect(afterCommit.audits.size).toBe(2);
    expect(afterCommit.audits.get(committed.write.audit.value)?.cause?.equals(cause.id)).toBe(
        true
    );

    const duplicate = await harness.dispatch(
        harness.envelope({ key: "direct-cause-key", callerCause: cause.id })
    );
    const afterDuplicate = harness.snapshot();
    expect(duplicate.outcome).toBe("duplicate");
    expect(afterDuplicate.audits.get(duplicate.write.audit.value)?.cause?.equals(cause.id)).toBe(
        true
    );
    expect(afterDuplicate.audits.size).toBe(3);
});

test("a write-kind caller cause is rejected before mutation", { tags: "p1" }, async () => {
    const harness = new CounterHarness();
    const source = await harness.dispatch(harness.envelope({ key: "write-cause-source" }));

    const rejected = await harness.dispatch(
        harness.envelope({ key: "write-cause-target", callerCause: source.write.audit })
    );

    expect(rejected.outcome).toBe("rejectedMalformed");
    expect(harness.snapshot().value).toBe(1);
});

test("[C13-ADV-COMMAND-REJECTIONS] rejects an envelope beyond the configured byte limit", { tags: "p0" }, async () => {
    const harness = new CounterHarness({ limits: { envelopeBytes: 32, payloadBytes: 1024 } });

    const result = await harness.dispatch(harness.envelope({ key: "oversized-envelope" }));

    expect(result.outcome).toBe("rejectedMalformed");
    expect(result.write.command).toBeUndefined();
    expect(result.write.caller).toBeUndefined();
    expect(harness.snapshot().value).toBe(0);
});

test("rejects a leased payload beyond the configured byte limit", { tags: "p0" }, async () => {
    const harness = new CounterHarness({ limits: { envelopeBytes: 4096, payloadBytes: 4 } });

    const result = await harness.dispatch(harness.envelope({ key: "oversized-payload" }));

    expect(result.outcome).toBe("rejectedMalformed");
    expect(harness.snapshot()).toMatchObject({ value: 0, contentGets: 1 });
});

test("rejects leased payload bytes that do not hash to the envelope digest", { tags: "p0" }, async () => {
    const harness = new CounterHarness();
    const raw = harness.envelope({ key: "substituted-payload", amount: 2 });
    harness.installPayload(
        CommandEnvelopeCodec.decode(raw).payload.value,
        harness.payloadBytes(9)
    );

    const result = await harness.dispatch(raw);

    expect(result.outcome).toBe("rejectedMalformed");
    expect(harness.snapshot().value).toBe(0);
});

test("rejects a payload reference that disagrees with the payload digest", { tags: "p0" }, async () => {
    const harness = new CounterHarness();
    const payload = harness.payloadBytes(3);
    const payloadDigest = Digest.sha256(payload);
    const reference = ContentRef.fromDigest(Digest.sha256(harness.payloadBytes(4)));
    const raw = CommandEnvelopeCodec.encode(
        new CommandEnvelope({
            command: "counter.increment",
            caller: harness.caller,
            idempotencyKey: "reference-mismatch",
            expectedRevision: harness.snapshot().revision,
            payload: reference,
            payloadDigest
        })
    );
    harness.installPayload(reference.value, payload);
    const authentication = await new CounterAuthenticator(harness.tenant).authenticate(
        harness.caller,
        CommandEnvelopeCodec.decode(raw),
        Digest.sha256(raw)
    );
    const admission = await harness.dispatcher.admit(raw, authentication);
    if (admission.kind !== "prepare") throw new TypeError("Expected command preparation");
    const binding = new PayloadLeaseBinding(
        harness.tenant,
        harness.actor,
        Digest.sha256(raw),
        reference,
        payloadDigest,
        new Date(CounterHarness.now.getTime() + 60_000)
    );
    const lease = await harness.content.acquire(binding);
    if (lease === undefined) throw new TypeError("Expected a payload lease");

    const result = await admission.dispatch(issueLeasedCommandPayload(lease, binding));

    expect(result.outcome).toBe("rejectedMalformed");
    expect(harness.snapshot().value).toBe(0);
    await lease.close();
});

test("unregistered commands reserve their identity without a caller cause", { tags: "p0" }, async () => {
    const harness = new CounterHarness({ commandName: "counter.other" });
    const cause = harness.seedInvocationCause("unregistered-cause");

    const rejected = await harness.dispatch(
        harness.envelope({ key: "unregistered", callerCause: cause.id })
    );
    expect(rejected.outcome).toBe("rejectedMalformed");
    expect(harness.snapshot().audits.get(rejected.write.audit.value)?.cause).toBeUndefined();

    const replay = await harness.dispatch(
        harness.envelope({ key: "unregistered", callerCause: cause.id })
    );
    expect(replay.outcome).toBe("duplicate");
    expect(replay.write.duplicateOf?.equals(rejected.write.id)).toBe(true);
});

test("malformed payloads keep exactly their own caller cause", { tags: "p0" }, async () => {
    const harness = new CounterHarness();
    const cause = harness.seedInvocationCause("malformed-payload-cause");

    const caused = harness.envelope({ key: "malformed-caused", callerCause: cause.id });
    harness.removePayload(CommandEnvelopeCodec.decode(caused).payload.value);
    const withCause = await harness.dispatch(caused);
    expect(withCause.outcome).toBe("rejectedMalformed");
    expect(
        harness.snapshot().audits.get(withCause.write.audit.value)?.cause?.equals(cause.id)
    ).toBe(true);

    const bare = harness.envelope({ key: "malformed-bare" });
    harness.removePayload(CommandEnvelopeCodec.decode(bare).payload.value);
    const withoutCause = await harness.dispatch(bare);
    expect(withoutCause.outcome).toBe("rejectedMalformed");
    expect(harness.snapshot().audits.get(withoutCause.write.audit.value)?.cause).toBeUndefined();
});

test("rejected outcomes reply with their canonical outcome document", { tags: "p1" }, async () => {
    const harness = new CounterHarness();
    harness.setAuthorized(false);

    const result = await harness.dispatch(harness.envelope({ key: "rejected-reply" }));

    expect(result.outcome).toBe("rejectedAuthority");
    expect(decodeCanonicalJson(result.reply)).toEqual({ outcome: "rejectedAuthority" });
    expect(decodeCanonicalJson(result.write.reply)).toEqual({ outcome: "rejectedAuthority" });
});

test("typed executions attach caller causes with and without observations", { tags: "p0" }, async () => {
    const observed = new CounterHarness({ typedExecution: true });
    const observedCause = observed.seedInvocationCause("typed-observed-cause");
    const withObservation = await observed.dispatch(
        observed.envelope({ key: "typed-observed", callerCause: observedCause.id })
    );
    expect(withObservation.outcome).toBe("committed");
    expect(withObservation.observation).toBeDefined();
    expect(
        observed.snapshot().audits.get(withObservation.write.audit.value)?.cause?.equals(
            observedCause.id
        )
    ).toBe(true);

    const plain = new CounterHarness({ typedExecution: true, typedObservation: false });
    const plainCause = plain.seedInvocationCause("typed-plain-cause");
    const withoutObservation = await plain.dispatch(
        plain.envelope({ key: "typed-plain", callerCause: plainCause.id })
    );
    expect(withoutObservation.outcome).toBe("committed");
    expect(withoutObservation.observation).toBeUndefined();
    expect(
        plain.snapshot().audits.get(withoutObservation.write.audit.value)?.cause?.equals(
            plainCause.id
        )
    ).toBe(true);
});

test("a cause-free rejected write audit cannot become a caller cause", { tags: "p0" }, async () => {
    const harness = new CounterHarness();
    harness.setAuthorized(false);
    const source = await harness.dispatch(harness.envelope({ key: "rejected-cause-source" }));
    expect(source.outcome).toBe("rejectedAuthority");
    expect(harness.snapshot().audits.get(source.write.audit.value)?.cause).toBeUndefined();
    harness.setAuthorized(true);

    const result = await harness.dispatch(
        harness.envelope({ key: "rejected-cause-target", callerCause: source.write.audit })
    );

    expect(result.outcome).toBe("rejectedMalformed");
    expect(harness.snapshot().value).toBe(0);
});

test("leases without a current holder, expiry, or record are fenced", { tags: "p0" }, async () => {
    const holderless = new CounterHarness({ lease: "required" });
    const holderlessToken = holderless.setPartialLease({ holder: true });
    expect(
        (
            await holderless.dispatch(
                holderless.envelope({ key: "lease-holderless", lease: holderlessToken })
            )
        ).outcome
    ).toBe("rejectedLease");

    const expiryless = new CounterHarness({ lease: "required" });
    const expirylessToken = expiryless.setPartialLease({ expiresAt: true });
    expect(
        (
            await expiryless.dispatch(
                expiryless.envelope({ key: "lease-expiryless", lease: expirylessToken })
            )
        ).outcome
    ).toBe("rejectedLease");

    const unheld = new CounterHarness({ lease: "required" });
    const foreignToken = new CounterHarness({ lease: "required" }).setLease();
    expect(
        (await unheld.dispatch(unheld.envelope({ key: "lease-unheld", lease: foreignToken })))
            .outcome
    ).toBe("rejectedLease");
});

test("forged commit uncertainty inside a transaction is refused exactly", { tags: "p0" }, async () => {
    const harness = new CounterHarness();
    harness.setFault("forgedUnknown");

    const result = await harness.accept(harness.envelope({ key: "forged-unknown" }));

    expect(result).toMatchObject({
        kind: "preDispatchFailure",
        phase: "dispatch",
        commit: "rolledBack"
    });
    if (result.kind !== "preDispatchFailure") throw new TypeError("Expected a forged failure");
    expectAgentCoreErrorValue(result.cause, "protocol.invalid-state");
    expect(result.cause).toMatchObject({
        message: "Commit uncertainty cannot originate inside an Actor transaction"
    });
});

test("protocol persistence repair runs on Actor activation", { tags: "p0" }, async () => {
    const harness = new CounterHarness();
    const committed = await harness.dispatch(harness.envelope({ key: "repair-on-activation" }));
    harness.corruptRemoveAudit(committed.write.audit);

    expect(() => harness.restart()).toThrow("Write record points to a missing audit record");
});

test("dispatchers admit a persistence without a repair hook", { tags: "p1" }, async () => {
    const records = new MemoryProtocolRecords();
    const adapter = new MemoryProtocolPersistence<ProbeState>((state) => state.records);
    const withoutRepair: ProtocolPersistence<ProbeState> = {
        findWrite: (transaction, identity) => adapter.findWrite(transaction, identity),
        findAudit: (transaction, id) => adapter.findAudit(transaction, id),
        appendAudit: (transaction, record, context) =>
            adapter.appendAudit(transaction, record, context),
        appendWrite: (transaction, record) => adapter.appendWrite(transaction, record)
    };
    const dispatcher = new CommandDispatcher(
        probeDispatcherInit({ records, persistence: withoutRepair })
    );

    const admission = await dispatcher.admit(Uint8Array.of(0xff), undefined);

    expect(admission.kind).toBe("completed");
    if (admission.kind !== "completed") throw new TypeError("Expected a completed admission");
    expect(admission.result.outcome).toBe("rejectedMalformed");
});

test("dispatchers require an Actor activation store exactly", { tags: "p0" }, () => {
    const invalidStores: readonly unknown[] = [
        null,
        undefined,
        "store",
        42,
        {},
        { activateActor: 1 }
    ];

    for (const store of invalidStores) {
        expect(
            () =>
                new CommandDispatcher(
                    probeDispatcherInitOver(
                        new MemoryProtocolRecords(),
                        forgedActorStore(store)
                    )
                )
        ).toThrow(new TypeError("Command dispatcher requires an Actor activation store"));
    }
});

test("typed executions must be objects that carry a reply", { tags: "p1" }, async () => {
    for (const execution of [null, 42] as const) {
        const records = new MemoryProtocolRecords();
        const dispatcher = new CommandDispatcher(
            probeDispatcherInit({ records, execution: forgedExecution(execution) })
        );
        const content = new CounterContentStore(() => undefined);
        const payload = encodeCanonicalJson({ probe: true });
        const payloadDigest = Digest.sha256(payload);
        const reference = ContentRef.fromDigest(payloadDigest);
        content.install(reference.value, payload);
        const raw = CommandEnvelopeCodec.encode(
            new CommandEnvelope({
                command: "probe.command",
                caller: probeCaller,
                idempotencyKey: `probe-${String(execution)}`,
                payload: reference,
                payloadDigest
            })
        );
        const authentication = await new ProbeAuthenticator().authenticate(
            probeCaller,
            CommandEnvelopeCodec.decode(raw),
            Digest.sha256(raw)
        );
        const admission = await dispatcher.admit(raw, authentication);
        if (admission.kind !== "prepare") throw new TypeError("Expected command preparation");
        const binding = new PayloadLeaseBinding(
            probeTenant,
            probeActor,
            Digest.sha256(raw),
            reference,
            payloadDigest,
            new Date(CounterHarness.now.getTime() + 60_000)
        );
        const lease = await content.acquire(binding);
        if (lease === undefined) throw new TypeError("Expected a payload lease");

        await expect(
            admission.dispatch(issueLeasedCommandPayload(lease, binding))
        ).rejects.toThrow(new TypeError("Typed command execution requires a reply codec"));
        await lease.close();
    }
});

test("caller revocation between admission and prepared dispatch rejects without replay", { tags: "p0" }, async () => {
    const policy = new RevocableCallerPolicy();
    const harness = new CounterHarness({ caller: policy });
    const raw = harness.envelope({ key: "revoked-caller" });
    const authentication = await new CounterAuthenticator(harness.tenant).authenticate(
        harness.caller,
        CommandEnvelopeCodec.decode(raw),
        Digest.sha256(raw)
    );
    const admission = await harness.dispatcher.admit(raw, authentication);
    if (admission.kind !== "prepare") throw new TypeError("Expected command preparation");
    const committed = await harness.dispatch(raw);
    expect(committed.outcome).toBe("committed");
    policy.revoke();

    const result = await admission.dispatch(issueMalformedCommandPayload("absent"));

    expect(result.outcome).toBe("rejectedAuthentication");
    expect(result.write.idempotencyKey).toBeUndefined();
    expect(harness.snapshot().value).toBe(1);
});

test("a supplied expected revision is fenced when no current revision exists", { tags: "p1" }, async () => {
    const records = new MemoryProtocolRecords();
    const dispatcher = new CommandDispatcher(
        probeDispatcherInit({ records, command: new OptionalRevisionProbeCommand() })
    );
    const content = new CounterContentStore(() => undefined);
    const payload = encodeCanonicalJson({ probe: true });
    const payloadDigest = Digest.sha256(payload);
    const reference = ContentRef.fromDigest(payloadDigest);
    content.install(reference.value, payload);
    const raw = CommandEnvelopeCodec.encode(
        new CommandEnvelope({
            command: "probe.command",
            caller: probeCaller,
            idempotencyKey: "probe-revisionless",
            expectedRevision: Revision.initial(),
            payload: reference,
            payloadDigest
        })
    );
    const authentication = await new ProbeAuthenticator().authenticate(
        probeCaller,
        CommandEnvelopeCodec.decode(raw),
        Digest.sha256(raw)
    );
    const admission = await dispatcher.admit(raw, authentication);
    if (admission.kind !== "prepare") throw new TypeError("Expected command preparation");
    const binding = new PayloadLeaseBinding(
        probeTenant,
        probeActor,
        Digest.sha256(raw),
        reference,
        payloadDigest,
        new Date(CounterHarness.now.getTime() + 60_000)
    );
    const lease = await content.acquire(binding);
    if (lease === undefined) throw new TypeError("Expected a payload lease");

    const result = await admission.dispatch(issueLeasedCommandPayload(lease, binding));

    expect(result.outcome).toBe("rejectedRevision");
    await lease.close();
});

test("committed replies detach from the command execution buffer", { tags: "p1" }, async () => {
    const execution = encodeCanonicalJson({ probe: "reply" });
    const expected = execution.slice();
    const records = new MemoryProtocolRecords();
    const adapter = new MemoryProtocolPersistence<ProbeState>((state) => state.records);
    const zeroing: ProtocolPersistence<ProbeState> = {
        findWrite: (transaction, identity) => adapter.findWrite(transaction, identity),
        findAudit: (transaction, id) => adapter.findAudit(transaction, id),
        appendAudit: (transaction, record, context) => {
            adapter.appendAudit(transaction, record, context);
            execution.fill(0);
        },
        appendWrite: (transaction, record) => adapter.appendWrite(transaction, record)
    };
    const dispatcher = new CommandDispatcher(
        probeDispatcherInit({ records, persistence: zeroing, execution })
    );
    const content = new CounterContentStore(() => undefined);
    const payload = encodeCanonicalJson({ probe: true });
    const payloadDigest = Digest.sha256(payload);
    const reference = ContentRef.fromDigest(payloadDigest);
    content.install(reference.value, payload);
    const raw = CommandEnvelopeCodec.encode(
        new CommandEnvelope({
            command: "probe.command",
            caller: probeCaller,
            idempotencyKey: "probe-detached-reply",
            payload: reference,
            payloadDigest
        })
    );
    const authentication = await new ProbeAuthenticator().authenticate(
        probeCaller,
        CommandEnvelopeCodec.decode(raw),
        Digest.sha256(raw)
    );
    const admission = await dispatcher.admit(raw, authentication);
    if (admission.kind !== "prepare") throw new TypeError("Expected command preparation");
    const binding = new PayloadLeaseBinding(
        probeTenant,
        probeActor,
        Digest.sha256(raw),
        reference,
        payloadDigest,
        new Date(CounterHarness.now.getTime() + 60_000)
    );
    const lease = await content.acquire(binding);
    if (lease === undefined) throw new TypeError("Expected a payload lease");

    const result = await admission.dispatch(issueLeasedCommandPayload(lease, binding));

    expect(result.outcome).toBe("committed");
    expect(result.reply).toEqual(expected);
    expect(result.write.reply).toEqual(expected);
    expect(Object.hasOwn(result, "observation")).toBe(false);
    await lease.close();
});

test("function-typed Actor activation stores are admitted", { tags: "p2" }, async () => {
    const state: ProbeState = { records: new MemoryProtocolRecords(), nextId: 0 };
    const base = new MemoryActorStore<ProbeState>(state, (value) => ({
        records: value.records.clone(),
        nextId: value.nextId
    }));
    const store = Object.assign(function activationCapableStore(): void {}, {
        bindActor: base.bindActor.bind(base),
        activateActor: base.activateActor.bind(base),
        transaction: base.transaction.bind(base),
        read: base.read.bind(base),
        loadRecoveryState: base.loadRecoveryState.bind(base),
        saveRecoveryState: base.saveRecoveryState.bind(base)
    });
    const dispatcher = new CommandDispatcher(
        probeDispatcherInitOver(state.records, forgedActorStore(store))
    );

    const admission = await dispatcher.admit(Uint8Array.of(0xff), undefined);

    expect(admission.kind).toBe("completed");
    if (admission.kind !== "completed") throw new TypeError("Expected a completed admission");
    expect(admission.result.outcome).toBe("rejectedMalformed");
});

class RevocableCallerPolicy extends CommandCallerPolicy {
    #revoked = false;

    public revoke(): void {
        this.#revoked = true;
    }

    public admits(caller: CommandCaller): boolean {
        return !this.#revoked && caller.kind === "principal";
    }
}

interface ProbeState {
    records: MemoryProtocolRecords;
    nextId: number;
}

interface ProbeRead {
    readonly ready: boolean;
}

const probeActor = new ActorRef("run", new ActorId("probe-actor"));
const probeTenant = new TenantId("probe-tenant");
const probeCaller: CommandCaller = {
    kind: "principal",
    principal: new PrincipalRef(probeTenant, new PrincipalId("probe-principal"))
};

class ProbeAuthenticator extends CommandAuthenticator<CommandCaller> {
    public constructor() {
        super(probeTenant);
    }

    protected authenticateTransport(caller: CommandCaller): CommandCaller {
        return caller;
    }
}

class ProbeCommand implements ProtocolCommand<ProbeState, ProbeRead> {
    public readonly command = "probe.command";
    public readonly caller = CommandCallerPolicy.principal();
    public readonly expectedRevision = "forbidden" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload = { decode: (bytes: Uint8Array) => decodeCanonicalJson(bytes) };
    public readonly replyCodec = {
        encode: (reply: Uint8Array): Uint8Array => reply.slice(),
        decode: (bytes: Uint8Array): Uint8Array => bytes.slice()
    };

    public constructor(private readonly execution: Uint8Array) {}

    public authorize(): boolean {
        return true;
    }

    public permitsLifecycle(): boolean {
        return true;
    }

    public currentRevision(): undefined {
        return undefined;
    }

    public currentLease(): undefined {
        return undefined;
    }

    public execute(): Uint8Array {
        return this.execution;
    }
}

class OptionalRevisionProbeCommand implements ProtocolCommand<ProbeState, ProbeRead> {
    public readonly command = "probe.command";
    public readonly caller = CommandCallerPolicy.principal();
    public readonly expectedRevision = "optional" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload = { decode: (bytes: Uint8Array) => decodeCanonicalJson(bytes) };

    public authorize(): boolean {
        return true;
    }

    public permitsLifecycle(): boolean {
        return true;
    }

    public currentRevision(): undefined {
        return undefined;
    }

    public currentLease(): undefined {
        return undefined;
    }

    public execute(): Uint8Array {
        return encodeCanonicalJson({ probe: "reply" });
    }
}

/**
 * Composes a dispatcher over a caller-supplied store, including the invalid ones these tests
 * forge. Absence is not expressible here on purpose: a store passed as null or undefined is a
 * store the dispatcher must reject, not a request for the default one.
 */
function probeDispatcherInitOver(
    records: MemoryProtocolRecords,
    store: MemoryActorStore<ProbeState>
): CommandDispatcherInit<ProbeState, ProbeRead> {
    return { ...probeDispatcherInit({ records }), store };
}

function probeDispatcherInit(init: {
    readonly records: MemoryProtocolRecords;
    readonly persistence?: ProtocolPersistence<ProbeState>;
    readonly execution?: Uint8Array;
    readonly command?: ProtocolCommand<ProbeState, ProbeRead>;
}): CommandDispatcherInit<ProbeState, ProbeRead> {
    const state: ProbeState = { records: init.records, nextId: 0 };
    return {
        store: new MemoryActorStore<ProbeState>(state, (value) => ({
            records: value.records.clone(),
            nextId: value.nextId
        })),
        persistence:
            init.persistence ?? new MemoryProtocolPersistence<ProbeState>((value) => value.records),
        ids: new CounterIds<ProbeState>((transaction, prefix) => {
            transaction.nextId += 1;
            return `${prefix}-${transaction.nextId}`;
        }),
        actor: probeActor,
        tenant: probeTenant,
        readOnly: () => Object.freeze({ ready: true }),
        commands: [
            init.command ??
                new ProbeCommand(
                    init.execution === undefined
                        ? encodeCanonicalJson({ probe: "reply" })
                        : init.execution
                )
        ],
        limits: { envelopeBytes: 4096, payloadBytes: 1024 },
        now: () => CounterHarness.now
    };
}

const commandOutcomes = {
    committed: true,
    rejectedMalformed: true,
    rejectedAuthentication: true,
    rejectedAuthority: true,
    rejectedLifecycle: true,
    rejectedRevision: true,
    rejectedLease: true,
    duplicate: true
} satisfies Record<CommandOutcome, true>;

void commandOutcomes;

/**
 * The forged* helpers below hand the dispatcher values its contracts forbid, so a runtime guard
 * can be shown rejecting them. Each names the contract it violates; nothing reads the result
 * except the call asserted to fail.
 */
function forgedPreparedPayload<TActual>(value: TActual): PreparedCommandPayload {
    // SAFETY: not a payload this dispatcher prepared. Admission must reject it as malformed
    // rather than dispatch a command whose payload it never issued.
    return value as TActual & PreparedCommandPayload;
}

function forgedActorStore<TActual>(value: TActual): MemoryActorStore<ProbeState> {
    // SAFETY: a store without activateActor. The dispatcher requires an activation store and
    // must say so while composing, instead of failing later on the first command.
    return value as TActual & MemoryActorStore<ProbeState>;
}

function forgedExecution<TActual>(value: TActual): Uint8Array {
    // SAFETY: not encoded reply bytes. A command that returns one must be reported as an invalid
    // execution rather than written to the record as if it were a reply.
    return value as TActual & Uint8Array;
}
