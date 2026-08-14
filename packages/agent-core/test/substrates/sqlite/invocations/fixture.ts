import { requireSynchronousResult } from "../../../../src/actors";
import { AttemptReceipt, PreEffectReceipt } from "../../../../src/invocations";
import { SqliteInvocationPersistence } from "../../../../src/substrates/sqlite/invocations";
import type { TransactionalSqlite } from "../../../../src/substrates/sqlite";
import {
    attemptCodec,
    claimCodec,
    invocationCodecs,
    preparedCodec
} from "../../../invocations/fixture";

export function runSynchronousSqliteTransaction<Result>(
    database: TransactionalSqlite,
    operation: () => Result
): Result {
    const unset = Symbol("unset");
    let result: Result | typeof unset = unset;
    database.transaction(() => {
        result = requireSynchronousResult(operation());
    });
    if (result === unset) {
        throw new TypeError("SQLite transaction produced no result");
    }
    return result;
}

export function createSqliteInvocationPersistence(database: TransactionalSqlite) {
    return new SqliteInvocationPersistence(database, {
        prepared: preparedCodec,
        approval: invocationCodecs.approval,
        claim: claimCodec,
        attempt: attemptCodec,
        receipt: invocationCodecs.receipt,
        continuation: invocationCodecs.continuation,
        projectPrepared: (record) => ({ id: record.header.id.value }),
        projectApproval: (record) => ({
            id: record.id.value,
            invocation: record.invocation.value,
            revision: record.revision.value,
            phase: record.state.kind
        }),
        projectClaim: (record) => ({
            id: record.id.value,
            invocation: record.invocation.value,
            itemIndex: record.itemIndex,
            ordinal: record.attemptOrdinal
        }),
        projectAttempt: (record) => ({
            id: record.id.value,
            invocation: record.invocation.value,
            itemIndex: record.itemIndex,
            ordinal: record.ordinal,
            claim: record.claim.value
        }),
        projectReceipt: (record) => {
            if (record instanceof PreEffectReceipt) {
                return {
                    id: record.id.value,
                    variant: record.variant,
                    invocation: record.invocation.value,
                    itemIndex: record.itemIndex,
                    outcome: record.outcome
                };
            }
            if (record instanceof AttemptReceipt) {
                const projected = {
                    id: record.id.value,
                    variant: record.variant,
                    attempt: record.attempt.value,
                    outcome: record.outcome
                };
                return record.previous === undefined
                    ? projected
                    : { ...projected, previous: record.previous.value };
            }
            throw new TypeError("Unknown Receipt test record");
        },
        projectContinuation: (record) => ({ invocation: record.invocation.value })
    });
}
