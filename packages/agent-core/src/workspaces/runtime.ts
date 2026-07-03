import type { OperationContext } from "../operations";
import type { EventRecord, Subscription, SubscriptionDedupeStore, SubscriptionInvoker, SubscriptionRouteResult } from "./events";
import { MemorySubscriptionDedupeStore, SubscriptionRouter } from "./events";
import type { Invocation, InvocationReceipt } from "../invocations";
import type { WorkspaceId } from "./id";

export interface WorkspaceEventStore {
    append(event: EventRecord): Promise<EventRecord>;
    list(): Promise<readonly EventRecord[]>;
}

export interface WorkspaceSubscriptionStore {
    matching(event: EventRecord): Promise<readonly Subscription[]>;
    list(): Promise<readonly Subscription[]>;
}

export class WorkspaceInvocationRecord {
    public constructor(
        public readonly invocation: Invocation,
        public readonly receipt: InvocationReceipt | undefined
    ) {
    }
}

export interface WorkspaceInvocationStore {
    append(record: WorkspaceInvocationRecord): Promise<WorkspaceInvocationRecord>;
    list(): Promise<readonly WorkspaceInvocationRecord[]>;
}

export class WorkspaceEventResult {
    public constructor(
        public readonly event: EventRecord,
        public readonly route: SubscriptionRouteResult
    ) {
    }
}

export class WorkspaceRuntime {
    public constructor(
        public readonly workspaceId: WorkspaceId,
        private readonly events: WorkspaceEventStore,
        private readonly subscriptions: WorkspaceSubscriptionStore,
        private readonly invocations: WorkspaceInvocationStore,
        private readonly invoker: SubscriptionInvoker,
        private readonly dedupe: SubscriptionDedupeStore = new MemorySubscriptionDedupeStore()
    ) {
    }

    public async acceptEvent(context: OperationContext, event: EventRecord): Promise<WorkspaceEventResult> {
        if (!event.workspaceId.equals(this.workspaceId)) {
            throw new TypeError("Workspace runtime cannot accept Events from another Workspace");
        }

        const accepted = await this.events.append(event);
        const matching = await this.subscriptions.matching(accepted);
        const route = await new SubscriptionRouter(matching, this.invoker, this.dedupe).route(context, accepted);
        for (const invocation of route.invocations) {
            await this.invocations.append(new WorkspaceInvocationRecord(invocation.invocation, invocation.receipt));
        }

        return new WorkspaceEventResult(accepted, route);
    }
}

export class MemoryWorkspaceEventStore implements WorkspaceEventStore {
    readonly #events: EventRecord[] = [];

    public async append(event: EventRecord): Promise<EventRecord> {
        if (this.#events.some(record => record.id.equals(event.id))) {
            throw new TypeError("Workspace Event IDs must be unique");
        }

        this.#events.push(event);
        return event;
    }

    public async list(): Promise<readonly EventRecord[]> {
        return Object.freeze([...this.#events]);
    }
}

export class MemoryWorkspaceSubscriptionStore implements WorkspaceSubscriptionStore {
    public constructor(private readonly subscriptions: readonly Subscription[]) {
    }

    public async matching(event: EventRecord): Promise<readonly Subscription[]> {
        return Object.freeze(this.subscriptions.filter(subscription => subscription.matches(event)));
    }

    public async list(): Promise<readonly Subscription[]> {
        return Object.freeze([...this.subscriptions]);
    }
}

export class MemoryWorkspaceInvocationStore implements WorkspaceInvocationStore {
    readonly #records: WorkspaceInvocationRecord[] = [];

    public async append(record: WorkspaceInvocationRecord): Promise<WorkspaceInvocationRecord> {
        if (this.#records.some(existing => existing.invocation.id.equals(record.invocation.id))) {
            throw new TypeError("Workspace Invocation IDs must be unique");
        }

        this.#records.push(record);
        return record;
    }

    public async list(): Promise<readonly WorkspaceInvocationRecord[]> {
        return Object.freeze([...this.#records]);
    }
}
