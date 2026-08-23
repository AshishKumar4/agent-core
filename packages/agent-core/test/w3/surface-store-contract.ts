import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard, TransactionOperation } from "../../src/actors";
import { Revision } from "../../src/core";
import { WorkspaceId } from "../../src/identity";
import {
    ContributionAttribution,
    SurfaceDescriptor,
    SurfaceId,
    SurfaceRegistration,
    type SurfaceWithdrawalSet
} from "../../src/facets";
import { attribution, pin } from "./slot-store-contract";

export interface SurfaceStoreContract<Transaction> {
    readonly owner: WorkspaceId;
    transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    loadRevision(transaction: Transaction): Revision;
    saveRevision(transaction: Transaction, revision: Revision): void;
    loadRegistration(
        transaction: Transaction,
        surface: SurfaceId
    ): SurfaceRegistration | undefined;
    insertRegistration(transaction: Transaction, registration: SurfaceRegistration): void;
    retireRegistration(transaction: Transaction, surface: SurfaceId): void;
    listRegistrations(transaction: Transaction): readonly SurfaceRegistration[];
    revision(): Revision;
    registration(surface: SurfaceId): SurfaceRegistration | undefined;
    registrations(): readonly SurfaceRegistration[];
    register(registration: SurfaceRegistration): Revision;
    withdrawalSet(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): SurfaceWithdrawalSet;
    retireWithdrawalSet(transaction: Transaction, attribution: ContributionAttribution): boolean;
    withdraw(attribution: ContributionAttribution): Revision;
}

