import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../src/actors";
import { Digest } from "../../src/core";
import { FacetInstallPhase } from "../../src/definition";
import type { FacetInstallFailure, PreparedPackageContribution } from "../../src/definition";
import {
    FacetActivation,
    FacetInvocationDrainPort,
    FacetWithdrawal,
    WorkspaceFacetMaterializer,
    type FacetInstallEvidencePort,
    type FacetRelianceQuery
} from "../../src/composition";
import { FacetManifest, PackageInstallationRef, SlotWithdrawalSet } from "../../src/facets";
import { InvocationId } from "../../src/interaction-references";
import type { ValidatedFacetRuntime } from "../../src/operations";
import type { WorkspacePersistence, WorkspaceRoutingWithdrawal } from "../../src/workspaces";
import type { WorkspaceSlotStore } from "../../src/facets";
import { forwarded, reaching } from "./fixture";
import { attribution } from "../w3/slot-store-contract";
import { authenticatedInstallationFixture } from "../workspaces/fixtures";
import { expectAgentCoreError } from "../protocol/error-assertion";

/** The Workspace Actor transaction shape; these tests never read one. */
type Control = Record<never, never>;
type CorrespondentFacet = ValidatedFacetRuntime["facets"][number];

const contribution = attribution("workspace:withdrawal-control");
const noReliance = reaching<FacetRelianceQuery>({ reliedUponBy: () => [] });
const noDrain = reaching<FacetInvocationDrainPort<Control>>({
    admitted: () => [],
    terminal: () => true
});

function controlTransaction<Result>(
    operation: (transaction: Control) => Result,
    ..._guard: SynchronousResultGuard<Result>
): Result {
    return operation({});
}

/** A withdrawal whose Workspace Actor transaction fails the way the caller's throw says. */
function failingControl(failure: () => never): FacetWithdrawal<Control> {
    return new FacetWithdrawal<Control>(
        reaching<WorkspaceSlotStore<Control>>({}),
        reaching<WorkspaceRoutingWithdrawal<Control>>({}),
        reaching<WorkspacePersistence<Control>>({}),
        failure,
        noReliance,
        noDrain
    );
}

/** An activation whose Facet fails the phase the caller names and then fails to stop. */
function activation(start: () => Promise<void>, stop: () => Promise<void>) {
    const installation = authenticatedInstallationFixture(
        contribution.contributor.value,
        contribution.package,
        new Digest("b".repeat(64))
    );
    const prepared: PreparedPackageContribution = {
        reference: new PackageInstallationRef(contribution, installation.packageFacet),
        manifestDigest: installation.manifestDigest,
        materialization: installation.materialization,
        stamp: Object.freeze({})
    };
    const recorded: FacetInstallFailure[] = [];
    const activator = new FacetActivation<Control, Control, Control>(
        reaching<FacetWithdrawal<Control>>({
            plan: () => ({
                attribution: contribution,
                records: {
                    catalogEntries: [],
                    ingressEndpoints: [],
                    promptSections: [],
                    settingsLayers: [],
                    surfaces: []
                },
                slots: new SlotWithdrawalSet(contribution, [], []),
                subscriptions: 0,
                obligations: []
            })
        }),
        reaching<WorkspaceFacetMaterializer<Control, Control, Control>>({
            prepareContribution: () => prepared,
            discard: () => undefined
        }),
        forwarded("The Workspace Actor transaction"),
        reaching<FacetInstallEvidencePort>({
            refusals: () => [],
            record: (failure) => {
                recorded.push(failure);
            }
        })
    );
    const facet = reaching<CorrespondentFacet>({
        ref: contribution.contributor,
        manifest: forwarded<FacetManifest>("The Facet manifest"),
        start,
        stop
    });
    return {
        activate: () => activator.activate(facet, {}, {}, { signal: new AbortController().signal }),
        recorded
    };
}

