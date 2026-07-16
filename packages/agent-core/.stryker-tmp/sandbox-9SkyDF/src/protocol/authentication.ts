// @ts-nocheck
import type { Digest } from "../core";
import { AgentCoreError } from "../errors";
import type { TenantId } from "../identity";
import {
    commandCallersEqual,
    copyCommandCaller,
    type CommandCaller,
    type CommandEnvelope
} from "./envelope";

const authenticationIssuer = Symbol("command-authentication-issuer");
const issuedAuthentications = new WeakSet<object>();

export class CommandAuthentication {
    readonly #envelopeDigest: Digest;
    readonly #caller: CommandCaller;
    readonly #tenant: TenantId;

    public constructor(
        issuer: symbol,
        envelopeDigest: Digest,
        caller: CommandCaller,
        tenant: TenantId
    ) {
        if (issuer !== authenticationIssuer) {
            throw new AgentCoreError(
                "protocol.invalid-envelope",
                "Command authentication has an invalid issuer"
            );
        }
        this.#envelopeDigest = envelopeDigest;
        this.#caller = copyCommandCaller(caller);
        this.#tenant = tenant;
        issuedAuthentications.add(this);
        Object.freeze(this);
    }

    public matches(envelopeDigest: Digest, envelope: CommandEnvelope, tenant: TenantId): boolean {
        return (
            this.#envelopeDigest.equals(envelopeDigest) &&
            commandCallersEqual(this.#caller, envelope.caller) &&
            this.#tenant.equals(tenant)
        );
    }
}

export function commandAuthenticationMatches(
    authentication: unknown,
    envelopeDigest: Digest,
    envelope: CommandEnvelope,
    tenant: TenantId
): boolean {
    if (
        (typeof authentication !== "object" || authentication === null) &&
        typeof authentication !== "function"
    )
        return false;
    if (!issuedAuthentications.has(authentication)) return false;
    return CommandAuthentication.prototype.matches.call(
        authentication,
        envelopeDigest,
        envelope,
        tenant
    );
}

export abstract class CommandAuthenticator<Transport> {
    protected constructor(private readonly tenant: TenantId) {}

    public async authenticate(
        transport: Transport,
        envelope: CommandEnvelope,
        envelopeDigest: Digest
    ): Promise<CommandAuthentication | undefined> {
        const caller = await this.authenticateTransport(transport, envelope);
        return caller === undefined
            ? undefined
            : issueAuthentication(envelopeDigest, caller, this.tenant);
    }

    protected abstract authenticateTransport(
        transport: Transport,
        envelope: CommandEnvelope
    ): CommandCaller | undefined | Promise<CommandCaller | undefined>;
}

function issueAuthentication(
    envelopeDigest: Digest,
    caller: CommandCaller,
    tenant: TenantId
): CommandAuthentication {
    return new CommandAuthentication(authenticationIssuer, envelopeDigest, caller, tenant);
}
