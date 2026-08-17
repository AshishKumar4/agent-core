import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard, TransactionOperation } from "../../src/actors";
import { Digest, JsonSchema, Revision, SemVer } from "../../src/core";
import { PackageId, PackagePin } from "../../src/definition-references";
import { WorkspaceId } from "../../src/identity";
import {
    ContributionAttribution,
    FacetRef,
    InstalledSlot,
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotEntry,
    SlotName,
    type FacetData,
    type SlotContributionOrigin,
    type SlotWithdrawalSet
} from "../../src/facets";

export interface SlotStoreContract<Transaction> {
    readonly owner: WorkspaceId;
    transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    loadRevision(transaction: Transaction): Revision;
    saveRevision(transaction: Transaction, revision: Revision): void;
    loadSlot(transaction: Transaction, name: SlotName): InstalledSlot | undefined;
    insertSlot(transaction: Transaction, slot: InstalledSlot): void;
    retireSlot(transaction: Transaction, name: SlotName): void;
    listSlots(transaction: Transaction): readonly InstalledSlot[];
    loadEntry(transaction: Transaction, id: SlotEntry["id"]): SlotEntry | undefined;
    loadEntryAt(transaction: Transaction, origin: SlotContributionOrigin): SlotEntry | undefined;
    listEntries(transaction: Transaction, slot: SlotName): readonly SlotEntry[];
    listAllEntries(transaction: Transaction): readonly SlotEntry[];
    insertEntry(transaction: Transaction, entry: SlotEntry): void;
    retireEntry(transaction: Transaction, id: SlotEntry["id"]): void;
    revision(): Revision;
    slot(name: SlotName): InstalledSlot | undefined;
    entries(name: SlotName): readonly SlotEntry[];
    install(slot: InstalledSlot): Revision;
    contribute(entry: SlotEntry): Revision;
    withdrawalSet(transaction: Transaction, contributor: FacetRef): SlotWithdrawalSet;
    retireWithdrawalSet(transaction: Transaction, contributor: FacetRef): boolean;
    withdraw(contributor: FacetRef): Revision;
}

