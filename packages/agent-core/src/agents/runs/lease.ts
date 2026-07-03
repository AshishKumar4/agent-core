import type { PrincipalId } from "../../identity";
import { AgentCoreError } from "../../errors";

export class TurnLeaseCommit {
    public constructor(
        public readonly holderId: PrincipalId,
        public readonly epoch: number
    ) {
        if (!Number.isInteger(epoch) || epoch < 0) {
            throw new TypeError("Turn lease commit epoch must be a non-negative integer");
        }
    }

    public isHeldBy(lease: TurnLease, now: Date): boolean {
        return lease.isHeldBy(this.holderId, this.epoch, now);
    }
}

export interface TurnLeaseVerifier {
    permits(commit: TurnLeaseCommit): boolean;
}

export class TurnLease {
    readonly #expiresAtTime: number | undefined;

    public constructor(
        public readonly epoch: number,
        public readonly holderId: PrincipalId | undefined,
        expiresAt: Date | undefined
    ) {
        if (!Number.isInteger(epoch) || epoch < 0) {
            throw new TypeError("Turn lease epoch must be a non-negative integer");
        }

        this.#expiresAtTime = expiresAt === undefined ? undefined : expiresAt.getTime();
    }

    public static unclaimed(): TurnLease {
        return new TurnLease(0, undefined, undefined);
    }

    public get expiresAt(): Date | undefined {
        if (this.#expiresAtTime === undefined) {
            return undefined;
        }

        return new Date(this.#expiresAtTime);
    }

    public isHeldBy(holderId: PrincipalId, epoch: number, now: Date): boolean {
        const expiresAtTime = this.#expiresAtTime;

        return this.holderId !== undefined
            && this.holderId.equals(holderId)
            && this.epoch === epoch
            && expiresAtTime !== undefined
            && expiresAtTime > now.getTime();
    }

    public claim(holderId: PrincipalId, expiresAt: Date, now: Date): TurnLease {
        ensureFutureExpiration(expiresAt, now);
        const expiresAtTime = this.#expiresAtTime;

        if (this.holderId === undefined) {
            return new TurnLease(this.epoch + 1, holderId, expiresAt);
        }

        if (expiresAtTime !== undefined && expiresAtTime <= now.getTime()) {
            return new TurnLease(this.epoch + 1, holderId, expiresAt);
        }

        throw new AgentCoreError("lease.invalid", "Turn lease claim requires an unclaimed or expired lease");
    }

    public renew(holderId: PrincipalId, epoch: number, expiresAt: Date, now: Date): TurnLease {
        ensureFutureExpiration(expiresAt, now);

        if (!this.isHeldBy(holderId, epoch, now)) {
            throw new AgentCoreError("lease.invalid", "Turn lease renewal requires the current holder and epoch");
        }

        return new TurnLease(this.epoch, holderId, expiresAt);
    }

    public fence(): TurnLease {
        return new TurnLease(this.epoch + 1, undefined, undefined);
    }
}

function ensureFutureExpiration(expiresAt: Date, now: Date): void {
    if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(now.getTime())) {
        throw new TypeError("Turn lease times must be valid Dates");
    }

    if (expiresAt.getTime() <= now.getTime()) {
        throw new TypeError("Turn lease expiration must be after the lease time");
    }
}
