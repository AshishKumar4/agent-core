import { describe, expect, test } from "vitest";
import { AgentCoreError } from "../src/errors";
import {
    Agent,
    AgentConfig,
    AgentId,
    AgentProfile,
    AgentProfileFacetSpec,
    AgentProfileFacetSpecSet,
    AgentProfileId,
    AgentRuntime,
    BindingSet,
    RuntimeContext,
    Run,
    RunBranchId,
    RunBranchRequest,
    RunCommitId,
    RunCommitKind,
    RunCommitRequest,
    RunController,
    RunCreationRequest,
    RunId,
    RunSpawnRequest,
    TurnClaimRequest,
    TurnCompleteRequest,
    TurnCreationRequest,
    TurnId,
    TurnLeaseCommit,
    TurnOutcome,
    TurnRenewLeaseRequest,
    TurnRole,
    TurnStatus,
    TurnSuspendRequest
} from "../src/agents";
import {
    AuthoritySummary,
    BindingName,
    Facet,
    FacetContext,
    FacetDataSchemas,
    FacetDescription,
    FacetId,
    FacetSet,
    FacetOperation,
    FacetOperationHandler,
    FacetOperationName,
    FacetVersion,
    OperationDescriptor,
    OperationSet,
    PromptContribution,
    PromptSection,
    type FacetData
} from "../src/facets";
import type { BindingAuthority } from "../src/authority";
import { PrincipalId, TenantId } from "../src/identity";
import { OperationContext } from "../src/operations";
import { NoopTelemetry } from "../src/observability";
import { ContentRef, Digest, Revision } from "../src/record";
import { WorkspaceId } from "../src/workspaces";
import { testOperationContext } from "./helpers/context";

const workspaceId = new WorkspaceId("workspace-1");
const tenantId = new TenantId("tenant-1");
const agentId = new AgentId("agent-1");
const holderId = new PrincipalId("executor-1");

function contentRef(name: string): ContentRef {
    return new ContentRef(`content:${name}`);
}

function digest(name: string): Digest {
    return new Digest(`digest:${name}`);
}

function date(value: string): Date {
    return new Date(value);
}

function operation(
    name: string,
    binding: BindingName = new BindingName("test"),
    authority: BindingAuthority | undefined = undefined,
    authorityVerifier: BindingSet | undefined = undefined
): OperationContext {
    return testOperationContext(name, binding, authority, authorityVerifier);
}

function facetContext(name: string, context: OperationContext): FacetContext {
    return new FacetContext(
        new FacetId(`facet-${name}`),
        new BindingName(name),
        context,
        new NoopTelemetry()
    );
}

function runCreation(id: string): RunCreationRequest {
    return new RunCreationRequest({
        id: new RunId(id),
        inputRef: contentRef(`${id}-input`)
    });
}

function startedRun(id: string): ReturnType<RunController["start"]> {
    return new RunController().start(
        runCreation(id),
        workspaceId,
        tenantId,
        agentId,
        Revision.initial()
    );
}

function turnFor(run: Run, branchId = run.activeBranchId): ReturnType<TurnCreationRequest["create"]> {
    return new TurnCreationRequest({
        id: new TurnId(`turn-${run.id.value}`),
        runId: run.id,
        branchId,
        inputRef: contentRef(`${run.id.value}-turn-input`)
    }).create();
}

function profile(): AgentProfile {
    return new AgentProfile(
        new AgentProfileId("profile-1"),
        "Runtime Test Agent",
        contentRef("instructions"),
        AgentProfileFacetSpecSet.of([
            new AgentProfileFacetSpec(
                new FacetId("facet-ambient"),
                new BindingName("ambient")
            )
        ]),
        AgentProfileFacetSpecSet.of([
            new AgentProfileFacetSpec(
                new FacetId("facet-bound"),
                new BindingName("bound")
            )
        ])
    );
}

function agent(): Agent {
    return new Agent(
        agentId,
        workspaceId,
        tenantId,
        new AgentConfig(profile()),
        "active",
        Revision.initial()
    );
}

class EchoHandler extends FacetOperationHandler<FacetData, FacetData> {
    public execute(
        _context: OperationContext,
        input: FacetData
    ): Promise<FacetData> {
        return Promise.resolve(input);
    }
}

