import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard, TransactionOperation } from "../../src/actors";
import { Revision } from "../../src/core";
import { WorkspaceId } from "../../src/identity";
import {
    ContributionAttribution,
    FacetRef,
    Prompt,
    PromptSection,
    PromptSectionId,
    type PromptSectionContributionOrigin,
    type PromptWithdrawalSet
} from "../../src/facets";
import { attribution, pin } from "./slot-store-contract";

export interface PromptStoreContract<Transaction> {
    readonly owner: WorkspaceId;
    transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    loadRevision(transaction: Transaction): Revision;
    saveRevision(transaction: Transaction, revision: Revision): void;
    loadSection(transaction: Transaction, id: PromptSectionId): PromptSection | undefined;
    loadSectionAt(
        transaction: Transaction,
        origin: PromptSectionContributionOrigin
    ): PromptSection | undefined;
    listSections(transaction: Transaction): readonly PromptSection[];
    insertSection(transaction: Transaction, section: PromptSection): void;
    retireSection(transaction: Transaction, id: PromptSectionId): void;
    revision(): Revision;
    assembledSections(): readonly PromptSection[];
    sectionsOf(contributor: FacetRef): readonly PromptSection[];
    contribute(attribution: ContributionAttribution, declaration: readonly Prompt[]): Revision;
    withdrawalSet(transaction: Transaction, attribution: ContributionAttribution): PromptWithdrawalSet;
    retireWithdrawalSet(transaction: Transaction, attribution: ContributionAttribution): boolean;
    withdraw(attribution: ContributionAttribution): Revision;
}

export function section(
    contributor: string,
    position: number,
    title: string,
    body = `${title} body`,
    priority = 0
): PromptSection {
    return new PromptSection(title, body, priority, attribution(contributor), position);
}

