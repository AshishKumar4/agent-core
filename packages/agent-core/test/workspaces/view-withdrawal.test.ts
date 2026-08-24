import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../src/actors";
import { DetachedJsonPatchEngine } from "../../src/composition";
import { encodeCanonicalJson, Revision } from "../../src/core";
import {
    FacetRef,
    MemoryWorkspaceSurfaceStore,
    SurfaceDescriptor,
    SurfaceId,
    SurfaceRegistration,
    type SurfaceWithdrawalSet
} from "../../src/facets";
import { malformed } from "../helpers/malformed";
import { TestSqlite } from "../helpers/sqlite";
import { WorkspaceId } from "../../src/identity";
import { AuditRecordId } from "../../src/interaction-references";
import { SqliteWorkspaceRecords } from "../../src/substrates/sqlite/workspace-records";
import {
    MemoryWorkspaceRecords,
    View,
    ViewReplayProtocol,
    WorkspacePersistence,
    WorkspaceRoutingWithdrawal,
    type ContentRetentionPort,
    type WorkspaceRecordStorage
} from "../../src/workspaces";
import {
    contributionAttributionFixture,
    materializeAttributedSubscription,
    reservationFixture,
    reservationRetention,
    sourceActor,
    subscriptionFixture,
    tenant,
    viewDeltaFixture,
    viewFixture
} from "./fixtures";

class DurableRetention implements ContentRetentionPort<WorkspaceRecordStorage> {
    public verify(): boolean {
        return true;
    }

    public release(): void {}

    public discard(): void {}
}

class SequentialAudits {
    #next = 0;

    public deliveryAudit(): AuditRecordId {
        this.#next += 1;
        return new AuditRecordId(`audit-view-withdrawal-${this.#next}`);
    }
}
interface WiredStores {
    readonly persistence: WorkspacePersistence<WorkspaceRecordStorage>;
    readonly protocol: ViewReplayProtocol<WorkspaceRecordStorage>;
    readonly routing: WorkspaceRoutingWithdrawal<WorkspaceRecordStorage>;
}

