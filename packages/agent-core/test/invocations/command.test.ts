import { describe, expect, test } from "vitest";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { InvocationId } from "../../src/invocations";
import {
    CommandCallerPolicy,
    CommandEnvelope,
    type CurrentLease,
    type ProtocolValueCodec
} from "../../src/protocol";
import { TurnId } from "../../src/agents";
import { isMember } from "../../src/core";
import { testContentRef, testDigest } from "../helpers/content";
import {
    INVOCATION_COMMANDS,
    InvocationCommandPayload,
    createInvocationProtocolCommands,
    type InvocationCommandBackend,
    type InvocationCommandName,
    type InvocationCommandPayloadValue
} from "../../src/invocations";

describe("Invocation protocol command families", () => {
    test(
        "[C13-ADV-EARLY-AGGREGATE] pins the executor/system lease matrix and forbids aggregate revisions",
        { tags: "p0" },
        () => {
            const commands = createInvocationProtocolCommands(new Backend(), callers);
            expect(commands).toHaveLength(Object.keys(INVOCATION_COMMANDS).length);
            for (const command of commands) {
                expect(command.expectedRevision).toBe("forbidden");
                const executor = command.command.endsWith(".executor");
                expect(command.lease).toBe(executor ? "required" : "forbidden");
            }
            const system = commands.find(
                (command) => command.command === INVOCATION_COMMANDS.attemptSystem
            )!;
            expect(
                system.caller.admits({
                    kind: "principal",
                    principal: new PrincipalRef(tenant, new PrincipalId("not-system"))
                })
            ).toBe(false);
        }
    );

    test(
        "[C13-ADV-REORDERED-INTENT] uses strict canonical payloads and delegates synchronously",
        { tags: "p0" },
        () => {
            const backend = new Backend();
            const command = createInvocationProtocolCommands(backend, callers).find(
                (entry) => entry.command === INVOCATION_COMMANDS.claimExecutor
            )!;
            const payload = command.payload.decode(
                InvocationCommandPayload.encode(new InvocationId("protocol-invocation"), {
                    itemIndex: 0
                })
            );
            expect(Object.isFrozen(payload.body)).toBe(true);
            const envelope = commandEnvelope(INVOCATION_COMMANDS.claimExecutor);
            const at = new Date("2026-07-12T12:00:00.000Z");
            expect(command.authorize({}, envelope, payload)).toBe(true);
            expect(command.permitsLifecycle({}, envelope, payload)).toBe(true);
            expect(command.currentRevision({}, envelope, payload)).toBeUndefined();
            expect(command.currentLease({}, envelope, payload, at)?.epoch).toBe(1);
            expect(command.execute({}, envelope, payload, at)).toEqual({
                outcome: "committed",
                reply: new Uint8Array([1]),
                observation: { command: INVOCATION_COMMANDS.claimExecutor, at }
            });
            expect(backend.calls).toEqual([
                "authorize:invocation.item.claim.executor",
                "lifecycle:invocation.item.claim.executor",
                "lease:invocation.item.claim.executor",
                "execute:invocation.item.claim.executor"
            ]);
            expect(() =>
                command.payload.decode(
                    new TextEncoder().encode('{"body":{},"extra":true,"invocation":"x"}')
                )
            ).toThrow();
            // SAFETY: an empty object never went through the command's payload codec, which is
            // precisely what the check under test looks for — a command must refuse a payload it
            // did not decode itself, however well-formed it looks.
            expect(() =>
                command.authorize({}, envelope, {} as InvocationCommandPayloadValue)
            ).toThrow(/not decoded/);
            for (const malformed of [
                "null",
                "[]",
                "1",
                "{}",
                '{"body":{},"invocation":1}',
                '{"body":null,"invocation":"x"}'
            ]) {
                expect(() => command.payload.decode(new TextEncoder().encode(malformed))).toThrow(
                    /payload is malformed/
                );
            }
        }
    );

    test(
        "[C13-ADV-REORDERED-INTENT] refuses a reordered payload at the edge rather than normalising it into the same intent",
        { tags: "p0" },
        () => {
            const command = protocolCommand(new Backend(), INVOCATION_COMMANDS.claimExecutor);
            const decoded = command.payload.decode(
                new TextEncoder().encode(
                    '{"body":{"alpha":1,"beta":2},"invocation":"reordered-intent"}'
                )
            );
            expect(decoded.invocation.value).toBe("reordered-intent");

            // One intent has one wire form. Reordering the payload's own fields, or the
            // body's keys, is refused rather than quietly normalised, so no second byte
            // sequence exists for an intent an audit record already names.
            for (const reordered of [
                '{"invocation":"reordered-intent","body":{"alpha":1,"beta":2}}',
                '{"body":{"beta":2,"alpha":1},"invocation":"reordered-intent"}'
            ]) {
                expect(() => command.payload.decode(new TextEncoder().encode(reordered))).toThrow(
                    /canonical form/
                );
            }
        }
    );

    test("binds backend codecs and rejects payloads that bypassed decoding", { tags: "p1" }, () => {
        const backend = new Backend();
        const command = protocolCommand(backend, INVOCATION_COMMANDS.attemptExecutor);
        expect(command.replyCodec).toBe(backend.replyCodec);
        expect(command.observationCodec).toBe(backend.observationCodec);
        const envelope = commandEnvelope(INVOCATION_COMMANDS.attemptExecutor);
        const carrier = Object.assign(() => undefined, {
            invocation: new InvocationId("bypassed-payload"),
            body: {}
        });
        const undecoded: readonly unknown[] = [
            null,
            { invocation: "bypassed-payload", body: {} },
            { invocation: new InvocationId("bypassed-payload") },
            carrier
        ];
        for (const payload of undecoded) {
            // SAFETY: none of these went through the command's payload codec, which is what the
            // check under test looks for — an absent value, a structural twin, a partial one,
            // and a callable carrier must all be refused as undecoded.
            expect(() =>
                command.authorize({}, envelope, payload as InvocationCommandPayloadValue)
            ).toThrow(/not decoded/);
        }
        expect(backend.calls).toEqual([]);
    });
});

