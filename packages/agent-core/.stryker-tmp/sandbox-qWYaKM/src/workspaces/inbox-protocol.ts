// @ts-nocheck
import type { LeaseToken } from "../agents";
import { AgentCoreError } from "../errors";
import type { RunInboxOutcome, RunInboxPort } from "./ports";
import { InboxEventReference } from "./inbox";

export class InboxProtocol<Transaction> {
    public constructor(private readonly runs: RunInboxPort<Transaction>) {}

    public append(
        transaction: Transaction,
        reference: InboxEventReference,
        lease: LeaseToken
    ): RunInboxOutcome {
        if (!reference.turn.equals(lease.turn) || reference.leaseEpoch !== lease.epoch) {
            throw new AgentCoreError(
                "lease.invalid",
                "Inbox delivery requires the exact current Turn lease"
            );
        }
        const outcome = this.runs.append(transaction, reference, lease);
        if (outcome.kind === "rejected") {
            throw new AgentCoreError(
                outcome.reason === "lease" ? "lease.invalid" : "turn.invalid-state",
                outcome.reason === "lease"
                    ? "Inbox delivery requires the exact current Turn lease"
                    : `Run inbox rejected delivery: ${outcome.reason}`
            );
        }
        return outcome;
    }
}
