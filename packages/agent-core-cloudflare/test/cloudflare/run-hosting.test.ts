import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ActorId, AgentCoreError, Revision } from "@agent-core/core";
import { RunId } from "@agent-core/core/agents/runs";
import {
    CloudflareRunHosting,
    CloudflareSqlite,
    DurableObjectRunStorage,
    SqliteRunHostingIndex,
    type RunHostingMode
} from "../../src/index.js";
import {
    errors,
    genesis,
    ids,
    pins,
    resultCommit,
    runHarness,
    seedRunningTurn,
    TestSettlementPort
} from "../run-fixture.js";
import type { RunDurableObject, RunWorkspaceDurableObject } from "./worker.js";

const READ_RUN_OBJECTS =
    "SELECT name FROM sqlite_schema WHERE name LIKE 'agent_run_%' ORDER BY name";

interface StartedHosting {
    readonly mode: string;
    readonly ownerKind: string;
    readonly ownerId: string;
    readonly objectName: string;
}

/** One Workspace per scenario, so no scenario reads another's private storage. */
function workspaceObject(workspace: ActorId): DurableObjectStub<RunWorkspaceDurableObject> {
    return env.RUN_WORKSPACES.getByName(
        new CloudflareRunHosting(ids.run, workspace).objectName
    );
}

function ownerObject(
    hosting: StartedHosting,
    workspace: ActorId
): DurableObjectStub<RunDurableObject | RunWorkspaceDurableObject> {
    return hosting.ownerKind === "run"
        ? env.RUN_OBJECTS.getByName(hosting.objectName)
        : workspaceObject(workspace);
}

/**
 * Runs the body inside the object's own isolate, against the SQLite adapter that object
 * built for itself. Only plain data crosses back out, because everything that matters
 * happens in the object's private storage rather than in the test's isolate.
 */
async function inObject<Instance extends RunDurableObject | RunWorkspaceDurableObject, Result>(
    stub: DurableObjectStub<Instance>,
    body: (sqlite: CloudflareSqlite) => Result
): Promise<Result> {
    return runInDurableObject(stub, (instance) => body(instance.sqlite));
}

function described(hosting: CloudflareRunHosting): StartedHosting {
    return {
        mode: hosting.mode,
        ownerKind: hosting.owner.kind,
        ownerId: hosting.owner.id.value,
        objectName: hosting.objectName
    };
}

async function startHosting(
    run: RunId,
    mode: RunHostingMode,
    workspace: ActorId
): Promise<StartedHosting> {
    return inObject(workspaceObject(workspace), (sqlite) =>
        described(
            new SqliteRunHostingIndex(sqlite, errors).start(
                new CloudflareRunHosting(run, workspace, mode)
            )
        )
    );
}

async function runObjectNames(
    stub: DurableObjectStub<RunDurableObject | RunWorkspaceDurableObject>
): Promise<readonly unknown[]> {
    return inObject(stub, (sqlite) => sqlite.all(READ_RUN_OBJECTS, []).map((row) => row["name"]));
}

