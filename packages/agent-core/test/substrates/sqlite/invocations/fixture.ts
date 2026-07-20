import { AttemptReceipt, PreEffectReceipt } from "../../../../src/invocations";
import { SqliteInvocationPersistence } from "../../../../src/substrates/sqlite/invocations";
import type { TransactionalSqlite } from "../../../../src/substrates/sqlite";
import {
    attemptCodec,
    claimCodec,
    invocationCodecs,
    preparedCodec
} from "../../../invocations/fixture";

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
                return {
                    id: record.id.value,
                    variant: record.variant,
                    attempt: record.attempt.value,
                    ...(record.previous === undefined ? {} : { previous: record.previous.value }),
                    outcome: record.outcome
                };
            }
            throw new TypeError("Unknown Receipt test record");
        },
        projectContinuation: (record) => ({ invocation: record.invocation.value })
    });
}
