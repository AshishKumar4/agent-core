import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard, TransactionOperation } from "../../src/actors";
import { JsonSchema, Revision } from "../../src/core";
import { WorkspaceId } from "../../src/identity";
import {
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotEntry,
    SlotName,
    type FacetData
} from "../../src/facets";

export interface SlotStoreContract<Transaction> {
    readonly owner: WorkspaceId;
    transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    loadRevision(transaction: Transaction): Revision;
    saveRevision(transaction: Transaction, revision: Revision): void;
    loadSlot(transaction: Transaction, name: SlotName): SlotDeclaration | undefined;
    insertSlot(transaction: Transaction, declaration: SlotDeclaration): void;
    loadEntry(transaction: Transaction, id: SlotEntry["id"]): SlotEntry | undefined;
    listEntries(transaction: Transaction, slot: SlotName): readonly SlotEntry[];
    insertEntry(transaction: Transaction, entry: SlotEntry): void;
    revision(): Revision;
    slot(name: SlotName): SlotDeclaration | undefined;
    entries(name: SlotName): readonly SlotEntry[];
    install(declaration: SlotDeclaration): Revision;
    contribute(entry: SlotEntry): Revision;
}

export function workspaceSlotStoreContract<Transaction>(
    name: string,
    create: (owner: WorkspaceId) => SlotStoreContract<Transaction>
): void {
    describe(`${name} [workspace-slot-store] Workspace Slot store`, () => {
        test("persists codec records with deterministic ordering and idempotent replay", () => {
            const store = create(new WorkspaceId("workspace"));
            const declaration = slot();
            const second = entry("workspace:second", 20, { title: "Second" });
            const first = entry("workspace:first", 10, { title: "First" });

            install(store, declaration);
            install(store, declaration);
            contribute(store, second);
            contribute(store, first);
            contribute(store, first);

            expect(store.transaction((transaction) => store.loadRevision(transaction)).value).toBe(
                3
            );
            expect(
                store
                    .transaction((transaction) => store.listEntries(transaction, declaration.name))
                    .map((value) => value.value)
            ).toEqual([{ title: "First" }, { title: "Second" }]);
            expect(
                store
                    .transaction((transaction) => store.loadEntry(transaction, first.id))
                    ?.id.equals(first.id)
            ).toBe(true);
        });

        test("rejects missing slots, invalid schemas, and conflicting contribution origins", () => {
            const store = create(new WorkspaceId("workspace"));
            const declaration = slot();
            const accepted = entry("workspace:facet", 1, { title: "Accepted" });
            const conflict = entry("workspace:facet", 1, { title: "Conflict" });

            expect(() => contribute(store, accepted)).toThrow(/not installed/);
            install(store, declaration);
            expect(() => contribute(store, entry("workspace:bad", 2, { value: 1 }))).toThrow(
                /schema/
            );
            contribute(store, accepted);
            expect(() => contribute(store, conflict)).toThrow(/immutable|UNIQUE/);
            expect(
                store.transaction((transaction) => store.listEntries(transaction, declaration.name))
            ).toHaveLength(1);
        });

        test("rolls back failed writes and rejects asynchronous transactions", async () => {
            const store = create(new WorkspaceId("workspace"));
            const declaration = slot();
            expect(() =>
                store.transaction((transaction) => {
                    store.insertSlot(transaction, declaration);
                    throw new TypeError("injected rollback");
                })
            ).toThrow(/injected rollback/);
            expect(
                store.transaction((transaction) => store.loadSlot(transaction, declaration.name))
            ).toBeUndefined();

            const operation = (async () => true) as unknown as TransactionOperation<
                Transaction,
                never
            >;
            expect(() => store.transaction(operation)).toThrow(/synchronous|Promise/);
            await Promise.resolve();
        });
    });
}

export function slot(): SlotDeclaration {
    return new SlotDeclaration(
        new SlotName("dashboard.card"),
        new JsonSchema({
            type: "object",
            required: ["title"],
            properties: { title: { type: "string" } },
            additionalProperties: false
        }),
        new SlotAuthorityPolicy(["installed"], ["binding:dashboard.read"])
    );
}

export function entry(contributor: string, ordinal: number, value: FacetData): SlotEntry {
    return SlotEntry.create(new SlotName("dashboard.card"), contributor, ordinal, value);
}

export function install<Transaction>(
    store: SlotStoreContract<Transaction>,
    declaration: SlotDeclaration
): Revision {
    return store.install(declaration);
}

export function contribute<Transaction>(
    store: SlotStoreContract<Transaction>,
    candidate: SlotEntry
): Revision {
    return store.contribute(candidate);
}
