import { RecordCodec, type JsonValue } from "../core";
import { requireIdentityFields, requireIdentityObject, requireIdentityString } from "./codec";
import { PrincipalId } from "./id";

export type PrincipalKind = "user" | "service" | "agent";
export type PrincipalStatus = "active" | "disabled";

abstract class PrincipalLifecycle {
    public abstract readonly status: PrincipalStatus;
    public abstract disable(): PrincipalLifecycle;
    public static from(status: PrincipalStatus): PrincipalLifecycle {
        return status === "active" ? activePrincipal : disabledPrincipal;
    }
}

class ActivePrincipalLifecycle extends PrincipalLifecycle {
    public readonly status = "active" as const;
    public disable(): PrincipalLifecycle {
        return disabledPrincipal;
    }
}

class DisabledPrincipalLifecycle extends PrincipalLifecycle {
    public readonly status = "disabled" as const;
    public disable(): PrincipalLifecycle {
        return this;
    }
}

const activePrincipal = Object.freeze(new ActivePrincipalLifecycle());
const disabledPrincipal = Object.freeze(new DisabledPrincipalLifecycle());

class PrincipalRecordCodec extends RecordCodec<Principal> {
    public constructor() {
        super("identity.principal", { major: 1, minor: 0 });
    }

    protected encodePayload(principal: Principal): JsonValue {
        return {
            id: principal.id.value,
            kind: principal.kind,
            status: principal.status
        };
    }

    protected decodePayload(payload: JsonValue): Principal {
        const object = requireIdentityObject(payload, "Principal payload");
        requireIdentityFields(object, ["id", "kind", "status"], "Principal payload");
        return new Principal(
            new PrincipalId(requireIdentityString(object["id"], "Principal ID")),
            requirePrincipalKind(object["kind"]),
            requirePrincipalStatus(object["status"])
        );
    }
}

export class Principal {
    public static readonly codec: RecordCodec<Principal> = new PrincipalRecordCodec();

    readonly #lifecycle: PrincipalLifecycle;

    public constructor(
        public readonly id: PrincipalId,
        public readonly kind: PrincipalKind,
        status: PrincipalStatus
    ) {
        requirePrincipalKind(kind);
        this.#lifecycle = PrincipalLifecycle.from(requirePrincipalStatus(status));
        Object.freeze(this);
    }

    public static encode(principal: Principal): Uint8Array {
        return Principal.codec.encode(principal);
    }

    public static decode(bytes: Uint8Array): Principal {
        return Principal.codec.decode(bytes);
    }

    public get canAct(): boolean {
        return this.#lifecycle.status === "active";
    }

    public get status(): PrincipalStatus {
        return this.#lifecycle.status;
    }

    public disable(): Principal {
        const next = this.#lifecycle.disable();
        return next === this.#lifecycle ? this : new Principal(this.id, this.kind, next.status);
    }
}

function requirePrincipalKind(value: JsonValue | undefined): PrincipalKind {
    if (value === "user" || value === "service" || value === "agent") {
        return value;
    }
    throw new TypeError("Principal kind is invalid");
}

function requirePrincipalStatus(value: JsonValue | undefined): PrincipalStatus {
    if (value === "active" || value === "disabled") {
        return value;
    }
    throw new TypeError("Principal status is invalid");
}
