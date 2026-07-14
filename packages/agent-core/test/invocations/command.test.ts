import { describe, expect, test } from "vitest";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { InvocationId } from "../../src/invocations";
import {
    CommandCallerPolicy,
    type CommandEnvelope,
    type CurrentLease,
    type ProtocolValueCodec
} from "../../src/protocol";
import {
    INVOCATION_COMMANDS,
    InvocationCommandPayload,
    createInvocationProtocolCommands,
    type InvocationCommandBackend,
    type InvocationCommandName,
    type InvocationCommandPayloadValue
} from "../../src/invocations";

describe("Invocation protocol command families", () => {
    test("[C13-ADV-EARLY-AGGREGATE] pins the executor/system lease matrix and forbids aggregate revisions", () => {
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
    });

    test("[C13-ADV-REORDERED-INTENT] uses strict canonical payloads and delegates synchronously", () => {
        const backend = new Backend();
        const command = createInvocationProtocolCommands(backend, callers).find(
            (entry) => entry.command === INVOCATION_COMMANDS.claimExecutor
        )!;
        const payload = command.payload.decode(
            InvocationCommandPayload.encode(new InvocationId("protocol-invocation"), {
                itemIndex: 0
            })
        );
        expect(Object.isFrozen((payload as InvocationCommandPayloadValue).body)).toBe(true);
        const envelope = {} as CommandEnvelope;
        const at = new Date("2026-07-12T12:00:00.000Z");
        expect(command.authorize({}, envelope, payload)).toBe(true);
        expect(command.permitsLifecycle({}, envelope, payload)).toBe(true);
        expect(command.currentRevision({}, envelope, payload)).toBeUndefined();
        expect(command.currentLease({}, envelope, payload, at)?.epoch).toBe(1);
        expect(command.execute({}, envelope, payload, at)).toEqual({
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
        expect(() => command.authorize({}, envelope, {} as never)).toThrow(/not decoded/);
        for (const malformed of [
            "null",
            "[]",
            "1",
            "{}",
            '{"body":{},"invocation":1}',
            '{"body":null,"invocation":"x"}'
        ]) {
            expect(() => command.payload.decode(new TextEncoder().encode(malformed))).toThrow();
        }
    });
});

interface InvocationObservation {
    readonly command: InvocationCommandName;
    readonly at: Date;
}

class Backend implements InvocationCommandBackend<
    object,
    object,
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
            return { command: command as InvocationCommandName, at: new Date(at!) };
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
        _read: object,
        _envelope: CommandEnvelope,
        _payload: InvocationCommandPayloadValue,
        _at: Date
    ): CurrentLease {
        this.calls.push(`lease:${_command}`);
        return {
            turn: { value: "turn" } as CurrentLease["turn"],
            holder: new PrincipalRef(tenant, new PrincipalId("holder")),
            epoch: 1,
            expiresAt: new Date(10_000)
        };
    }

    public execute(
        command: InvocationCommandName,
        _transaction: object,
        _envelope: CommandEnvelope,
        _payload: InvocationCommandPayloadValue,
        at: Date
    ) {
        this.calls.push(`execute:${command}`);
        return {
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
