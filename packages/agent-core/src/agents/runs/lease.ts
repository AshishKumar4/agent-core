import { RecordCodec, hasExactJsonKeys, type JsonValue } from "../../core";
import { PrincipalId, PrincipalRef, TenantId } from "../../identity";
import { AgentCoreError } from "../../errors";
import { TurnId } from "./id";

export interface LeaseToken {
    readonly turn: TurnId;
    readonly holder: PrincipalRef;
    readonly epoch: number;
}

export interface TurnLeaseVerifier {
    permits(token: LeaseToken): boolean;
}

class TurnLeaseCodec extends RecordCodec<TurnLease> {
    public constructor() {
        super("turn-lease", { major: 2, minor: 0 });
    }

    protected encodePayload(lease: TurnLease): JsonValue {
        return TurnLease.toData(lease);
    }

    protected decodePayload(payload: JsonValue): TurnLease {
        return TurnLease.fromData(payload);
    }
}

export abstract class TurnLease {
    public static readonly codec: RecordCodec<TurnLease> = new TurnLeaseCodec();
    readonly #expiresAtTime: number | undefined;

    protected constructor(
        public readonly turn: TurnId,
        public readonly holder: PrincipalRef | undefined,
        public readonly epoch: number,
        expiresAt: Date | undefined
    ) {
        if (!Number.isSafeInteger(epoch) || epoch < 0) {
            throw new TypeError("Turn lease epoch must be a non-negative safe integer");
        }
        if (expiresAt !== undefined && !Number.isFinite(expiresAt.getTime())) {
            throw new TypeError("Turn lease expiration must be a valid Date");
        }
        if (holder !== undefined && expiresAt === undefined) {
            throw new TypeError("Held Turn leases require an expiration");
        }
        if (holder !== undefined && !(holder instanceof PrincipalRef)) {
            throw new TypeError("Turn lease holder must be a tenant-qualified PrincipalRef");
        }
        this.#expiresAtTime = expiresAt?.getTime();
        Object.freeze(this);
    }

    public get expiresAt(): Date | undefined {
        return this.#expiresAtTime === undefined ? undefined : new Date(this.#expiresAtTime);
    }

    protected get expiresAtTime(): number | undefined {
        return this.#expiresAtTime;
    }

    public abstract admits(token: LeaseToken, now: Date): boolean;
    public abstract claim(holder: PrincipalRef, now: Date, expiresAt: Date): TurnLease;
    public abstract renew(
        holder: PrincipalRef,
        epoch: number,
        now: Date,
        expiresAt: Date
    ): TurnLease;
    public abstract reclaim(holder: PrincipalRef, now: Date, expiresAt: Date): TurnLease;
    public abstract fence(): TurnLease;

    public static encode(lease: TurnLease): Uint8Array {
        return TurnLease.codec.encode(lease);
    }

    public static decode(bytes: Uint8Array): TurnLease {
        return TurnLease.codec.decode(bytes);
    }

    public static restore(
        turn: TurnId,
        holder: PrincipalRef | undefined,
        epoch: number,
        expiresAt: Date | undefined
    ): TurnLease {
        return new ExactTurnLease(turn, holder, epoch, expiresAt);
    }

    public static unclaimed(turn: TurnId): TurnLease {
        return new ExactTurnLease(turn, undefined, 0, undefined);
    }

    public static toData(lease: TurnLease): JsonValue {
        return {
            turn: lease.turn.value,
            holder: lease.holder === undefined ? null : principalRefToData(lease.holder),
            epoch: lease.epoch,
            expiresAt: lease.expiresAt?.getTime() ?? null
        };
    }

    public static fromData(payload: JsonValue): TurnLease {
        if (!isTurnLeasePayload(payload)) {
            throw new AgentCoreError("codec.invalid", "Turn lease payload is malformed");
        }
        return TurnLease.restore(
            new TurnId(payload.turn),
            payload.holder === null ? undefined : principalRefFromData(payload.holder),
            payload.epoch,
            payload.expiresAt === null ? undefined : new Date(payload.expiresAt)
        );
    }
}

class ExactTurnLease extends TurnLease {
    public constructor(
        turn: TurnId,
        holder: PrincipalRef | undefined,
        epoch: number,
        expiresAt: Date | undefined
    ) {
        super(turn, holder, epoch, expiresAt);
    }

    public admits(token: LeaseToken, now: Date): boolean {
        const expiresAtTime = this.expiresAtTime;

        return (
            token.turn instanceof TurnId &&
            token.holder instanceof PrincipalRef &&
            this.turn.equals(token.turn) &&
            this.holder !== undefined &&
            this.holder.equals(token.holder) &&
            this.epoch === token.epoch &&
            expiresAtTime !== undefined &&
            expiresAtTime > now.getTime()
        );
    }

    public claim(holder: PrincipalRef, now: Date, expiresAt: Date): TurnLease {
        ensureFutureExpiration(expiresAt, now);

        if (this.holder !== undefined) {
            throw new AgentCoreError("lease.invalid", "Turn lease claim requires an unheld lease");
        }

        return new ExactTurnLease(this.turn, holder, nextEpoch(this.epoch), expiresAt);
    }

