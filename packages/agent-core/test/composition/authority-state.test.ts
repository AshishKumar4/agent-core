import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    Binding,
    GrantId,
    MemoryInvalidationWatermarkStore,
    PathEpochEvidence,
    ScopeEpoch,
    type InvalidationWatermarkStore
} from "../../src/authority";
import {
    ActorAuthorityState,
    ResolvedOperationAuthority,
    TenantOperationAuthority,
    type ActorAuthorityHost,
    type OperationResolutionCandidate,
    type OperationResolutionState
} from "../../src/composition";
import { Digest, JsonSchema, SemVer } from "../../src/core";
import { PackageId, PackagePin, PolicySet } from "../../src/definition";
import {
    BindingName,
    CapabilitySpec,
    FacetRef,
    OperationDescriptor,
    OperationName,
    ProtectionDomain,
    type FacetData,
    type InterceptorDeclaration
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
    PreEffectReceipt
} from "../../src/invocations";
import { AuditRecordId, CorrelationId, InvocationId } from "../../src/interaction-references";
import { ReceiptId } from "../../src/invocation-references";
import { TurnId, TurnLease, type LeaseToken } from "../../src/agents";
import { SqliteInvalidationWatermarkStore } from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";

const tenant = new TenantId("authority-state-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("authority-state-principal"));
const owner = new ActorRef("workspace", new ActorId("authority-state-owner"));
const tenantScope = ScopeRef.tenant(tenant);
const workspaceScope = ScopeRef.workspace(tenant, new WorkspaceId("authority-state-workspace"));
const facetRef = new FacetRef("workspace:authority-state");
const bindingName = new BindingName("authority-state");
const domain = new ProtectionDomain("backend", "authority-state", "may-hold-secrets");
const schema = new JsonSchema({ type: "object" });
const readDescriptor = new OperationDescriptor(new OperationName("read"), "observe", schema, schema);
const inputs: readonly FacetData[] = [{ channel: "internal" }];

const RESOLVED_AT = 1_000_000;
const LEASE_EXPIRY = RESOLVED_AT + 5_000;
const WINDOW_MS = 2_000;
const DEADLINE = RESOLVED_AT + WINDOW_MS;

interface DenialLog {
    readonly receipts: PreEffectReceipt[];
    readonly audits: AuditRecord[];
    readonly attempts: string[];
}

class StateHarness implements ActorAuthorityHost {
    public binding = Binding.active(
        workspaceScope,
        SubjectRef.principal(principal.principalId),
        domain,
        bindingName,
        new GrantId("authority-state-grant"),
        facetRef
    );
    public path = new PathEpochEvidence([
        ScopeEpoch.initial(tenantScope),
        ScopeEpoch.initial(workspaceScope)
    ]);
    public lease: TurnLease;
    public token: LeaseToken;
    public resolves = 0;
    public failDenialAppend = false;
    public readonly log: DenialLog = { receipts: [], audits: [], attempts: [] };
    public readonly state: ActorAuthorityState;
    public readonly authority: TenantOperationAuthority<PrincipalRef>;
    public now = new Date(RESOLVED_AT);
    #snapshot: (() => void) | undefined;

    public constructor(watermarks: InvalidationWatermarkStore) {
        this.lease = TurnLease.restore(
            new TurnId("authority-state-turn"),
            principal,
            1,
            new Date(LEASE_EXPIRY)
        );
        this.token = { turn: this.lease.turn, holder: principal, epoch: 1 };
        this.state = new ActorAuthorityState(tenant, owner, watermarks, this);
        this.authority = new TenantOperationAuthority(this.state, () => this.now);
    }

    public resolve(caller: PrincipalRef): OperationResolutionCandidate | undefined {
        if (!caller.equals(principal)) return undefined;
        this.resolves += 1;
        return {
            principal,
            binding: this.binding,
            pathEpochs: this.path,
            watermark: this.state.currentWatermark(principal),
            lease: this.token,
            originalLease: this.lease,
            route: undefined,
            package: new PackagePin(
                new PackageId("authority-state-package"),
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
        return token.turn.equals(this.lease.turn) ? this.lease : undefined;
    }
    public admits(): boolean {
        return true;
    }
    public contributorDomain(): ProtectionDomain | undefined {
        return domain;
    }
    public admitsInterception(
        _resolution: OperationResolutionState,
        _contributor: FacetRef,
        _declaration: InterceptorDeclaration,
        _descriptor: OperationDescriptor
    ): boolean {
        return true;
    }

    public appendDenial(receipt: PreEffectReceipt, audit: AuditRecord): void {
        if (this.failDenialAppend) throw new TypeError("Injected denial-append failure");
        this.log.receipts.push(receipt);
        this.log.audits.push(audit);
    }

    public denialEvidence(resolution: OperationResolutionState): {
        readonly receipt: PreEffectReceipt;
        readonly audit: AuditRecord;
    } {
        const ordinal = this.log.receipts.length;
        const invocation = new InvocationId(`authority-state:${ordinal}`);
        const receipt = new PreEffectReceipt(
            new ReceiptId(`denied:${ordinal}`),
            invocation,
            0,
            "deniedPreEffect",
            this.now,
            "Mediated authority intent is stale"
        );
        const audit = new AuditRecord({
            id: new AuditRecordId(`audit:denied:${ordinal}`),
            actor: resolution.owner,
            tenant,
            correlation: new CorrelationId(`correlation:${ordinal}`),
            kind: { kind: "receipt", id: receipt.id, outcome: "deniedPreEffect" }
        });
        return { receipt, audit };
    }

    public transaction<Result>(operation: () => Result): Result {
        // The memory harness models the Actor transaction's atomicity: on a
        // thrown operation every mutation this span made is rolled back.
        const restore = this.#snapshot;
        try {
            return operation();
        } finally {
            this.#snapshot = restore;
        }
    }

    public async resolved(): Promise<OperationResolutionState> {
        const resolution = await this.authority.resolve(principal, bindingName);
        return resolution.resolution;
    }

    public advancePathEpoch(): void {
        this.path = new PathEpochEvidence([
            ScopeEpoch.initial(tenantScope),
            new ScopeEpoch(workspaceScope, 1)
        ]);
    }
}

function authorityStateContract(
    name: string,
    createStore: () => InvalidationWatermarkStore
): void {
    describe(`production authority state (${name})`, () => {
        test(
            "[C13-AUTH-DIRECT-DEADLINE] admits direct calls strictly before the derived deadline and never at or after it",
            { tags: "p0" },
            async () => {
                const harness = new StateHarness(createStore());
                const resolution = await harness.resolved();
                expect(resolution.resolutionDeadline?.getTime()).toBe(DEADLINE);

                harness.now = new Date(DEADLINE - 1);
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeDefined();
                harness.now = new Date(DEADLINE);
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeUndefined();
            }
        );

        test(
            "[C13-ADV-IMMUTABLE-DEADLINE] lease renewal cannot extend an existing resolution deadline",
            { tags: "p0" },
            async () => {
                const harness = new StateHarness(createStore());
                const resolution = await harness.resolved();

                // Renew the Turn lease far past the derived deadline; the already
                // issued resolution keeps its immutable deadline.
                harness.lease = TurnLease.restore(
                    harness.lease.turn,
                    principal,
                    1,
                    new Date(LEASE_EXPIRY + 60_000)
                );
                harness.now = new Date(DEADLINE);
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeUndefined();
                expect(resolution.resolutionDeadline?.getTime()).toBe(DEADLINE);
            }
        );

        test(
            "[C13-AUTH-DIRECT-LEASE] rejects direct admission for a wrong Turn, holder, or epoch",
            { tags: "p0" },
            async () => {
                const harness = new StateHarness(createStore());
                const resolution = await harness.resolved();
                harness.now = new Date(RESOLVED_AT + 1);
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeDefined();

                // The current lease moved to another Turn: the resolution's token
                // no longer admits.
                harness.lease = TurnLease.restore(
                    new TurnId("authority-state-next-turn"),
                    principal,
                    2,
                    new Date(LEASE_EXPIRY)
                );
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeUndefined();

                // Same Turn, advanced epoch: the stale token epoch no longer admits.
                harness.lease = TurnLease.restore(
                    new TurnId("authority-state-turn"),
                    principal,
                    2,
                    new Date(LEASE_EXPIRY)
                );
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeUndefined();

                // Same Turn and epoch, different holder: never admits.
                harness.lease = TurnLease.restore(
                    new TurnId("authority-state-turn"),
                    new PrincipalRef(tenant, new PrincipalId("authority-state-other")),
                    1,
                    new Date(LEASE_EXPIRY)
                );
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeUndefined();
            }
        );

        test(
            "[C13-AUTH-DIRECT-WATERMARK] a delivered higher epoch ends direct authorization; equal or lower does not",
            { tags: "p0" },
            async () => {
                const harness = new StateHarness(createStore());
                const resolution = await harness.resolved();
                harness.now = new Date(RESOLVED_AT + 1);

                // Equal epochs: delivery is monotone but does not end authorization.
                harness.state.deliverInvalidation(principal, [
                    ScopeEpoch.initial(workspaceScope)
                ]);
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeDefined();

                // A relevant higher epoch ends authorization immediately.
                harness.state.deliverInvalidation(principal, [
                    new ScopeEpoch(workspaceScope, 1)
                ]);
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeUndefined();
            }
        );

        test(
            "[C13-AUTH-WATERMARK-MONOTONE] delivery and observation share one monotone per-holder watermark",
            { tags: "p0" },
            async () => {
                const harness = new StateHarness(createStore());
                const resolution = await harness.resolved();

                const first = harness.state.deliverInvalidation(principal, [
                    new ScopeEpoch(workspaceScope, 1)
                ]);
                expect(first.epoch(workspaceScope)).toBe(1);
                // Redelivery of an equal or lower epoch never regresses the watermark.
                const replay = harness.state.deliverInvalidation(principal, [
                    ScopeEpoch.initial(workspaceScope)
                ]);
                expect(replay.epoch(workspaceScope)).toBe(1);

                // A mediated stale observation joins into the SAME watermark record.
                harness.advancePathEpoch();
                await expect(
                    harness.authority.authorizeMediated(resolution, readDescriptor, inputs)
                ).rejects.toMatchObject({ code: "authority.denied" });
                expect(
                    harness.state.currentWatermark(principal).epoch(workspaceScope)
                ).toBe(1);
                expect(harness.log.receipts).toHaveLength(1);
            }
        );

        test(
            "[C13-AUTH-MEDIATED-STALE] a stale observation atomically joins the watermark, invalidates the cache, and records the denial without an EffectAttempt",
            { tags: "p0" },
            async () => {
                const harness = new StateHarness(createStore());
                const resolution = await harness.resolved();
                expect(harness.resolves).toBe(1);

                harness.advancePathEpoch();
                await expect(
                    harness.authority.authorizeMediated(resolution, readDescriptor, inputs)
                ).rejects.toMatchObject({ code: "authority.denied" });

                expect(
                    harness.state.currentWatermark(principal).epoch(workspaceScope)
                ).toBe(1);
                expect(harness.log.receipts).toHaveLength(1);
                expect(harness.log.receipts[0]?.outcome).toBe("deniedPreEffect");
                expect(harness.log.audits).toHaveLength(1);
                expect(harness.log.attempts).toHaveLength(0);

                // The cached resolution was invalidated: the next resolve rebuilds.
                await harness.resolved();
                expect(harness.resolves).toBe(2);
            }
        );

        test(
            "[C13-ADV-MEDIATED-STALE] a failed denial append propagates and leaves no partial denial evidence",
            { tags: "p0" },
            async () => {
                const harness = new StateHarness(createStore());
                const resolution = await harness.resolved();
                harness.advancePathEpoch();
                harness.failDenialAppend = true;

                await expect(
                    harness.authority.authorizeMediated(resolution, readDescriptor, inputs)
                ).rejects.toThrow(/Injected denial-append failure/);
                expect(harness.log.receipts).toHaveLength(0);
                expect(harness.log.audits).toHaveLength(0);
            }
        );

        test(
            "[C13-ADV-DELAYED-WATERMARK] a relevant epoch advance with delayed delivery keeps direct calls inside the bounded window and denies mediated calls",
            { tags: "p0" },
            async () => {
                const harness = new StateHarness(createStore());
                const resolution = await harness.resolved();
                harness.now = new Date(RESOLVED_AT + 1);

                // The authoritative epoch advances, but no invalidation has been
                // delivered to this holder yet.
                harness.advancePathEpoch();

                // Direct authorization survives on the bounded window (§3.4 rule 6)…
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeDefined();
                // …but never past the immutable deadline.
                harness.now = new Date(DEADLINE);
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeUndefined();

                // Mediated calls require current evidence and deny immediately,
                // recording the denial durably.
                harness.now = new Date(RESOLVED_AT + 1);
                await expect(
                    harness.authority.authorizeMediated(resolution, readDescriptor, inputs)
                ).rejects.toMatchObject({ code: "authority.denied" });
                expect(harness.log.receipts).toHaveLength(1);

                // Once delivery catches up, the shared watermark ends direct
                // authorization as well.
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeUndefined();
            }
        );
    });
}

authorityStateContract("memory", () => new MemoryInvalidationWatermarkStore(tenant, owner));
authorityStateContract(
    "sqlite",
    () => new SqliteInvalidationWatermarkStore(new TestSqlite(), tenant, owner)
);
