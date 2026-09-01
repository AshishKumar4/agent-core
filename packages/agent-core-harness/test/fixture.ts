import { ActorId, ActorRef } from "@agent-core/core/actors";
import type { ContentStore } from "@agent-core/core/content";
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
import { EffectAttemptId, InvocationId } from "@agent-core/core/invocations";
import { TurnCutPointPort, type TurnInterceptionResult } from "@agent-core/core/operations";
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
    SpawnAttenuation,
    SettlementEvidencePort,
    Turn,
    TurnAdmissionHandle,
    TurnAdmissionIdentity,
    TurnBoundOperation,
    type TurnModelCall,
    TurnId,
    TurnOmission,
    TurnPlacementSnapshot,
    TurnPromptSectionName,
    type LeaseToken
} from "@agent-core/core/agents/runs";

export const ids = Object.freeze({
    owner: new ActorRef("workspace", new ActorId("workspace-1")),
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

/**
 * MemoryRunStorage keeps the state it hands each transaction private, so the fixture
 * names that state through the storage's own signature rather than erasing it to
 * `object`. The ports below then declare the transaction they are actually given.
 */
type MemoryTransaction = Parameters<Parameters<MemoryRunStorage["transaction"]>[0]>[0];

class AcceptingSourcePort extends RunSourceRevisionPort<
    MemoryTransaction,
    RunConfigurationSnapshot
> {
    public verify(): boolean {
        return true;
    }
    public verifyPackageClosure(
        _transaction: MemoryTransaction,
        snapshot: RunConfigurationSnapshot
    ): boolean {
        return snapshot.pins.packages.length > 0;
    }
}

class EmptyEvidencePort extends RunEvidencePort<MemoryTransaction> {
    public receipt() {
        return undefined;
    }
    public delivery() {
        return undefined;
    }
    public control() {
        return undefined;
    }
    public abandonedRewrite() {
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
    public storedReceipt() {
        return undefined;
    }
    public publishedHandle() {
        return undefined;
    }
}

/**
 * A Turn-bound cut-point schedule with no contributions: every value passes through and
 * no gate can refuse it, so these tests exercise the loop without standing a Facet
 * runtime up beside it.
 *
 * The parameters are derived from the port rather than annotated: `TurnBoundCutPoint` and
 * `FacetData` are reachable from no public subpath, so naming them here would either
 * hard-code the cut-point union or require widening the published surface.
 */
class UncontributedCutPoints extends TurnCutPointPort {
    public override run(
        ...[, , value]: Parameters<TurnCutPointPort["run"]>
    ): TurnInterceptionResult {
        return Object.freeze({ value, traces: Object.freeze([]), stop: undefined });
    }
}

/** Stateless, so one instance serves every host these tests stand up. */
export const cutPoints: TurnCutPointPort = new UncontributedCutPoints();

class EmptySettlementPort extends SettlementEvidencePort<MemoryTransaction> {
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

class RejectingSpawnPort extends RunSpawnPort<MemoryTransaction> {
    public verify(): boolean {
        return false;
    }
    // Never reached: verify() rejects first, so the runtime never asks for the
    // attenuation this would commit to.
    public attenuation(): SpawnAttenuation {
        return new SpawnAttenuation();
    }
}

class RejectingMergePort extends RunMergePort<MemoryTransaction> {
    public verifyConcat(): boolean {
        return false;
    }
    public verifyTree(): boolean {
        return false;
    }
}

export interface RunFixture {
    readonly runtime: RunRuntime<MemoryTransaction>;
    readonly repository: RunRepository<MemoryTransaction>;
    readonly content: ContentStore;
    readonly token: LeaseToken;
    readonly input: ContentRef;
    readonly inputDigest: Digest;
}

/** A live Run with one claimed Turn, built entirely through supported exports. */
export async function seedRunningTurn(inputText: string): Promise<RunFixture> {
    const storage = new MemoryRunStorage(
        ids.holder.tenantId,
        ids.owner,
        undefined,
        () => new Date(0)
    );
    const repository = new RunRepository(storage);
    const runtime = new RunRuntime(
        repository,
        new AcceptingSourcePort(),
        new EmptyEvidencePort(),
        new EmptySettlementPort(),
        new RejectingSpawnPort(),
        new RejectingMergePort(),
        cutPoints
    );
    const content = storage.content;
    const snapshot = new RunConfigurationSnapshot({ pins: pins() });
    const rootContent = await content.put(new TextEncoder().encode("root"));
    const root = new RunCommit({
        id: ids.root,
        run: ids.run,
        branch: ids.branch,
        kind: "root",
        parents: [],
        pins: snapshot.pins,
        writer: { kind: "root" },
        content: rootContent.ref
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

/**
 * A mediated admission handle for a stand-in invocation port. Every record it names is
 * synthetic because nothing in the loop reads them: the tool position a real handle
 * renders is the authority plane's concern, and the loop commits the tool output either
 * way (§7.2).
 */
export function admissionHandle(sequence: number): TurnAdmissionHandle {
    const invocation = new InvocationId(`invocation-${sequence}`);
    return new TurnAdmissionHandle({
        run: ids.run,
        turn: ids.turn,
        issuedEpoch: 1,
        invocation,
        itemIndex: 0,
        itemKey: `${ids.turn.value}:${sequence}`,
        attempt: new EffectAttemptId(`attempt-${sequence}`),
        identity: TurnAdmissionIdentity.invocation(invocation)
    });
}

/**
 * A TurnModelCall carrying a real Turn and lease token rather than stand-ins: the port
 * under test reads only the shown sections, the catalog, and the signal, but a call built
 * from the kernel's own constructors cannot quietly diverge from the record the runtime
 * hands it. The request is the reconstruction of a recorded model input, so the shown
 * bytes arrive resolved and the Turn's input names exactly them.
 */
export function modelCall(
    prompt: Uint8Array,
    operations: readonly TurnBoundOperation[],
    signal: AbortSignal
): TurnModelCall {
    const snapshot = new RunConfigurationSnapshot({ pins: pins() });
    const placement = new TurnPlacementSnapshot(ids.turn, snapshot.pins, []);
    return Object.freeze({
        turn: new Turn({
            id: ids.turn,
            run: ids.run,
            branch: ids.branch,
            startHead: ids.root,
            effectiveInput: ids.root,
            pins: snapshot.pins,
            placement: placement.digest,
            input: ContentRef.fromDigest(Digest.sha256(prompt)),
            revision: new Revision(0)
        }),
        token: Object.freeze({ turn: ids.turn, holder: ids.holder, epoch: 1 }),
        input: new RunCommitId("commit-model-input"),
        baseCommit: ids.root,
        sections: Object.freeze([
            Object.freeze({
                name: new TurnPromptSectionName("transcript"),
                bytes: prompt,
                omission: TurnOmission.none
            })
        ]),
        catalog: operations,
        admitted: Object.freeze([]),
        admissionCut: 0,
        covers: Object.freeze([]),
        signal
    });
}
