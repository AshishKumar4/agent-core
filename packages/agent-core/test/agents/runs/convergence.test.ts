import { describe, expect, it } from "vitest";
import { ContentRef, Revision, SemVer } from "../../../src/core";
import type { ContentStore } from "../../../src/content";
import { AgentCoreError } from "../../../src/errors";
import { PackageId, PackagePin, TreeMergePolicy } from "../../../src/definition";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { InvocationId } from "../../../src/interaction-references";
import { ReceiptId } from "../../../src/invocations";
import { RunCommit, type RunCommitInit } from "../../../src/agents/runs/commit";
import {
    RunMergePort,
    type ControlCommitEvidence,
    type MergeFoldStep
} from "../../../src/agents/runs/evidence";
import {
    BlueprintPin,
    RunConfigurationSnapshot,
    RunPinDimension,
    RunPins
} from "../../../src/agents/runs/pins";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { RunBranch } from "../../../src/agents/runs/run";
import { RunBranchId } from "../../../src/agents/runs/id";
import type { RunRepository, RunTransaction } from "../../../src/agents/runs/store";
import { RunRuntime } from "../../../src/agents/runs/runtime";
import { Turn } from "../../../src/agents/runs/turn";
import {
    TestEvidencePort,
    TestSettlementPort,
    TestSourcePort,
    TestSpawnPort,
    genesis,
    ids,
    memoryRunStorage,
    pins,
    refs,
    testRunRepository,
    thrownBy,
    UncontributedCutPoints
} from "./fixture";

const encoder = new TextEncoder();

/**
 * A merge port that resolves `concat` against real content rather than a boolean: the merged
 * text must be the parent-order concatenation of the two parents' texts. That is what makes a
 * fold's result in this suite depend on its order rather than on what the test asserted.
 */
class ConcatMergePort extends RunMergePort<RunTransaction> {
    private readonly texts = new Map<string, string>();

    public constructor(private readonly store: ContentStore) {
        super();
    }

    /**
     * Writes `text` into the Run's own content store, the only plane a Run commit may name, and
     * hands back the ref that store derived from the bytes. The text is kept alongside because a
     * merge is resolved inside a storage transaction, where content cannot be read back.
     */
    public async say(text: string): Promise<ContentRef> {
        const { ref } = await this.store.put(encoder.encode(text));
        this.texts.set(ref.value, text);
        return ref;
    }

    /** Ascribes a text to content the Run already holds, such as the genesis root's. */
    public remember(ref: ContentRef, text: string): void {
        this.texts.set(ref.value, text);
    }

    public read(ref: ContentRef | undefined): string | undefined {
        return ref === undefined ? undefined : this.texts.get(ref.value);
    }

    public verifyConcat(
        _transaction: RunTransaction,
        commit: RunCommit,
        target: RunCommit,
        source: RunCommit
    ): boolean {
        const merged = this.read(commit.content);
        const left = this.read(target.content);
        return merged !== undefined && left !== undefined && merged === left + this.text(source);
    }

    public verifyTree(): boolean {
        return true;
    }

    /**
     * This suite's Blueprint declares `perPath`; its folds are about order, not about the
     * §5.2.1 absence refusal.
     */
    public declaredTreeMerge(): TreeMergePolicy {
        return TreeMergePolicy.perPath;
    }

    /** The text a parent contributes; a commit kind carrying no content contributes none. */
    public text(commit: RunCommit): string {
        return this.read(commit.content) ?? "";
    }
}

interface Convergence {
    readonly repository: RunRepository<RunTransaction>;
    readonly evidence: TestEvidencePort<RunTransaction>;
    readonly merge: ConcatMergePort;
    readonly runtime: RunRuntime<RunTransaction>;
}

const foldInvocation = new InvocationId("invocation-fold");
const otherInvocation = new InvocationId("invocation-other");

function convergence(): Convergence {
    const repository = testRunRepository(memoryRunStorage());
    const evidence = new TestEvidencePort<RunTransaction>();
    const merge = new ConcatMergePort(repository.content);
    const runtime = new RunRuntime(
        repository,
        new TestSourcePort<RunTransaction>(),
        evidence,
        new TestSettlementPort<RunTransaction>(),
        new TestSpawnPort<RunTransaction>(),
        merge,
        new UncontributedCutPoints()
    );
    const start = genesis();
    runtime.createRun(start);
    merge.remember(start.root.content!, "R");
    return { repository, evidence, merge, runtime };
}

