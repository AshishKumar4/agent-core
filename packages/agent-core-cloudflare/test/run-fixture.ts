import {
    ActorId,
    AgentCoreError,
    ApprovalId,
    AuditRecordId,
    ContentRef,
    Digest,
    PackageId,
    PackagePin,
    PrincipalId,
    PrincipalRef,
    ReceiptId,
    Revision,
    SemVer,
    TenantId
} from "@agent-core/core";
import { type ContentStore } from "@agent-core/core/content";
import { EnvironmentId } from "@agent-core/core/environment-provider";
import {
    AgentId,
    AgentPolicyId,
    BlueprintPin,
    ModelPolicyId,
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
    SpawnAttenuation,
    Turn,
    TurnId,
    TurnPlacementSnapshot,
    type ControlCommitEvidence,
    type RunStoragePort
} from "@agent-core/core/agents/runs";
import { TurnCutPointPort, type TurnInterceptionResult } from "@agent-core/core/operations";
import type { CloudflareErrorPort } from "../src/index.js";

/**
 * A Turn-bound cut-point schedule with no contributions: every value passes through and no
 * gate can refuse it. Mirrors the core package's own fixture so hosting tests exercise Run
 * behaviour without standing a Facet runtime up beside them.
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

export const errors: CloudflareErrorPort = {
    raise(code, message, cause): never {
        const failure = new AgentCoreError(code, message);
        if (cause !== undefined) Object.defineProperty(failure, "cause", { value: cause.value });
        throw failure;
    }
};

export const ids = Object.freeze({
    workspace: new ActorId("hosting-workspace"),
    agent: new AgentId("hosting-agent"),
    run: new RunId("hosting-run"),
    branch: new RunBranchId("hosting-branch"),
    root: new RunCommitId("hosting-root"),
    turn: new TurnId("hosting-turn"),
    approval: new ApprovalId("hosting-approval"),
    receipt: new ReceiptId("hosting-receipt"),
    audit: new AuditRecordId("hosting-audit"),
    holder: new PrincipalRef(new TenantId("hosting-tenant"), new PrincipalId("hosting-principal"))
});

export function digest(character: string): Digest {
    return Digest.sha256(fixtureContentBytes(character));
}

export function content(character: string): ContentRef {
    return ContentRef.fromDigest(digest(character));
}

const FIXTURE_CONTENT_KEYS = Object.freeze([
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f"
]);

function fixtureContentBytes(character: string): Uint8Array {
    if (!FIXTURE_CONTENT_KEYS.includes(character)) {
        throw new TypeError("Run fixture content key must be one hexadecimal character");
    }
    return new TextEncoder().encode(`cloudflare-run-fixture:${character}`);
}

async function seedFixtureContent(store: ContentStore): Promise<void> {
    for (const character of FIXTURE_CONTENT_KEYS) {
        const stored = await store.put(fixtureContentBytes(character));
        if (!stored.ref.equals(content(character))) {
            throw new TypeError("Cloudflare Run fixture stored an unexpected ContentRef");
        }
    }
}

export function pins(agentRevision = 3): RunPins {
    const revision = new Revision(3);
    return new RunPins({
        blueprint: new BlueprintPin("hosting-blueprint", new SemVer("1.2.3"), digest("e")),
        packages: [
            new PackagePin(new PackageId("zeta"), new SemVer("2.0.0"), digest("f"), digest("1")),
            new PackagePin(new PackageId("alpha"), new SemVer("1.0.0"), digest("2"), digest("3"))
        ],
        agent: { id: ids.agent, revision: new Revision(agentRevision), digest: digest("a") },
        effectivePolicy: { id: new AgentPolicyId("hosting-policy"), revision, digest: digest("b") },
        modelPolicy: { id: new ModelPolicyId("hosting-model"), revision, digest: digest("c") },
        environment: {
            id: new EnvironmentId("hosting-environment"),
            revision,
            digest: digest("d")
        }
    });
}

export function genesis() {
    const configuration = new RunConfigurationSnapshot({ pins: pins() });
    const root = new RunCommit({
        id: ids.root,
        run: ids.run,
        branch: ids.branch,
        kind: "root",
        parents: [],
        pins: configuration.pins,
        writer: { kind: "root" },
        content: content("4")
    });
    return {
        run: new Run({
            id: ids.run,
            agent: ids.agent,
            configuration: configuration.id,
            root: root.id,
            initialBranch: ids.branch,
            revision: new Revision(0)
        }),
        configuration,
        branch: new RunBranch(ids.branch, ids.run, "main", root.id, new Revision(0)),
        root
    };
}

export function resultCommit(
    id: string,
    token: { readonly turn: TurnId; readonly holder: PrincipalRef; readonly epoch: number },
    parent: RunCommitId = ids.root
): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "result",
        parents: [parent],
        pins: pins(),
        writer: { kind: "turn", token },
        subjectTurn: ids.turn,
        content: content("b")
    });
}

/** The Run's source of authoritative revisions; migration targets resolve through it. */
export class TestSourcePort<Transaction> extends RunSourceRevisionPort<
    Transaction,
    RunConfigurationSnapshot