    public renew(holder: PrincipalRef, epoch: number, now: Date, expiresAt: Date): TurnLease {
        ensureFutureExpiration(expiresAt, now);
        const currentExpiresAtTime = this.expiresAtTime;

        const currentToken = { turn: this.turn, holder, epoch };
        if (!this.admits(currentToken, now) || currentExpiresAtTime === undefined) {
            throw new AgentCoreError(
                "lease.invalid",
                "Turn lease renewal requires the exact current token"
            );
        }
        if (expiresAt.getTime() <= currentExpiresAtTime) {
            throw new AgentCoreError(
                "lease.invalid",
                "Turn lease renewal requires a later expiration"
            );
        }

        return new ExactTurnLease(this.turn, this.holder, this.epoch, expiresAt);
    }

    public reclaim(holder: PrincipalRef, now: Date, expiresAt: Date): TurnLease {
        ensureFutureExpiration(expiresAt, now);
        const expiresAtTime = this.expiresAtTime;

        if (
            this.holder === undefined ||
            expiresAtTime === undefined ||
            expiresAtTime > now.getTime()
        ) {
            throw new AgentCoreError(
                "lease.invalid",
                "Turn lease reclaim requires an expired held lease"
            );
        }

        return new ExactTurnLease(this.turn, holder, nextEpoch(this.epoch), expiresAt);
    }

    public fence(): TurnLease {
        return new ExactTurnLease(this.turn, undefined, nextEpoch(this.epoch), this.expiresAt);
    }
}

interface TurnLeasePayload {
    readonly turn: string;
    readonly holder: JsonValue;
    readonly epoch: number;
    readonly expiresAt: number | null;
}

function isTurnLeasePayload(payload: JsonValue): payload is JsonValue & TurnLeasePayload {
    if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
        return false;
    }

    const object = payload as { readonly [key: string]: JsonValue };
    const holder = object["holder"];
    const epoch = object["epoch"];
    const expiresAt = object["expiresAt"];
    return (
        hasExactJsonKeys(object, ["epoch", "expiresAt", "holder", "turn"]) &&
        typeof object["turn"] === "string" &&
        (holder === null || (holder !== undefined && isPrincipalRefData(holder))) &&
        typeof epoch === "number" &&
        Number.isSafeInteger(epoch) &&
        epoch >= 0 &&
        (expiresAt === null || typeof expiresAt === "number")
    );
}

export function leaseTokenToData(token: LeaseToken): JsonValue {
    if (
        !(token.turn instanceof TurnId) ||
        !(token.holder instanceof PrincipalRef) ||
        !Number.isSafeInteger(token.epoch) ||
        token.epoch < 0
    ) {
        throw new AgentCoreError("codec.invalid", "Lease token is malformed");
    }
    return {
        epoch: token.epoch,
        holder: principalRefToData(token.holder),
        turn: token.turn.value
    };
}

export function leaseTokenFromData(value: JsonValue, name = "Lease token"): LeaseToken {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new AgentCoreError("codec.invalid", `${name} must be an object`);
    }
    const object = value as { readonly [key: string]: JsonValue };
    if (!hasExactJsonKeys(object, ["epoch", "holder", "turn"])) {
        throw new AgentCoreError("codec.invalid", `${name} fields are invalid`);
    }
    const turn = object["turn"];
    const epoch = object["epoch"];
    if (
        typeof turn !== "string" ||
        typeof epoch !== "number" ||
        !Number.isSafeInteger(epoch) ||
        epoch < 0
    ) {
        throw new AgentCoreError("codec.invalid", `${name} is malformed`);
    }
    return Object.freeze({
        turn: new TurnId(turn),
        holder: principalRefFromData(object["holder"]!),
        epoch
    });
}

function principalRefToData(holder: PrincipalRef): JsonValue {
    return {
        principal: holder.principalId.value,
        tenant: holder.tenantId.value
    };
}

function principalRefFromData(value: JsonValue): PrincipalRef {
    if (!isPrincipalRefData(value)) {
        throw new AgentCoreError("codec.invalid", "Lease holder is malformed");
    }
    return new PrincipalRef(new TenantId(value.tenant), new PrincipalId(value.principal));
}

interface PrincipalRefData {
    readonly principal: string;
    readonly tenant: string;
}

function isPrincipalRefData(value: JsonValue): value is JsonValue & PrincipalRefData {
    if (value === null || Array.isArray(value) || typeof value !== "object") return false;
    const object = value as { readonly [key: string]: JsonValue };
    return (
        hasExactJsonKeys(object, ["principal", "tenant"]) &&
        typeof object["principal"] === "string" &&
        typeof object["tenant"] === "string"
    );
}

function ensureFutureExpiration(expiresAt: Date, now: Date): void {
    if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(now.getTime())) {
        throw new AgentCoreError("lease.invalid", "Turn lease times must be valid Dates");
    }

    if (expiresAt.getTime() <= now.getTime()) {
        throw new AgentCoreError(
            "lease.invalid",
            "Turn lease expiration must be after the lease time"
        );
    }
}

function nextEpoch(epoch: number): number {
    if (epoch === Number.MAX_SAFE_INTEGER) {
        throw new AgentCoreError("lease.invalid", "Turn lease epoch is exhausted");
    }
    return epoch + 1;
}
