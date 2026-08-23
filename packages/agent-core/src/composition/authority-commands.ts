import type { ActorRef } from "../actors";
import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityPermitIssuer,
    TenantAuthorityRuntime,
    BindingValidationEvidence,
    BindingValidationRequest,
    TargetLeaseEvidence,
    type TenantAuthorityPermitStore
} from "../authority";
import type { TransientContentAccess } from "../content";
import { AgentCoreError } from "../errors";
import type { PrincipalRef, TenantId } from "../identity";
import {
    AuthorityCheckPayloadCodec,
    AuthorityCheckReply,
    TargetLeaseEvidencePayloadCodec,
    AuthorityPermitIssuancePayloadCodec,
    AuthorityPermitIssuanceReply,
    AuthorityPermitIssuanceRequest,
    BindingValidationPayloadCodec,
    BindingValidationReply,
    CommandAuthenticator,
    CommandCallerPolicy,
    CommandIngress,
    type CommandCaller,
    type CommandDispatchResult,
    type CommandEnvelope,
    type CommandIngressResult,
    type CurrentLease,
    type ProtocolCommandExecution,
    type ProtocolCommandRegistration,
    type ProtocolValueCodec,
    type RegisteredProtocolCommand
} from "../protocol";
import {
    createClosedCommandDispatcher,
    type ClosedCommandFamilies,
    type ClosedDispatcherInit
} from "./dispatcher";

export const TENANT_AUTHORITY_COMMANDS = Object.freeze({
    validateBinding: "binding.validate",
    check: "authority.check",
    projectLeaseEvidence: "authority.permit.evidence.project",
    issuePermit: "authority.permit.issue"
});

export interface TenantAuthorityCommandBackend<Transaction, Read> {
    actorFence(read: Read, actor: ActorRef): number | undefined;
    checkPrincipal(read: Read, request: AuthorityCheckRequest): PrincipalRef | undefined;
    currentCheckLease(
        read: Read,
        request: AuthorityCheckRequest,
        at: Date
    ): CurrentLease | undefined;
    projectLeaseEvidence(
        transaction: Transaction,
        evidence: TargetLeaseEvidence,
        at: Date
    ): TargetLeaseEvidence;
    validateBinding(
        transaction: Transaction,
        request: BindingValidationRequest,
        at: Date
    ): BindingValidationEvidence;
    check(
        transaction: Transaction,
        request: AuthorityCheckRequest,
        at: Date
    ): AuthorityCheckEvidence;
    issuePermit(
        transaction: Transaction,
        request: AuthorityPermitIssuanceRequest,
        at: Date
    ): AuthorityPermitIssuanceReply;
}

export abstract class TenantAuthorityCommandStatePort<Read> {
    public abstract actorFence(read: Read, actor: ActorRef): number | undefined;
    public abstract checkPrincipal(
        read: Read,
        request: AuthorityCheckRequest
    ): PrincipalRef | undefined;
    public abstract currentCheckLease(
        read: Read,
        request: AuthorityCheckRequest,
        at: Date
    ): CurrentLease | undefined;
}

export class TenantAuthorityRuntimeCommandBackend<
    Transaction,
    Read