function runRevision(value: Convergence): Revision {
    return value.repository.transaction((tx) => value.repository.loadRun(tx, ids.run)!.revision);
}

function branchRevision(value: Convergence, branch: RunBranchId): Revision {
    return value.repository.transaction((tx) => value.repository.loadBranch(tx, branch)!.revision);
}

function headIn(value: Convergence, tx: RunTransaction, branch: RunBranchId): RunCommit {
    const head = value.repository.loadBranch(tx, branch)!.head;
    return value.repository.loadCommit(tx, head)!;
}

function headOf(value: Convergence, branch: RunBranchId): RunCommit {
    return value.repository.transaction((tx) => headIn(value, tx, branch));
}

/** A swarm member: its own branch off the root, carrying one Turn's completed work. */
async function member(value: Convergence, name: string, text: string): Promise<RunBranch> {
    const branch = new RunBranch(
        new RunBranchId(`branch-${name}`),
        ids.run,
        name,
        ids.root,
        new Revision(0)
    );
    value.runtime.createBranch(ids.run, branch, runRevision(value));
    await contribute(value, branch, `${name}-turn`, text);
    return branch;
}

/**
 * One member Turn on its own branch, completing with a result commit that carries its work.
 * Completed rather than left running, because a held Turn blocks the branch from migrating and
 * a member reconciling its pins is exactly what the reconciliation case needs to do.
 */
async function contribute(
    value: Convergence,
    branch: RunBranch,
    name: string,
    text: string
): Promise<RunCommit> {
    const head = headOf(value, branch.id);
    const turn = new TurnId(`turn-${name}`);
    const placement = new TurnPlacementSnapshot(turn, head.pins, []);
    value.runtime.createTurn(
        {
            turn: new Turn({
                id: turn,
                run: ids.run,
                branch: branch.id,
                startHead: head.id,
                effectiveInput: head.id,
                pins: head.pins,
                placement: placement.digest,
                input: await value.merge.say(`${text}?`),
                revision: new Revision(0)
            }),
            placement
        },
        branchRevision(value, branch.id)
    );
    const claimed = value.runtime.claimTurn(
        turn,
        new Revision(0),
        ids.holder,
        new Date(1000),
        new Date(5000)
    );
    const token = Object.freeze({ turn, holder: ids.holder, epoch: 1 });
    const result = new RunCommit({
        id: new RunCommitId(`commit-${name}`),
        run: ids.run,
        branch: branch.id,
        kind: "result",
        parents: [head.id],
        pins: head.pins,
        writer: { kind: "turn", token },
        subjectTurn: turn,
        content: await value.merge.say(text)
    });
    value.runtime.completeTurn({
        turn,
        expectedTurnRevision: claimed.revision,
        expectedBranchRevision: branchRevision(value, branch.id),
        token,
        outcome: "succeeded",
        commit: result,
        now: new Date(1010)
    });
    return result;
}

interface FoldStepRequest {
    readonly id: string;
    readonly source: RunBranch;
    readonly fold?: MergeFoldStep | undefined;
    readonly over?: Partial<RunCommitInit> | undefined;
}

/**
 * Proposes one binary merge of a fold onto the main branch. The control Receipt is bound to
 * this exact proposal, which is why every step of a fold carries its own Receipt rather than
 * one Receipt covering the whole chain.
 */
async function foldStep(value: Convergence, request: FoldStepRequest): Promise<RunCommit> {
    const target = headOf(value, ids.branch);
    const source = headOf(value, request.source.id);
    const receipt = new ReceiptId(`receipt-${request.id}`);
    const commit = new RunCommit({
        id: new RunCommitId(request.id),
        run: ids.run,
        branch: ids.branch,
        kind: "merge",
        parents: [target.id, source.id],
        pins: target.pins,
        writer: { kind: "system", cause: { kind: "control", audit: refs.audit, receipt } },
        content: await value.merge.say(value.merge.text(target) + value.merge.text(source)),
        resolution: { kind: "concat" },
        receipt,
        ...request.over
    });
    const base = {
        kind: "control",
        run: ids.run,
        receipt,
        audit: refs.audit,
        proposalDigest: commit.proposalDigest.value
    } satisfies Omit<ControlCommitEvidence, "fold">;
    const control: ControlCommitEvidence =
        request.fold === undefined ? base : { ...base, fold: request.fold };
    value.evidence.controls.set(`${receipt.value}:${refs.audit.value}`, control);
    return commit;
}

