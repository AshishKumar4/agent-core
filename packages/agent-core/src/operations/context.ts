import type { TurnLeaseCommit, TurnLeaseVerifier } from "../agents/runs/lease";
import type { AuthorityVerifier, BindingAuthority } from "../authority";
import type { BindingName } from "../facets/id";
import type { ProtectionDomain } from "../facets/protection";
import type { Principal } from "../identity/principal";
import type {
    AuditRecord,
    Observability,
    ObservedEvent,
    ObservedOperation,
    Span
} from "../observability";
import type { ObservationContext } from "../observability/context";
import type { OperationId } from "./id";

export interface OperationContextInit {
    readonly id: OperationId;
    readonly principal: Principal;
    readonly domain: ProtectionDomain;
    readonly binding: BindingName;
    readonly authority?: BindingAuthority;
    readonly authorityVerifier?: AuthorityVerifier;
    readonly lease?: TurnLeaseCommit | undefined;
    readonly leaseVerifier?: TurnLeaseVerifier;
    readonly observability: Observability;
}

export class OperationContext {
    public readonly id: OperationId;

    public readonly principal: Principal;

    public readonly domain: ProtectionDomain;

    public readonly binding: BindingName;

    public readonly authority: BindingAuthority | undefined;

    public readonly authorityVerifier: AuthorityVerifier | undefined;

    public readonly lease: TurnLeaseCommit | undefined;

    public readonly leaseVerifier: TurnLeaseVerifier | undefined;

    public readonly observability: Observability;

    public constructor(init: OperationContextInit) {
        this.id = init.id;
        this.principal = init.principal;
        this.domain = init.domain;
        this.binding = init.binding;
        this.authority = init.authority;
        this.authorityVerifier = init.authorityVerifier;
        this.lease = init.lease;
        this.leaseVerifier = init.leaseVerifier;
        this.observability = init.observability;
    }

    public get observation(): ObservationContext {
        return this.observability.observation;
    }

    public start(operation: ObservedOperation): Span {
        return this.observability.start(operation);
    }

    public appendAudit(record: AuditRecord): void {
        this.observability.auditLog.append(this, record);
    }

    public emitEvent(event: ObservedEvent): void {
        this.observability.eventStream.emit(this, event);
    }

    public permits(required: BindingAuthority | undefined): boolean {
        if (required === undefined) {
            return true;
        }

        return this.authority !== undefined
            && this.authority.matches(required)
            && this.authorityVerifier !== undefined
            && this.authorityVerifier.permits(this.authority);
    }

    public permitsLease(): boolean {
        return this.lease === undefined
            || (this.leaseVerifier !== undefined && this.leaseVerifier.permits(this.lease));
    }
}