> implements TenantAuthorityCommandBackend<Transaction, Read> {
    readonly #issuer: AuthorityPermitIssuer<Transaction>;

    public constructor(
        private readonly state: TenantAuthorityCommandStatePort<Read>,
        private readonly authority: TenantAuthorityPermitStore<Transaction>,
        private readonly issuerActor: ActorRef
    ) {
        if (!authority.owner.equals(issuerActor) || issuerActor.kind !== "tenant") {
            throw new TypeError(
                "Tenant authority command backend requires its Tenant permit owner"
            );
        }
        this.#issuer = new AuthorityPermitIssuer(authority);
    }

    public actorFence(read: Read, actor: ActorRef): number | undefined {
        return this.state.actorFence(read, actor);
    }

    public get transactionStore(): TenantAuthorityPermitStore<Transaction> {
        return this.authority;
    }

    public checkPrincipal(read: Read, request: AuthorityCheckRequest): PrincipalRef | undefined {
        return this.state.checkPrincipal(read, request);
    }

    public currentCheckLease(
        read: Read,
        request: AuthorityCheckRequest,
        at: Date
    ): CurrentLease | undefined {
        return this.state.currentCheckLease(read, request, at);
    }

    public projectLeaseEvidence(
        transaction: Transaction,
        evidence: TargetLeaseEvidence,
        _at: Date
    ): TargetLeaseEvidence {
        return this.authority.projectEvidence(transaction, evidence);
    }

    public validateBinding(
        transaction: Transaction,
        request: BindingValidationRequest,
        at: Date
    ): BindingValidationEvidence {
        return this.runtime(transaction).validateBinding(request, at);
    }

    public check(
        transaction: Transaction,
        request: AuthorityCheckRequest,
        at: Date
    ): AuthorityCheckEvidence {
        return this.runtime(transaction).check(request, at);
    }

    public issuePermit(
        transaction: Transaction,
        request: AuthorityPermitIssuanceRequest,
        at: Date
    ): AuthorityPermitIssuanceReply {
        const evidence = this.runtime(transaction).check(request.targetRequest.authority, at);
        if (!evidence.binds(request.targetRequest.authority)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant authority returned evidence for another permit request"
            );
        }
        if (!evidence.allowed) return AuthorityPermitIssuanceReply.denied(evidence);
        return AuthorityPermitIssuanceReply.issued(
            evidence,
            this.#issuer.issue(transaction, request.targetRequest, evidence, at)
        );
    }

    private runtime(transaction: Transaction): TenantAuthorityRuntime {
        return new TenantAuthorityRuntime(this.authority.authority(transaction), this.issuerActor);
    }
}

type AdditionalTenantCommandFamilies<Transaction, Read> = Omit<
    ClosedCommandFamilies<Transaction, Read>,
    "authority"
>;

export type ClosedTenantAuthorityCompositionInit<
    Transaction,
    Read,
    ReadTransaction = Transaction,
    Transport = unknown
> = Omit<ClosedDispatcherInit<Transaction, Read, ReadTransaction>, "commands"> & {
    readonly backend: TenantAuthorityCommandBackend<Transaction, Read>;
    readonly authenticator: CommandAuthenticator<Transport>;
    readonly content: TransientContentAccess;
    readonly commands?: AdditionalTenantCommandFamilies<Transaction, Read>;
    readonly leaseForMilliseconds: number;
};

export class ClosedTenantAuthorityComposition<
    Transaction,
    Read,
    ReadTransaction = Transaction,
    Transport = unknown
> {
    readonly #ingress: CommandIngress<Transaction, Read, ReadTransaction, Transport>;

    public constructor(
        init: ClosedTenantAuthorityCompositionInit<Transaction, Read, ReadTransaction, Transport>
    ) {
        requireTenantActor(init.actor);
        if (
            init.backend instanceof TenantAuthorityRuntimeCommandBackend &&
            !Object.is(init.backend.transactionStore, init.store)
        ) {
            throw new TypeError(
                "Tenant authority runtime backend and dispatcher require one transaction store"
            );
        }
        const authority = createTenantAuthorityCommands(init.backend, init.actor, init.tenant);
        const dispatcher = createClosedCommandDispatcher({
            ...init,
            commands: { ...init.commands, authority }
        });
        const ingress = {
            dispatcher,
            content: init.content,
            authenticator: init.authenticator,
            leaseForMilliseconds: init.leaseForMilliseconds
        };
        this.#ingress = new CommandIngress(
            init.now === undefined ? ingress : { ...ingress, now: init.now }
        );
    }

    public accept(
        envelope: Uint8Array,
        transport: Transport,
        submittedBytes?: Uint8Array
    ): Promise<CommandIngressResult> {
        return this.#ingress.accept(envelope, transport, submittedBytes);
    }

    public async dispatch(
        envelope: Uint8Array,
        transport: Transport,
        submittedBytes?: Uint8Array
    ): Promise<CommandDispatchResult> {
        const result = await this.accept(envelope, transport, submittedBytes);
        if (result.kind === "preDispatchFailure") throw result.cause;
        return result;
    }
}

