import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { TurnId, TurnLease, type LeaseToken } from "../../src/agents";
import {
    Binding,
    GrantId,
    InvalidationWatermark,
    PathEpochEvidence,
    ScopeEpoch
} from "../../src/authority";
import {
    TenantOperationAuthority,
    type OperationAuthorityStatePort,
    type OperationResolutionState
} from "../../src/composition";
import { Digest, JsonSchema, SemVer } from "../../src/core";
import { PackageId, PackagePin } from "../../src/definition";
import {
    BindingName,
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
import { AuditRecord, PreEffectReceipt } from "../../src/invocations";
import { ReceiptId } from "../../src/invocation-references";
import { AuditRecordId, CorrelationId, InvocationId } from "../../src/interaction-references";
import { InvocationPlacementPin } from "../../src/invocations";

const tenant = new TenantId("stale-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("stale-principal"));
const owner = new ActorRef("workspace", new ActorId("stale-owner"));
const tenantScope = ScopeRef.tenant(tenant);
const scope = ScopeRef.workspace(tenant, new WorkspaceId("stale-workspace"));
const facet = new FacetRef("workspace:stale-target");
const bindingName = new BindingName("stale-target");
const domain = new ProtectionDomain("backend", "stale-domain", "may-hold-secrets");
const digest = new Digest("c".repeat(64));
const pin = new PackagePin(new PackageId("stale-package"), new SemVer("1.0.0"), digest, digest);
const schema = new JsonSchema({});
const sendDescriptor = new OperationDescriptor(
    new OperationName("send"),
    "externalSend",
    schema,
    schema
);
const readDescriptor = new OperationDescriptor(new OperationName("read"), "observe", schema, schema);
const inputs: readonly FacetData[] = [{ id: 1 }];

const NOW = new Date(10);

class StaleAuthorityState implements OperationAuthorityStatePort<PrincipalRef> {
    public readonly binding = Binding.active(
        scope,
        SubjectRef.principal(principal.principalId),
        domain,
        bindingName,
        new GrantId("stale-grant"),
        facet
    );
    readonly #lease = TurnLease.restore(
        new TurnId("stale-turn"),
        principal.principalId,
        1,
        new Date(100)
    );
    readonly #token: LeaseToken = {
        turn: this.#lease.turn,
        holder: principal.principalId,
        epoch: this.#lease.epoch
    };
    #currentPath = new PathEpochEvidence([
        ScopeEpoch.initial(tenantScope),
        ScopeEpoch.initial(scope)
    ]);
    #watermark = InvalidationWatermark.empty(tenant, owner, principal);
    #cached: OperationResolutionState | undefined;
    readonly #receipts: PreEffectReceipt[] = [];
    readonly #audits: AuditRecord[] = [];
    readonly #attempts: string[] = [];

    public resolve(caller: PrincipalRef): OperationResolutionState | undefined {
        if (!caller.equals(principal)) return undefined;
        if (this.#cached === undefined) this.#cached = this.buildResolution();
        return this.#cached;
    }

    public revoke(): void {
        this.#currentPath = new PathEpochEvidence([
            ScopeEpoch.initial(tenantScope),
            new ScopeEpoch(scope, 1)
        ]);
    }

    public currentBinding(): Binding {
        return this.binding;
    }

    public currentPath(): PathEpochEvidence {
        return this.#currentPath;
    }

    public currentWatermark(): InvalidationWatermark {
        return this.#watermark;
    }

    public currentLease(): TurnLease {
        return this.#lease;
    }

    public admits(): boolean {
        return true;
    }

    public contributorDomain(): ProtectionDomain {
        return domain;
    }

    public admitsInterception(): boolean {
        return true;
    }

    public release(): void {}

    public observeStale(resolution: OperationResolutionState): void {
        // §3.4 rule 7: atomically advance the holder watermark, invalidate the cached
        // resolution, and record deniedPreEffect evidence with no EffectAttempt.
        this.#watermark = this.#watermark.join(this.#currentPath.path);
        this.#cached = undefined;
        this.recordDenial(resolution);
    }

    public get receipts(): readonly PreEffectReceipt[] {
        return this.#receipts;
    }

    public get audits(): readonly AuditRecord[] {
        return this.#audits;
    }

    public get attempts(): readonly string[] {
        return this.#attempts;
    }

    public get cachedResolution(): OperationResolutionState | undefined {
        return this.#cached;
    }

    private recordDenial(resolution: OperationResolutionState): void {
        const name = resolution.binding.name.value;
        const invocation = new InvocationId(`stale:${name}`);
        if (this.#receipts.some((receipt) => receipt.invocation.equals(invocation))) {
            return;
        }
        const receipt = new PreEffectReceipt(
            new ReceiptId(`denied:${name}`),
            invocation,
            0,
            "deniedPreEffect",
            NOW,
            "Mediated authority intent is stale"
        );
        this.#receipts.push(receipt);
        this.#audits.push(
            new AuditRecord({
                id: new AuditRecordId(`audit:${name}`),
                actor: owner,
                tenant,
                correlation: new CorrelationId(`corr:${name}`),
                kind: { kind: "receipt", id: receipt.id, outcome: "deniedPreEffect" }
            })
        );
    }

    private buildResolution(): OperationResolutionState {
        return {
            principal,
            binding: this.binding,
            pathEpochs: this.#currentPath,
            watermark: this.#watermark,
            lease: this.#token,
            originalLease: this.#lease,
            package: pin,
            placement: new InvocationPlacementPin({
                manifest: ["bundled"],
                policy: ["bundled"],
                substrate: ["bundled"],
                trust: ["bundled"],
                selected: "bundled"
            }),
            resolvedAt: new Date(0),
            deadline: new Date(50),
            owner,
            policies: [],
            turnOwnedSession: true
        };
    }
}