class TestFacet extends Facet {
    public constructor(
        context: FacetContext,
        private readonly title: string,
        private readonly body: string,
        private readonly priority: number,
        private readonly operationName: FacetOperationName
    ) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            this.title,
            this.body,
            new FacetVersion("1"),
            AuthoritySummary.scoped("test")
        );
    }

    public prompt(): PromptContribution {
        return PromptContribution.of([
            new PromptSection(this.title, this.body, this.priority)
        ]);
    }

    public operations(): OperationSet {
        return OperationSet.of([
            new FacetOperation(
                new OperationDescriptor(
                    this.operationName,
                    `Echo through ${this.title}`,
                    "observe",
                    FacetDataSchemas.any(),
                    FacetDataSchemas.any()
                ),
                new EchoHandler()
            )
        ]);
    }
}

class TestRuntime extends AgentRuntime {
    public constructor(context: RuntimeContext) {
        super(context);
    }

    public execute(): Promise<TurnOutcome> {
        return Promise.resolve(TurnOutcome.succeeded(undefined));
    }
}

describe("Agent runtime", () => {
    test("assembles prompt and operation catalog from resolved facet bindings", async () => {
        const runtimeOperation = operation("runtime");
        const low = new TestFacet(
            facetContext("low", runtimeOperation),
            "Lower",
            "lower body",
            10,
            new FacetOperationName("low.echo")
        );
        const high = new TestFacet(
            facetContext("high", runtimeOperation),
            "Higher",
            "higher body",
            20,
            new FacetOperationName("high.echo")
        );
        const bindings = BindingSet.of([low, high]);
        const run = startedRun("runtime-run").run;
        const runtime = new TestRuntime(new RuntimeContext(
            agent(),
            run,
            runtimeOperation,
            new NoopTelemetry(),
            bindings
        ));
        await runtime.start();

        expect(runtime.context.agent.profile.facetSpecs.specs).toHaveLength(2);
        expect(bindings.resolve(new BindingName("low"))).toBe(low);
        expect(runtime.prompt().render()).toBe("## Higher\nhigher body\n\n## Lower\nlower body");
        expect(runtime.operationCatalog().operations).toHaveLength(2);

        const operationEntry = runtime.operationCatalog().operations.find(entry =>
            entry.name.equals(new FacetOperationName("high.echo"))
        );
        if (operationEntry === undefined) {
            throw new Error("Expected high.echo operation");
        }

        expect(await operationEntry.execute(
            operation("runtime-high", new BindingName("high"), bindings.authorityFor(new BindingName("high")), bindings),
            "value"
        )).toBe("value");
        await runtime.stop();
    });

    test("rejects duplicate ambient and bound profile bindings", () => {
        expect(() => new AgentProfile(
            new AgentProfileId("profile-duplicate"),
            "Duplicate Profile",
            contentRef("duplicate-instructions"),
            AgentProfileFacetSpecSet.of([
                new AgentProfileFacetSpec(
                    new FacetId("facet-one"),
                    new BindingName("shared")
                )
            ]),
            AgentProfileFacetSpecSet.of([
                new AgentProfileFacetSpec(
                    new FacetId("facet-two"),
                    new BindingName("shared")
                )
            ])
        )).toThrow(TypeError);
    });
});

