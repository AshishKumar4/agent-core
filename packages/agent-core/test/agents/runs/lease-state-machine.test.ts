import fc, { type Command } from "fast-check";
import { expect, test } from "vitest";
import { TurnId, TurnLease, type LeaseToken } from "../../../src/agents/runs";
import { PrincipalId, PrincipalRef, TenantId } from "../../../src/identity";

const turn = new TurnId("turn-state-machine");
const sharedPrincipal = new PrincipalId("principal-state-shared");
const holders = [
    new PrincipalRef(new TenantId("tenant-state-a"), sharedPrincipal),
    new PrincipalRef(new TenantId("tenant-state-b"), sharedPrincipal),
    new PrincipalRef(new TenantId("tenant-state-a"), new PrincipalId("principal-state-distinct"))
] as const;

interface LeaseModel {
    now: number;
    holder: number | undefined;
    epoch: number;
    expiresAt: number | undefined;
    stale: LeaseToken[];
}

interface LeaseSystem {
    lease: TurnLease;
}

test("generated lease histories never restore authority to a stale token", { tags: "p0" }, () => {
    const holder = fc.integer({ min: 0, max: holders.length - 1 });
    const duration = fc.integer({ min: 1, max: 20 });
    const commands = fc.commands<LeaseModel, LeaseSystem>(
        [
            fc.tuple(holder, duration).map(([candidate, ttl]) => new Claim(candidate, ttl)),
            duration.map((extension) => new Renew(extension)),
            fc.integer({ min: 0, max: 20 }).map((elapsed) => new Advance(elapsed)),
            fc.tuple(holder, duration).map(([candidate, ttl]) => new Reclaim(candidate, ttl)),
            fc.constant(new Fence()),
            fc.constant(new RoundTrip()),
            fc.constant(new Probe()),
            duration.map((extension) => new RejectStaleRenew(extension)),
            fc
                .tuple(holder, duration)
                .map(([candidate, ttl]) => new RejectPrematureReclaim(candidate, ttl)),
            fc
                .tuple(holder, duration)
                .map(([candidate, ttl]) => new RejectDuplicateClaim(candidate, ttl)),
            holder.map((candidate) => new RejectExpiredClaim(candidate))
        ],
        { maxCommands: 100 }
    );

    fc.assert(
        fc.property(commands, (history) => {
            fc.modelRun(
                () => ({
                    model: {
                        now: 0,
                        holder: undefined,
                        epoch: 0,
                        expiresAt: undefined,
                        stale: []
                    },
                    real: { lease: TurnLease.unclaimed(turn) }
                }),
                history
            );
        }),
        { numRuns: 300 }
    );
});

class Claim implements Command<LeaseModel, LeaseSystem> {
    public constructor(
        private readonly holder: number,
        private readonly ttl: number
    ) {}

    public check(model: Readonly<LeaseModel>): boolean {
        return model.holder === undefined;
    }

    public run(model: LeaseModel, system: LeaseSystem): void {
        const expiresAt = model.now + this.ttl;
        system.lease = system.lease.claim(holders[this.holder]!, at(model.now), at(expiresAt));
        model.holder = this.holder;
        model.epoch += 1;
        model.expiresAt = expiresAt;
        assertState(model, system);
    }

    public toString(): string {
        return `claim(${this.holder},+${this.ttl})`;
    }
}

class Renew implements Command<LeaseModel, LeaseSystem> {
    public constructor(private readonly extension: number) {}

    public check(model: Readonly<LeaseModel>): boolean {
        return (
            model.holder !== undefined &&
            model.expiresAt !== undefined &&
            model.expiresAt > model.now
        );
    }

    public run(model: LeaseModel, system: LeaseSystem): void {
        const expiresAt = model.expiresAt! + this.extension;
        system.lease = system.lease.renew(
            holders[model.holder!]!,
            model.epoch,
            at(model.now),
            at(expiresAt)
        );
        model.expiresAt = expiresAt;
        assertState(model, system);
    }

    public toString(): string {
        return `renew(+${this.extension})`;
    }
}

class Advance implements Command<LeaseModel, LeaseSystem> {
    public constructor(private readonly elapsed: number) {}

    public check(): boolean {
        return true;
    }

    public run(model: LeaseModel, system: LeaseSystem): void {
        model.now += this.elapsed;
        assertState(model, system);
    }

    public toString(): string {
        return `advance(+${this.elapsed})`;
    }
}

class Reclaim implements Command<LeaseModel, LeaseSystem> {
    public constructor(
        private readonly holder: number,
        private readonly ttl: number
    ) {}

    public check(model: Readonly<LeaseModel>): boolean {
        return (
            model.holder !== undefined &&
            model.expiresAt !== undefined &&
            model.expiresAt <= model.now
        );
    }

    public run(model: LeaseModel, system: LeaseSystem): void {
        retireCurrent(model);
        const expiresAt = model.now + this.ttl;
        system.lease = system.lease.reclaim(holders[this.holder]!, at(model.now), at(expiresAt));
        model.holder = this.holder;
        model.epoch += 1;
        model.expiresAt = expiresAt;
        assertState(model, system);
    }

    public toString(): string {
        return `reclaim(${this.holder},+${this.ttl})`;
    }
}

