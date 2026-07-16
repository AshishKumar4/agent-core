// @ts-nocheck
import { RecordCodec, Revision, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import {
    requireIdentityFields,
    requireIdentityObject,
    requireIdentityRevision,
    requireIdentityString
} from "./codec";
import { TenantId } from "./id";

export type TenantKind = "personal" | "organization" | "service";
export type TenantStatus = "active" | "suspended" | "deleted";

abstract class TenantLifecycle {
    public abstract readonly status: TenantStatus;
    public abstract transition(next: TenantStatus): TenantLifecycle;
    public static from(status: TenantStatus): TenantLifecycle {
        if (status === "active") return activeTenant;
        if (status === "suspended") return suspendedTenant;
        return deletedTenant;
    }
}

class MutableTenantLifecycle extends TenantLifecycle {
    public constructor(public readonly status: "active" | "suspended") {
        super();
    }
    public transition(next: TenantStatus): TenantLifecycle {
        return TenantLifecycle.from(next);
    }
}

class DeletedTenantLifecycle extends TenantLifecycle {
    public readonly status = "deleted" as const;
    public transition(next: TenantStatus): TenantLifecycle {
        if (next !== "deleted") {
            throw new AgentCoreError("protocol.invalid-state", "Deleted Tenants are terminal");
        }
        return this;
    }
}

const activeTenant = Object.freeze(new MutableTenantLifecycle("active"));
const suspendedTenant = Object.freeze(new MutableTenantLifecycle("suspended"));
const deletedTenant = Object.freeze(new DeletedTenantLifecycle());

class TenantRecordCodec extends RecordCodec<Tenant> {
    public constructor() {
        super("identity.tenant", { major: 1, minor: 0 });
    }

    protected encodePayload(tenant: Tenant): JsonValue {
        return {
            authorizationRevision: tenant.authorizationRevision.value,
            id: tenant.id.value,
            kind: tenant.kind,
            status: tenant.status
        };
    }

    protected decodePayload(payload: JsonValue): Tenant {
        const object = requireIdentityObject(payload, "Tenant payload");
        requireIdentityFields(
            object,
            ["authorizationRevision", "id", "kind", "status"],
            "Tenant payload"
        );
        return new Tenant(
            new TenantId(requireIdentityString(object["id"], "Tenant ID")),
            requireTenantKind(object["kind"]),
            requireTenantStatus(object["status"]),
            requireIdentityRevision(
                object["authorizationRevision"],
                "Tenant authorization revision"
            )
        );
    }
}

export class Tenant {
    public static readonly codec: RecordCodec<Tenant> = new TenantRecordCodec();
    readonly #lifecycle: TenantLifecycle;

    public constructor(
        public readonly id: TenantId,
        public readonly kind: TenantKind,
        status: TenantStatus,
        public readonly authorizationRevision: Revision
    ) {
        requireTenantKind(kind);
        this.#lifecycle = TenantLifecycle.from(requireTenantStatus(status));
        Object.freeze(this);
    }

    public static encode(tenant: Tenant): Uint8Array {
        return Tenant.codec.encode(tenant);
    }

    public static decode(bytes: Uint8Array): Tenant {
        return Tenant.codec.decode(bytes);
    }

    public get acceptsMutation(): boolean {
        return this.#lifecycle.status === "active";
    }

    public get status(): TenantStatus {
        return this.#lifecycle.status;
    }

    public revise(status: TenantStatus): Tenant {
        if (status !== "active" && status !== "suspended" && status !== "deleted") {
            throw new AgentCoreError("protocol.invalid-state", "Tenant status is invalid");
        }
        if (this.authorizationRevision.value === Number.MAX_SAFE_INTEGER) {
            throw new AgentCoreError("protocol.invalid-state", "Tenant revision is exhausted");
        }
        const lifecycle = this.#lifecycle.transition(status);
        return lifecycle === this.#lifecycle
            ? this
            : new Tenant(this.id, this.kind, lifecycle.status, this.authorizationRevision.next());
    }
}

function requireTenantKind(value: JsonValue | undefined): TenantKind {
    if (value === "personal" || value === "organization" || value === "service") {
        return value;
    }
    throw new TypeError("Tenant kind is invalid");
}

function requireTenantStatus(value: JsonValue | undefined): TenantStatus {
    if (value === "active" || value === "suspended" || value === "deleted") {
        return value;
    }
    throw new TypeError("Tenant status is invalid");
}