interface ViewHarness extends WiredStores {
    transact<Result>(
        operation: (storage: WorkspaceRecordStorage) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    restart(): void;
}

function wire(): WiredStores {
    const persistence = new WorkspacePersistence<WorkspaceRecordStorage>(
        (transaction) => transaction,
        new DurableRetention(),
        sourceActor,
        tenant
    );
    return {
        persistence,
        protocol: new ViewReplayProtocol(
            persistence,
            new DetachedJsonPatchEngine(),
            sourceActor,
            tenant
        ),
        routing: new WorkspaceRoutingWithdrawal(persistence, new SequentialAudits())
    };
}


function harness(kind: "memory" | "sqlite"): ViewHarness {
    if (kind === "sqlite") {
        const database = new TestSqlite();
        let records = new SqliteWorkspaceRecords(database);
        let wired = wire();
        return {
            get persistence() {
                return wired.persistence;
            },
            get protocol() {
                return wired.protocol;
            },
            get routing() {
                return wired.routing;
            },
            transact<Result>(
                operation: (storage: WorkspaceRecordStorage) => Result,
                ...guard: SynchronousResultGuard<Result>
            ): Result {
                return database.transaction(() => operation(records), ...guard);
            },
            restart(): void {
                records = new SqliteWorkspaceRecords(database);
                wired = wire();
            }
        };
    }
    let records = new MemoryWorkspaceRecords();
    let wired = wire();
    return {
        get persistence() {
            return wired.persistence;
        },
        get protocol() {
            return wired.protocol;
        },
        get routing() {
            return wired.routing;
        },
        transact<Result>(
            operation: (storage: WorkspaceRecordStorage) => Result,
            ..._guard: SynchronousResultGuard<Result>
        ): Result {
            return operation(records);
        },
        restart(): void {
            records = new MemoryWorkspaceRecords(records.snapshot());
            wired = wire();
        }
    };
}

const WITHDRAWN_FACET = new FacetRef("workspace:withdrawn");
const OTHER_FACET = new FacetRef("workspace:other");
const BACKENDS = ["memory", "sqlite"] as const;

function registerSurface(store: MemoryWorkspaceSurfaceStore, contributor: FacetRef, surface: string): void {
    store.register(
        new SurfaceRegistration(
            new SurfaceDescriptor(new SurfaceId(`surface-${surface}`), `Surface ${surface}`),
            contributionAttributionFixture(contributor.value)
        )
    );
}

/**
 * Seeds two attributed Surfaces and one direct (never registered) Surface, gives each a
 * durable View, advances the withdrawing contributor's View by one live delta, and runs
 * the withdrawal through the attribution query.
 */
function seedAndWithdraw(harness: ViewHarness): void {
    const surfaces = new MemoryWorkspaceSurfaceStore(new WorkspaceId("workspace-view-withdrawal"));
    registerSurface(surfaces, WITHDRAWN_FACET, "withdrawn");
    registerSurface(surfaces, OTHER_FACET, "other");
    const withdrawn = viewFixture(0, "withdrawn");
    const other = viewFixture(0, "other");
    const direct = viewFixture(0, "direct");
    harness.transact((storage) => {
        harness.protocol.publishSnapshot(storage, withdrawn, []);
        harness.protocol.publishSnapshot(storage, other, []);
        harness.protocol.publishSnapshot(storage, direct, []);
        harness.protocol.publish(storage, viewDeltaFixture(withdrawn), [], []);
    });
    withdrawRegisteredSurface(harness, surfaces);
}

function withdrawRegisteredSurface(
    harness: ViewHarness,
    surfaces: MemoryWorkspaceSurfaceStore
): readonly SurfaceId[] {
    return harness.transact((storage) => {
        const set: SurfaceWithdrawalSet = surfaces.transaction((transaction) =>
            surfaces.withdrawalSet(
                transaction,
                contributionAttributionFixture(WITHDRAWN_FACET.value)
            )
        );
        return harness.protocol.retire(storage, set, () => ({ view: [], delta: [] })).map((view) => view.surface);
    });
}

function expectTerminalConflict(operation: () => void): void {
    expect(operation).toThrow(
        expect.objectContaining({ code: "protocol.revision-conflict" })
    );
}

function exactContributorWithdrawal(harness: ViewHarness): void {
    seedAndWithdraw(harness);

    harness.transact((storage) => {
        const terminal = harness.persistence.currentView(storage, "surface-withdrawn");
        expect(terminal?.revision.value).toBe(2);
        expect(terminal?.terminal).toBe(true);
        expect(terminal?.body).toEqual({ count: 1, nested: { enabled: true } });
        const deltas = harness.persistence.listViewDeltas(
            storage,
            "surface-withdrawn",
            Revision.initial()
        );
        expect(deltas.map((delta) => delta.revision.value)).toEqual([1, 2]);
        expect(deltas[1]?.patch).toEqual([{ op: "add", path: "/terminal", value: true }]);
        // The cursor never advanced: retirement terminates the stream without an Event.
        expect(deltas[1]?.cursor.equals(deltas[0]!.cursor)).toBe(true);

        // Exactly the contributor's own registrations retired; nothing else changed.
        for (const surface of ["surface-other", "surface-direct"]) {
            const untouched = harness.persistence.currentView(storage, surface);
            expect(untouched?.terminal).toBeUndefined();
            expect(untouched?.revision.value).toBe(0);
            expect(View.codec.encode(untouched!)).toEqual(
                View.codec.encode(viewFixture(0, surface.replace("surface-", "")))
            );
        }
    });
}

function replayReturnsTerminalRevision(harness: ViewHarness): void {
    seedAndWithdraw(harness);
    const surface = new SurfaceId("surface-withdrawn");

    harness.transact((storage) => {
        // A client presenting any cursor it already holds catches up to the terminal
        // revision through the ordinary reader — no error, no endless stream.
        const fromStart = harness.protocol.replay(storage, surface, Revision.initial());
        expect(fromStart.kind).toBe("deltas");
        if (fromStart.kind !== "deltas") throw new TypeError("Expected durable deltas");
        expect(fromStart.deltas).toHaveLength(2);
        expect(fromStart.view.terminal).toBe(true);

        const atTerminal = harness.protocol.replay(storage, surface, fromStart.view.revision);
        expect(atTerminal.kind).toBe("deltas");
        if (atTerminal.kind !== "deltas") throw new TypeError("Expected durable deltas");
        expect(atTerminal.deltas).toEqual([]);
        expect(atTerminal.view.terminal).toBe(true);

        expect(() =>
            harness.protocol.replay(storage, surface, fromStart.view.revision.next())
        ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
    });

    // Compaction may drop every earlier base; the terminal revision stays answerable.
    harness.transact((storage) => harness.protocol.compact(storage, surface, new Revision(1)));
    harness.transact((storage) => {
        const fallback = harness.protocol.replay(storage, surface, Revision.initial());
        expect(fallback.kind).toBe("snapshot");
        if (fallback.kind !== "snapshot") throw new TypeError("Expected snapshot fallback");
        expect(fallback.view.revision.value).toBe(2);
        expect(fallback.view.terminal).toBe(true);
    });
}

function survivesResponseLossAndRestart(harness: ViewHarness): void {
    seedAndWithdraw(harness);
    const durableViews = () =>
        harness.transact((storage) =>
            storage
                .listRecords("view")
                .filter((record) => record.id.startsWith("surface-withdrawn@")).length
        );

    // The caller loses the response entirely: the transition is re-derived from records.
    harness.restart();

    const surfaces = new MemoryWorkspaceSurfaceStore(new WorkspaceId("workspace-view-withdrawal"));
    registerSurface(surfaces, WITHDRAWN_FACET, "withdrawn");
    registerSurface(surfaces, OTHER_FACET, "other");
    expect(withdrawRegisteredSurface(harness, surfaces)).toEqual([]);
    expect(durableViews()).toBe(3);
    harness.transact((storage) => {
        expect(harness.persistence.currentView(storage, "surface-withdrawn")?.revision.value).toBe(
            2
        );
        expect(
            harness.persistence.listViewDeltas(storage, "surface-withdrawn", Revision.initial())
        ).toHaveLength(2);
    });
}

function refusesRevisionLaundering(harness: ViewHarness): void {
    seedAndWithdraw(harness);
    const surface = new SurfaceId("surface-withdrawn");

    harness.transact((storage) => {
        const terminal = harness.persistence.currentView(storage, surface.value);
        if (terminal === undefined) throw new TypeError("Expected the terminal View");
        const durableBytes = View.codec.encode(terminal);

        const continuation = viewDeltaFixture(terminal);
        expectTerminalConflict(() => harness.protocol.publish(storage, continuation, [], []));

        expectTerminalConflict(() =>
            harness.protocol.publishSnapshot(storage, viewFixture(0, "withdrawn"), [])
        );

        // A higher revision that strips `terminal` revives nothing either.
        const laundered = new View({
            surface: terminal.surface,
            revision: terminal.revision.next(),
            body: terminal.body,
            actions: terminal.actions,
            cursor: terminal.cursor
        });
        expectTerminalConflict(() =>
            harness.persistence.saveView(storage, laundered, terminal.revision, [])
        );

        // Terminality is declared by presence at the value and on the wire alike.
        for (const forged of [false, 0, "true"]) {
            expect(
                () =>
                    new View({
                        surface: terminal.surface,
                        revision: terminal.revision.next(),
                        body: terminal.body,
                        actions: terminal.actions,
                        cursor: terminal.cursor,
                        terminal: malformed<true>(forged)
                    })
            ).toThrow(new TypeError("View terminality is declared by presence"));
        }
        const forgedPayload = {
            kind: View.codec.kind,
            version: { major: 2, minor: 0 },
            payload: {
                surface: terminal.surface.value,
                revision: terminal.revision.value,
                actions: terminal.actions.map((action) => ({
                    emits: action.emits.value,
                    id: action.id.value,
                    label: action.label
                })),
                cursor: terminal.cursor.value,
                terminal: "yes"
            }
        };
        expect(() => View.decode(encodeCanonicalJson(forgedPayload))).toThrow(
            expect.objectContaining({ code: "codec.invalid" })
        );

        expect(View.codec.encode(harness.persistence.currentView(storage, surface.value)!)).toEqual(
            durableBytes
        );
        expect(
            harness.persistence.listViewDeltas(storage, surface.value, Revision.initial())
        ).toHaveLength(2);
    });
}

function preservesUnrelatedDirectViews(harness: ViewHarness): void {
    seedAndWithdraw(harness);

    harness.transact((storage) => {
        for (const suffix of ["other", "direct"]) {
            const current = harness.persistence.currentView(storage, `surface-${suffix}`);
            if (current === undefined) throw new TypeError(`Expected the ${suffix} View`);
            const published = harness.protocol.publish(
                storage,
                viewDeltaFixture(current),
                [],
                []
            );
            expect(published.revision.value).toBe(1);
            expect(published.terminal).toBeUndefined();
            const replayed = harness.protocol.replay(
                storage,
                new SurfaceId(`surface-${suffix}`),
                Revision.initial()
            );
            expect(replayed.kind).toBe("deltas");
            if (replayed.kind !== "deltas") throw new TypeError("Expected durable deltas");
            expect(replayed.view.revision.equals(published.revision)).toBe(true);
        }

        // The withdrawn Surface alone stayed closed while its neighbours moved on.
        expectTerminalConflict(() =>
            harness.protocol.publish(
                storage,
                viewDeltaFixture(harness.persistence.currentView(storage, "surface-withdrawn")!),
                [],
                []
            )
        );
    });
}

function routingSweepRetryChangesNothing(harness: ViewHarness): void {
    const owner = contributionAttributionFixture("workspace:routed");
    harness.transact((storage) => {
        materializeAttributedSubscription(
            harness.persistence,
            storage,
            owner,
            subscriptionFixture("routed")
        );
        const reservation = reservationFixture("routed");
        harness.persistence.appendReservation(storage, reservation, reservationRetention(reservation));
    });

    const first = harness.transact((storage) => harness.routing.retire(storage, owner));
    expect(first.subscriptions.map((id) => id.value)).toEqual(["subscription-routed"]);
    expect(first.rejected.map((id) => id.value)).toEqual(["reservation-routed"]);

    // Retirement is terminal, so the retried sweep's response shrinks to nothing: the
    // retired Subscription no longer surfaces as a live contribution at all.
    harness.restart();
    const retry = harness.transact((storage) => harness.routing.retire(storage, owner));
    expect(retry.subscriptions).toEqual([]);
    expect(retry.rejected).toEqual([]);
    harness.transact((storage) => {
        const rejection = harness.persistence.findDelivery(storage, reservationFixture("routed").id);
        expect(rejection?.state.kind).toBe("rejected");
    });
}

describe("contributed View withdrawal", () => {
    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] exact contributor withdrawal marks exactly its registered Surfaces terminal",
        { tags: "p0" },
        () => {
            for (const backend of BACKENDS) exactContributorWithdrawal(harness(backend));
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] replay returns the terminal revision through the ordinary reader",
        { tags: "p0" },
        () => {
            for (const backend of BACKENDS) replayReturnsTerminalRevision(harness(backend));
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] the transition survives response loss and restart without a second terminal delta",
        { tags: "p0" },
        () => {
            for (const backend of BACKENDS) survivesResponseLossAndRestart(harness(backend));
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] no revision launders past the terminal one",
        { tags: "p0" },
        () => {
            for (const backend of BACKENDS) refusesRevisionLaundering(harness(backend));
        }
    );

    test(
        "[C13-VIEW-WITHDRAWAL-TERMINAL] an unrelated direct View stays live while the withdrawn Surface publishes no later delta",
        { tags: "p0" },
        () => {
            for (const backend of BACKENDS) preservesUnrelatedDirectViews(harness(backend));
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] a repeated routing sweep after response loss retires nothing twice",
        { tags: "p1" },
        () => {
            for (const backend of BACKENDS) routingSweepRetryChangesNothing(harness(backend));
        }
    );
});