describe("Run and Turn controller", () => {
    test("starts a branchable Run with a root branch and root commit", () => {
        const record = startedRun("run-start");

        expect(record.run.active).toBe(true);
        expect(record.run.rootBranchId.equals(record.rootBranch.id)).toBe(true);
        expect(record.run.rootCommitId.equals(record.rootCommit.id)).toBe(true);
        expect(record.rootCommit.kind.equals(RunCommitKind.input)).toBe(true);
        expect(record.rootCommit.parents).toEqual([]);
    });

    test("claims, renews, suspends, and completes a Turn with lease fencing", () => {
        const controller = new RunController();
        const now = date("2026-01-01T00:00:00.000Z");
        const run = startedRun("turn-lifecycle").run;
        const queued = turnFor(run);

        const claimed = controller.claim(
            queued,
            new TurnClaimRequest(holderId, date("2026-01-01T00:05:00.000Z"), now)
        );

        expect(claimed.status.equals(TurnStatus.running)).toBe(true);
        expect(claimed.lease.epoch).toBe(1);
        expect(claimed.lease.isHeldBy(holderId, 1, now)).toBe(true);

        const renewed = controller.renewLease(
            claimed,
            new TurnRenewLeaseRequest(
                new TurnLeaseCommit(holderId, 1),
                date("2026-01-01T00:10:00.000Z"),
                now
            )
        );
        const checkpointRef = contentRef("checkpoint");
        const suspended = controller.suspend(
            renewed,
            new TurnSuspendRequest(
                new TurnLeaseCommit(holderId, 1),
                checkpointRef,
                now
            )
        );

        expect(suspended.status.equals(TurnStatus.suspended)).toBe(true);
        expect(suspended.lease.epoch).toBe(2);
        expect(suspended.suspension?.checkpointRef.equals(checkpointRef)).toBe(true);

        const resumed = controller.claim(
            suspended,
            new TurnClaimRequest(holderId, date("2026-01-01T00:15:00.000Z"), now)
        );
        const completed = controller.complete(
            resumed,
            new TurnCompleteRequest(
                new TurnLeaseCommit(holderId, 3),
                TurnOutcome.succeeded(contentRef("result")),
                now
            )
        );

        expect(completed.terminal).toBe(true);
        expect(completed.status.equals(TurnStatus.succeeded)).toBe(true);
        expect(completed.lease.holderId).toBeUndefined();
    });

    test("rejects stale Turn lease commits at transition time", () => {
        const controller = new RunController();
        const now = date("2026-01-01T00:00:00.000Z");
        const claimed = controller.claim(
            turnFor(startedRun("stale-turn").run),
            new TurnClaimRequest(holderId, date("2026-01-01T00:05:00.000Z"), now)
        );

        expect(() => controller.renewLease(
            claimed,
            new TurnRenewLeaseRequest(
                new TurnLeaseCommit(holderId, 1),
                date("2026-01-01T00:11:00.000Z"),
                date("2026-01-01T00:06:00.000Z")
            )
        )).toThrow(new AgentCoreError("lease.invalid", "Turn lease renewal requires the current holder and epoch"));
    });

    test("branches, commits, undoes, merges, and spawns child Runs", () => {
        const controller = new RunController();
        const now = date("2026-01-01T00:00:00.000Z");
        const start = startedRun("branch-run");
        const turn = controller.claim(
            turnFor(start.run),
            new TurnClaimRequest(holderId, date("2026-01-01T00:05:00.000Z"), now)
        );
        const commitLease = new TurnLeaseCommit(holderId, 1);
        const branchRecord = controller.branch(start.run, new RunBranchRequest(
            new RunBranchId("branch-experiment"),
            "experiment",
            start.rootCommit.id
        ), Revision.initial());
        const proposal = controller.commit(turn, start.rootBranch, new RunCommitRequest(
            new RunCommitId("commit-proposal"),
            RunCommitKind.message,
            [start.rootCommit.id],
            contentRef("proposal"),
            digest("proposal"),
            commitLease,
            now
        ), Revision.initial());
        const undo = controller.undo(turn, proposal.branch, start.rootCommit.id, new RunCommitRequest(
            new RunCommitId("commit-undo"),
            RunCommitKind.undo,
            [proposal.commit.id],
            undefined,
            undefined,
            commitLease,
            now
        ), Revision.initial());
        const merge = controller.commit(turn, proposal.branch, new RunCommitRequest(
            new RunCommitId("commit-merge"),
            RunCommitKind.merge,
            [proposal.commit.id, undo.commit.id],
            contentRef("merge"),
            digest("merge"),
            commitLease,
            now
        ), Revision.initial());
        const child = controller.spawn(start.run, turn, new RunSpawnRequest(
            runCreation("child-run"),
            FacetSet.empty(),
            commitLease,
            now
        ), Revision.initial());

        expect(branchRecord.branch.head.equals(start.rootCommit.id)).toBe(true);
        expect(proposal.branch.head.equals(proposal.commit.id)).toBe(true);
        expect(undo.branch.head.equals(start.rootCommit.id)).toBe(true);
        expect(merge.commit.parents.map(parent => parent.value)).toEqual(["commit-proposal", "commit-undo"]);
        expect(child.run.parentId?.equals(start.run.id)).toBe(true);
        expect(child.parentTurnId.equals(turn.id)).toBe(true);
    });

    test("models Hermes-style mixture of agents with proposer, aggregator, and judge Turns", () => {
        const controller = new RunController();
        const now = date("2026-01-01T00:00:00.000Z");
        const start = startedRun("moa-run");
        const proposerA = controller.claim(new TurnCreationRequest({
            id: new TurnId("turn-proposer-a"),
            runId: start.run.id,
            branchId: start.rootBranch.id,
            inputRef: start.rootCommit.contentRef ?? contentRef("prompt"),
            role: TurnRole.proposer,
            layer: 1
        }).create(), new TurnClaimRequest(holderId, date("2026-01-01T00:05:00.000Z"), now));
        const proposerB = controller.claim(new TurnCreationRequest({
            id: new TurnId("turn-proposer-b"),
            runId: start.run.id,
            branchId: start.rootBranch.id,
            inputRef: start.rootCommit.contentRef ?? contentRef("prompt"),
            role: TurnRole.proposer,
            layer: 1
        }).create(), new TurnClaimRequest(holderId, date("2026-01-01T00:05:00.000Z"), now));
        const proposalA = controller.commit(proposerA, start.rootBranch, new RunCommitRequest(
            new RunCommitId("commit-proposal-a"),
            RunCommitKind.message,
            [start.rootCommit.id],
            contentRef("proposal-a"),
            digest("proposal-a"),
            new TurnLeaseCommit(holderId, 1),
            now
        ), Revision.initial());
        const proposalB = controller.commit(proposerB, start.rootBranch, new RunCommitRequest(
            new RunCommitId("commit-proposal-b"),
            RunCommitKind.message,
            [start.rootCommit.id],
            contentRef("proposal-b"),
            digest("proposal-b"),
            new TurnLeaseCommit(holderId, 1),
            now
        ), Revision.initial());
        const aggregator = controller.claim(new TurnCreationRequest({
            id: new TurnId("turn-aggregator"),
            runId: start.run.id,
            branchId: start.rootBranch.id,
            inputRef: contentRef("aggregate-input"),
            role: TurnRole.aggregator,
            layer: 2
        }).create(), new TurnClaimRequest(holderId, date("2026-01-01T00:05:00.000Z"), now));
        const synthesis = controller.commit(aggregator, start.rootBranch, new RunCommitRequest(
            new RunCommitId("commit-synthesis"),
            RunCommitKind.merge,
            [proposalA.commit.id, proposalB.commit.id],
            contentRef("synthesis"),
            digest("synthesis"),
            new TurnLeaseCommit(holderId, 1),
            now
        ), Revision.initial());
        const judge = controller.claim(new TurnCreationRequest({
            id: new TurnId("turn-judge"),
            runId: start.run.id,
            branchId: start.rootBranch.id,
            inputRef: synthesis.commit.contentRef ?? contentRef("synthesis"),
            role: TurnRole.judge,
            layer: 3
        }).create(), new TurnClaimRequest(holderId, date("2026-01-01T00:05:00.000Z"), now));
        const verdict = controller.commit(judge, synthesis.branch, new RunCommitRequest(
            new RunCommitId("commit-verdict"),
            RunCommitKind.verdict,
            [synthesis.commit.id],
            contentRef("verdict"),
            digest("verdict"),
            new TurnLeaseCommit(holderId, 1),
            now
        ), Revision.initial());

        expect(proposerA.role.equals(TurnRole.proposer)).toBe(true);
        expect(proposerB.role.equals(TurnRole.proposer)).toBe(true);
        expect(aggregator.role.equals(TurnRole.aggregator)).toBe(true);
        expect(judge.role.equals(TurnRole.judge)).toBe(true);
        expect(synthesis.commit.parents.map(parent => parent.value)).toEqual(["commit-proposal-a", "commit-proposal-b"]);
        expect(verdict.commit.kind.equals(RunCommitKind.verdict)).toBe(true);
    });
});