export function workspaceSlotStoreContract<Transaction>(
    name: string,
    create: (owner: WorkspaceId) => SlotStoreContract<Transaction>
): void {
    describe(`${name} [workspace-slot-store] Workspace Slot store`, () => {
        test(
            "persists codec records with deterministic ordering and idempotent replay",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const declaration = slot();
                const second = entry("workspace:second", 20, { title: "Second" });
                const first = entry("workspace:first", 10, { title: "First" });

                install(store, declaration);
                install(store, declaration);
                contribute(store, second);
                contribute(store, first);
                contribute(store, first);

                expect(
                    store.transaction((transaction) => store.loadRevision(transaction)).value
                ).toBe(3);
                expect(
                    store
                        .transaction((transaction) =>
                            store.listEntries(transaction, declaration.declaration.name)
                        )
                        .map((value) => value.value)
                ).toEqual([{ title: "First" }, { title: "Second" }]);
                expect(
                    store
                        .transaction((transaction) => store.loadEntry(transaction, first.id))
                        ?.id.equals(first.id)
                ).toBe(true);
            }
        );

        test(
            "rejects missing slots, invalid schemas, and conflicting contribution origins",
            { tags: "p1" },
            () => {
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
                // §4.2 origin exclusivity belongs to the storage primitive: `contribute`
                // supersedes at an occupied position, so `insertEntry` must refuse to write
                // a second entry there rather than make that supersession unobservable.
                expect(() =>
                    store.transaction((transaction) => store.insertEntry(transaction, conflict))
                ).toThrow(/already occupies/);
                expect(
                    store.transaction((transaction) =>
                        store.listEntries(transaction, declaration.declaration.name)
                    )
                ).toHaveLength(1);
            }
        );

        test(
            "rolls back failed writes and rejects asynchronous transactions",
            { tags: "p0" },
            async () => {
                const store = create(new WorkspaceId("workspace"));
                const declaration = slot();
                expect(() =>
                    store.transaction((transaction) => {
                        store.insertSlot(transaction, declaration);
                        throw new TypeError("injected rollback");
                    })
                ).toThrow(/injected rollback/);
                expect(
                    store.transaction((transaction) =>
                        store.loadSlot(transaction, declaration.declaration.name)
                    )
                ).toBeUndefined();

                // @ts-expect-error Actor-local transactions statically reject asynchronous callbacks.
                const operation: TransactionOperation<Transaction, never> = async () => true;
                expect(() => store.transaction(operation)).toThrow(/synchronous|Promise/);
                await Promise.resolve();
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] carries the contributing Facet and source release on every stored record",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const declaration = slot();
                install(store, declaration);
                const candidate = entry("workspace:facet", 1, { title: "Card" });
                contribute(store, candidate);

                const stored = store.transaction((transaction) =>
                    store.loadEntry(transaction, candidate.id)
                );
                expect(stored?.attribution.contributor.value).toBe("workspace:facet");
                expect(stored?.attribution.package.equals(pin("workspace:facet"))).toBe(true);
                expect(
                    store
                        .transaction((transaction) => store.listSlots(transaction))
                        .map((installed) => installed.attribution.contributor.value)
                ).toEqual(["workspace:declarer"]);

                // The pin is a declared field, so the same contribution read from another
                // release is a different entry rather than the same one rewritten.
                const rereleased = new SlotEntry(
                    candidate.slot,
                    new ContributionAttribution(
                        candidate.attribution.contributor,
                        pin("workspace:facet", "2.0.0")
                    ),
                    candidate.ordinal,
                    candidate.value
                );
                expect(rereleased.id.equals(candidate.id)).toBe(false);
                expect(rereleased.origin.equals(candidate.origin)).toBe(true);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] supersedes a changed contribution at the same origin instead of accreting beside it",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const declaration = slot();
                install(store, declaration);
                const before = entry("workspace:facet", 1, { title: "Before" });
                const after = entry("workspace:facet", 1, { title: "After" });
                contribute(store, before);
                const revision = store.revision().value;

                expect(contribute(store, after).value).toBe(revision + 1);

                expect(
                    store.entries(declaration.declaration.name).map((held) => held.value)
                ).toEqual([{ title: "After" }]);
                expect(
                    store.transaction((transaction) => store.loadEntry(transaction, before.id))
                ).toBeUndefined();
                expect(
                    store.transaction((transaction) => store.loadEntryAt(transaction, after.origin))
                        ?.id.value
                ).toBe(after.id.value);
                // The withdrawal set of §4.1 is a query over attribution, so the superseded
                // predecessor must not survive in it as a second record to retire.
                expect(
                    store
                        .transaction((transaction) =>
                            store.withdrawalSet(transaction, new FacetRef("workspace:facet"))
                        )
                        .entries.map((id) => id.value)
                ).toEqual([after.id.value]);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] re-reads the same contribution from a later release by superseding the entry attributed to the earlier one",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const declaration = slot();
                install(store, declaration);
                const first = entry("workspace:facet", 1, { title: "Card" });
                const upgraded = new SlotEntry(
                    first.slot,
                    new ContributionAttribution(
                        first.attribution.contributor,
                        pin("workspace:facet", "2.0.0")
                    ),
                    first.ordinal,
                    first.value
                );
                contribute(store, first);
                const revision = store.revision().value;

                expect(contribute(store, upgraded).value).toBe(revision + 1);

                const held = store.entries(declaration.declaration.name);
                expect(held).toHaveLength(1);
                expect(held[0]!.attribution.package.version.toString()).toBe("2.0.0");
                expect(
                    store.transaction((transaction) => store.loadEntry(transaction, first.id))
                ).toBeUndefined();
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] re-materializing the same contribution from the same release is the same entry and changes nothing",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const declaration = slot();
                install(store, declaration);
                const candidate = entry("workspace:facet", 1, { title: "Card" });
                contribute(store, candidate);
                const revision = store.revision().value;

                expect(
                    contribute(store, entry("workspace:facet", 1, { title: "Card" })).value
                ).toBe(revision);

                const held = store.entries(declaration.declaration.name);
                expect(held).toHaveLength(1);
                expect(held[0]!.id.value).toBe(candidate.id.value);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] supersedes only the contributing Facet's own entry at that ordinal",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const declaration = slot();
                install(store, declaration);
                const mine = entry("workspace:mine", 1, { title: "Mine" });
                const theirs = entry("workspace:theirs", 1, { title: "Theirs" });
                const replacement = entry("workspace:mine", 1, { title: "Replaced" });
                contribute(store, mine);
                contribute(store, theirs);
                const theirBytes = SlotEntry.encode(theirs);

                contribute(store, replacement);

                const held = store.entries(declaration.declaration.name);
                expect(held.map((entry) => entry.attribution.contributor.value).sort()).toEqual([
                    "workspace:mine",
                    "workspace:theirs"
                ]);
                const retained = store.transaction((transaction) =>
                    store.loadEntry(transaction, theirs.id)
                );
                expect([...SlotEntry.encode(retained!)]).toEqual([...theirBytes]);
                expect(
                    store.transaction((transaction) => store.loadEntry(transaction, mine.id))
                ).toBeUndefined();
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] refuses to write a second entry at an occupied origin, with no partial effect",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const declaration = slot();
                install(store, declaration);
                const held = entry("workspace:facet", 1, { title: "Held" });
                const second = entry("workspace:facet", 1, { title: "Second" });
                contribute(store, held);
                const revision = store.revision().value;

                // Supersession is only observable while the storage primitive cannot be made
                // to accrete behind it, so the refusal is asserted at `insertEntry` itself.
                expect(() =>
                    store.transaction((transaction) => store.insertEntry(transaction, second))
                ).toThrow(/already occupies workspace:facet at ordinal 1 of slot dashboard\.card/);

                expect(store.revision().value).toBe(revision);
                expect(
                    store.entries(declaration.declaration.name).map((kept) => kept.id.value)
                ).toEqual([held.id.value]);
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] retires exactly the withdrawing Facet's records and refuses a set holding a retained contribution",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                install(store, declarerSlot("dashboard.card"));
                install(store, declarerSlot("dashboard.panel", "workspace:first"));
                const first = entry("workspace:first", 1, { title: "First" });
                const second = entry("workspace:second", 2, { title: "Second" });
                const firstElsewhere = new SlotEntry(
                    new SlotName("dashboard.panel"),
                    attribution("workspace:first"),
                    3,
                    { title: "Panel" }
                );
                contribute(store, first);
                contribute(store, second);
                contribute(store, firstElsewhere);
                const secondBytes = SlotEntry.encode(second);

                const set = store.transaction((transaction) =>
                    store.withdrawalSet(transaction, new FacetRef("workspace:first"))
                );
                expect(set.entries.map((id) => id.value).sort()).toEqual(
                    [first.id.value, firstElsewhere.id.value].sort()
                );
                expect(set.slots.map((slotName) => slotName.value)).toEqual(["dashboard.panel"]);

                store.withdraw(new FacetRef("workspace:first"));

                expect(
                    store.transaction((transaction) => store.loadEntry(transaction, first.id))
                ).toBeUndefined();
                expect(
                    store.transaction((transaction) =>
                        store.loadSlot(transaction, new SlotName("dashboard.panel"))
                    )
                ).toBeUndefined();
                const retained = store.transaction((transaction) =>
                    store.loadEntry(transaction, second.id)
                );
                expect(retained).toBeDefined();
                expect([...SlotEntry.encode(retained!)]).toEqual([...secondBytes]);
                expect(
                    store.transaction((transaction) =>
                        store.loadSlot(transaction, new SlotName("dashboard.card"))
                    )
                ).toBeDefined();
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] refuses a withdrawal whose Slot still carries a retained Facet's entry, with no partial effect",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                install(store, declarerSlot("dashboard.card"));
                const declarerEntry = new SlotEntry(
                    new SlotName("dashboard.card"),
                    attribution("workspace:declarer"),
                    0,
                    { title: "Own" }
                );
                const retainedEntry = entry("workspace:retained", 1, { title: "Retained" });
                contribute(store, declarerEntry);
                contribute(store, retainedEntry);
                const before = store.revision().value;

                expect(() => store.withdraw(new FacetRef("workspace:declarer"))).toThrow(
                    /still contributes/
                );

                expect(store.revision().value).toBe(before);
                expect(
                    store.transaction((transaction) =>
                        store.loadEntry(transaction, declarerEntry.id)
                    )
                ).toBeDefined();
                expect(
                    store.transaction((transaction) =>
                        store.loadEntry(transaction, retainedEntry.id)
                    )
                ).toBeDefined();
                expect(
                    store.transaction((transaction) =>
                        store.loadSlot(transaction, new SlotName("dashboard.card"))
                    )
                ).toBeDefined();
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] leaves a Facet that contributed nothing unchanged",
            { tags: "p1" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                install(store, slot());
                contribute(store, entry("workspace:facet", 1, { title: "Card" }));
                const before = store.revision().value;

                expect(store.withdraw(new FacetRef("workspace:absent")).value).toBe(before);
                expect(store.entries(new SlotName("dashboard.card"))).toHaveLength(1);
            }
        );
    });
}

