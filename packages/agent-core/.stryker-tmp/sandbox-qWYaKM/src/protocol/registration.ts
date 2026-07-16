// @ts-nocheck
import type { Revision } from "../core";
import type { CommandEnvelope } from "./envelope";
import type { CommandPayloadCodec } from "./payload";
import type { CommandCallerPolicy } from "./policy";

type CommandFieldPolicy = "required" | "optional" | "forbidden";

export type ExpectedRevisionPolicy = CommandFieldPolicy;
export type LeaseTokenPolicy = CommandFieldPolicy;

export interface CurrentLease {
    readonly turn: NonNullable<CommandEnvelope["lease"]>["turn"];
    readonly holder: NonNullable<CommandEnvelope["lease"]>["holder"] | undefined;
    readonly epoch: number;
    readonly expiresAt: Date | undefined;
}

export interface ProtocolValueCodec<Value> {
    encode(value: Value): Uint8Array;
    decode(bytes: Uint8Array): Value;
}

export interface ProtocolCommandExecution<Reply, Observation> {
    readonly reply: Reply;
    readonly observation?: Observation;
}

export interface ProtocolCommandRegistration<
    Transaction,
    Read,
    Request = unknown,
    Reply = Uint8Array,
    Observation = never
> {
    readonly command: string;
    readonly caller: CommandCallerPolicy;
    readonly expectedRevision: ExpectedRevisionPolicy;
    readonly lease: LeaseTokenPolicy;
    readonly payload: CommandPayloadCodec<Request>;
    readonly replyCodec?: ProtocolValueCodec<Reply>;
    readonly observationCodec?: ProtocolValueCodec<Observation>;

    authorize(read: Read, envelope: CommandEnvelope, payload: Request): boolean;
    permitsLifecycle(read: Read, envelope: CommandEnvelope, payload: Request): boolean;
    currentRevision(read: Read, envelope: CommandEnvelope, payload: Request): Revision | undefined;
    currentLease(
        read: Read,
        envelope: CommandEnvelope,
        payload: Request,
        at: Date
    ): CurrentLease | undefined;
    execute(
        transaction: Transaction,
        envelope: CommandEnvelope,
        payload: Request,
        at: Date
    ): Uint8Array | ProtocolCommandExecution<Reply, Observation>;
}

export type ProtocolCommand<
    Transaction,
    Read,
    Request = unknown,
    Reply = Uint8Array,
    Observation = never
> = ProtocolCommandRegistration<Transaction, Read, Request, Reply, Observation>;
