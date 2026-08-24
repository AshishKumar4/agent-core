import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../src/actors";
import { Revision, SecretRef, SemVer } from "../../src/core";
import { PackageId, PackagePin, type AuthenticatedContribution } from "../../src/definition";
import {
    ContributionAttribution,
    FacetPackageId,
    FacetRef,
    FieldMove,
    IngressDeclaration,
    IngressVerification,
    PackageInstallationRef,
    PromptSection,
    ProvenanceMapping
} from "../../src/facets";
import { ScopeRef, WorkspaceId } from "../../src/identity";
import { AuditRecordId } from "../../src/interaction-references";
import {
    Event,
    EventId,
    IngressEndpoint,
    IngressEndpointId,
    RouteProjection,
    RouteProjectionId,
    RouteReservation,
    RouteReservationId,
    View,
    WorkspacePersistence,
    WorkspaceRoutingWithdrawal,
    WorkspaceSubscriptionMaterializer,
    type EventInit,
    type Subscription
} from "../../src/workspaces";
import { malformed } from "../helpers/malformed";
import { attribution } from "../w3/slot-store-contract";
import { attributed } from "../w3/catalog-store-contract";
import { layer } from "../w3/settings-store-contract";
import { registration } from "../w3/surface-store-contract";
import {
    authenticatedInstallationFixture,
    authenticatedProjectionFixture,
    content,
    deliveryFixture,
    DeterministicJsonPatchEngine,
    eventFixture,
    eventRetention,
    projectionFixture,
    projectionRetention,
    reservationFixture,
    reservationRetention,
    retentionFixture,
    materializeAttributedSubscription,
    sourceActor,
    subscriptionFixture,
    subscriptionMaterializationInit,
    TestPackageInstallationProvenance,
    tenant,
    viewDeltaFixture,
    viewFixture
} from "../workspaces/fixtures";

export interface WorkspacePersistenceHarness<Transaction> {
    readonly persistence: WorkspacePersistence<Transaction>;
    transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    restart(): void;
    dispose(): void;
}

function ingressEndpoint(
    suffix: string,
    contribution: ContributionAttribution,
    path: string
): IngressEndpoint {
    return new IngressEndpoint({
        id: new IngressEndpointId(`ingress-${suffix}`),
        revision: Revision.initial(),
        scope: ScopeRef.workspace(tenant, new WorkspaceId("workspace-scope")),
        declared: new IngressDeclaration(
            path,
            new IngressVerification(
                "hmac",
                new SecretRef("env", "provider-test", `secret-${suffix}`)
            ),
            new ProvenanceMapping([new FieldMove("/identity", { literal: "external" })])
        ),
        contribution
    });
}

