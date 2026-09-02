import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { TurnId, TurnLease, type LeaseToken } from "../../src/agents";
import {
    Binding,
    GrantId,
    MemoryInvalidationWatermarkStore,
    PathEpochEvidence,
    ScopeEpoch
} from "../../src/authority";
import {
    ActorAuthorityState,
    DerivedDenialAuthorityHost,
    MEDIATED_STALE_DENIAL_REASON,
    ResolvedOperationAuthority,
    TenantOperationAuthority,
    type OperationResolutionCandidate
} from "../../src/composition";
import type { OperationResolutionState } from "../../src/composition/authority";
import { Digest, JsonSchema, SemVer } from "../../src/core";
import { PackageId, PackagePin, PolicySet } from "../../src/definition";
import {
    BindingName,
    CapabilitySpec,
    FacetRef,
    OperationDescriptor,
    OperationName,
    ProtectionDomain,
    type FacetData
} from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import {
    AuditRecord,
    InvocationPlacementPin,
    PreEffectReceipt,
    validateAuditAppend,
    type AuditEvidenceResolver,
    type AuditRecordLookup
} from "../../src/invocations";

const tenant = new TenantId("derived-denial-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("derived-denial-principal"));
const stranger = new PrincipalRef(tenant, new PrincipalId("derived-denial-stranger"));
const owner = new ActorRef("workspace", new ActorId("derived-denial-owner"));
const tenantScope = ScopeRef.tenant(tenant);
const workspaceScope = ScopeRef.workspace(tenant, new WorkspaceId("derived-denial-workspace"));
const facetRef = new FacetRef("workspace:derived-denial");
const bindingName = new BindingName("derived-denial");
const domain = new ProtectionDomain("backend", "derived-denial", "no-secrets");
const schema = new JsonSchema({ type: "object" });
const readDescriptor = new OperationDescriptor(
    new OperationName("read"),
    "observe",
    schema,
    schema
);
const writeDescriptor = new OperationDescriptor(
    new OperationName("write"),
    "mutate",
    schema,
    schema
);
const inputs: readonly FacetData[] = [{ channel: "internal" }];
const otherInputs: readonly FacetData[] = [{ channel: "external" }];

const RESOLVED_AT = 1_000_000;
const LEASE_EXPIRY = RESOLVED_AT + 5_000;
const WINDOW_MS = 2_000;
const IDENTITY_SCOPE = "derived-denial";

/**
 * A deployment host that supplies only what `ActorAuthorityHost` leaves abstract — the
 * candidate, the lease, the policy verdict, the transaction, and the durable write. The
 * denial CONTENT comes from `DerivedDenialAuthorityHost`, which is the whole point: this
 * harness cannot choose a Receipt id, an Invocation, or an audit edge even if it wanted
 * to, so what the tests below read back is what shipped code derived.
 */
class DeploymentHost extends DerivedDenialAuthorityHost {
    public binding = Binding.active(
        workspaceScope,
        SubjectRef.principal(principal),
        domain,
        bindingName,
        new GrantId("derived-denial-grant"),
        facetRef
    );
    public path = new PathEpochEvidence([
        ScopeEpoch.initial(tenantScope),
        ScopeEpoch.initial(workspaceScope)
    ]);
    public readonly appended: { receipt: PreEffectReceipt; audit: AuditRecord }[] = [];
    public readonly state: ActorAuthorityState;
    public readonly authority: TenantOperationAuthority<PrincipalRef>;
    readonly #lease: TurnLease;
    readonly #token: LeaseToken;
    readonly #now = new Date(RESOLVED_AT);

    public constructor() {
        super({ actor: owner, tenant }, IDENTITY_SCOPE, () => this.#now);
        this.#lease = TurnLease.restore(
            new TurnId("derived-denial-turn"),
            principal,
            1,
            new Date(LEASE_EXPIRY)
        );
        this.#token = { turn: this.#lease.turn, holder: principal, epoch: 1 };
        this.state = new ActorAuthorityState(
            tenant,
            owner,
            new MemoryInvalidationWatermarkStore(tenant, owner),
            this,
            () => this.#now
        );
        this.authority = new TenantOperationAuthority(this.state, () => this.#now);
    }

    public resolve(caller: PrincipalRef): OperationResolutionCandidate | undefined {
        if (!caller.equals(principal)) return undefined;
        return {
            principal,
            binding: this.binding,
            pathEpochs: this.path,
            watermark: this.state.currentWatermark(principal),
            lease: this.#token,
            originalLease: this.#lease,
            route: undefined,
            package: new PackagePin(
                new PackageId("derived-denial-package"),
                new SemVer("1.0.0"),
                new Digest("d".repeat(64)),
                new Digest("d".repeat(64))
            ),
            placement: new InvocationPlacementPin({
                manifest: ["bundled"],
                policy: ["bundled"],
                substrate: ["bundled"],
                trust: ["bundled"],
                selected: "bundled"
            }),
            owner,
            policies: [new PolicySet({ maxDirectRevocationWindowMs: WINDOW_MS })],
            turnOwnedSession: true,
            sessionFilesystemTarget: false,
            turnActorAuthorityLocal: true,
            directAuthority: new ResolvedOperationAuthority(facetRef, [
                new CapabilitySpec({
                    facetPattern: facetRef.value,
                    operations: ["read"],
                    impacts: ["observe"],
                    argumentConstraints: { channel: "internal" }
                })
            ])
        };
    }

    public currentBinding(): Binding | undefined {
        return this.binding;
    }
    public currentPath(): PathEpochEvidence {
        return this.path;
    }
    public currentLease(token: LeaseToken): TurnLease | undefined {
        return token.turn.equals(this.#lease.turn) ? this.#lease : undefined;
    }
    public admits(): boolean {
        return true;
    }
    public contributorDomain(): ProtectionDomain | undefined {
        return domain;
    }
    public admitsInterception(): boolean {
        return true;
    }
    public appendDenial(receipt: PreEffectReceipt, audit: AuditRecord): void {
        this.appended.push({ receipt, audit });
    }
    public transaction<Result>(operation: () => Result): Result {
        return operation();
    }

    /** The derivation under test, reached the way a deployment reaches it. */
    public records(
        resolution: OperationResolutionState,
        descriptor: OperationDescriptor = readDescriptor,
        payload: readonly FacetData[] = inputs
    ) {
        return this.denial.records(resolution, descriptor, payload);
    }

    public async resolved(): Promise<OperationResolutionState> {
        return (await this.authority.resolve(principal, bindingName)).resolution;
    }

    /** Advance the Workspace epoch, which is what makes the held resolution stale. */
    public advancePathEpoch(): void {
        this.path = new PathEpochEvidence([
            ScopeEpoch.initial(tenantScope),
            new ScopeEpoch(workspaceScope, 1)
        ]);
    }
}

describe("the denial content a stale mediated observation derives", () => {
    test(
        "[C13-AUTH-MEDIATED-STALE] shipped code derives the whole §7.4 chain from the stale resolution",
        { tags: "p0" },
        async () => {
            const host = new DeploymentHost();
            const resolution = await host.resolved();
            const { root, receipt, audit } = host.records(resolution);

            // The Receipt is the pre-effect denial §7.4 defines: one item, no attempt, and
            // the same reason the caller's error carries, so the durable record and the
            // thrown refusal cannot disagree about what happened.
            expect(receipt.outcome).toBe("deniedPreEffect");
            expect(receipt.itemIndex).toBe(0);
            expect(receipt.reason).toBe(MEDIATED_STALE_DENIAL_REASON);
            expect(receipt.recordedAt).toEqual(new Date(RESOLVED_AT));

            // The root names the Invocation the Receipt names, and it is causeless because
            // an Invocation root is where the chain starts.
            expect(root.kind).toEqual({ kind: "invocation", id: receipt.invocation });
            expect(root.cause).toBeUndefined();

            // The denial audit hangs off that root, in the same Actor and correlation.
            expect(audit.kind).toEqual({
                kind: "receipt",
                id: receipt.id,
                outcome: "deniedPreEffect"
            });
            expect(audit.cause?.equals(root.id)).toBe(true);
            expect(audit.correlation.equals(root.correlation)).toBe(true);
            expect(audit.actor.equals(owner)).toBe(true);
            expect(audit.tenant.equals(tenant)).toBe(true);

            // Every identifier is domain-separated from the evidence rather than minted,
            // so none of the three is a value the deployment could have chosen.
            for (const value of [receipt.invocation.value, receipt.id.value, audit.id.value]) {
                expect(value).toMatch(/^agent-core\.identity\.[a-z-]+\.v1:[0-9a-f]{64}$/);
            }
            expect(new Set([root.id.value, audit.id.value]).size).toBe(2);
        }
    );

    test(
        "[C13-AUTH-MEDIATED-STALE] the derived edge is the one the audit chain admits, and a supplied one need not be",
        { tags: "p0" },
        async () => {
            const host = new DeploymentHost();
            const resolution = await host.resolved();
            const { root, receipt, audit } = host.records(resolution);
            const stored = new Map<string, AuditRecord>();
            const lookup: AuditRecordLookup = { get: (id) => stored.get(id.value) };
            const evidence = receiptEvidence(receipt);

            validateAuditAppend(root, lookup);
            stored.set(root.id.value, root);
            expect(() => validateAuditAppend(audit, lookup, undefined, evidence)).not.toThrow();

            // The defect deriving the content removes: a host free to author this pair can
            // chain a real denial Receipt to the root of a DIFFERENT Invocation and produce
            // two records that are individually well-formed, share an actor, a Tenant and a
            // correlation, and describe a refusal that never happened. Only the §7.4 edge
            // rule catches it, and it catches it because the Receipt's Invocation and the
            // cause root's Invocation are the same value only when both were derived from
            // one resolution.
            const foreign = host.records(resolution, writeDescriptor);
            stored.set(foreign.root.id.value, foreign.root);
            const misattributed = new AuditRecord({
                id: foreign.audit.id,
                actor: owner,
                tenant,
                correlation: foreign.root.correlation,
                cause: foreign.root.id,
                kind: { kind: "receipt", id: receipt.id, outcome: "deniedPreEffect" }
            });
            expect(() => validateAuditAppend(misattributed, lookup, undefined, evidence)).toThrow(
                expect.objectContaining({
                    failure: "audit.evidence-mismatch",
                    message: "Audit edge invocation -> receipt is not permitted"
                })
            );
        }
    );

    test(
        "[C13-AUTH-MEDIATED-STALE] one stale resolution derives one denial, and every changed evidence field derives another",
        { tags: "p0" },
        async () => {
            const host = new DeploymentHost();
            const resolution = await host.resolved();
            const first = host.records(resolution);

            // Recomputation converges: a worker that crashed before persisting recomputes
            // the same three ids instead of forking a second denial for one refusal.
            const again = host.records(resolution);
            expect(again.receipt.id.value).toBe(first.receipt.id.value);
            expect(again.audit.id.value).toBe(first.audit.id.value);
            expect(again.root.id.value).toBe(first.root.id.value);

            // And separation: each field below is part of what made the intent distinct,
            // so a denial for one operation can never be read as the denial for another.
            const distinct = new Set([first.receipt.invocation.value]);
            distinct.add(host.records(resolution, writeDescriptor).receipt.invocation.value);
            distinct.add(
                host.records(resolution, readDescriptor, otherInputs).receipt.invocation.value
            );

            const advanced = new DeploymentHost();
            advanced.advancePathEpoch();
            distinct.add(advanced.records(await advanced.resolved()).receipt.invocation.value);

            const regenerated = new DeploymentHost();
            regenerated.binding = regenerated.binding.replace(
                new GrantId("derived-denial-grant"),
                facetRef
            );
            distinct.add(
                regenerated.records(await regenerated.resolved()).receipt.invocation.value
            );

            expect(distinct.size).toBe(5);
        }
    );

    test(
        "[C13-AUTH-MEDIATED-STALE] observeStale persists exactly the derived pair and no host-chosen record",
        { tags: "p0" },
        async () => {
            const host = new DeploymentHost();
            const resolution = await host.resolved();
            // The Workspace epoch moves after the resolution was handed out, which is the
            // one thing that makes the mediated re-check stale.
            host.advancePathEpoch();
            const expected = host.records(resolution);

            await expect(
                host.authority.authorizeMediated(resolution, readDescriptor, inputs)
            ).rejects.toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: MEDIATED_STALE_DENIAL_REASON
                })
            );

            expect(host.appended).toHaveLength(1);
            const written = host.appended[0];
            if (written === undefined) throw new TypeError("No denial was appended");
            expect(written.receipt.id.value).toBe(expected.receipt.id.value);
            expect(written.receipt.invocation.value).toBe(expected.receipt.invocation.value);
            expect(written.receipt.reason).toBe(MEDIATED_STALE_DENIAL_REASON);
            expect(written.audit.id.value).toBe(expected.audit.id.value);
            expect(written.audit.cause?.equals(expected.root.id)).toBe(true);

            // The stale path epochs the caller presented are what the denial names, not
            // the advanced ones that replaced them: the record identifies the refusal.
            const current = host.records(await host.resolved());
            expect(current.receipt.invocation.value).not.toBe(expected.receipt.invocation.value);
        }
    );

    test(
        "[C13-AUTH-MEDIATED-STALE] a resolution the host will not answer for derives no denial",
        { tags: "p1" },
        async () => {
            const host = new DeploymentHost();
            await expect(host.authority.resolve(stranger, bindingName)).rejects.toThrow();
            expect(host.appended).toEqual([]);
        }
    );
});

/** The durable Receipt ledger the audit chain consults to substantiate the denial edge. */
function receiptEvidence(receipt: PreEffectReceipt): AuditEvidenceResolver {
    return {
        approval: () => undefined,
        attempt: () => undefined,
        receipt: (id) =>
            id.equals(receipt.id)
                ? { invocation: receipt.invocation, outcome: receipt.outcome }
                : undefined,
        event: () => undefined,
        route: () => undefined,
        projection: () => undefined,
        delivery: () => undefined,
        commit: () => undefined,
        write: () => undefined
    };
}
