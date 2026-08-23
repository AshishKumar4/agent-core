import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard, TransactionOperation } from "../../src/actors";
import { JsonSchema, Revision } from "../../src/core";
import { WorkspaceId } from "../../src/identity";
import {
    CatalogEntry,
    CatalogOrigin,
    FacetRef,
    OperationDescriptor,
    OperationName,
    type CatalogKind
} from "../../src/facets";
import type { CatalogDeclarationInit } from "../../src/facets/catalog-entry-store";
import { attribution } from "./slot-store-contract";

export interface CatalogStoreContract<Transaction> {
    readonly owner: WorkspaceId;
    transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    loadRevision(transaction: Transaction): Revision;
    saveRevision(transaction: Transaction, revision: Revision): void;
    loadEntry(transaction: Transaction, id: CatalogEntry["id"]): CatalogEntry | undefined;
    loadEntryAt(transaction: Transaction, origin: CatalogOrigin): CatalogEntry | undefined;
    insertEntry(transaction: Transaction, entry: CatalogEntry): void;
    retireEntry(transaction: Transaction, id: CatalogEntry["id"]): void;
    listEntries(transaction: Transaction): readonly CatalogEntry[];
    revision(): Revision;
    entry(id: CatalogEntry["id"]): CatalogEntry | undefined;
    entries(): readonly CatalogEntry[];
    declare(init: CatalogDeclarationInit): Revision;
    contribute(entry: CatalogEntry): Revision;
    withdrawalSet(
        transaction: Transaction,
        contributor: FacetRef
    ): { readonly contributor: FacetRef; readonly entries: readonly CatalogEntry["id"][] };
    retireWithdrawalSet(transaction: Transaction, contributor: FacetRef): boolean;
    withdraw(contributor: FacetRef): Revision;
}