export function workspaceSurfaceStoreContract<Transaction>(
    name: string,
    create: (owner: WorkspaceId) => SurfaceStoreContract<Transaction>
): void {
    describe(`${name} [workspace-surface-store] Workspace Surface store`, () => {
        test(
            "persists codec records with deterministic ordering and idempotent replay",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const tasks = registration("workspace:second", "dashboard.tasks", "Tasks");
                const overview = registration("workspace:first", "dashboard.overview", "Overview");

                expect(store.register(tasks).value).toBe(1);
                expect(store.register(overview).value).toBe(2);
                expect(store.register(overview).value).toBe(2);

                expect(store.revision().value).toBe(2);
                expect(store.registrations().map((held) => held.descriptor.id.value)).toEqual([
                    "dashboard.overview",
                    "dashboard.tasks"
                ]);
                expect(store.registration(surface("dashboard.tasks"))?.descriptor.title).toBe(
                    "Tasks"
                );
                expect(store.registration(surface("dashboard.absent"))).toBeUndefined();
            }
        );

        test(
            "rejects retiring an unregistered Surface, rolls back failed writes, and rejects asynchronous transactions",
            { tags: "p0" },
            async () => {
                const store = create(new WorkspaceId("workspace"));
                const overview = registration("workspace:facet", "dashboard.overview", "Overview");

                expect(() =>
                    store.transaction((transaction) =>
                        store.retireRegistration(transaction, surface("dashboard.overview"))
                    )
                ).toThrow(/dashboard\.overview is not registered/);
                expect(() =>
                    store.transaction((transaction) => {
                        store.insertRegistration(transaction, overview);
                        throw new TypeError("injected rollback");
                    })
                ).toThrow(/injected rollback/);
                expect(store.registration(overview.descriptor.id)).toBeUndefined();
                expect(store.revision().value).toBe(0);

                // @ts-expect-error Actor-local transactions statically reject asynchronous callbacks.
                const operation: TransactionOperation<Transaction, never> = async () => true;
                expect(() => store.transaction(operation)).toThrow(/synchronous|Promise/);
                await Promise.resolve();
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] carries the contributing Facet and source release on every stored registration",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const candidate = registration(
                    "workspace:facet",
                    "dashboard.overview",
                    "Overview"
                );
                store.register(candidate);

                const stored = store.transaction((transaction) =>
                    store.loadRegistration(transaction, candidate.descriptor.id)
                );
                expect(stored?.attribution.contributor.value).toBe("workspace:facet");
                expect(stored?.attribution.package.equals(pin("workspace:facet"))).toBe(true);
                expect(
                    store
                        .transaction((transaction) =>
                            store.withdrawalSet(transaction, attribution("workspace:facet"))
                        )
                        .surfaces.map((held) => held.value)
                ).toEqual(["dashboard.overview"]);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] supersedes a changed Surface declaration instead of accreting beside it",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const before = registration("workspace:facet", "dashboard.overview", "Before");
                const after = registration("workspace:facet", "dashboard.overview", "After");
                store.register(before);
                const revision = store.revision().value;

                expect(store.register(after).value).toBe(revision + 1);

                expect(store.registrations().map((held) => held.descriptor.title)).toEqual([
                    "After"
                ]);
                // The withdrawal set of §4.1 is a query over attribution, so the superseded
                // predecessor must not survive in it as a second record to retire.
                expect(
                    store
                        .transaction((transaction) =>
                            store.withdrawalSet(transaction, attribution("workspace:facet"))
                        )
                        .surfaces.map((held) => held.value)
                ).toEqual(["dashboard.overview"]);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] re-reads the same contribution from a later release by superseding the registration attributed to the earlier one",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const first = registration("workspace:facet", "dashboard.overview", "Overview");
                const upgraded = registration(
                    "workspace:facet",
                    "dashboard.overview",
                    "Overview",
                    "2.0.0"
                );
                store.register(first);
                const revision = store.revision().value;

                expect(store.register(upgraded).value).toBe(revision + 1);

                const held = store.registrations();
                expect(held).toHaveLength(1);
                expect(held[0]!.attribution.package.version.toString()).toBe("2.0.0");
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] re-materializing the same contribution from the same release is the same registration and changes nothing",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const candidate = registration(
                    "workspace:facet",
                    "dashboard.overview",
                    "Overview"
                );
                store.register(candidate);
                const revision = store.revision().value;
                const bytes = SurfaceRegistration.encode(candidate);

                expect(
                    store.register(
                        registration("workspace:facet", "dashboard.overview", "Overview")
                    ).value
                ).toBe(revision);

                const held = store.registrations();
                expect(held).toHaveLength(1);
                expect([...SurfaceRegistration.encode(held[0]!)]).toEqual([...bytes]);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] refuses a Surface another Facet registered, with no partial effect",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const mine = registration("workspace:mine", "dashboard.overview", "Mine");
                const theirs = registration("workspace:theirs", "dashboard.overview", "Theirs");
                store.register(mine);
                const revision = store.revision().value;

                expect(() => store.register(theirs)).toThrow(
                    /Surface dashboard\.overview is registered by workspace:mine/
                );
                // Exclusivity is only observable while the storage primitive cannot be made
                // to overwrite behind it, so the refusal is asserted at `insertRegistration`.
                expect(() =>
                    store.transaction((transaction) =>
                        store.insertRegistration(transaction, theirs)
                    )
                ).toThrow(/Surface dashboard\.overview is registered by workspace:mine/);

                expect(store.revision().value).toBe(revision);
                expect(store.registrations().map((held) => held.descriptor.title)).toEqual([
                    "Mine"
                ]);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] refuses to rewrite a stored registration in place",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const held = registration("workspace:facet", "dashboard.overview", "Held");
                const rewrite = registration("workspace:facet", "dashboard.overview", "Rewritten");
                store.register(held);
                const revision = store.revision().value;

                // Attribution is immutable for the record's lifetime, so supersession is a
                // retirement plus a fresh materialization and never a write over the bytes.
                expect(() =>
                    store.transaction((transaction) =>
                        store.insertRegistration(transaction, rewrite)
                    )
                ).toThrow(/Surface registration dashboard\.overview is immutable/);

                expect(store.revision().value).toBe(revision);
                expect(store.registration(held.descriptor.id)?.descriptor.title).toBe("Held");
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] retires exactly the withdrawing Facet's Surfaces",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const mine = registration("workspace:mine", "dashboard.overview", "Overview");
                const alsoMine = registration("workspace:mine", "dashboard.pinned", "Pinned");
                const theirs = registration("workspace:theirs", "dashboard.tasks", "Tasks");
                store.register(mine);
                store.register(alsoMine);
                store.register(theirs);
                const theirBytes = SurfaceRegistration.encode(theirs);

                const set = store.transaction((transaction) =>
                    store.withdrawalSet(transaction, attribution("workspace:mine"))
                );
                expect(set.attribution.contributor.value).toBe("workspace:mine");
                expect(set.surfaces.map((held) => held.value)).toEqual([
                    "dashboard.overview",
                    "dashboard.pinned"
                ]);
                expect(Object.isFrozen(set.surfaces)).toBe(true);

                store.withdraw(attribution("workspace:mine"));

                expect(store.registration(mine.descriptor.id)).toBeUndefined();
                expect(store.registration(alsoMine.descriptor.id)).toBeUndefined();
                const retained = store.registration(theirs.descriptor.id);
                expect(retained).toBeDefined();
                expect([...SurfaceRegistration.encode(retained!)]).toEqual([...theirBytes]);
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] leaves a Facet that registered no Surface unchanged",
            { tags: "p1" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.register(registration("workspace:facet", "dashboard.overview", "Overview"));
                const before = store.revision().value;

                expect(store.withdraw(attribution("workspace:absent")).value).toBe(before);
                expect(
                    store.transaction((transaction) =>
                        store.retireWithdrawalSet(transaction, attribution("workspace:absent"))
                    )
                ).toBe(false);
                expect(store.registrations()).toHaveLength(1);
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] withdraws only the named release and replays as a no-op",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const earlier = registration(
                    "workspace:facet",
                    "dashboard.overview",
                    "Overview",
                    "1.0.0"
                );
                const later = registration(
                    "workspace:facet",
                    "dashboard.tasks",
                    "Tasks",
                    "2.0.0"
                );
                store.register(earlier);
                store.register(later);
                const laterBytes = SurfaceRegistration.encode(later);

                const retiredRevision = store.withdraw(attribution("workspace:facet", "1.0.0"));

                expect(store.registration(earlier.descriptor.id)).toBeUndefined();
                const retained = store.registration(later.descriptor.id);
                expect(retained).toBeDefined();
                expect([...SurfaceRegistration.encode(retained!)]).toEqual([...laterBytes]);
                expect(store.withdraw(attribution("workspace:facet", "1.0.0")).value).toBe(
                    retiredRevision.value
                );
                expect(store.withdraw(attribution("workspace:facet", "9.9.9")).value).toBe(
                    retiredRevision.value
                );
            }
        );
    });
}

export function surface(id: string): SurfaceId {
    return new SurfaceId(id);
}

/**
 * Only the declaration and the release version vary, so a supersession or a refusal is
 * attributable to the contributor, the declaration, or the release alone.
 */
export function registration(
    contributor: string,
    id: string,
    title: string,
    version = "1.0.0"
): SurfaceRegistration {
    return new SurfaceRegistration(
        new SurfaceDescriptor(new SurfaceId(id), title),
        attribution(contributor, version)
    );
}
