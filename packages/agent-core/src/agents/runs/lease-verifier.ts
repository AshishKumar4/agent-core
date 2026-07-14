import type { LeaseToken, TurnLeaseVerifier } from "./lease";
import { TurnLease } from "./lease";
import type { RunRepository } from "./store";

export class MemoryTurnLeaseVerifier implements TurnLeaseVerifier {
    readonly #leases = new Map<string, TurnLease>();

    public constructor(
        leases: readonly TurnLease[] = [],
        private readonly now: () => Date = () => new Date()
    ) {
        for (const lease of leases) this.save(lease);
    }

    public save(lease: TurnLease): void {
        this.#leases.set(lease.turn.value, TurnLease.decode(TurnLease.encode(lease)));
    }

    public permits(token: LeaseToken): boolean {
        return this.#leases.get(token.turn.value)?.admits(token, this.now()) === true;
    }
}

export class RepositoryTurnLeaseVerifier<Transaction> implements TurnLeaseVerifier {
    public constructor(
        private readonly repository: RunRepository<Transaction>,
        private readonly now: () => Date = () => new Date()
    ) {}

    public permits(token: LeaseToken): boolean {
        return this.repository.transaction(
            (transaction) =>
                this.repository
                    .loadTurn(transaction, token.turn)
                    ?.lease.admits(token, this.now()) === true
        );
    }
}