describe("the withdrawal control seam refuses what it cannot answer", () => {
    test(
        "never reports a completion whose Workspace Actor transaction failed",
        { tags: "p0" },
        () => {
            // SPEC §4.1: `complete` is the one state a host may act on as finished, so a
            // completion attempt that could not read the frozen drain set has to refuse. A
            // transaction failure answered as `complete` — or escaping as the raw platform
            // error — would let a host retire a Facet whose admitted items are still settling.
            expectAgentCoreError(
                () =>
                    failingControl(() => {
                        throw new TypeError("control failed");
                    }).completion(contribution),
                "protocol.invalid-state",
                /Workspace Actor transaction: control failed/u
            );
            // A platform that rejects with a value that is not an Error still gets named in
            // the refusal rather than reported as an empty reason.
            expectAgentCoreError(
                () =>
                    failingControl(() => {
                        throw "control rejected";
                    }).completion(contribution),
                "protocol.invalid-state",
                /Workspace Actor transaction: control rejected/u
            );
        }
    );

    test("names the plane that could not answer the withdrawal set", { tags: "p1" }, () => {
        // The set is read and written inside one transaction, so a plane that cannot answer
        // fails the whole withdrawal rather than retiring a partial set. The refusal carries
        // what the plane said even when it threw something that is not an Error.
        const withdrawal = new FacetWithdrawal<Control>(
            reaching<WorkspaceSlotStore<Control>>({
                withdrawalSet: () => {
                    throw "slot records unreadable";
                }
            }),
            reaching<WorkspaceRoutingWithdrawal<Control>>({}),
            reaching<WorkspacePersistence<Control>>({}),
            controlTransaction,
            noReliance,
            noDrain
        );
        expectAgentCoreError(
            () => withdrawal.plan(contribution),
            "protocol.invalid-state",
            /not computable from Workspace records: slot records unreadable/u
        );
        expectAgentCoreError(
            () => withdrawal.withdraw(contribution),
            "protocol.invalid-state",
            /not computable from Workspace records: slot records unreadable/u
        );
    });

    test("reports what a withdrawal that has not begun would face", { tags: "p0" }, () => {
        // SPEC §4.1: `plan` is the answer before anything is written, and it has to name both
        // kinds. Reliance comes first because it holds the withdrawal before it begins, while
        // a drain obligation only stands once it has. A plan that reported an empty set here
        // would tell a host it may withdraw a Facet another Facet still reaches and whose
        // admitted item is still settling.
        const dependent = attribution("workspace:withdrawal-dependent").contributor;
        const settling = new InvocationId("withdrawal-settling-item");
        const finished = new InvocationId("withdrawal-finished-item");
        const withdrawal = new FacetWithdrawal<Control>(
            reaching<WorkspaceSlotStore<Control>>({
                withdrawalSet: () => new SlotWithdrawalSet(contribution, [], []),
                requireWithdrawable: () => undefined
            }),
            reaching<WorkspaceRoutingWithdrawal<Control>>({ contributed: () => [] }),
            reaching<WorkspacePersistence<Control>>({
                listContributedCatalogEntries: () => [],
                listContributedIngressEndpoints: () => [],
                listContributedPromptSections: () => [],
                listContributedSettingsLayers: () => [],
                listContributedSurfaceRegistrations: () => []
            }),
            controlTransaction,
            reaching<FacetRelianceQuery>({
                reliedUponBy: (provider) =>
                    provider.equals(contribution.contributor) ? [dependent] : []
            }),
            reaching<FacetInvocationDrainPort<Control>>({
                admitted: () => [finished, settling],
                terminal: (_transaction, item) => item.equals(finished)
            })
        );

        expect(withdrawal.plan(contribution).obligations).toEqual([
            { kind: "reliance", dependent },
            { kind: "drain", item: settling }
        ]);
    });

    test("records both the phase failure and a failed stop", { tags: "p0" }, async () => {
        // SPEC §4.1: a Facet that failed to start is recorded as a typed failed install rather
        // than as a live Facet, and the stop that was supposed to clean it up can fail too.
        // Both facts reach the record: a reason carrying only the start failure would leave an
        // operator believing the partial activation was stopped.
        const failing = activation(
            () => Promise.reject(new TypeError("start failed")),
            () => Promise.reject(new TypeError("stop failed"))
        );
        await expect(failing.activate()).resolves.toMatchObject({
            kind: "failed",
            reason: "start failed; Facet stop failed: stop failed"
        });
        expect(failing.recorded).toHaveLength(1);
        expect(failing.recorded[0]?.phase).toBe(FacetInstallPhase.start);
        // A start-phase failure published no contribution records, so nothing is withdrawn —
        // the `plan` stub above is the only withdrawal member this path may reach.
        expect(failing.recorded[0]?.phase.materializedRecords).toBe(false);
    });
});
