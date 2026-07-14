import type { ActorRef, SynchronousResultGuard } from "@agent-core/core";
import type {
    AuthorityPermit,
    AuthorityPermitExpectation,
    AuthorityPermitOwnerStore
} from "@agent-core/core/authority";
import {
    SqliteAuthorityPermitStore,
    type TransactionalSqlite
} from "@agent-core/core/substrates/sqlite";
import { requireSynchronousResult } from "@agent-core/core";
import type { CloudflareSqlite } from "./sqlite.js";

export function createCloudflareAuthorityPermitStore(
    database: CloudflareSqlite,
    owner: ActorRef
): SqliteAuthorityPermitStore {
    return new SqliteAuthorityPermitStore(database, owner);
}

export class CloudflareAuthorityPermitAdmission<Transaction = TransactionalSqlite> {
    public constructor(private readonly store: AuthorityPermitOwnerStore<Transaction>) {}

    public admit<Result>(
        transaction: Transaction,
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date,
        appendEffectAttempt: (transaction: Transaction) => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        this.store.consume(transaction, permit, expected, now);
        return requireSynchronousResult(appendEffectAttempt(transaction));
    }
}
