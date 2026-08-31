import { AgentCoreError } from "../errors";
import type { InvocationId } from "../interaction-references";
import type { EffectAttempt } from "./attempt";
import { EffectAttemptId } from "./id";
import type { PreparedInvocation } from "./prepared";

export interface AdmittedInvocationItemInit {
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
    readonly attempt: EffectAttemptId;
}

/**
 * One admitted item of one Invocation, named by exactly the four facts a later message about
 * it must match: the Invocation, the item index, that item's idempotency key, and the exact
 * EffectAttempt admission recorded (§7.3, §7.4).
 *
 * It is derived and disposable, never stored. §8.4 gives each record one owning Actor and
 * forbids a second durable copy, so this value reads the PreparedInvocation and the
 * EffectAttempt that already exist and holds nothing else. It deliberately carries no Receipt
 * and no result: it names work that has been admitted, which is the one thing a Receipt
 * cannot say, and a value that could carry an outcome would let a caller treat a finished
 * item as an admitted one.
 */
export class AdmittedInvocationItem {
    public readonly invocation: InvocationId;
    public readonly itemIndex: number;
    public readonly itemKey: string;
    public readonly attempt: EffectAttemptId;

    /**
     * Reads the item off the two records that own its facts, refusing an attempt that does not
     * belong to exactly this prepared item. Every caller obtains the value this way, so
     * "the attempt matches the item" is established once instead of at each use.
     */
    public static derive<Lease, Authority, Domain, PathEpochs, Admission>(
        prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        attempt: EffectAttempt<Lease, Admission>
    ): AdmittedInvocationItem {
        const item = prepared.item(attempt.itemIndex);
        if (
            !attempt.invocation.equals(prepared.header.id) ||
            attempt.idempotencyKey !== item.idempotencyKey
        ) {
            throw new AgentCoreError(
                "invocation.invalid",
                "EffectAttempt does not belong to its PreparedInvocation item"
            );
        }
        return new AdmittedInvocationItem({
            invocation: prepared.header.id,
            itemIndex: attempt.itemIndex,
            itemKey: item.idempotencyKey,
            attempt: attempt.id
        });
    }

    public constructor(init: AdmittedInvocationItemInit) {
        if (init.attempt.constructor !== EffectAttemptId) {
            throw new TypeError("Admitted Invocation item names its exact EffectAttempt");
        }
        if (!Number.isSafeInteger(init.itemIndex) || init.itemIndex < 0) {
            throw new TypeError("Admitted Invocation item index is invalid");
        }
        if (init.itemKey.length === 0 || init.itemKey !== init.itemKey.trim()) {
            throw new TypeError("Admitted Invocation item key must be canonical");
        }
        this.invocation = init.invocation;
        this.itemIndex = init.itemIndex;
        this.itemKey = init.itemKey;
        this.attempt = init.attempt;
        Object.freeze(this);
    }

    /** True exactly when the four scalar facts a delivery carries name this item. */
    public names(
        invocation: InvocationId,
        itemIndex: number,
        itemKey: string,
        attempt: EffectAttemptId
    ): boolean {
        return (
            this.invocation.equals(invocation) &&
            this.itemIndex === itemIndex &&
            this.itemKey === itemKey &&
            this.attempt.equals(attempt)
        );
    }

    public equals(other: AdmittedInvocationItem): boolean {
        return (
            other instanceof AdmittedInvocationItem &&
            other.names(this.invocation, this.itemIndex, this.itemKey, this.attempt)
        );
    }
}