describe("stale mediated authority produces durable denial evidence (§3.4 rule 7)", () => {
    test("advancing a scope epoch denies mediated with joined watermark, invalidation, and evidence", async () => {
        const state = new StaleAuthorityState();
        const authority = new TenantOperationAuthority(state, () => NOW);
        const resolution = state.resolve(principal)!;

        // Before revocation the holder watermark is at epoch 0.
        expect(state.currentWatermark().epoch(scope)).toBe(0);

        state.revoke();

        await expect(
            authority.authorizeMediated(resolution, sendDescriptor, inputs)
        ).rejects.toMatchObject({ code: "authority.denied" });

        // (3) deniedPreEffect Receipt + AuditRecord recorded, with no EffectAttempt.
        expect(state.receipts).toHaveLength(1);
        expect(state.receipts[0]!.outcome).toBe("deniedPreEffect");
        expect(state.audits).toHaveLength(1);
        expect(state.audits[0]!.kind).toMatchObject({ kind: "receipt", outcome: "deniedPreEffect" });
        expect(state.attempts).toHaveLength(0);

        // (1) holder watermark advanced by the epoch join, so direct calls now cease.
        expect(state.currentWatermark().epoch(scope)).toBe(1);
        expect(authority.authorizeDirect(resolution, readDescriptor, inputs)).toBeUndefined();

        // (2) cached resolution invalidated; re-resolution yields fresh, admissible evidence.
        expect(state.cachedResolution).toBeUndefined();
        const fresh = state.resolve(principal)!;
        expect(fresh.pathEpochs.equals(state.currentPath())).toBe(true);
        await expect(
            authority.authorizeMediated(fresh, sendDescriptor, inputs)
        ).resolves.toMatchObject({ binding: state.binding, domain });
    });

    test("repeated stale invocations add no unbounded duplicate denial evidence", async () => {
        const state = new StaleAuthorityState();
        const authority = new TenantOperationAuthority(state, () => NOW);
        const resolution = state.resolve(principal)!;
        state.revoke();

        for (let attempt = 0; attempt < 3; attempt += 1) {
            await expect(
                authority.authorizeMediated(resolution, sendDescriptor, inputs)
            ).rejects.toMatchObject({ code: "authority.denied" });
        }

        expect(state.receipts).toHaveLength(1);
        expect(state.audits).toHaveLength(1);
        expect(state.currentWatermark().epoch(scope)).toBe(1);
    });
});