export function workspacePersistenceContract<Transaction>(
    name: string,
    create: () => WorkspacePersistenceHarness<Transaction>
): void {
    describe(`${name} workspace persistence`, () => {
        test(
            "persists and withdraws every immutable contribution record by exact release",
            { tags: "p0" },
            () => {
                const harness = create();
                try {
                    const contributor = "workspace:records";
                    const firstAttribution = attribution(contributor, "1.0.0");
                    const secondAttribution = attribution(contributor, "2.0.0");
                    const firstCatalog = attributed(contributor, "1.0.0", "first");
                    const secondCatalog = attributed(contributor, "2.0.0", "second");
                    const supersededCatalog = attributed(contributor, "1.0.0", "replace");
                    const replacementCatalog = attributed(contributor, "2.0.0", "replace");
                    const firstPrompt = new PromptSection(
                        "First",
                        "First body",
                        0,
                        firstAttribution,
                        0
                    );
                    const secondPrompt = new PromptSection(
                        "Second",
                        "Second body",
                        0,
                        secondAttribution,
                        1
                    );
                    const firstSettings = layer(contributor, 0, { type: "object" }, "1.0.0");
                    const secondSettings = layer(contributor, 1, { type: "object" }, "2.0.0");
                    const firstSurface = registration(
                        contributor,
                        "surface:first",
                        "First",
                        "1.0.0"
                    );
                    const secondSurface = registration(
                        contributor,
                        "surface:second",
                        "Second",
                        "2.0.0"
                    );

                    harness.transaction((transaction) => {
                        const persistence = harness.persistence;
                        for (const entry of [
                            firstCatalog,
                            secondCatalog,
                            supersededCatalog,
                            replacementCatalog
                        ]) {
                            persistence.putCatalogEntry(transaction, entry);
                        }
                        persistence.putPromptSection(transaction, firstPrompt);
                        persistence.putPromptSection(transaction, secondPrompt);
                        persistence.putSettingsLayer(transaction, firstSettings);
                        persistence.putSettingsLayer(transaction, secondSettings);
                        persistence.putSurfaceRegistration(transaction, firstSurface);
                        persistence.putSurfaceRegistration(transaction, secondSurface);

                        expect(
                            persistence
                                .catalogEntryAt(transaction, replacementCatalog.origin)
                                ?.id.equals(replacementCatalog.id)
                        ).toBe(true);
                        expect(
                            persistence
                                .listContributedCatalogEntries(transaction, firstAttribution)
                                .map((entry) => entry.name)
                        ).toEqual(["first"]);
                    });

                    harness.restart();
                    harness.transaction((transaction) => {
                        const persistence = harness.persistence;
                        for (const entry of persistence.listContributedCatalogEntries(
                            transaction,
                            firstAttribution
                        )) {
                            persistence.retireCatalogEntry(transaction, entry.id);
                        }
                        for (const section of persistence.listContributedPromptSections(
                            transaction,
                            firstAttribution
                        )) {
                            persistence.retirePromptSection(transaction, section.id);
                        }
                        for (const settings of persistence.listContributedSettingsLayers(
                            transaction,
                            firstAttribution
                        )) {
                            persistence.retireSettingsLayer(transaction, settings.id);
                        }
                        for (const surface of persistence.listContributedSurfaceRegistrations(
                            transaction,
                            firstAttribution
                        )) {
                            persistence.retireSurfaceRegistration(
                                transaction,
                                surface.descriptor.id
                            );
                        }
                    });

                    harness.restart();
                    harness.transaction((transaction) => {
                        const persistence = harness.persistence;
                        expect(
                            persistence.listContributedCatalogEntries(transaction, firstAttribution)
                        ).toEqual([]);
                        expect(
                            persistence.listContributedPromptSections(transaction, firstAttribution)
                        ).toEqual([]);
                        expect(
                            persistence.listContributedSettingsLayers(transaction, firstAttribution)
                        ).toEqual([]);
                        expect(
                            persistence.listContributedSurfaceRegistrations(
                                transaction,
                                firstAttribution
                            )
                        ).toEqual([]);
                        expect(
                            persistence
                                .listContributedCatalogEntries(transaction, secondAttribution)
                                .map((entry) => entry.name)
                                .sort()
                        ).toEqual(["replace", "second"]);
                        expect(
                            persistence.listContributedPromptSections(
                                transaction,
                                secondAttribution
                            )
                        ).toHaveLength(1);
                        expect(
                            persistence.listContributedSettingsLayers(
                                transaction,
                                secondAttribution
                            )
                        ).toHaveLength(1);
                        expect(
                            persistence.listContributedSurfaceRegistrations(
                                transaction,
                                secondAttribution
                            )
                        ).toHaveLength(1);
                    });
                } finally {
                    harness.dispose();
                }
            }
        );
        test(
            "persists revisioned ingress and retires only the exact release",
            { tags: "p0" },
            () => {
                const harness = create();
                try {
                    const contributor = "workspace:ingress";
                    const firstAttribution = attribution(contributor, "1.0.0");
                    const secondAttribution = attribution(contributor, "2.0.0");
                    const first = ingressEndpoint(
                        `${name}-first`,
                        firstAttribution,
                        `/${name}/first`
                    );
                    const second = ingressEndpoint(
                        `${name}-second`,
                        secondAttribution,
                        `/${name}/second`
                    );
                    harness.transaction((transaction) => {
                        expect(
                            harness.persistence.putManagedIngressEndpoint(transaction, first)
                        ).toBe(true);
                        expect(
                            harness.persistence.putManagedIngressEndpoint(transaction, second)
                        ).toBe(true);
                        expect(
                            harness.persistence.putManagedIngressEndpoint(transaction, second)
                        ).toBe(false);
                        expect(() =>
                            harness.persistence.putManagedIngressEndpoint(
                                transaction,
                                ingressEndpoint(
                                    `${name}-conflict`,
                                    secondAttribution,
                                    `/${name}/second`
                                )
                            )
                        ).toThrow(
                            expect.objectContaining({
                                code: "protocol.duplicate"
                            })
                        );
                    });

                    harness.restart();
                    harness.transaction((transaction) => {
                        expect(
                            harness.persistence.listContributedIngressEndpoints(
                                transaction,
                                firstAttribution
                            )
                        ).toHaveLength(1);
                        expect(
                            harness.persistence.listContributedIngressEndpoints(
                                transaction,
                                secondAttribution
                            )
                        ).toHaveLength(1);
                        harness.persistence.retireIngressEndpoint(transaction, first.id);
                    });

                    harness.restart();
                    harness.transaction((transaction) => {
                        expect(
                            harness.persistence.listContributedIngressEndpoints(
                                transaction,
                                firstAttribution
                            )
                        ).toEqual([]);
                        expect(
                            harness.persistence.currentIngressEndpoint(transaction, first.id)
                                ?.retired
                        ).toBe(true);
                        expect(
                            harness.persistence.listContributedIngressEndpoints(
                                transaction,
                                secondAttribution
                            )
                        ).toHaveLength(1);
                        expect(() =>
                            harness.persistence.putManagedIngressEndpoint(transaction, first)
                        ).toThrow(
                            expect.objectContaining({
                                code: "protocol.invalid-state"
                            })
                        );
                    });
                } finally {
                    harness.dispose();
                }
            }
        );

        test(
            "binds retained content to the exact durable record atomically",
            { tags: "p0" },
            () => {
                const harness = create();
                try {
                    const event = eventFixture(`${name}-retention`);
                    const wrongRecord = retentionFixture({
                        id: `${name}-wrong-retention`,
                        recordKind: "event",
                        recordId: "another-event",
                        content: { ref: event.payload, digest: event.payloadDigest }
                    });
                    expect(() =>
                        harness.transaction((transaction) => {
                            harness.persistence.appendEvent(transaction, event, wrongRecord);
                        })
                    ).toThrow(/does not bind/);
                    harness.transaction((transaction) => {
                        expect(
                            harness.persistence.findEvent(transaction, event.id)
                        ).toBeUndefined();
                    });

                    const wrongContent = content(`${name}-wrong-content`);
                    const mismatchedContent = retentionFixture({
                        id: `${name}-wrong-content-retention`,
                        recordKind: "event",
                        recordId: event.id.value,
                        content: wrongContent
                    });
                    expect(() =>
                        harness.transaction((transaction) => {
                            harness.persistence.appendEvent(transaction, event, mismatchedContent);
                        })
                    ).toThrow(/does not bind/);

                    harness.transaction((transaction) => {
                        harness.persistence.appendEvent(transaction, event, eventRetention(event));
                        expect(
                            harness.persistence.findEventByIdentity(
                                transaction,
                                event.idempotencyKey
                            )?.id
                        ).toEqual(event.id);
                    });
                } finally {
                    harness.dispose();
                }
            }
        );

        test(
            "rolls back partial unique reservations and preserves the original owner",
            { tags: "p0" },
            () => {
                const harness = create();
                try {
                    const original = eventFixture(`${name}-unique-original`);
                    harness.transaction((transaction) => {
                        harness.persistence.appendEvent(
                            transaction,
                            original,
                            eventRetention(original)
                        );
                    });
                    const conflictingInit: EventInit = {
                        id: new EventId(`${name}-unique-conflict`),
                        scope: original.scope,
                        source: original.source,
                        kind: original.kind,
                        payload: original.payload,
                        payloadDigest: original.payloadDigest,
                        idempotencyKey: original.idempotencyKey,
                        correlation: original.correlation,
                        provenance: original.provenance,
                        trust: original.trust,
                        visibility: original.visibility
                    };
                    const conflicting = new Event(
                        original.initiator === undefined
                            ? conflictingInit
                            : { ...conflictingInit, initiator: original.initiator }
                    );

                    expect(() =>
                        harness.transaction((transaction) => {
                            harness.persistence.appendEvent(
                                transaction,
                                conflicting,
                                eventRetention(conflicting, `${name}-conflict-retention`)
                            );
                        })
                    ).toThrow();

                    harness.transaction((transaction) => {
                        expect(
                            harness.persistence.findEvent(transaction, conflicting.id)
                        ).toBeUndefined();
                        expect(
                            harness.persistence.findEventByIdentity(
                                transaction,
                                original.idempotencyKey
                            )?.id
                        ).toEqual(original.id);
                    });
                } finally {
                    harness.dispose();
                }
            }
        );

        test("enforces subscription and View compare-and-set revisions", { tags: "p0" }, () => {
            const harness = create();
            try {
                const initial = subscriptionFixture(`${name}-cas`);
                const revised = initial.revise({
                    source: initial.source,
                    target: initial.target,
                    mapping: initial.mapping,
                    dedupe: "payload",
                    authority: initial.authority
                });
                harness.transaction((transaction) => {
                    harness.persistence.saveSubscription(transaction, initial, undefined);
                    harness.persistence.saveSubscription(transaction, revised, initial.revision);
                });
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.persistence.saveSubscription(
                            transaction,
                            revised,
                            initial.revision
                        );
                    })
                ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));

                const view = viewFixture(0, `${name}-cas`);
                harness.transaction((transaction) => {
                    harness.persistence.saveView(transaction, view, undefined, []);
                });
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.persistence.saveView(transaction, view, undefined, []);
                    })
                ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.persistence.saveView(
                            transaction,
                            new View({
                                surface: view.surface,
                                revision: new Revision(2),
                                body: view.body,
                                actions: view.actions,
                                cursor: view.cursor
                            }),
                            view.revision,
                            []
                        );
                    })
                ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));

                harness.transaction((transaction) => {
                    expect(
                        harness.persistence.currentSubscription(transaction, initial.id)?.revision
                            .value
                    ).toBe(1);
                    expect(
                        harness.persistence.currentView(transaction, view.surface.value)?.revision
                            .value
                    ).toBe(0);
                });
            } finally {
                harness.dispose();
            }
        });

        test(
            "[C13-SUBSCRIPTION-ATTRIBUTION-FIXED] refuses a caller-supplied attribution before it can enter a withdrawal set",
            { tags: "p0" },
            () => {
                const harness = create();
                try {
                    const contribution = attribution("workspace:laundered");
                    const laundered = subscriptionFixture(`${name}-laundered`, {
                        contribution
                    });
                    const direct = subscriptionFixture(`${name}-direct`);

                    expect(() =>
                        harness.transaction((transaction) => {
                            harness.persistence.saveSubscription(transaction, laundered, undefined);
                        })
                    ).toThrow(
                        expect.objectContaining({
                            code: "authority.denied",
                            message:
                                "Subscription attribution requires authenticated contribution materialization"
                        })
                    );

                    harness.transaction((transaction) => {
                        harness.persistence.saveSubscription(transaction, direct, undefined);
                        expect(
                            harness.persistence.currentSubscription(transaction, laundered.id)
                        ).toBeUndefined();
                        expect(
                            harness.persistence.currentSubscription(transaction, direct.id)
                                ?.contribution
                        ).toBeUndefined();
                        expect(
                            harness.persistence.listContributedSubscriptions(
                                transaction,
                                contribution
                            )
                        ).toEqual([]);
                    });
                } finally {
                    harness.dispose();
                }
            }
        );

        test(
            "[C13-SUBSCRIPTION-ATTRIBUTION-FIXED] materializes attribution from authenticated provenance and refuses every later rewrite",
            { tags: "p0" },
            () => {
                const harness = create();
                try {
                    const installation = authenticatedInstallationFixture("workspace:fixed");
                    const contribution = new ContributionAttribution(
                        installation.facet,
                        installation.package
                    );
                    const provenance = new TestPackageInstallationProvenance<Transaction>(
                        installation
                    );
                    const materializer = new WorkspaceSubscriptionMaterializer(
                        harness.persistence,
                        provenance
                    );
                    const context = {};
                    const initial = subscriptionMaterializationInit(
                        subscriptionFixture(`${name}-attributed`)
                    );
                    const supplied = {
                        ...initial,
                        contribution: attribution("workspace:forged")
                    };
                    const prepared = harness.transaction((transaction) =>
                        materializer.prepareContribution(transaction, context)
                    );
                    if (prepared === undefined) {
                        throw new TypeError(
                            "Authenticated test installation did not prepare a contribution"
                        );
                    }
                    expect(() =>
                        harness.transaction((transaction) =>
                            materializer.materialize(transaction, context, prepared, supplied)
                        )
                    ).toThrow(
                        expect.objectContaining({
                            code: "operation.invalid-input",
                            message:
                                "Subscription materialization input must not supply record state"
                        })
                    );
                    const acceptedPrepared = harness.transaction((transaction) =>
                        materializer.prepareContribution(transaction, context)
                    );
                    if (acceptedPrepared === undefined) {
                        throw new TypeError(
                            "Authenticated test installation did not prepare a contribution"
                        );
                    }
                    const contributed = harness.transaction((transaction) =>
                        materializer.materialize(transaction, context, acceptedPrepared, initial)
                    );
                    const direct = subscriptionFixture(`${name}-direct`);
                    harness.transaction((transaction) => {
                        harness.persistence.saveSubscription(transaction, direct, undefined);
                    });

                    for (const candidate of [
                        revised(contributed, attribution("workspace:other")),
                        revised(contributed, undefined),
                        revised(direct, contribution)
                    ]) {
                        expect(() =>
                            harness.transaction((transaction) => {
                                harness.persistence.saveSubscription(
                                    transaction,
                                    candidate,
                                    Revision.initial()
                                );
                            })
                        ).toThrow(
                            expect.objectContaining({
                                code: "protocol.invalid-state",
                                message: "Subscription contribution attribution is immutable"
                            })
                        );
                    }

                    harness.transaction((transaction) => {
                        const stored = harness.persistence.currentSubscription(
                            transaction,
                            contributed.id
                        );
                        expect(stored?.revision.value).toBe(0);
                        expect(stored?.contribution?.contributor.equals(installation.facet)).toBe(
                            true
                        );
                        expect(stored?.contribution?.package.equals(installation.package)).toBe(
                            true
                        );
                        expect(
                            harness.persistence.currentSubscription(transaction, direct.id)
                                ?.contribution
                        ).toBeUndefined();
                    });

                    // The store refuses a changed pair rather than a later revision, and the
                    // trusted pair survives the substrate rather than the process that wrote it.
                    harness.transaction((transaction) => {
                        harness.persistence.saveSubscription(
                            transaction,
                            revised(contributed, contribution),
                            Revision.initial()
                        );
                    });
                    harness.restart();
                    harness.transaction((transaction) => {
                        const reopened = harness.persistence.currentSubscription(
                            transaction,
                            contributed.id
                        );
                        expect(reopened?.revision.value).toBe(1);
                        expect(reopened?.contribution?.equals(contribution)).toBe(true);
                    });
                } finally {
                    harness.dispose();
                }
            }
        );

        test(
            "[C13-SUBSCRIPTION-ATTRIBUTION-FIXED] [C13-FACET-WITHDRAWAL-EXACT] selects the exact release across codec restart and replay",
            { tags: "p0" },
            () => {
                const harness = create();
                try {
                    const releaseA = attribution("workspace:dual-release", "1.0.0");
                    const releaseB = attribution("workspace:dual-release", "2.0.0");
                    const wrongRelease = attribution("workspace:dual-release", "9.9.9");
                    const routing = new WorkspaceRoutingWithdrawal(harness.persistence, {
                        deliveryAudit: () => new AuditRecordId(`${name}-unused-withdrawal-audit`)
                    });
                    const [subscriptionA, subscriptionB, direct] = harness.transaction(
                        (transaction) => {
                            const first = materializeAttributedSubscription(
                                harness.persistence,
                                transaction,
                                releaseA,
                                subscriptionFixture(`${name}-release-a`)
                            );
                            const second = materializeAttributedSubscription(
                                harness.persistence,
                                transaction,
                                releaseB,
                                subscriptionFixture(`${name}-release-b`)
                            );
                            const callerCreated = subscriptionFixture(`${name}-direct-release`);
                            harness.persistence.saveSubscription(
                                transaction,
                                callerCreated,
                                undefined
                            );
                            return [first, second, callerCreated] as const;
                        }
                    );

                    harness.restart();
                    harness.transaction((transaction) => {
                        expect(
                            harness.persistence
                                .listContributedSubscriptions(transaction, releaseA)
                                .map((subscription) => subscription.id.value)
                        ).toEqual([subscriptionA.id.value]);
                        expect(
                            harness.persistence
                                .listContributedSubscriptions(transaction, releaseB)
                                .map((subscription) => subscription.id.value)
                        ).toEqual([subscriptionB.id.value]);
                        expect(routing.retire(transaction, wrongRelease)).toEqual({
                            subscriptions: [],
                            rejected: []
                        });
                        expect(routing.retire(transaction, releaseA).subscriptions).toEqual([
                            subscriptionA.id
                        ]);
                    });

                    harness.restart();
                    harness.transaction((transaction) => {
                        expect(
                            harness.persistence.currentSubscription(transaction, subscriptionA.id)
                                ?.retired
                        ).toBe(true);
                        expect(
                            harness.persistence.currentSubscription(transaction, subscriptionB.id)
                                ?.retired
                        ).toBeUndefined();
                        expect(
                            harness.persistence.currentSubscription(transaction, direct.id)?.retired
                        ).toBeUndefined();
                        expect(
                            harness.persistence
                                .listContributedSubscriptions(transaction, releaseB)
                                .map((subscription) => subscription.id.value)
                        ).toEqual([subscriptionB.id.value]);
                        expect(routing.retire(transaction, releaseA)).toEqual({
                            subscriptions: [],
                            rejected: []
                        });
                    });
                } finally {
                    harness.dispose();
                }
            }
        );

        test(
            "[C13-SUBSCRIPTION-ATTRIBUTION-FIXED] refuses forged, replayed, expired, and drifted contribution provenance",
            { tags: "p0" },
            async () => {
                const harness = create();
                try {
                    const context = {};
                    const initial = subscriptionMaterializationInit(
                        subscriptionFixture(`${name}-capability`)
                    );
                    for (const forged of [
                        malformed<AuthenticatedContribution>({}),
                        forgedAuthenticatedContribution(
                            new PackageInstallationRef(
                                attribution("workspace:lookalike"),
                                new FacetPackageId("subscription.lookalike")
                            )
                        )
                    ]) {
                        expect(() =>
                            harness.transaction((transaction) => {
                                harness.persistence.materializeSubscription(
                                    transaction,
                                    forged,
                                    initial
                                );
                            })
                        ).toThrow(
                            expect.objectContaining({
                                code: "authority.denied",
                                message:
                                    "Subscription materialization requires authenticated contribution provenance"
                            })
                        );
                    }

                    const installation = authenticatedInstallationFixture("workspace:capability");
                    const port = new TestPackageInstallationProvenance<Transaction>(installation);
                    const prepared = harness.transaction((transaction) =>
                        port.prepareContribution(transaction, context)
                    );
                    if (prepared === undefined) {
                        throw new TypeError(
                            "Authenticated test installation did not prepare a capability"
                        );
                    }
                    const materialized = harness.transaction((transaction) =>
                        port.withAuthenticatedContribution(
                            transaction,
                            context,
                            prepared.stamp,
                            (contribution) => {
                                const subscription = harness.persistence.materializeSubscription(
                                    transaction,
                                    contribution,
                                    initial
                                );
                                expect(() =>
                                    harness.persistence.materializeSubscription(
                                        transaction,
                                        contribution,
                                        subscriptionMaterializationInit(
                                            subscriptionFixture(`${name}-replay`)
                                        )
                                    )
                                ).toThrow(expect.objectContaining({ code: "authority.denied" }));
                                return subscription;
                            }
                        )
                    );
                    expect(materialized?.contribution?.contributor.equals(installation.facet)).toBe(
                        true
                    );

                    const expiringPort = new TestPackageInstallationProvenance<Transaction>(
                        authenticatedInstallationFixture("workspace:expired")
                    );
                    const expiringPrepared = harness.transaction((transaction) =>
                        expiringPort.prepareContribution(transaction, context)
                    );
                    if (expiringPrepared === undefined) {
                        throw new TypeError(
                            "Authenticated test installation did not prepare a capability"
                        );
                    }
                    let unconsumed: AuthenticatedContribution | undefined;
                    expect(
                        harness.transaction((transaction) =>
                            expiringPort.withAuthenticatedContribution(
                                transaction,
                                context,
                                expiringPrepared.stamp,
                                (contribution) => {
                                    unconsumed = contribution;
                                    return undefined;
                                }
                            )
                        )
                    ).toBeUndefined();
                    const expired = unconsumed;
                    if (expired === undefined) {
                        throw new TypeError("Authenticated contribution was not issued");
                    }
                    await Promise.resolve();
                    expect(() =>
                        harness.transaction((transaction) => {
                            harness.persistence.materializeSubscription(
                                transaction,
                                expired,
                                subscriptionMaterializationInit(
                                    subscriptionFixture(`${name}-expired`)
                                )
                            );
                        })
                    ).toThrow(expect.objectContaining({ code: "authority.denied" }));

                    const failedPort = new TestPackageInstallationProvenance<Transaction>(
                        authenticatedInstallationFixture("workspace:failed")
                    );
                    const failedMaterializer = new WorkspaceSubscriptionMaterializer(
                        harness.persistence,
                        failedPort
                    );
                    const failedPrepared = harness.transaction((transaction) =>
                        failedMaterializer.prepareContribution(transaction, context)
                    );
                    if (failedPrepared === undefined) {
                        throw new TypeError(
                            "Authenticated test installation did not prepare a capability"
                        );
                    }
                    failedPort.installation = undefined;
                    expect(() =>
                        harness.transaction((transaction) =>
                            failedMaterializer.materialize(
                                transaction,
                                context,
                                failedPrepared,
                                subscriptionMaterializationInit(
                                    subscriptionFixture(`${name}-failed-resolve`)
                                )
                            )
                        )
                    ).toThrow(
                        expect.objectContaining({
                            code: "authority.denied",
                            message:
                                "Subscription contributor installation provenance changed before materialization"
                        })
                    );

                    for (const [drift, changedInstallation] of [
                        [
                            "package",
                            Object.freeze({
                                ...installation,
                                package: new PackagePin(
                                    new PackageId("subscription-substituted"),
                                    new SemVer("1.0.0"),
                                    installation.package.manifestDigest,
                                    installation.package.codeDigest
                                )
                            })
                        ],
                        [
                            "package-facet",
                            Object.freeze({
                                ...installation,
                                packageFacet: new FacetPackageId("subscription.substituted")
                            })
                        ],
                        [
                            "contributor-facet",
                            Object.freeze({
                                ...installation,
                                facet: new FacetRef("workspace:substituted")
                            })
                        ]
                    ] as const) {
                        const driftedPort = new TestPackageInstallationProvenance<Transaction>(
                            installation
                        );
                        const drifted = new WorkspaceSubscriptionMaterializer(
                            harness.persistence,
                            driftedPort
                        );
                        const driftedPrepared = harness.transaction((transaction) =>
                            drifted.prepareContribution(transaction, context)
                        );
                        if (driftedPrepared === undefined) {
                            throw new TypeError(
                                "Authenticated test installation did not prepare a contribution"
                            );
                        }
                        driftedPort.installation = changedInstallation;
                        expect(() =>
                            harness.transaction((transaction) => {
                                drifted.materialize(
                                    transaction,
                                    context,
                                    driftedPrepared,
                                    subscriptionMaterializationInit(
                                        subscriptionFixture(`${name}-drifted-${drift}`)
                                    )
                                );
                            })
                        ).toThrow(
                            expect.objectContaining({
                                code: "authority.denied",
                                message:
                                    "Subscription contributor installation provenance changed before materialization"
                            })
                        );
                    }
                } finally {
                    harness.dispose();
                }
            }
        );

        test("makes route projection and delivery decisions terminal", { tags: "p0" }, () => {
            const harness = create();
            try {
                const reservation = reservationFixture(`${name}-terminal`, { target: sourceActor });
                const projection = projectionFixture(reservation);
                const delivery = deliveryFixture(reservation);
                harness.transaction((transaction) => {
                    harness.persistence.appendReservation(
                        transaction,
                        reservation,
                        reservationRetention(reservation)
                    );
                    harness.persistence.appendProjection(
                        transaction,
                        authenticatedProjectionFixture(reservation),
                        projectionRetention(projection, sourceActor)
                    );
                    harness.persistence.appendDelivery(transaction, delivery);
                });

                const duplicateReservation = new RouteReservation({
                    ...reservation.init,
                    id: new RouteReservationId(`${name}-duplicate-reservation`),
                    projection: new RouteProjectionId(`${name}-duplicate-projection`)
                });
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.persistence.appendReservation(
                            transaction,
                            duplicateReservation,
                            reservationRetention(duplicateReservation)
                        );
                    })
                ).toThrow();

                const duplicateProjection = new RouteProjection({
                    id: new RouteProjectionId(`${name}-second-projection`),
                    reservation: reservation.id,
                    content: projection.content,
                    digest: projection.digest
                });
                expect(() =>
                    harness.transaction((transaction) => {
                        const duplicateRoute = new RouteReservation({
                            ...reservation.init,
                            projection: duplicateProjection.id
                        });
                        harness.persistence.appendProjection(
                            transaction,
                            authenticatedProjectionFixture(duplicateRoute),
                            projectionRetention(duplicateProjection)
                        );
                    })
                ).toThrow();
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.persistence.appendDelivery(
                            transaction,
                            deliveryFixture(reservation, "rejected")
                        );
                    })
                ).toThrow(/immutable|unique|constraint|already terminal/i);

                harness.transaction((transaction) => {
                    const stored = harness.persistence.findReservation(transaction, reservation.id);
                    expect(stored?.sourceActor.equals(sourceActor)).toBe(true);
                    expect(stored?.targetActor.equals(sourceActor)).toBe(true);
                    expect(
                        harness.persistence.findProjection(transaction, duplicateProjection.id)
                    ).toBeUndefined();
                    expect(
                        harness.persistence.findDelivery(transaction, reservation.id)?.state.kind
                    ).toBe("delivered");
                    expect(harness.persistence.listReservations(transaction)).toEqual([stored]);
                });
            } finally {
                harness.dispose();
            }
        });

        test("restores Events, routes, Views, and deltas after restart", { tags: "p1" }, () => {
            const harness = create();
            try {
                const event = eventFixture(`${name}-restart`);
                const reservation = reservationFixture(`${name}-restart`, { target: sourceActor });
                const projection = projectionFixture(reservation);
                const view = viewFixture(0, `${name}-restart`);
                const delta = viewDeltaFixture(view);
                const next = new View({
                    surface: view.surface,
                    revision: delta.revision,
                    body: { count: 1, nested: { enabled: true } },
                    actions: view.actions,
                    cursor: delta.cursor
                });
                harness.transaction((transaction) => {
                    harness.persistence.appendEvent(transaction, event, eventRetention(event));
                    harness.persistence.appendReservation(
                        transaction,
                        reservation,
                        reservationRetention(reservation)
                    );
                    harness.persistence.appendProjection(
                        transaction,
                        authenticatedProjectionFixture(reservation),
                        projectionRetention(projection, sourceActor)
                    );
                    harness.persistence.saveView(transaction, view, undefined, []);
                    expect(
                        harness.persistence.appendViewDelta(
                            transaction,
                            delta,
                            new DeterministicJsonPatchEngine(),
                            [],
                            []
                        ).body
                    ).toEqual(next.body);
                });
                harness.restart();

                harness.transaction((transaction) => {
                    expect(harness.persistence.findEvent(transaction, event.id)?.id).toEqual(
                        event.id
                    );
                    expect(
                        harness.persistence.findReservation(transaction, reservation.id)?.id
                    ).toEqual(reservation.id);
                    expect(
                        harness.persistence.findProjection(transaction, projection.id)?.id
                    ).toEqual(projection.id);
                    expect(
                        harness.persistence.findView(
                            transaction,
                            view.surface.value,
                            Revision.initial()
                        )?.body
                    ).toEqual(view.body);
                    expect(
                        harness.persistence.currentView(transaction, view.surface.value)?.body
                    ).toEqual(next.body);
                    expect(
                        harness.persistence
                            .listViewDeltas(transaction, view.surface.value, Revision.initial())
                            .map((item) => item.revision.value)
                    ).toEqual([1]);
                });
            } finally {
                harness.dispose();
            }
        });
    });
}

/** A later revision of one Subscription that changes only the attribution it carries. */
function revised(
    subscription: Subscription,
    contribution: ContributionAttribution | undefined
): Subscription {
    return subscription.revise({
        source: subscription.source,
        target: subscription.target,
        mapping: subscription.mapping,
        dedupe: subscription.dedupe,
        authority: subscription.authority,
        contribution
    });
}

/**
 * SAFETY: this is deliberately not an AuthenticatedContribution. The persistence boundary
 * must reject a public PackageInstallationRef even though it carries a valid-looking pair.
 */
function forgedAuthenticatedContribution<TActual>(value: TActual): AuthenticatedContribution {
    // SAFETY: this value has no private WeakMap entry, and the boundary must reject it.
    return value as TActual & AuthenticatedContribution;
}