export function createClosedTenantAuthorityComposition<
    Transaction,
    Read,
    ReadTransaction = Transaction,
    Transport = unknown
>(
    init: ClosedTenantAuthorityCompositionInit<Transaction, Read, ReadTransaction, Transport>
): ClosedTenantAuthorityComposition<Transaction, Read, ReadTransaction, Transport> {
    return new ClosedTenantAuthorityComposition(init);
}

function createTenantAuthorityCommands<Transaction, Read>(
    backend: TenantAuthorityCommandBackend<Transaction, Read>,
    tenantActor: ActorRef,
    tenant: TenantId
): readonly RegisteredProtocolCommand<Transaction, Read>[] {
    return Object.freeze([
        new BindingValidationCommand(backend, tenantActor, tenant),
        new AuthorityCheckCommand(backend, tenantActor, tenant),
        new TargetLeaseEvidenceProjectionCommand(backend, tenant),
        new AuthorityPermitIssuanceCommand(backend, tenantActor, tenant)
    ]);
}

class BindingValidationCommand<Transaction, Read> implements ProtocolCommandRegistration<
    Transaction,
    Read,
    BindingValidationRequest,
    BindingValidationReply,
    BindingValidationEvidence
> {
    public readonly command = TENANT_AUTHORITY_COMMANDS.validateBinding;
    public readonly caller = anyActorCallerPolicy;
    public readonly expectedRevision = "forbidden" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload = new BindingValidationPayloadCodec();
    public readonly replyCodec: ProtocolValueCodec<BindingValidationReply> = {
        encode: BindingValidationReply.encode,
        decode: BindingValidationReply.decode
    };
    public readonly observationCodec: ProtocolValueCodec<BindingValidationEvidence> = {
        encode: BindingValidationEvidence.encode,
        decode: BindingValidationEvidence.decode
    };

    public constructor(
        private readonly backend: TenantAuthorityCommandBackend<Transaction, Read>,
        private readonly tenantActor: ActorRef,
        private readonly tenant: TenantId
    ) {}

    public authorize(
        read: Read,
        envelope: CommandEnvelope,
        request: BindingValidationRequest
    ): boolean {
        return (
            request.ownerTenant.equals(this.tenant) &&
            callerIs(envelope.caller, request.workspaceActor) &&
            this.backend.actorFence(read, request.workspaceActor) === request.workspaceFence
        );
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

    public execute(
        transaction: Transaction,
        _envelope: CommandEnvelope,
        request: BindingValidationRequest,
        at: Date
    ): ProtocolCommandExecution<BindingValidationReply, BindingValidationEvidence> {
        const evidence = this.backend.validateBinding(transaction, request, at);
        requireBindingEvidence(evidence, request, this.tenantActor, this.tenant, at);
        return {
            outcome: "committed",
            reply: new BindingValidationReply(evidence),
            observation: evidence
        };
    }
}

class AuthorityCheckCommand<Transaction, Read> implements ProtocolCommandRegistration<
    Transaction,
    Read,
    AuthorityCheckRequest,
    AuthorityCheckReply,
    AuthorityCheckEvidence
> {
    public readonly command = TENANT_AUTHORITY_COMMANDS.check;
    public readonly caller = anyActorCallerPolicy;
    public readonly expectedRevision = "forbidden" as const;
    public readonly lease = "optional" as const;
    public readonly payload = new AuthorityCheckPayloadCodec();
    public readonly replyCodec: ProtocolValueCodec<AuthorityCheckReply> = {
        encode: AuthorityCheckReply.encode,
        decode: AuthorityCheckReply.decode
    };
    public readonly observationCodec: ProtocolValueCodec<AuthorityCheckEvidence> = {
        encode: AuthorityCheckEvidence.encode,
        decode: AuthorityCheckEvidence.decode
    };

    public constructor(
        private readonly backend: TenantAuthorityCommandBackend<Transaction, Read>,
        private readonly tenantActor: ActorRef,
        private readonly tenant: TenantId
    ) {}

    public authorize(
        read: Read,
        envelope: CommandEnvelope,
        request: AuthorityCheckRequest
    ): boolean {
        const principal = this.backend.checkPrincipal(read, request);
        return (
            request.ownerTenant.equals(this.tenant) &&
            callerIs(envelope.caller, request.owner) &&
            this.backend.actorFence(read, request.owner) === request.ownerFence &&
            principal?.equals(request.principal) === true
        );
    }

    public permitsLifecycle(): boolean {
        return true;
    }

    public currentRevision(): undefined {
        return undefined;
    }

    public currentLease(
        read: Read,
        _envelope: CommandEnvelope,
        request: AuthorityCheckRequest,
        at: Date
    ): CurrentLease | undefined {
        return this.backend.currentCheckLease(read, request, at);
    }

    public execute(
        transaction: Transaction,
        _envelope: CommandEnvelope,
        request: AuthorityCheckRequest,
        at: Date
    ): ProtocolCommandExecution<AuthorityCheckReply, AuthorityCheckEvidence> {
        const evidence = this.backend.check(transaction, request, at);
        requireCheckEvidence(evidence, request, this.tenantActor, this.tenant, at);
        return {
            outcome: "committed",
            reply: new AuthorityCheckReply(evidence),
            observation: evidence
        };
    }
}

class TargetLeaseEvidenceProjectionCommand<Transaction, Read> implements ProtocolCommandRegistration<
    Transaction,
    Read,
    TargetLeaseEvidence,
    TargetLeaseEvidence,
    TargetLeaseEvidence
> {
    public readonly command = TENANT_AUTHORITY_COMMANDS.projectLeaseEvidence;
    public readonly caller = anyActorCallerPolicy;
    public readonly expectedRevision = "forbidden" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload = new TargetLeaseEvidencePayloadCodec();
    public readonly replyCodec: ProtocolValueCodec<TargetLeaseEvidence> = {
        encode: TargetLeaseEvidence.encode,
        decode: TargetLeaseEvidence.decode
    };
    public readonly observationCodec: ProtocolValueCodec<TargetLeaseEvidence> = {
        encode: TargetLeaseEvidence.encode,
        decode: TargetLeaseEvidence.decode
    };
    public constructor(
        private readonly backend: TenantAuthorityCommandBackend<Transaction, Read>,
        private readonly tenant: TenantId
    ) {}

    public authorize(
        _read: Read,
        envelope: CommandEnvelope,
        evidence: TargetLeaseEvidence
    ): boolean {
        return (
            evidence.tenant.equals(this.tenant) &&
            callerIs(envelope.caller, evidence.key.source) &&
            envelope.idempotencyKey === evidence.key.idempotencyKey
        );
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

    public execute(
        transaction: Transaction,
        _envelope: CommandEnvelope,
        evidence: TargetLeaseEvidence,
        at: Date
    ): ProtocolCommandExecution<TargetLeaseEvidence, TargetLeaseEvidence> {
        const projected = this.backend.projectLeaseEvidence(transaction, evidence, at);
        if (
            !projected.digest().equals(evidence.digest()) ||
            !projected.key.equals(evidence.key) ||
            !projected.isCurrentAt(at) ||
            !projected.tenant.equals(this.tenant) ||
            !projected.target.actor.equals(evidence.target.actor) ||
            projected.target.fence !== evidence.target.fence ||
            !projected.target.domain.equals(evidence.target.domain)
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant authority projected substituted source lease evidence"
            );
        }
        return { outcome: "committed", reply: projected, observation: projected };
    }
}

class AuthorityPermitIssuanceCommand<Transaction, Read> implements ProtocolCommandRegistration<
    Transaction,
    Read,
    AuthorityPermitIssuanceRequest,
    AuthorityPermitIssuanceReply,
    AuthorityPermitIssuanceReply
> {
    public readonly command = TENANT_AUTHORITY_COMMANDS.issuePermit;
    public readonly caller = anyActorCallerPolicy;
    public readonly expectedRevision = "forbidden" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload = new AuthorityPermitIssuancePayloadCodec();
    public readonly replyCodec: ProtocolValueCodec<AuthorityPermitIssuanceReply> = {
        encode: AuthorityPermitIssuanceReply.encode,
        decode: AuthorityPermitIssuanceReply.decode
    };
    public readonly observationCodec: ProtocolValueCodec<AuthorityPermitIssuanceReply> = {
        encode: AuthorityPermitIssuanceReply.encode,
        decode: AuthorityPermitIssuanceReply.decode
    };

    public constructor(
        private readonly backend: TenantAuthorityCommandBackend<Transaction, Read>,
        private readonly tenantActor: ActorRef,
        private readonly tenant: TenantId
    ) {}

    public authorize(
        _read: Read,
        envelope: CommandEnvelope,
        request: AuthorityPermitIssuanceRequest
    ): boolean {
        const { expectation } = request.targetRequest;
        return (
            expectation.tenant.equals(this.tenant) &&
            expectation.issuer.equals(this.tenantActor) &&
            callerIs(envelope.caller, expectation.target.actor) &&
            (expectation.lease === undefined || request.targetRequest.leaseEvidence !== undefined)
        );
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

    public execute(
        transaction: Transaction,
        _envelope: CommandEnvelope,
        request: AuthorityPermitIssuanceRequest,
        at: Date
    ): ProtocolCommandExecution<AuthorityPermitIssuanceReply, AuthorityPermitIssuanceReply> {
        const reply = this.backend.issuePermit(transaction, request, at);
        requirePermitDecision(reply, request, this.tenantActor, this.tenant, at);
        if (reply.kind === "issued") {
            return { outcome: "committed", reply, observation: reply };
        }
        return { outcome: "rejectedAuthority", reply };
    }
}

class AnyActorCallerPolicy extends CommandCallerPolicy {
    public admits(caller: CommandCaller): boolean {
        return caller.kind === "actor";
    }
}

const anyActorCallerPolicy = new AnyActorCallerPolicy();

function callerIs(caller: CommandCaller, actor: ActorRef): boolean {
    return caller.kind === "actor" && caller.actor.equals(actor);
}

function requireTenantActor(actor: ActorRef): void {
    if (actor.kind !== "tenant") {
        throw new TypeError("Closed Tenant authority composition requires a Tenant Actor");
    }
}

function requireBindingEvidence(
    evidence: BindingValidationEvidence,
    request: BindingValidationRequest,
    tenantActor: ActorRef,
    tenant: TenantId,
    at: Date
): void {
    if (
        !evidence.binds(request) ||
        !evidence.issuer.equals(tenantActor) ||
        !evidence.issuerTenant.equals(tenant) ||
        evidence.checkedAt.getTime() !== at.getTime()
    ) {
        throw new TypeError("Binding validation returned substituted evidence");
    }
}

function requireCheckEvidence(
    evidence: AuthorityCheckEvidence,
    request: AuthorityCheckRequest,
    tenantActor: ActorRef,
    tenant: TenantId,
    at: Date
): void {
    if (
        !evidence.binds(request) ||
        !evidence.issuer.equals(tenantActor) ||
        !evidence.issuerTenant.equals(tenant) ||
        evidence.checkedAt.getTime() !== at.getTime()
    ) {
        throw new TypeError("Authority check returned substituted evidence");
    }
}

function requirePermitDecision(
    reply: AuthorityPermitIssuanceReply,
    request: AuthorityPermitIssuanceRequest,
    tenantActor: ActorRef,
    tenant: TenantId,
    at: Date
): void {
    const evidence = reply.evidence;
    if (
        !evidence.binds(request.targetRequest.authority) ||
        !evidence.issuer.equals(tenantActor) ||
        !evidence.issuerTenant.equals(tenant) ||
        evidence.checkedAt.getTime() !== at.getTime()
    ) {
        throw new TypeError("Authority permit issuer returned substituted evidence");
    }
    if (reply.kind === "denied") return;
    const permit = reply.requirePermit();
    if (
        !permit.expectation.equals(request.targetRequest.expectation) ||
        !permit.requestDigest.equals(request.targetRequest.digest()) ||
        !permit.issuer.equals(tenantActor) ||
        permit.nonce !== request.targetRequest.nonce ||
        permit.issuedAt.getTime() !== at.getTime() ||
        permit.expiresAt.getTime() !== request.targetRequest.expiresAt.getTime()
    ) {
        throw new TypeError("Authority permit issuer returned substituted evidence");
    }
}

