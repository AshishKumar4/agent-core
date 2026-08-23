import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard, TransactionOperation } from "../../src/actors";
import { JsonSchema, Revision, encodeCanonicalJson } from "../../src/core";
import type { FacetData } from "../../src/facets";
import {
    FacetRef,
    SettingsLayer,
    SettingsLayerOrigin,
    type SettingsWithdrawalSet
} from "../../src/facets";
import { WorkspaceId } from "../../src/identity";
import { attribution, pin } from "./slot-store-contract";

export const BASE_CONFIG_SCHEMA = new JsonSchema({ type: "object" });

const LOGGING_FRAGMENT: FacetData = Object.freeze({
    type: "object",
    properties: { level: { type: "string" } }
});

const UI_FRAGMENT: FacetData = Object.freeze({
    type: "object",
    properties: { theme: { type: "string" } }
});

export interface SettingsStoreContract<Transaction> {
    readonly owner: WorkspaceId;
    transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    loadRevision(transaction: Transaction): Revision;
    saveRevision(transaction: Transaction, revision: Revision): void;
    loadLayer(transaction: Transaction, id: SettingsLayer["id"]): SettingsLayer | undefined;
    loadLayerAt(transaction: Transaction, origin: SettingsLayerOrigin): SettingsLayer | undefined;
    insertLayer(transaction: Transaction, layer: SettingsLayer): void;
    retireLayer(transaction: Transaction, id: SettingsLayer["id"]): void;
    listLayers(transaction: Transaction): readonly SettingsLayer[];
    revision(): Revision;
    layers(): readonly SettingsLayer[];
    contribute(layer: SettingsLayer): Revision;
    withdrawalSet(transaction: Transaction, contributor: FacetRef): SettingsWithdrawalSet;
    retireWithdrawalSet(transaction: Transaction, contributor: FacetRef): boolean;
    withdraw(contributor: FacetRef): Revision;
    composedSchema(base: JsonSchema): JsonSchema;
}

/**
 * Only the contributor, declared position, fragment, and release version vary, so a
 * supersession or refusal is attributable to one of them alone.
 */
export function layer(
    contributor: string,
    ordinal: number,
    schema: FacetData = LOGGING_FRAGMENT,
    version = "1.0.0"
): SettingsLayer {
    return new SettingsLayer(attribution(contributor, version), ordinal, schema);
}

interface MergedView {
    readonly allOf?: readonly [
        unknown,
        { readonly required?: string[]; readonly properties?: Record<string, FacetData> }
    ];
}

function mergedView(view: FacetData): MergedView {
    // SAFETY: composedSchema always emits the §4.2 allOf [base, merge] document shape.
    return view as MergedView;
}

function requiredGroups(view: FacetData): string[] {
    return [...(mergedView(view).allOf?.[1]?.required ?? [])];
}

function groupOf(view: FacetData, groupId: string): FacetData {
    return mergedView(view).allOf?.[1]?.properties?.[groupId] ?? {};
}

function sameCanonical(left: FacetData, right: FacetData): boolean {
    return (
        Buffer.from(encodeCanonicalJson(left)).compare(Buffer.from(encodeCanonicalJson(right))) ===
        0
    );
}