describe("Cloudflare Run hosting in a Durable Object", () => {
    it.each([
        { name: "Workspace-owned by default", mode: "workspace" as const },
        { name: "pinned dedicated at start", mode: "dedicated" as const }
    ])(
        "[C13-CLOUDFLARE-RUN-HOSTING] keeps a $name Run's pins, outcome, graph, and derived " +
            "Settled obligations in its owner across a real Durable Object eviction",
        { tags: "p0" },
        async ({ mode }) => {
            const run = new RunId(`workerd-${mode}-run`);
            const workspace = new ActorId(`workerd-${mode}-workspace`);
            const hosting = await startHosting(run, mode, workspace);
            expect(hosting.ownerKind).toBe(mode === "workspace" ? "workspace" : "run");
            expect(hosting.ownerId).toBe(mode === "workspace" ? workspace.value : run.value);
            const terminal = resultCommit("workerd-terminal-result", {
                turn: ids.turn,
                holder: ids.holder,
                epoch: 1
            });

            await inObject(ownerObject(hosting, workspace), (sqlite) => {
                const harness = runHarness(
                    new DurableObjectRunStorage(
                        sqlite,
                        new CloudflareRunHosting(run, workspace, mode),
                        errors
                    )
                );
                const { running, token } = seedRunningTurn(harness);
                harness.runtime.reserveRunObligation(ids.run, {
                    kind: "approval",
                    approval: ids.approval
                });
                harness.runtime.terminalizeRun({
                    run: ids.run,
                    turn: ids.turn,
                    expectedRunRevision: harness.repository.transaction(
                        (tx) => harness.repository.loadRun(tx, ids.run)!.revision
                    ),
                    expectedTurnRevision: running.revision,
                    expectedBranchRevision: new Revision(0),
                    token,
                    outcome: "succeeded",
                    commit: terminal,
                    siblingCancellations: new Map(),
                    now: new Date(1500)
                });
            });

            // The real thing: the isolate is destroyed and the object restarts from disk.
            if (mode === "dedicated") await evictDurableObject(ownerObject(hosting, workspace));
            await evictDurableObject(workspaceObject(workspace));

            const reloaded = await inObject(workspaceObject(workspace), (sqlite) => {
                const found = new SqliteRunHostingIndex(sqlite, errors).get(run);
                return found === undefined ? undefined : described(found);
            });
            expect(reloaded).toEqual(hosting);

            const retained = await inObject(ownerObject(hosting, workspace), (sqlite) => {
                const settlement = new TestSettlementPort();
                const harness = runHarness(
                    new DurableObjectRunStorage(
                        sqlite,
                        new CloudflareRunHosting(run, workspace, mode),
                        errors
                    ),
                    settlement
                );
                return harness.repository.transaction((tx) => {
                    const stored = harness.repository.loadRun(tx, ids.run)!;
                    const settledBefore = harness.runtime.settledInTransaction(tx, ids.run);
                    settlement.approvals.add(ids.approval.value);
                    return {
                        pins: harness.repository
                            .loadConfiguration(tx, genesis().configuration.id.value)!
                            .pins.equals(pins()),
                        rootPins: harness.repository.loadCommit(tx, ids.root)!.pins.equals(pins()),
                        lifecycle: stored.lifecycle.kind,
                        outcome: stored.terminal?.outcome,
                        parents: harness.storage
                            .parents(tx, terminal.id.value)
                            .map((edge) => `${edge.ordinal}:${edge.parent}`),
                        ancestral: harness.repository.isAncestor(tx, ids.root, terminal.id),
                        obligations: stored.terminal!.obligation.obligations.map(
                            (value) => value.kind
                        ),
                        settledBefore,
                        settledAfter: harness.runtime.settledInTransaction(tx, ids.run)
                    };
                });
            });

            expect(retained).toEqual({
                pins: true,
                rootPins: true,
                lifecycle: "terminal",
                outcome: "succeeded",
                parents: [`0:${ids.root.value}`],
                ancestral: true,
                obligations: ["approval"],
                settledBefore: false,
                settledAfter: true
            });

            expect(await runObjectNames(ownerObject(hosting, workspace))).toEqual([
                "agent_run_commit_parent_reverse",
                "agent_run_commit_parents",
                "agent_run_records",
                "agent_run_storage_schema"
            ]);
            if (mode === "dedicated") {
                // The Workspace object keeps the Run index and none of the Run's records.
                expect(await runObjectNames(workspaceObject(workspace))).toEqual([]);
            }
        }
    );

    it(
        "[C13-CLOUDFLARE-RUN-HOSTING] refuses a dedicated pin for a Run the Workspace already " +
            "started, across an eviction",
        { tags: "p0" },
        async () => {
            const run = new RunId("workerd-late-pin-run");
            const workspace = new ActorId("workerd-late-pin-workspace");
            const started = await startHosting(run, "workspace", workspace);
            await evictDurableObject(workspaceObject(workspace));

            const late = await inObject(workspaceObject(workspace), (sqlite) => {
                try {
                    new SqliteRunHostingIndex(sqlite, errors).start(
                        new CloudflareRunHosting(run, workspace, "dedicated")
                    );
                    return "accepted";
                } catch (error) {
                    return error instanceof AgentCoreError ? error.code : "unknown";
                }
            });

            expect(late).toBe("protocol.invalid-state");
            expect(await startHosting(run, "workspace", workspace)).toEqual(started);
        }
    );
});