> {
    public accepts = true;

    public verify(): boolean {
        return this.accepts;
    }

    public verifyPackageClosure(
        _transaction: Transaction,
        snapshot: RunConfigurationSnapshot
    ): boolean {
        return snapshot.pins.packages.length > 0;
    }
}

/** Only `control` carries evidence here; the other seams have no scenario in this suite. */
export class TestEvidencePort<Transaction> extends RunEvidencePort<Transaction> {
    public readonly controls = new Map<string, ControlCommitEvidence>();

    public receipt(): undefined {
        return undefined;
    }

    public delivery(): undefined {
        return undefined;
    }

    public control(
        _transaction: Transaction,
        receipt: ReceiptId,
        audit: AuditRecordId
    ): ControlCommitEvidence | undefined {
        return this.controls.get(`${receipt.value}:${audit.value}`);
    }

    public abandonedRewrite(): undefined {
        return undefined;
    }

    public storedReceipt(
        ..._arguments: Parameters<RunEvidencePort<Transaction>["storedReceipt"]>
    ): undefined {
        return undefined;
    }

    public publishedHandle(
        ..._arguments: Parameters<RunEvidencePort<Transaction>["publishedHandle"]>
    ): undefined {
        return undefined;
    }

    public synthesis(): undefined {
        return undefined;
    }

    public administer(): undefined {
        return undefined;
    }

    public forcedCancellation(): undefined {
        return undefined;
    }

    public acceptance(): undefined {
        return undefined;
    }
}

/** Settlement evidence the Run does not hold: only resolved Approvals are modelled. */
export class TestSettlementPort<Transaction> extends SettlementEvidencePort<Transaction> {
    public readonly approvals = new Set<string>();

    public approvalResolved(_transaction: Transaction, approval: ApprovalId): boolean {
        return this.approvals.has(approval.value);
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

export class TestSpawnPort extends RunSpawnPort<unknown> {
    public verify(): boolean {
        return false;
    }

    public attenuation(): SpawnAttenuation {
        return new SpawnAttenuation();
    }
}

export class TestMergePort extends RunMergePort<unknown> {
    public verifyConcat(): boolean {
        return false;
    }

    public verifyTree(): boolean {
        return false;
    }
}

export interface RunHarness<Transaction> {
    readonly storage: RunStoragePort<Transaction>;
    readonly repository: RunRepository<Transaction>;
    readonly sources: TestSourcePort<Transaction>;
    readonly evidence: TestEvidencePort<Transaction>;
    readonly settlement: TestSettlementPort<Transaction>;
    readonly runtime: RunRuntime<Transaction>;
}

export async function runHarness<Transaction>(
    storage: RunStoragePort<Transaction>,
    settlement: TestSettlementPort<Transaction> = new TestSettlementPort()
): Promise<RunHarness<Transaction>> {
    await seedFixtureContent(storage.content);
    const repository = new RunRepository(storage);
    const sources = new TestSourcePort<Transaction>();
    const evidence = new TestEvidencePort<Transaction>();
    return {
        storage,
        repository,
        sources,
        evidence,
        settlement,
        runtime: new RunRuntime<Transaction>(
            repository,
            sources,
            evidence,
            settlement,
            new TestSpawnPort(),
            new TestMergePort(),
            new UncontributedCutPoints()
        )
    };
}

/** Opens the Run, admits one Turn, and claims it, so a terminal result can be written. */
export function seedRunningTurn<Transaction>(harness: RunHarness<Transaction>) {
    harness.runtime.createRun(genesis());
    const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
    harness.runtime.createTurn(
        {
            turn: new Turn({
                id: ids.turn,
                run: ids.run,
                branch: ids.branch,
                startHead: ids.root,
                effectiveInput: ids.root,
                pins: pins(),
                placement: placement.digest,
                input: content("a"),
                revision: new Revision(0)
            }),
            placement
        },
        new Revision(0)
    );
    const running = harness.runtime.claimTurn(
        ids.turn,
        new Revision(0),
        ids.holder,
        new Date(1000),
        new Date(5000)
    );
    return {
        running,
        token: Object.freeze({ turn: ids.turn, holder: ids.holder, epoch: running.lease.epoch })
    };
}
