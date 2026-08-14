import { requireSynchronousResult } from "../actors";
import { decodeCanonicalJson, encodeCanonicalJson, type Revision } from "../core";
import { InvocationId } from "../interaction-references";
import type {
    CommandCallerPolicy,
    CommandEnvelope,
    CommandPayloadCodec,
    CurrentLease,
    LeaseTokenPolicy,
    ProtocolCommand,
    ProtocolCommandExecution,
    ProtocolValueCodec
} from "../protocol";
import { canonicalFacetDataMap, isFacetDataMap, type FacetDataMap } from "../facets";
import { requireExactObject, requireString } from "./codec";

export const INVOCATION_COMMANDS = Object.freeze({
    prepareExecutor: "invocation.prepare.executor",
    prepareOwner: "invocation.prepare.owner",
    resolveApproval: "invocation.approval.resolve",
    claimExecutor: "invocation.item.claim.executor",
    claimSystem: "invocation.item.claim.system",
    recoverExecutor: "invocation.item.recover.executor",
    recoverSystem: "invocation.item.recover.system",
    attemptExecutor: "invocation.attempt.append.executor",
    attemptSystem: "invocation.attempt.append.system",
    preEffectReceipt: "invocation.receipt.preEffect",
    attemptReceipt: "invocation.receipt.attempt",
    reconcileReceipt: "invocation.receipt.reconcile"
});

export type InvocationCommandName = (typeof INVOCATION_COMMANDS)[keyof typeof INVOCATION_COMMANDS];

export interface InvocationCommandPayloadValue {
    readonly invocation: InvocationId;
    readonly body: FacetDataMap;
}

export interface InvocationCommandBackend<Transaction, Read, Reply, Observation> {
    readonly replyCodec: ProtocolValueCodec<Reply>;
    readonly observationCodec: ProtocolValueCodec<Observation>;
    authorize(
        command: InvocationCommandName,
        read: Read,
        envelope: CommandEnvelope,
        payload: InvocationCommandPayloadValue
    ): boolean;
    permitsLifecycle(
        command: InvocationCommandName,
        read: Read,
        envelope: CommandEnvelope,
        payload: InvocationCommandPayloadValue
    ): boolean;
    currentLease(
        command: InvocationCommandName,
        read: Read,
        envelope: CommandEnvelope,
        payload: InvocationCommandPayloadValue,
        at: Date
    ): CurrentLease | undefined;
    execute(
        command: InvocationCommandName,
        transaction: Transaction,
        envelope: CommandEnvelope,
        payload: InvocationCommandPayloadValue,
        at: Date
    ): ProtocolCommandExecution<Reply, Observation>;
}

export interface InvocationCommandCallerPolicies {
    readonly executor: CommandCallerPolicy;
    readonly owner: CommandCallerPolicy;
    readonly approver: CommandCallerPolicy;
    readonly system: CommandCallerPolicy;
}

export function createInvocationProtocolCommands<Transaction, Read, Reply, Observation>(
    backend: InvocationCommandBackend<Transaction, Read, Reply, Observation>,
    callers: InvocationCommandCallerPolicies
): readonly ProtocolCommand<
    Transaction,
    Read,
    InvocationCommandPayloadValue,
    Reply,
    Observation
>[] {
    return Object.freeze(
        commandPolicies.map(
            (policy) =>
                new InvocationProtocolCommand(
                    backend,
                    policy.command,
                    policy.lease,
                    callers[policy.caller]
                )
        )
    );
}

export const InvocationCommandPayload = Object.freeze({
    encode(invocation: InvocationId, body: FacetDataMap): Uint8Array {
        return encodeCanonicalJson({ body, invocation: invocation.value });
    }
});

class InvocationProtocolCommand<Transaction, Read, Reply, Observation> implements ProtocolCommand<
    Transaction,
    Read,
    InvocationCommandPayloadValue,
    Reply,
    Observation
