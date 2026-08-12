import { MemoryContentStore } from "@agent-core/core/content";
import { ContentRef, Digest, JsonSchema, Revision, SemVer } from "@agent-core/core/core";
import { PackageId, PackagePin } from "@agent-core/core/definition";
import { EnvironmentId } from "@agent-core/core/environment-provider";
import {
    BindingName,
    FacetRef,
    OperationDescriptor,
    OperationName,
    OperationRef
} from "@agent-core/core/facets";
import { PrincipalId, PrincipalRef, TenantId } from "@agent-core/core/identity";
import {
    AgentId,
    AgentPolicyId,
    BlueprintPin,
    ModelPolicyId,
    MemoryRunStorage,
    PlacementPin,
    Run,
    RunBranch,
    RunBranchId,
    RunCommit,
    RunCommitId,
    RunConfigurationSnapshot,
    RunEvidencePort,
    RunId,
    RunMergePort,
    RunPins,
    RunRepository,
    RunRuntime,
    RunSourceRevisionPort,
    RunSpawnPort,
    SettlementEvidencePort,
    Turn,
    TurnBoundOperation,
    TurnId,
    TurnPlacementSnapshot,
    type LeaseToken
} from "@agent-core/core/agents/runs";

export const ids = Object.freeze({
    run: new RunId("run-1"),
    branch: new RunBranchId("branch-main"),
    root: new RunCommitId("commit-root"),
    turn: new TurnId("turn-1"),
    holder: new PrincipalRef(new TenantId("tenant-1"), new PrincipalId("principal-1")),
    facet: new FacetRef("memory:primary")
});

export function digest(character: string): Digest {
    return new Digest(character.repeat(64));
}

export function contentRef(character: string): ContentRef {
    return new ContentRef(`sha256:${character.repeat(64)}`);
}

function pins(): RunPins {
    const revision = new Revision(3);
    return new RunPins({
        blueprint: new BlueprintPin("blueprint", new SemVer("1.2.3"), digest("e")),
        packages: [
            new PackagePin(new PackageId("memory"), new SemVer("1.0.0"), digest("f"), digest("1"))
        ],
        agent: { id: new AgentId("agent-1"), revision, digest: digest("a") },
        effectivePolicy: { id: new AgentPolicyId("policy-1"), revision, digest: digest("b") },
        modelPolicy: { id: new ModelPolicyId("model-1"), revision, digest: digest("c") },
        environment: { id: new EnvironmentId("environment-1"), revision, digest: digest("d") }
    });
}

class AcceptingSourcePort extends RunSourceRevisionPort<object, RunConfigurationSnapshot> {
    public verify(): boolean {
        return true;
    }
    public verifyPackageClosure(_transaction: object, snapshot: RunConfigurationSnapshot): boolean {
        return snapshot.pins.packages.length > 0;
    }
}

class EmptyEvidencePort extends RunEvidencePort<object> {
    public receipt() {
        return undefined;
    }
    public delivery() {
        return undefined;
    }
    public control() {
        return undefined;
    }
    public synthesis() {
        return undefined;
    }
    public administer() {
        return undefined;
    }
    public forcedCancellation() {
        return undefined;
    }
    public acceptance() {
        return undefined;
    }
}

class EmptySettlementPort extends SettlementEvidencePort<object> {
    public approvalResolved(): boolean {
        return false;
    }
    public invocationItemTerminal(): boolean {
        return false;
    }
    public routeTerminal(): boolean {
        return false;
    }
    public reconciliationSuperseded(): boolean {
        return false;
    }
    public commitExists(): boolean {
        return false;
    }
    public acceptanceSatisfied(): boolean {
        return false;
    }
    public auditSatisfied(): boolean {
        return false;
    }
}

class RejectingSpawnPort extends RunSpawnPort<object> {
    public verify(): boolean {
        return false;
    }
}

class RejectingMergePort extends RunMergePort<object> {
    public verifyConcat(): boolean {
        return false;
    }
    public verifyTree(): boolean {
        return false;
    }
}

export interface RunFixture {
    readonly runtime: RunRuntime<object>;
    readonly repository: RunRepository<object>;
    readonly content: MemoryContentStore;
    readonly token: LeaseToken;
    readonly input: ContentRef;
    readonly inputDigest: Digest;
}

/** A live Run with one claimed Turn, built entirely through supported exports. */
export async function seedRunningTurn(inputText: string): Promise<RunFixture> {
    const storage = new MemoryRunStorage();
    const repository = new RunRepository(storage);
    const runtime = new RunRuntime(
        repository,
        new AcceptingSourcePort(),
        new EmptyEvidencePort(),
        new EmptySettlementPort(),
        new RejectingSpawnPort(),
        new RejectingMergePort()
    );
    const content = new MemoryContentStore();
    const snapshot = new RunConfigurationSnapshot({ pins: pins() });
    const root = new RunCommit({
        id: ids.root,
        run: ids.run,
        branch: ids.branch,
        kind: "root",
        parents: [],
        pins: snapshot.pins,
        writer: { kind: "root" },
        content: contentRef("4")
    });
    runtime.createRun({
        run: new Run({
            id: ids.run,
            agent: new AgentId("agent-1"),
            configuration: snapshot.id,
            root: root.id,
            initialBranch: ids.branch,
            revision: new Revision(0)
        }),
        configuration: snapshot,
        branch: new RunBranch(ids.branch, ids.run, "main", root.id, new Revision(0)),
        root
    });

    const stored = await content.put(new TextEncoder().encode(inputText));
    const input = stored.ref;
    const placement = new TurnPlacementSnapshot(ids.turn, snapshot.pins, [
        new PlacementPin({
            facet: ids.facet,
            manifest: ["provider"],
            policy: ["provider"],
            substrate: ["provider"],
            trust: ["provider"],
            selected: "provider"
        })
    ]);
    runtime.createTurn(
        {
            turn: new Turn({
                id: ids.turn,
                run: ids.run,
                branch: ids.branch,
                startHead: ids.root,
                effectiveInput: ids.root,
                pins: snapshot.pins,
                placement: placement.digest,
                input,
                revision: new Revision(0)
            }),
            placement
        },
        new Revision(0)
    );
    runtime.claimTurn(ids.turn, new Revision(0), ids.holder, new Date(1_000), new Date(500_000));

    return {
        runtime,
        repository,
        content,
        token: Object.freeze({ turn: ids.turn, holder: ids.holder, epoch: 1 }),
        input,
        inputDigest: stored.digest
    };
}

export function boundOperation(binding: string, operation: string): TurnBoundOperation {
    return new TurnBoundOperation(
        new BindingName(binding),
        ids.facet,
        new OperationRef(`memory:${operation}`),
        new OperationDescriptor(
            new OperationName(operation),
            "observe",
            new JsonSchema({ type: "object" }),
            new JsonSchema({ type: "object" }),
            `Perform ${operation}.`
        )
    );
}