async function applyFold(value: Convergence, request: FoldStepRequest): Promise<RunCommit> {
    const commit = await foldStep(value, request);
    value.runtime.mergeRun(commit, branchRevision(value, ids.branch), new Date(1100));
    return commit;
}

async function refuseFold(value: Convergence, request: FoldStepRequest): Promise<AgentCoreError> {
    const commit = await foldStep(value, request);
    return thrownBy(AgentCoreError, () =>
        value.runtime.mergeRun(commit, branchRevision(value, ids.branch), new Date(1100))
    );
}

function step(source: RunBranch, itemIndex: number, itemCount = 3): MergeFoldStep {
    return { invocation: foldInvocation, itemIndex, itemCount, source: source.id };
}

function converged(value: Convergence): string {
    return value.merge.read(headOf(value, ids.branch).content)!;
}

/**
 * Reads the fold back out the way a reconstruction would: walk the merge chain below the branch
 * head and read the control Receipt each merge already names.
 */
function recordedFold(value: Convergence): readonly MergeFoldStep[] {
    return value.repository.transaction((tx) => {
        const steps: MergeFoldStep[] = [];
        let cursor: RunCommit | undefined = headIn(value, tx, ids.branch);
        while (cursor?.kind === "merge") {
            const cause = cursor.writer.kind === "system" ? cursor.writer.cause : undefined;
            const fold =
                cause?.kind === "control"
                    ? value.evidence.control(tx, cause.receipt, cause.audit)?.fold
                    : undefined;
            if (fold !== undefined) steps.unshift(fold);
            cursor = value.repository.loadCommit(tx, cursor.parents[0]!);
        }
        return steps;
    });
}

/** A pin set whose Package closure advanced one member's version, and nothing else. */
function advancedPins(): RunPins {
    const base = pins();
    return new RunPins({
        ...pinsInit(base),
        packages: base.packages.map((pin) =>
            pin.id.value === "zeta"
                ? new PackagePin(pin.id, new SemVer("3.0.0"), pin.manifestDigest, pin.codeDigest)
                : pin
        )
    });
}

/** Migrates one branch to exact target pins; the migration commit is the durable evidence. */
function migrate(
    value: Convergence,
    branch: RunBranch,
    id: string,
    from: RunPins,
    to: RunPins
): void {
    const receipt = new ReceiptId(`receipt-${id}`);
    const commit = new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: branch.id,
        kind: "migration",
        parents: [headOf(value, branch.id).id],
        pins: to,
        writer: { kind: "system", cause: { kind: "control", audit: refs.audit, receipt } },
        receipt,
        migration: { from, to }
    });
    value.evidence.controls.set(`${receipt.value}:${refs.audit.value}`, {
        kind: "control",
        run: ids.run,
        receipt,
        audit: refs.audit,
        proposalDigest: commit.proposalDigest.value
    });
    value.runtime.migrateRun(
        commit,
        new RunConfigurationSnapshot({ pins: to }),
        branchRevision(value, branch.id),
        new Date(1050)
    );
}

function pinsInit(base: RunPins) {
    return {
        blueprint: base.blueprint,
        packages: base.packages,
        agent: base.agent,
        effectivePolicy: base.effectivePolicy,
        modelPolicy: base.modelPolicy,
        environment: base.environment
    };
}

interface Perturbation {
    readonly dimension: RunPinDimension;
    readonly perturbed: RunPins;
    readonly identity: string;
}

/** One perturbation per pin dimension, so a dimension nobody compares reads as equal here. */
function perturbations(): readonly Perturbation[] {
    const base = pins();
    const bumped = new Revision(9);
    return [
        {
            dimension: RunPinDimension.blueprint,
            perturbed: new RunPins({
                ...pinsInit(base),
                blueprint: new BlueprintPin(
                    base.blueprint.name,
                    new SemVer("9.9.9"),
                    base.blueprint.digest
                )
            }),
            identity: base.blueprint.name
        },
        {
            dimension: RunPinDimension.packages,
            perturbed: advancedPins(),
            identity: "zeta"
        },
        {
            dimension: RunPinDimension.agent,
            perturbed: new RunPins({
                ...pinsInit(base),
                agent: { ...base.agent, revision: bumped }
            }),
            identity: base.agent.id.value
        },
        {
            dimension: RunPinDimension.effectivePolicy,
            perturbed: new RunPins({
                ...pinsInit(base),
                effectivePolicy: { ...base.effectivePolicy, revision: bumped }
            }),
            identity: base.effectivePolicy.id.value
        },
        {
            dimension: RunPinDimension.modelPolicy,
            perturbed: new RunPins({
                ...pinsInit(base),
                modelPolicy: { ...base.modelPolicy, revision: bumped }
            }),
            identity: base.modelPolicy.id.value
        },
        {
            dimension: RunPinDimension.environment,
            perturbed: new RunPins({
                ...pinsInit(base),
                environment: { ...base.environment, revision: bumped }
            }),
            identity: base.environment.id.value
        }
    ];
}