export function workspaceSettingsStoreContract<Transaction>(
    name: string,
    create: (owner: WorkspaceId) => SettingsStoreContract<Transaction>
): void {
    describe(`${name} [workspace-settings-store] Workspace settings store`, () => {
        test(
            "persists codec records in precedence order with idempotent replay",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const logging = layer("workspace:zeta", 0);
                const ui = layer("workspace:alpha", 0);

                expect(store.contribute(logging).value).toBe(1);
                expect(store.contribute(ui).value).toBe(2);
                // Re-materializing either contribution is the same record and changes nothing.
                expect(store.contribute(logging).value).toBe(2);

                expect(store.revision().value).toBe(2);
                expect(
                    store.layers().map((held) => held.attribution.contributor.value)
                ).toEqual(["workspace:alpha", "workspace:zeta"]);
                const firstId = store.layers()[0]!.id;
                expect(
                    store.transaction((transaction) => store.loadLayer(transaction, firstId))
                        ?.schema.document
                ).toEqual(LOGGING_FRAGMENT);
            }
        );

        test(
            "rejects retiring an unstored layer, rolls back failed writes, and rejects asynchronous transactions",
            { tags: "p0" },
            async () => {
                const store = create(new WorkspaceId("workspace"));
                const candidate = layer("workspace:facet", 0);

                expect(() =>
                    store.transaction((transaction) =>
                        store.retireLayer(transaction, candidate.id)
                    )
                ).toThrow(/is not stored/);
                expect(() =>
                    store.transaction((transaction) => {
                        store.insertLayer(transaction, candidate);
                        throw new TypeError("injected rollback");
                    })
                ).toThrow(/injected rollback/);
                expect(store.layers()).toHaveLength(0);
                expect(store.revision().value).toBe(0);

                // @ts-expect-error Actor-local transactions statically reject asynchronous callbacks.
                const operation: TransactionOperation<Transaction, never> = async () => true;
                expect(() => store.transaction(operation)).toThrow(/synchronous|Promise/);
                await Promise.resolve();
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] carries the contributing Facet and source release on every stored layer",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const candidate = layer("workspace:facet", 0);
                store.contribute(candidate);

                const stored = store.transaction((transaction) =>
                    store.loadLayerAt(transaction, candidate.origin)
                );
                expect(stored?.attribution.contributor.value).toBe("workspace:facet");
                expect(stored?.attribution.package.equals(pin("workspace:facet"))).toBe(true);
                expect(
                    store
                        .transaction((transaction) =>
                            store.withdrawalSet(transaction, new FacetRef("workspace:facet"))
                        )
                        .layers.map((held) => held.value)
                ).toEqual([candidate.id.value]);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] supersedes a changed settings fragment instead of accreting beside it",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(layer("workspace:facet", 0, LOGGING_FRAGMENT));
                const revision = store.revision().value;

                expect(
                    store.contribute(layer("workspace:facet", 0, UI_FRAGMENT)).value
                ).toBe(revision + 1);

                const held = store.layers();
                expect(held).toHaveLength(1);
                expect(held[0]!.schema.document).toEqual(UI_FRAGMENT);
                expect(
                    store
                        .transaction((transaction) =>
                            store.withdrawalSet(transaction, new FacetRef("workspace:facet"))
                        )
                        .layers
                ).toHaveLength(1);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] re-reads the same contribution from a later release by superseding the earlier layer",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(layer("workspace:facet", 0));
                const revision = store.revision().value;

                expect(
                    store.contribute(layer("workspace:facet", 0, LOGGING_FRAGMENT, "2.0.0")).value
                ).toBe(revision + 1);

                const held = store.layers();
                expect(held).toHaveLength(1);
                expect(held[0]!.attribution.package.version.toString()).toBe("2.0.0");
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] re-materializing the same contribution from the same release is the same layer",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const candidate = layer("workspace:facet", 0);
                store.contribute(candidate);
                const revision = store.revision().value;
                const bytes = SettingsLayer.encode(candidate);

                expect(store.contribute(layer("workspace:facet", 0)).value).toBe(revision);

                const held = store.layers();
                expect(held).toHaveLength(1);
                expect([...SettingsLayer.encode(held[0]!)]).toEqual([...bytes]);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] refuses to rewrite a stored position in place; supersession goes through contribute",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(layer("workspace:facet", 0, LOGGING_FRAGMENT));
                const revision = store.revision().value;

                // Attribution is immutable for the record's lifetime, so a different
                // fragment at an occupied position is never written over the bytes.
                expect(() =>
                    store.transaction((transaction) =>
                        store.insertLayer(transaction, layer("workspace:facet", 0, UI_FRAGMENT))
                    )
                ).toThrow(/position 0 is held by workspace:facet/);

                expect(store.revision().value).toBe(revision);
                expect(store.layers()[0]!.schema.document).toEqual(LOGGING_FRAGMENT);
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] retires exactly the withdrawing Facet's layers and leaves every other byte unchanged",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const first = layer("workspace:mine", 0, LOGGING_FRAGMENT);
                const second = layer("workspace:mine", 1, UI_FRAGMENT);
                const theirs = layer("workspace:theirs", 0);
                store.contribute(first);
                store.contribute(second);
                store.contribute(theirs);
                const theirBytes = SettingsLayer.encode(theirs);

                const set = store.transaction((transaction) =>
                    store.withdrawalSet(transaction, new FacetRef("workspace:mine"))
                );
                expect(set.contributor.value).toBe("workspace:mine");
                expect(set.layers.map((held) => held.value)).toEqual([
                    first.id.value,
                    second.id.value
                ]);
                expect(Object.isFrozen(set.layers)).toBe(true);

                store.withdraw(new FacetRef("workspace:mine"));

                expect(store.layers().map((held) => held.id.value)).toEqual([theirs.id.value]);
                expect([...SettingsLayer.encode(store.layers()[0]!)]).toEqual([...theirBytes]);
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] leaves a Facet that contributed no settings unchanged",
            { tags: "p1" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(layer("workspace:facet", 0));
                const before = store.revision().value;

                expect(store.withdraw(new FacetRef("workspace:absent")).value).toBe(before);
                expect(
                    store.transaction((transaction) =>
                        store.retireWithdrawalSet(transaction, new FacetRef("workspace:absent"))
                    )
                ).toBe(false);
                expect(store.layers()).toHaveLength(1);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] derives the merged config view from records alone in canonical package order",
            { tags: "p0" },
            () => {
                const forward = create(new WorkspaceId("workspace"));
                const reversed = create(new WorkspaceId("workspace"));

                for (const candidate of [
                    layer("workspace:zulu", 0),
                    layer("workspace:alpha", 1, UI_FRAGMENT),
                    layer("workspace:alpha", 0)
                ]) {
                    forward.contribute(candidate);
                }
                for (const candidate of [
                    layer("workspace:alpha", 0),
                    layer("workspace:alpha", 1, UI_FRAGMENT),
                    layer("workspace:zulu", 0)
                ].reverse()) {
                    reversed.contribute(candidate);
                }

                const view = forward.composedSchema(BASE_CONFIG_SCHEMA).document;
                expect(
                    sameCanonical(
                        view,
                        reversed.composedSchema(BASE_CONFIG_SCHEMA).document
                    )
                ).toBe(true);
                expect(requiredGroups(view)).toEqual(["workspace:alpha", "workspace:zulu"]);
                expect(groupOf(view, "workspace:alpha")).toEqual({
                    allOf: [LOGGING_FRAGMENT, UI_FRAGMENT]
                });
            }
        );

        test(
            "[C13-FACET-WITHDRAWAL-EXACT] recomputes the merged view after a withdrawal without durable duplicate state",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                store.contribute(layer("workspace:alpha", 0));
                store.contribute(layer("workspace:zulu", 0));
                const before = store.revision().value;

                expect(
                    requiredGroups(store.composedSchema(BASE_CONFIG_SCHEMA).document)
                ).toEqual(["workspace:alpha", "workspace:zulu"]);

                expect(store.withdraw(new FacetRef("workspace:alpha")).value).toBe(before + 1);

                // The view is derived on read: the withdrawn Facet's group is gone from the
                // very next call, and nothing but the retired records changed.
                expect(
                    requiredGroups(store.composedSchema(BASE_CONFIG_SCHEMA).document)
                ).toEqual(["workspace:zulu"]);
                expect(store.layers().map((held) => held.attribution.contributor.value)).toEqual([
                    "workspace:zulu"
                ]);
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] preserves secret-reference-only fragments through codec and storage verbatim",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const secretFragment: FacetData = Object.freeze({
                    type: "object",
                    properties: {
                        token: {
                            $secret: { id: "token-1", provider: "vault", source: "tenant" }
                        }
                    }
                });
                const candidate = layer("workspace:facet", 0, secretFragment);

                store.contribute(candidate);
                const held = store.layers()[0]!;
                expect([...SettingsLayer.encode(held)]).toEqual([
                    ...SettingsLayer.encode(candidate)
                ]);
                // SAFETY: the merged view keys one schema fragment per contributing package.
                const properties = held.schema.document as {
                    properties: Record<string, FacetData>;
                };
                expect(properties.properties["token"]).toEqual({
                    $secret: { id: "token-1", provider: "vault", source: "tenant" }
                });
                expect(JSON.stringify(held.toData())).toContain('"$secret"');
            }
        );

        test(
            "[C13-FACET-CONTRIBUTION-ATTRIBUTION] rebuilds layers and the derived view from persisted bytes alone after a restart",
            { tags: "p0" },
            () => {
                const store = create(new WorkspaceId("workspace"));
                const kept = layer("workspace:alpha", 0);
                const withdrawn = layer("workspace:zulu", 0);
                store.contribute(kept);
                store.contribute(withdrawn);
                // Only canonical record bytes survive a restart; nothing else crosses.
                const persisted = [kept, withdrawn].map((held) => SettingsLayer.encode(held));

                const restarted = create(new WorkspaceId("workspace"));
                restarted.transaction((transaction) => {
                    for (const bytes of persisted) {
                        restarted.insertLayer(transaction, SettingsLayer.decode(bytes));
                    }
                    restarted.saveRevision(transaction, restarted.loadRevision(transaction).next());
                });

                expect(
                    restarted.layers().map((held) => held.attribution.contributor.value)
                ).toEqual(["workspace:alpha", "workspace:zulu"]);
                expect(
                    sameCanonical(
                        restarted.composedSchema(BASE_CONFIG_SCHEMA).document,
                        store.composedSchema(BASE_CONFIG_SCHEMA).document
                    )
                ).toBe(true);

                // A withdrawal recorded before the restart stays retired: the surviving
                // bytes alone produce a view without the withdrawn Facet.
                expect(restarted.withdraw(new FacetRef("workspace:zulu")).value).toBe(2);
                expect(
                    requiredGroups(restarted.composedSchema(BASE_CONFIG_SCHEMA).document)
                ).toEqual(["workspace:alpha"]);
            }
        );
    });
}