> {
    public readonly expectedRevision = "forbidden" as const;
    public readonly payload: CommandPayloadCodec<InvocationCommandPayloadValue> =
        new InvocationPayloadCodec();
    public readonly replyCodec: ProtocolValueCodec<Reply>;
    public readonly observationCodec: ProtocolValueCodec<Observation>;

    public constructor(
        private readonly backend: InvocationCommandBackend<Transaction, Read, Reply, Observation>,
        public readonly command: InvocationCommandName,
        public readonly lease: LeaseTokenPolicy,
        public readonly caller: CommandCallerPolicy
    ) {
        this.replyCodec = backend.replyCodec;
        this.observationCodec = backend.observationCodec;
    }

    public authorize(
        read: Read,
        envelope: CommandEnvelope,
        payload: InvocationCommandPayloadValue
    ): boolean {
        return requireSynchronousResult(
            this.backend.authorize(this.command, read, envelope, requirePayload(payload))
        );
    }

    public permitsLifecycle(
        read: Read,
        envelope: CommandEnvelope,
        payload: InvocationCommandPayloadValue
    ): boolean {
        return requireSynchronousResult(
            this.backend.permitsLifecycle(this.command, read, envelope, requirePayload(payload))
        );
    }

    public currentRevision(
        _read: Read,
        _envelope: CommandEnvelope,
        _payload: InvocationCommandPayloadValue
    ): Revision | undefined {
        return undefined;
    }

    public currentLease(
        read: Read,
        envelope: CommandEnvelope,
        payload: InvocationCommandPayloadValue,
        at: Date
    ): CurrentLease | undefined {
        return requireSynchronousResult(
            this.backend.currentLease(this.command, read, envelope, requirePayload(payload), at)
        );
    }

    public execute(
        transaction: Transaction,
        envelope: CommandEnvelope,
        payload: InvocationCommandPayloadValue,
        at: Date
    ): ProtocolCommandExecution<Reply, Observation> {
        return requireSynchronousResult(
            this.backend.execute(this.command, transaction, envelope, requirePayload(payload), at)
        );
    }
}

class InvocationPayloadCodec implements CommandPayloadCodec<InvocationCommandPayloadValue> {
    public decode(bytes: Uint8Array): InvocationCommandPayloadValue {
        const value = decodeCanonicalJson(bytes);
        let object;
        try {
            object = requireExactObject(
                value,
                ["body", "invocation"],
                "Invocation command payload"
            );
        } catch {
            throw new TypeError("Invocation command payload is malformed");
        }
        const body = object["body"];
        if (!isFacetDataMap(body)) {
            throw new TypeError("Invocation command payload is malformed");
        }
        let invocation;
        try {
            invocation = requireString(object, "invocation");
        } catch {
            throw new TypeError("Invocation command payload is malformed");
        }
        const payload = Object.freeze({
            invocation: new InvocationId(invocation),
            body: canonicalFacetDataMap(body)
        });
        issuedPayloads.add(payload);
        return payload;
    }
}

function requirePayload(value: InvocationCommandPayloadValue): InvocationCommandPayloadValue {
    if (!issuedPayloads.has(value)) {
        throw new TypeError("Invocation command payload was not decoded");
    }
    return value;
}

const issuedPayloads = new WeakSet<InvocationCommandPayloadValue>();

const commandPolicies: readonly {
    readonly command: InvocationCommandName;
    readonly lease: LeaseTokenPolicy;
    readonly caller: keyof InvocationCommandCallerPolicies;
}[] = Object.freeze([
    { command: INVOCATION_COMMANDS.prepareExecutor, lease: "required", caller: "executor" },
    { command: INVOCATION_COMMANDS.prepareOwner, lease: "forbidden", caller: "owner" },
    { command: INVOCATION_COMMANDS.resolveApproval, lease: "forbidden", caller: "approver" },
    { command: INVOCATION_COMMANDS.claimExecutor, lease: "required", caller: "executor" },
    { command: INVOCATION_COMMANDS.claimSystem, lease: "forbidden", caller: "system" },
    { command: INVOCATION_COMMANDS.recoverExecutor, lease: "required", caller: "executor" },
    { command: INVOCATION_COMMANDS.recoverSystem, lease: "forbidden", caller: "system" },
    { command: INVOCATION_COMMANDS.attemptExecutor, lease: "required", caller: "executor" },
    { command: INVOCATION_COMMANDS.attemptSystem, lease: "forbidden", caller: "system" },
    { command: INVOCATION_COMMANDS.preEffectReceipt, lease: "forbidden", caller: "system" },
    { command: INVOCATION_COMMANDS.attemptReceipt, lease: "forbidden", caller: "system" },
    { command: INVOCATION_COMMANDS.reconcileReceipt, lease: "forbidden", caller: "system" }
]);
