import { ActorId, ActorRef } from "../../src/actors";
import {
    ContentRecordCustody,
    MemoryContentStore,
    type ContentCustodyPort,
    type MemoryContentRetentionState,
    type RetainedContentRecord
} from "../../src/content";
import { TenantId } from "../../src/identity";

/**
 * One custody call a store made, as a recording seam observes it. Tests that exercise a
 * store's own contract rather than its custody assert over these instead of standing up a
 * ContentStore: retention itself is proven once, against both substrates, by
 * test/content/retention-contract.ts.
 */
export interface RecordedCustodyCall {
    readonly operation: "retain" | "release";
    readonly record: RetainedContentRecord;
    readonly previous: RetainedContentRecord | undefined;
}

export interface RecordingContentCustody<Transaction> extends ContentCustodyPort<Transaction> {
    readonly calls: readonly RecordedCustodyCall[];
    /** The owner keys this custody was asked to hold, in the order the store named them. */
    retainedKeys(): readonly string[];
}

/**
 * A custody seam that records what a store registered without holding content itself. It is
 * a test double for the store contract only: a store wired to it still has to name every
 * ContentRef its record shape declares, which is what the recording asserts.
 */
export function recordingCustody<Transaction>(): RecordingContentCustody<Transaction> {
    const calls: RecordedCustodyCall[] = [];
    return {
        calls,
        retain(_transaction: Transaction, record, previous): void {
            calls.push(Object.freeze({ operation: "retain", record, previous }));
        },
        release(_transaction: Transaction, record): void {
            calls.push(Object.freeze({ operation: "release", record, previous: undefined }));
        },
        retainedKeys(): readonly string[] {
            return calls
                .filter((call) => call.operation === "retain")
                .flatMap((call) => call.record.fields.map((field) => field.field));
        }
    };
}

export const custodyTenant = new TenantId("custody-tenant");
export const custodySlateActor = new ActorRef("slate", new ActorId("custody-slate"));
export const custodyEnvironmentActor = new ActorRef("environment", new ActorId("custody-env"));
export const custodyTenantActor = new ActorRef("tenant", new ActorId("custody-tenant-actor"));
export const custodyWorkspaceActor = new ActorRef("workspace", new ActorId("custody-workspace"));

/**
 * The real seam over an in-memory ContentStore: a store wired to this registers into the
 * same `ContentRetention` the collection sweep reads, so content a record names survives a
 * collection pass and content nothing names does not.
 */
export function memoryCustody(
    store: MemoryContentStore,
    actor: ActorRef,
    now: () => Date = () => new Date(1_000)
): ContentRecordCustody<MemoryContentRetentionState> {
    return new ContentRecordCustody(store.retention(custodyTenant, actor), now);
}