export function digestFor(seed: string): Digest {
    let value = "";
    for (let index = 0; value.length < 64; index += 1) {
        value += Buffer.from(`${seed}:${index}`).toString("hex");
    }
    return new Digest(value.slice(0, 64));
}

/**
 * Only the release version varies, so an identity or supersession difference between two
 * pins of one Package is attributable to the release alone.
 */
export function pin(contributor: string, version = "1.0.0"): PackagePin {
    return new PackagePin(
        new PackageId(contributor),
        new SemVer(version),
        digestFor(`${contributor}:manifest`),
        digestFor(`${contributor}:code`)
    );
}

export function attribution(contributor: string): ContributionAttribution {
    return new ContributionAttribution(new FacetRef(contributor), pin(contributor));
}

export function declaration(name = "dashboard.card"): SlotDeclaration {
    return new SlotDeclaration(
        new SlotName(name),
        new JsonSchema({
            type: "object",
            required: ["title"],
            properties: { title: { type: "string" } },
            additionalProperties: false
        }),
        new SlotAuthorityPolicy(["installed"], ["binding:dashboard.read"])
    );
}

export function slot(): InstalledSlot {
    return declarerSlot("dashboard.card");
}

export function declarerSlot(name: string, contributor = "workspace:declarer"): InstalledSlot {
    return new InstalledSlot(declaration(name), attribution(contributor));
}

export function entry(contributor: string, ordinal: number, value: FacetData): SlotEntry {
    return new SlotEntry(new SlotName("dashboard.card"), attribution(contributor), ordinal, value);
}

export function install<Transaction>(
    store: SlotStoreContract<Transaction>,
    installed: InstalledSlot
): Revision {
    return store.install(installed);
}

export function contribute<Transaction>(
    store: SlotStoreContract<Transaction>,
    candidate: SlotEntry
): Revision {
    return store.contribute(candidate);
}