class Fence implements Command<LeaseModel, LeaseSystem> {
    public check(): boolean {
        return true;
    }

    public run(model: LeaseModel, system: LeaseSystem): void {
        retireCurrent(model);
        system.lease = system.lease.fence();
        model.holder = undefined;
        model.epoch += 1;
        assertState(model, system);
    }

    public toString(): string {
        return "fence";
    }
}

class RoundTrip implements Command<LeaseModel, LeaseSystem> {
    public check(): boolean {
        return true;
    }

    public run(model: LeaseModel, system: LeaseSystem): void {
        system.lease = TurnLease.decode(TurnLease.encode(system.lease));
        assertState(model, system);
    }

    public toString(): string {
        return "roundTrip";
    }
}

class Probe implements Command<LeaseModel, LeaseSystem> {
    public check(): boolean {
        return true;
    }

    public run(model: LeaseModel, system: LeaseSystem): void {
        assertState(model, system);
    }

    public toString(): string {
        return "probe";
    }
}

class RejectStaleRenew implements Command<LeaseModel, LeaseSystem> {
    public constructor(private readonly extension: number) {}

    public check(model: Readonly<LeaseModel>): boolean {
        return (
            model.holder !== undefined &&
            model.expiresAt !== undefined &&
            model.expiresAt > model.now
        );
    }

    public run(model: LeaseModel, system: LeaseSystem): void {
        const before = system.lease;
        expectLeaseRejection(() =>
            system.lease.renew(
                holders[model.holder!]!,
                model.epoch + 1,
                at(model.now),
                at(model.expiresAt! + this.extension)
            )
        );
        expect(system.lease).toBe(before);
        assertState(model, system);
    }

    public toString(): string {
        return `rejectStaleRenew(+${this.extension})`;
    }
}

class RejectPrematureReclaim implements Command<LeaseModel, LeaseSystem> {
    public constructor(
        private readonly holder: number,
        private readonly ttl: number
    ) {}

    public check(model: Readonly<LeaseModel>): boolean {
        return (
            model.holder !== undefined &&
            model.expiresAt !== undefined &&
            model.expiresAt > model.now
        );
    }

    public run(model: LeaseModel, system: LeaseSystem): void {
        const before = system.lease;
        expectLeaseRejection(() =>
            system.lease.reclaim(holders[this.holder]!, at(model.now), at(model.now + this.ttl))
        );
        expect(system.lease).toBe(before);
        assertState(model, system);
    }

    public toString(): string {
        return `rejectPrematureReclaim(${this.holder},+${this.ttl})`;
    }
}

class RejectDuplicateClaim implements Command<LeaseModel, LeaseSystem> {
    public constructor(
        private readonly holder: number,
        private readonly ttl: number
    ) {}

    public check(model: Readonly<LeaseModel>): boolean {
        return model.holder !== undefined;
    }

    public run(model: LeaseModel, system: LeaseSystem): void {
        const before = system.lease;
        expectLeaseRejection(() =>
            system.lease.claim(holders[this.holder]!, at(model.now), at(model.now + this.ttl))
        );
        expect(system.lease).toBe(before);
        assertState(model, system);
    }

    public toString(): string {
        return `rejectDuplicateClaim(${this.holder},+${this.ttl})`;
    }
}

class RejectExpiredClaim implements Command<LeaseModel, LeaseSystem> {
    public constructor(private readonly holder: number) {}

    public check(model: Readonly<LeaseModel>): boolean {
        return model.holder === undefined;
    }

    public run(model: LeaseModel, system: LeaseSystem): void {
        const before = system.lease;
        expectLeaseRejection(() =>
            system.lease.claim(holders[this.holder]!, at(model.now), at(model.now))
        );
        expect(system.lease).toBe(before);
        assertState(model, system);
    }

    public toString(): string {
        return `rejectExpiredClaim(${this.holder})`;
    }
}

function retireCurrent(model: LeaseModel): void {
    if (model.holder === undefined) return;
    model.stale.push(token(model.holder, model.epoch));
}

function assertState(model: LeaseModel, system: LeaseSystem): void {
    expect(system.lease.turn.equals(turn)).toBe(true);
    expect(system.lease.epoch).toBe(model.epoch);
    expect(system.lease.holder?.equals(holders[model.holder ?? 0]!)).toBe(
        model.holder === undefined ? undefined : true
    );
    expect(system.lease.expiresAt?.getTime()).toBe(model.expiresAt);

    if (model.holder !== undefined && model.expiresAt !== undefined) {
        expect(system.lease.admits(token(model.holder, model.epoch), at(model.now))).toBe(
            model.expiresAt > model.now
        );
    }
    for (const stale of model.stale) {
        expect(system.lease.admits(stale, at(model.now))).toBe(false);
    }
}

function token(holder: number, epoch: number): LeaseToken {
    return { turn, holder: holders[holder]!, epoch };
}

function at(milliseconds: number): Date {
    return new Date(milliseconds);
}

function expectLeaseRejection(operation: () => TurnLease): void {
    try {
        operation();
        expect.fail("invalid lease transition unexpectedly succeeded");
    } catch (error) {
        expect(error).toMatchObject({ code: "lease.invalid" });
    }
}