export function workspacePromptStoreContract<Transaction>(
    name: string,
    create: (owner: WorkspaceId) => PromptStoreContract<Transaction>
): void {
    describe(`${name} [workspace-prompt-store] Workspace prompt section store`, () => {
        test(
            "persists codec records with deterministic assembly order and idempotent replay",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const late = [new Prompt("Second", "Second body", 20)];
                const early = [new Prompt("First", "First body", 10)];

                expect(store.contribute(attribution("workspace:second"), late).value).toBe(1);
                expect(store.contribute(attribution("workspace:first"), early).value).toBe(2);
                // Re-materializing the same contribution from the same release changes nothing.
                expect(store.contribute(attribution("workspace:first"), early).value).toBe(2);

                expect(store.revision().value).toBe(2);
                expect(store.assembledSections().map((held) => held.title)).toEqual([
                    "First",
                    "Second"
                ]);
                const stored = store.transaction((transaction) =>
                    store.loadSection(
                        transaction,
                        section("workspace:first", 0, "First", "First body", 10).id
                    )
                );
                expect(stored?.attribution.contributor.value).toBe("workspace:first");
                expect(stored?.attribution.package.equals(pin("workspace:first"))).toBe(true);
                expect(store.sectionsOf(new FacetRef("workspace:absent"))).toHaveLength(0);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] breaks assembly-order ties through declared text and then origin",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(attribution("workspace:beta"), [
                    new Prompt("Same", "Same body", 5),
                    new Prompt("Same", "Same body", 5)
                ]);
                store.contribute(attribution("workspace:alpha"), [
                    new Prompt("Same", "Other body", 5)
                ]);

                expect(store.assembledSections().map((held) => held.origin.key)).toEqual([
                    `workspace:alpha\0${0}`,
                    `workspace:beta\0${0}`,
                    `workspace:beta\0${1}`
                ]);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] supersedes a changed contribution instead of accreting beside it",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const release = attribution("workspace:facet");
                const contributor = release.contributor;
                store.contribute(release, [
                    new Prompt("One", "One body", 1),
                    new Prompt("Two", "Two body", 2),
                    new Prompt("Three", "Three body", 3)
                ]);
                const revision = store.revision().value;

                // A shorter replacement retires the tail the predecessor left behind.
                expect(
                    store.contribute(release, [
                        new Prompt("One", "rewritten", 1)
                    ]).value
                ).toBe(revision + 1);

                const held = store.sectionsOf(contributor);
                expect(held).toHaveLength(1);
                expect(held[0]?.body).toBe("rewritten");
                expect(held[0]?.origin.position).toBe(0);
                // The withdrawal set is a query over attribution, so the superseded
                // predecessors must not survive in it as extra records to retire.
                expect(
                    store.transaction((transaction) =>
                        store.withdrawalSet(transaction, release)
                    ).sections
                ).toHaveLength(1);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] re-reads the same contribution from a later release by superseding the records attributed to the earlier one",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(attribution("workspace:facet"), [new Prompt("One", "body", 1)]);
                const revision = store.revision().value;

                expect(
                    store.contribute(attribution("workspace:facet", "2.0.0"), [
                        new Prompt("One", "body", 1)
                    ]).value
                ).toBe(revision + 1);

                const held = store.sectionsOf(new FacetRef("workspace:facet"));
                expect(held).toHaveLength(1);
                expect(held[0]?.attribution.package.version.toString()).toBe("2.0.0");
                expect(held[0]?.id.equals(section("workspace:facet", 0, "One").id)).toBe(false);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] refuses to rewrite a stored section in place",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const held = section("workspace:facet", 0, "Held");
                store.contribute(attribution("workspace:facet"), [
                    new Prompt("Held", "Held body", 0)
                ]);
                const revision = store.revision().value;

                // Attribution and declared fields are immutable for a record's lifetime, so
                // supersession is a retirement plus a fresh materialization and never a write
                // over the bytes — at the storage primitive too.
                expect(() =>
                    store.transaction((transaction) =>
                        store.insertSection(transaction, section("workspace:facet", 0, "Rewritten"))
                    )
                ).toThrow(/already occupies workspace:facet at position 0/);

                expect(store.revision().value).toBe(revision);
                const surviving = store.assembledSections();
                expect(surviving).toHaveLength(1);
                expect(surviving[0]?.title).toBe("Held");
                expect(surviving[0]?.id.equals(held.id)).toBe(true);
            }
        );

        test(
            "rejects retiring an uncontributed section, rolls back failed writes, and rejects asynchronous transactions",
            { tags: "p0" },
            async () => {
                const store = create(new WorkspaceId("workspace"));

                expect(() =>
                    store.transaction((transaction) =>
                        store.retireSection(transaction, section("workspace:x", 9, "X").id)
                    )
                ).toThrow(/is not contributed/);
                expect(() =>
                    store.transaction((transaction) => {
                        store.insertSection(
                            transaction,
                            section("workspace:facet", 0, "Overview")
                        );
                        store.saveRevision(transaction, store.loadRevision(transaction).next());
                        throw new TypeError("injected rollback");
                    })
                ).toThrow(/injected rollback/);
                expect(store.assembledSections()).toHaveLength(0);
                expect(store.revision().value).toBe(0);

                // @ts-expect-error Actor-local transactions statically reject asynchronous callbacks.
                const operation: TransactionOperation<Transaction, never> = async () => true;
                expect(() => store.transaction(operation)).toThrow(/synchronous|Promise/);
                await Promise.resolve();
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] retires exactly the withdrawing Facet's sections and preserves unrelated sections and their order",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(attribution("workspace:mine"), [
                    new Prompt("Mine one", "body", 5),
                    new Prompt("Mine two", "body", 1)
                ]);
                store.contribute(attribution("workspace:theirs"), [
                    new Prompt("Theirs one", "body", 3),
                    new Prompt("Theirs two", "body", 7)
                ]);
                const theirs = store
                    .assembledSections()
                    .filter((held) => held.attribution.contributor.value === "workspace:theirs")
                    .map((held) => [...PromptSection.encode(held)]);

                // The set is computed by querying attribution inside one control read.
                const set = store.transaction((transaction) =>
                    store.withdrawalSet(transaction, attribution("workspace:mine"))
                );
                expect(set.attribution.equals(attribution("workspace:mine"))).toBe(true);
                expect(set.sections).toHaveLength(2);

                const revisionBefore = store.revision().value;
                expect(store.withdraw(attribution("workspace:mine")).value).toBe(
                    revisionBefore + 1
                );

                const remaining = store.assembledSections();
                expect(remaining.map((held) => held.origin.contributor.value)).toEqual([
                    "workspace:theirs",
                    "workspace:theirs"
                ]);
                expect(remaining.map((held) => [...PromptSection.encode(held)])).toEqual(theirs);

                // A withdrawal whose set holds nothing changes nothing.
                const revision = store.revision().value;
                expect(store.withdraw(attribution("workspace:absent")).value).toBe(revision);
                expect(store.assembledSections()).toHaveLength(2);
            }
        );
        test(
            "[C13-FACET-WITHDRAWAL-EXACT] a wrong PackagePin cannot retire the same Facet",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const releaseA = attribution("workspace:mine", "1.0.0");
                const releaseB = attribution("workspace:mine", "2.0.0");
                store.contribute(releaseA, [new Prompt("Mine", "body", 1)]);
                const before = store.revision().value;
                const bytes = store.assembledSections().map(PromptSection.encode);

                expect(store.withdraw(releaseB).value).toBe(before);
                expect(store.assembledSections().map(PromptSection.encode)).toEqual(bytes);
                expect(store.withdraw(releaseA).value).toBe(before + 1);
                expect(store.assembledSections()).toEqual([]);
            }
        );

    });
}