function protocolCommand(backend: Backend, name: InvocationCommandName) {
    for (const command of createInvocationProtocolCommands(backend, callers)) {
        if (command.command === name) return command;
    }
    throw new TypeError(`Unknown invocation command: ${name}`);
}

interface InvocationObservation {
    readonly command: InvocationCommandName;
    readonly at: Date;
}

/**
 * The transaction and read handles the protocol hands a backend. This one records the calls
 * it receives and never looks at either handle, so the type only has to name that.
 */
interface UnusedHandle {
    readonly unused?: never;
}

class Backend implements InvocationCommandBackend<
    UnusedHandle,
    UnusedHandle,
    Uint8Array,
    InvocationObservation
> {
    public readonly calls: string[] = [];
    public readonly replyCodec: ProtocolValueCodec<Uint8Array> = {
        encode: (value) => value.slice(),
        decode: (bytes) => bytes.slice()
    };
    public readonly observationCodec: ProtocolValueCodec<InvocationObservation> = {
        encode: (value) => new TextEncoder().encode(`${value.command}\n${value.at.toISOString()}`),
        decode: (bytes) => {
            const [command, at] = new TextDecoder().decode(bytes).split("\n");
            if (!isMember(Object.values(INVOCATION_COMMANDS), command) || at === undefined) {
                throw new TypeError("Invocation observation is malformed");
            }
            return { command, at: new Date(at) };
        }
    };

    public authorize(command: InvocationCommandName): boolean {
        this.calls.push(`authorize:${command}`);
        return true;
    }

    public permitsLifecycle(command: InvocationCommandName): boolean {
        this.calls.push(`lifecycle:${command}`);
        return true;
    }

    public currentLease(
        _command: InvocationCommandName,
        _read: UnusedHandle,
        _envelope: CommandEnvelope,
        _payload: InvocationCommandPayloadValue,
        _at: Date
    ): CurrentLease {
        this.calls.push(`lease:${_command}`);
        return {
            turn: new TurnId("turn"),
            holder: new PrincipalRef(tenant, new PrincipalId("holder")),
            epoch: 1,
            expiresAt: new Date(10_000)
        };
    }

    public execute(
        command: InvocationCommandName,
        _transaction: UnusedHandle,
        _envelope: CommandEnvelope,
        _payload: InvocationCommandPayloadValue,
        at: Date
    ) {
        this.calls.push(`execute:${command}`);
        return {
            outcome: "committed" as const,
            reply: new Uint8Array([1]),
            observation: { command, at }
        };
    }
}

const callers = {
    executor: CommandCallerPolicy.principal(),
    owner: CommandCallerPolicy.actor("run"),
    approver: CommandCallerPolicy.principal(),
    system: CommandCallerPolicy.actor("run")
};

const tenant = new TenantId("invocation-command-tenant");

function commandEnvelope(command: InvocationCommandName): CommandEnvelope {
    return new CommandEnvelope({
        command,
        caller: {
            kind: "principal",
            principal: new PrincipalRef(tenant, new PrincipalId("executor"))
        },
        idempotencyKey: `${command}:key`,
        payload: testContentRef(command),
        payloadDigest: testDigest(command)
    });
}