describe("swarm convergence", () => {
    it(
        "[C13-RUN-FOLD-ORDER] folds four equal-pinned parents as exactly the chain its declared items name",
        { tags: "p0" },
        async () => {
            const value = convergence();
            const alpha = await member(value, "alpha", "A");
            const beta = await member(value, "beta", "B");
            const gamma = await member(value, "gamma", "C");

            await applyFold(value, { id: "fold-0", source: alpha, fold: step(alpha, 0) });
            await applyFold(value, { id: "fold-1", source: beta, fold: step(beta, 1) });
            await applyFold(value, { id: "fold-2", source: gamma, fold: step(gamma, 2) });

            expect(converged(value)).toBe("RABC");
            const recorded = recordedFold(value);
            expect(recorded.map((entry) => entry.source.value)).toEqual([
                alpha.id.value,
                beta.id.value,
                gamma.id.value
            ]);
            expect(recorded.map((entry) => entry.itemIndex)).toEqual([0, 1, 2]);
            expect(recorded.every((entry) => entry.invocation.equals(foldInvocation))).toBe(true);
            expect(recorded.every((entry) => entry.itemCount === 3)).toBe(true);
        }
    );

    it(
        "[C13-RUN-FOLD-ORDER] records two orders over the same three members as two different results",
        { tags: "p0" },
        async () => {
            const forward = convergence();
            const forwardAlpha = await member(forward, "alpha", "A");
            const forwardBeta = await member(forward, "beta", "B");
            const forwardGamma = await member(forward, "gamma", "C");
            await applyFold(forward, {
                id: "fold-0",
                source: forwardAlpha,
                fold: step(forwardAlpha, 0)
            });
            await applyFold(forward, {
                id: "fold-1",
                source: forwardBeta,
                fold: step(forwardBeta, 1)
            });
            await applyFold(forward, {
                id: "fold-2",
                source: forwardGamma,
                fold: step(forwardGamma, 2)
            });

            const swapped = convergence();
            const swappedAlpha = await member(swapped, "alpha", "A");
            const swappedBeta = await member(swapped, "beta", "B");
            const swappedGamma = await member(swapped, "gamma", "C");
            await applyFold(swapped, {
                id: "fold-0",
                source: swappedAlpha,
                fold: step(swappedAlpha, 0)
            });
            await applyFold(swapped, {
                id: "fold-1",
                source: swappedGamma,
                fold: step(swappedGamma, 1)
            });
            await applyFold(swapped, {
                id: "fold-2",
                source: swappedBeta,
                fold: step(swappedBeta, 2)
            });

            expect(converged(forward)).toBe("RABC");
            expect(converged(swapped)).toBe("RACB");
            expect(converged(forward)).not.toBe(converged(swapped));
            expect(recordedFold(forward).map((entry) => entry.source.value)).toEqual([
                "branch-alpha",
                "branch-beta",
                "branch-gamma"
            ]);
            expect(recordedFold(swapped).map((entry) => entry.source.value)).toEqual([
                "branch-alpha",
                "branch-gamma",
                "branch-beta"
            ]);
        }
    );

    it(
        "[C13-RUN-FOLD-ORDER] refuses a step that joins a source its item did not declare",
        { tags: "p0" },
        async () => {
            const value = convergence();
            const alpha = await member(value, "alpha", "A");
            const beta = await member(value, "beta", "B");
            const failure = await refuseFold(value, {
                id: "fold-0",
                source: alpha,
                fold: step(beta, 0)
            });
            expect(failure.code).toBe("run.invalid-state");
            expect(failure.message).toBe(
                "Fold step must join the exact source branch its item declared"
            );
        }
    );

    it(
        "[C13-RUN-FOLD-ORDER] refuses a step that does not extend the merge its predecessor appended",
        { tags: "p0" },
        async () => {
            const early = convergence();
            const earlyAlpha = await member(early, "alpha", "A");
            const beforeStart = await refuseFold(early, {
                id: "fold-1",
                source: earlyAlpha,
                fold: step(earlyAlpha, 1)
            });
            expect(beforeStart.message).toBe(
                "Fold item must extend exactly the merge its predecessor appended"
            );

            const restarted = convergence();
            const restartedAlpha = await member(restarted, "alpha", "A");
            const restartedBeta = await member(restarted, "beta", "B");
            await applyFold(restarted, {
                id: "fold-0",
                source: restartedAlpha,
                fold: step(restartedAlpha, 0)
            });
            const restart = await refuseFold(restarted, {
                id: "fold-restart",
                source: restartedBeta,
                fold: step(restartedBeta, 0)
            });
            expect(restart.message).toBe(
                "Fold item must extend exactly the merge its predecessor appended"
            );

            const foreign = convergence();
            const foreignAlpha = await member(foreign, "alpha", "A");
            const foreignBeta = await member(foreign, "beta", "B");
            await applyFold(foreign, {
                id: "fold-0",
                source: foreignAlpha,
                fold: {
                    invocation: otherInvocation,
                    itemIndex: 0,
                    itemCount: 3,
                    source: foreignAlpha.id
                }
            });
            const crossInvocation = await refuseFold(foreign, {
                id: "fold-1",
                source: foreignBeta,
                fold: step(foreignBeta, 1)
            });
            expect(crossInvocation.message).toBe(
                "Fold item must extend exactly the merge its predecessor appended"
            );
        }
    );

    it(
        "[C13-RUN-FOLD-ORDER] refuses a repeated source, a changed payload length, and an item outside it",
        { tags: "p0" },
        async () => {
            const repeated = convergence();
            const repeatedAlpha = await member(repeated, "alpha", "A");
            await applyFold(repeated, {
                id: "fold-0",
                source: repeatedAlpha,
                fold: step(repeatedAlpha, 0)
            });
            const twice = await refuseFold(repeated, {
                id: "fold-1",
                source: repeatedAlpha,
                fold: step(repeatedAlpha, 1)
            });
            expect(twice.message).toBe("A fold joins each declared source branch once");

            const relength = convergence();
            const relengthAlpha = await member(relength, "alpha", "A");
            const relengthBeta = await member(relength, "beta", "B");
            await applyFold(relength, {
                id: "fold-0",
                source: relengthAlpha,
                fold: step(relengthAlpha, 0)
            });
            const relengthed = await refuseFold(relength, {
                id: "fold-1",
                source: relengthBeta,
                fold: step(relengthBeta, 1, 2)
            });
            expect(relengthed.message).toBe("Fold items must declare one payload length");

            const beyond = convergence();
            const beyondAlpha = await member(beyond, "alpha", "A");
            const above = await refuseFold(beyond, {
                id: "fold-0",
                source: beyondAlpha,
                fold: step(beyondAlpha, 3)
            });
            expect(above.message).toBe("Fold item index is outside its declared payload");
            const below = await refuseFold(beyond, {
                id: "fold-negative",
                source: beyondAlpha,
                fold: step(beyondAlpha, -1)
            });
            expect(below.message).toBe("Fold item index is outside its declared payload");
        }
    );

    it(
        "[C13-RUN-FOLD-ORDER] leaves a merge that declares no fold exactly as it was",
        { tags: "p0" },
        async () => {
            const value = convergence();
            const alpha = await member(value, "alpha", "A");
            const beta = await member(value, "beta", "B");
            await applyFold(value, { id: "plain-0", source: alpha });
            await applyFold(value, { id: "plain-1", source: beta });
            expect(converged(value)).toBe("RAB");
            expect(recordedFold(value)).toEqual([]);
        }
    );

    it(
        "[C13-RUN-FOLD-ORDER] keeps the merges a fold did not perform outstanding in the Run registry",
        { tags: "p0" },
        async () => {
            const value = convergence();
            const alpha = await member(value, "alpha", "A");
            const beta = await member(value, "beta", "B");
            await member(value, "gamma", "C");
            const reservations = [0, 1, 2].map((itemIndex) =>
                value.runtime.reserveRunObligation(ids.run, {
                    kind: "invocationItem",
                    invocation: foldInvocation,
                    itemIndex,
                    itemKey: `fold-${itemIndex}`
                })
            );

            await applyFold(value, { id: "fold-0", source: alpha, fold: step(alpha, 0) });
            value.runtime.completeRunObligation(reservations[0]!);
            await applyFold(value, { id: "fold-1", source: beta, fold: step(beta, 1) });
            value.runtime.completeRunObligation(reservations[1]!);

            const outstanding = value.repository.transaction((tx) =>
                value.repository.loadAdmission(tx, ids.run)!.frontier()
            );
            expect(
                outstanding.map((obligation) =>
                    obligation.kind === "invocationItem" ? obligation.itemIndex : -1
                )
            ).toEqual([2]);
        }
    );

    it(
        "[C13-RUN-FOLD-RECONCILIATION] refuses a divergent-pin fold naming the exact divergence, and folds once it is reconciled",
        { tags: "p0" },
        async () => {
            const value = convergence();
            const alpha = await member(value, "alpha", "A");
            const beta = await member(value, "beta", "B");
            await applyFold(value, { id: "fold-0", source: alpha, fold: step(alpha, 0) });

            migrate(value, beta, "beta-advance", pins(), advancedPins());
            await contribute(value, beta, "beta-advanced", "B");
            const refused = await refuseFold(value, {
                id: "fold-1",
                source: beta,
                fold: step(beta, 1)
            });
            expect(refused.code).toBe("run.invalid-state");
            expect(refused.message).toBe(
                "Merge requires equal-pinned current heads; migrate the divergent pins first: packages(zeta)"
            );

            migrate(value, beta, "beta-reconcile", advancedPins(), pins());
            await contribute(value, beta, "beta-reconciled", "B");
            expect(headOf(value, beta.id).pins.divergence(pins())).toEqual([]);
            await applyFold(value, { id: "fold-1", source: beta, fold: step(beta, 1) });
            expect(converged(value)).toBe("RAB");
        }
    );

    it(
        "[C13-RUN-FOLD-RECONCILIATION] refuses a merge commit whose own pins diverge from its parents",
        { tags: "p0" },
        async () => {
            const value = convergence();
            const alpha = await member(value, "alpha", "A");
            const refused = await refuseFold(value, {
                id: "fold-0",
                source: alpha,
                fold: step(alpha, 0),
                over: { pins: advancedPins() }
            });
            expect(refused.message).toBe(
                "Merge commit must carry its equal-pinned parents' pins; divergent pins: packages(zeta)"
            );
        }
    );

    it(
        "[C13-RUN-FOLD-RECONCILIATION] names every pin dimension that disagrees and nothing that agrees",
        { tags: "p0" },
        () => {
            const base = pins();
            expect(base.divergence(pins())).toEqual([]);
            expect(base.equals(pins())).toBe(true);

            const dropped = new RunPins({
                ...pinsInit(base),
                packages: base.packages.filter((pin) => pin.id.value !== "zeta")
            });
            expect(base.divergence(dropped).map(({ identities }) => [...identities])).toEqual([
                ["zeta"]
            ]);
            expect(dropped.divergence(base).map(({ identities }) => [...identities])).toEqual([
                ["zeta"]
            ]);

            const added = new RunPins({
                ...pinsInit(base),
                packages: [
                    ...base.packages,
                    new PackagePin(
                        new PackageId("omega"),
                        new SemVer("1.0.0"),
                        base.packages[0]!.manifestDigest,
                        base.packages[0]!.codeDigest
                    )
                ]
            });
            expect(base.divergence(added).map(({ identities }) => [...identities])).toEqual([
                ["omega"]
            ]);

            for (const { dimension, perturbed, identity } of perturbations()) {
                const divergence = base.divergence(perturbed);
                expect(divergence.map(({ dimension: named }) => named.label)).toEqual([
                    dimension.label
                ]);
                expect(divergence[0]!.dimension.equals(dimension)).toBe(true);
                expect([...divergence[0]!.identities]).toEqual([identity]);
                expect(base.equals(perturbed)).toBe(false);
            }
            expect(perturbations().length).toBe(RunPinDimension.all.length);
            expect(new Set(RunPinDimension.all).size).toBe(RunPinDimension.all.length);
        }
    );
});