export function workspaceCatalogStoreContract<Transaction>(
    name: string,
    create: (owner: WorkspaceId) => CatalogStoreContract<Transaction>
): void {
    describe(`${name} [workspace-catalog-store] Workspace catalog store`, () => {
        test(
            "persists codec records with deterministic ordering and idempotent replay",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const direct = store.declare(directDeclaration("run"));
                const contributed = store.contribute(attributed("workspace:first", "1.0.0", "resize"));

                expect(direct.value).toBe(1);
                expect(contributed.value).toBe(2);
                expect(
                    store.contribute(attributed("workspace:first", "1.0.0", "resize")).value
                ).toBe(2);

                expect(store.revision().value).toBe(2);
                expect(store.entries().map((entry) => entry.name).sort()).toEqual([
                    "resize",
                    "run"
                ]);
            }
        );

        test(
            "rejects retiring an absent entry, rolls back failed writes, and rejects asynchronous transactions",
            { tags: "p0" },
            async () => {
                const store = create(new WorkspaceId("workspace"));
                const candidate = attributed("workspace:facet", "1.0.0", "resize");

                expect(() =>
                    store.transaction((transaction) =>
                        store.retireEntry(transaction, candidate.id)
                    )
                ).toThrow(/is not contributed/);
                expect(() =>
                    store.transaction((transaction) => {
                        store.insertEntry(transaction, candidate);
                        throw new TypeError("injected rollback");
                    })
                ).toThrow(/injected rollback/);
                expect(store.entry(candidate.id)).toBeUndefined();
                // @ts-expect-error Actor-local transactions statically reject asynchronous callbacks.
                const operation_: TransactionOperation<Transaction, never> = async () => true;
                expect(() => store.transaction(operation_)).toThrow(/synchronous|Promise/);
                await Promise.resolve();
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] carries the contributing Facet and source release on every stored entry",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const candidate = attributed("workspace:facet", "1.0.0", "resize");
                store.contribute(candidate);

                const stored = store.transaction((transaction) =>
                    store.loadEntry(transaction, candidate.id)
                );
                expect(stored?.attribution?.contributor.value).toBe("workspace:facet");
                expect(stored?.attribution?.package.equals(attribution("workspace:facet").package))
                    .toBe(true);
                expect(stored?.origin.key).toBe(candidate.origin.key);
                expect(
                    store
                        .transaction((transaction) =>
                            store.withdrawalSet(transaction, new FacetRef("workspace:facet"))
                        )
                        .entries.map((held) => held.value)
                ).toEqual([candidate.id.value]);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] supersedes a changed declaration instead of accreting beside it",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(withHelp("workspace:facet", "1.0.0", "Before"));
                const revision = store.revision().value;

                expect(store.contribute(withHelp("workspace:facet", "1.0.0", "After")).value).toBe(
                    revision + 1
                );

                const held = store.entries();
                expect(held).toHaveLength(1);
                // SAFETY: the fixture builds operation descriptors directly, so only this cast
                // reads the optional field the identity test asserts on.
                expect((held[0]!.declaration as OperationDescriptor).help).toBe("After");
                // The withdrawal set of §4.1 is a query over attribution, so the superseded
                // predecessor must not survive in it as a second record to retire.
                expect(
                    store
                        .transaction((transaction) =>
                            store.withdrawalSet(transaction, new FacetRef("workspace:facet"))
                        )
                        .entries
                ).toHaveLength(1);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] re-reads the same contribution from a later release by superseding the entry pinned to the earlier one",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(attributed("workspace:facet", "1.0.0", "resize"));
                const revision = store.revision().value;

                expect(store.contribute(attributed("workspace:facet", "2.0.0", "resize")).value).toBe(
                    revision + 1
                );

                const held = store.entries();
                expect(held).toHaveLength(1);
                expect(held[0]!.attribution!.package.version.toString()).toBe("2.0.0");
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] re-materializing the same contribution from the same release is the same entry and changes nothing",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const candidate = attributed("workspace:facet", "1.0.0", "resize");
                store.contribute(candidate);
                const revision = store.revision().value;
                const bytes = CatalogEntry.encode(candidate);

                expect(
                    store.contribute(attributed("workspace:facet", "1.0.0", "resize")).value
                ).toBe(revision);

                const held = store.entries();
                expect(held).toHaveLength(1);
                expect([...CatalogEntry.encode(held[0]!)]).toEqual([...bytes]);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] keys a position by its owner and holds one origin to one record",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(attributed("workspace:mine", "1.0.0", "resize"));

                // Another Facet contributing the same name occupies a different §4.2
                // position — owner, kind, name — so both records exist and neither
                // rewrites the other; the ids differ because the pair is digested in.
                expect(() =>
                    store.contribute(attributed("workspace:theirs", "1.0.0", "resize"))
                ).not.toThrow();
                const sameName = store.entries().filter((entry) => entry.name === "resize");
                expect(
                    sameName.map((entry) => entry.attribution!.contributor.value).sort()
                ).toEqual(["workspace:mine", "workspace:theirs"]);

                // Exclusivity is only observable while the storage primitive cannot be made
                // to overwrite behind it: one owner's occupied origin refuses a second
                // record outright, so the refusal is asserted at `insertEntry`.
                expect(() =>
                    store.transaction((transaction) =>
                        store.insertEntry(
                            transaction,
                            withHelp("workspace:mine", "1.0.0", "Rewritten")
                        )
                    )
                ).toThrow(/Catalog operation resize is already held by workspace:mine/);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] refuses to rewrite a stored entry in place",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const held = withHelp("workspace:facet", "1.0.0", "Held");
                store.contribute(held);
                const revision = store.revision().value;

                // Attribution is immutable for the record's lifetime, so supersession is a
                // retirement plus a fresh materialization and never a write over the bytes.
                expect(() =>
                    store.transaction((transaction) =>
                        store.insertEntry(transaction, withHelp("workspace:facet", "1.0.0", "Rewritten"))
                    )
                ).toThrow(
                    /Catalog operation resize is already held by workspace:facet/
                );

                expect(store.revision().value).toBe(revision);
                // SAFETY: as above, the stored declaration is the descriptor the fixture built.
                expect((store.entries()[0]!.declaration as OperationDescriptor).help).toBe("Held");
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] refuses a contribution path that claims provenance it was not minted",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const unattributed = new CatalogEntry(
                    "operation",
                    "resize",
                    descriptor("resize"),
                    undefined
                );
                expect(() => store.contribute(unattributed)).toThrow(
                    /requires its authenticated attribution/
                );
                expect(store.revision().value).toBe(0);
                expect(store.entries()).toHaveLength(0);
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] retires exactly the withdrawing Facet's entries and leaves direct and other-Facet records untouched",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const direct = new CatalogEntry("operation", "run", descriptor("run"), undefined);
                store.declare(directDeclaration("run"));
                const mine = attributed("workspace:mine", "1.0.0", "resize");
                const alsoMine = attributed("workspace:mine", "1.0.0", "crop");
                const theirs = attributed("workspace:theirs", "1.0.0", "rotate");
                store.contribute(mine);
                store.contribute(alsoMine);
                store.contribute(theirs);
                const directBytes = CatalogEntry.encode(direct);
                const theirBytes = CatalogEntry.encode(theirs);

                const set = store.transaction((transaction) =>
                    store.withdrawalSet(transaction, new FacetRef("workspace:mine"))
                );
                expect(set.contributor.value).toBe("workspace:mine");
                expect(set.entries.map((held) => held.value)).toEqual(
                    [mine.id.value, alsoMine.id.value].sort()
                );
                expect(Object.isFrozen(set.entries)).toBe(true);

                store.withdraw(new FacetRef("workspace:mine"));

                expect(store.entry(mine.id)).toBeUndefined();
                expect(store.entry(alsoMine.id)).toBeUndefined();
                const retained = store.entry(theirs.id);
                expect(retained).toBeDefined();
                expect([...CatalogEntry.encode(retained!)]).toEqual([...theirBytes]);
                // The host's direct declaration carries no attribution, so the withdrawal
                // query never reaches it even while a withdrawn Facet named the same kind.
                const survivingDirect = store.entries().find((entry) => entry.attribution === undefined)!;
                expect([...CatalogEntry.encode(survivingDirect)]).toEqual([...directBytes]);
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] leaves a Facet that contributed nothing unchanged",
            { tags: "p1" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(attributed("workspace:facet", "1.0.0", "resize"));
                const before = store.revision().value;

                expect(store.withdraw(new FacetRef("workspace:absent")).value).toBe(before);
                expect(
                    store.transaction((transaction) =>
                        store.retireWithdrawalSet(transaction, new FacetRef("workspace:absent"))
                    )
                ).toBe(false);
                expect(store.entries()).toHaveLength(1);
            }
        );
    });
}

export function descriptor(name: string): OperationDescriptor {
    const schema = new JsonSchema({ type: "object" });
    return new OperationDescriptor(new OperationName(name), "mutate", schema, schema);
}

export function directDeclaration(
    name: string,
    kind: CatalogKind = "operation"
): CatalogDeclarationInit {
    return { kind, name, declaration: descriptor(name) };
}

/**
 * Only the release version varies, so an identity or supersession difference between two
 * contributions of one Facet is attributable to the release alone.
 */
export function attributed(
    contributor: string,
    version: string,
    name: string,
    kind: CatalogKind = "operation"
): CatalogEntry {
    return new CatalogEntry(kind, name, descriptor(name), attribution(contributor, version));
}

export function withHelp(contributor: string, version: string, help: string): CatalogEntry {
    const schema = new JsonSchema({ type: "object" });
    const declaration = new OperationDescriptor(new OperationName("resize"), "mutate", schema, schema, help);
    return new CatalogEntry("operation", "resize", declaration, attribution(contributor, version));
}
