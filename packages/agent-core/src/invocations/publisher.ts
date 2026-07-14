import type {
    InvocationCommitPort,
    InvocationEventPort,
    InvocationEvidencePersistence,
    InvocationTransactionPort
} from "./ports";
import { AgentCoreError } from "../errors";

export class InvocationPublicationDrainer<Transaction> {
    public constructor(
        private readonly transactions: InvocationTransactionPort<Transaction>,
        private readonly persistence: InvocationEvidencePersistence<Transaction>,
        private readonly events: InvocationEventPort,
        private readonly commits: InvocationCommitPort,
        private readonly now: () => Date
    ) {}

    public async flush(): Promise<void> {
        const pending = this.transactions.transact((transaction) =>
            this.persistence.pendingPublications(transaction)
        );
        for (const publication of pending) {
            let current = this.transactions.transact((transaction) =>
                this.persistence.publication(transaction, publication.id)
            );
            if (current?.state.kind !== "pending") continue;
            if (current.state.eventPublishedAt === undefined) {
                await this.events.publish(current.id, current.observation);
                current = this.acknowledge(current.id, "event");
            }
            if (current.state.kind === "pending" && current.state.commitAppendedAt === undefined) {
                await this.commits.append(current.id, current.observation);
                this.acknowledge(current.id, "commit");
            }
        }
    }

    private acknowledge(
        id: Parameters<InvocationEvidencePersistence<Transaction>["publication"]>[1],
        sink: "event" | "commit"
    ) {
        return this.transactions.transact((transaction) => {
            const current = this.persistence.publication(transaction, id);
            if (current === undefined) {
                throw new AgentCoreError(
                    "invocation.invalid",
                    "Publication disappeared during acknowledgement"
                );
            }
            if (current.state.kind === "published") return current;
            if (
                (sink === "event" && current.state.eventPublishedAt !== undefined) ||
                (sink === "commit" && current.state.commitAppendedAt !== undefined)
            ) {
                return current;
            }
            const next =
                sink === "event"
                    ? current.eventPublished(this.now())
                    : current.commitAppended(this.now());
            this.persistence.appendPublication(transaction, next);
            return next;
        });
    }
}
