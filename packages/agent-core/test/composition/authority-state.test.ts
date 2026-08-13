import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    Binding,
    GrantId,
    MemoryInvalidationWatermarkStore,
    PathEpochEvidence,
    ScopeEpoch,
    type InvalidationWatermark,
    type InvalidationWatermarkStore
} from "../../src/authority";
import {
    ActorAuthorityState,
    ResolvedOperationAuthority,
    TenantOperationAuthority,
    type ActorAuthorityHost,
    type OperationResolutionCandidate
} from "../../src/composition";
import { OperationResolutionState } from "../../src/composition/authority";
import { Digest, JsonSchema, SemVer } from "../../src/core";
import { PackageId, PackagePin, PolicySet } from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import {
    BindingName,
    CapabilitySpec,
    FacetRef,
    InterceptorDeclaration,
    InterceptorId,
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
import { AuditRecord, InvocationPlacementPin, PreEffectReceipt } from "../../src/invocations";
import {
    AuditRecordId,
    CorrelationId,
    InvocationId,
    RouteReservationId
} from "../../src/interaction-references";
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
const readDescriptor = new OperationDescriptor(
    new OperationName("read"),
    "observe",
    schema,
    schema
);
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
        SubjectRef.principal(new PrincipalRef(tenant, principal.principalId)),
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
        this.state = new ActorAuthorityState(tenant, owner, watermarks, this, () => this.now);
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

    public denialEvidence(resolution: OperationResolutionState) {
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

class IdentityCacheHarness implements ActorAuthorityHost {
    public readonly state: ActorAuthorityState;
    public readonly authority: TenantOperationAuthority<PrincipalRef>;
    public readonly requests: { readonly caller: PrincipalRef; readonly binding: BindingName }[] =
        [];
    public candidateOverride:
        ((candidate: OperationResolutionCandidate) => OperationResolutionCandidate) | undefined;
    readonly #resolutions: {
        readonly caller: PrincipalRef;
        readonly binding: BindingName;
    }[] = [];

    public constructor(
        public readonly tenant: TenantId,
        private readonly actor: ActorRef = new ActorRef(
            "workspace",
            new ActorId("identity-cache-owner")
        )
    ) {
        this.state = new ActorAuthorityState(
            tenant,
            actor,
            new MemoryInvalidationWatermarkStore(tenant, actor),
            this,
            () => new Date(RESOLVED_AT)
        );
        this.authority = new TenantOperationAuthority(this.state, () => new Date(RESOLVED_AT));
    }

    public register(caller: PrincipalRef, binding: BindingName): void {
        this.#resolutions.push({ caller, binding });
    }

    public resolve(
        caller: PrincipalRef,
        binding: BindingName
    ): OperationResolutionCandidate | undefined {
        this.requests.push({ caller, binding });
        const registered = this.#resolutions.find(
            (entry) => entry.caller.equals(caller) && entry.binding.equals(binding)
        );
        if (registered === undefined) return undefined;
        const workspace = ScopeRef.workspace(
            this.tenant,
            new WorkspaceId(`identity-cache-${this.requests.length}`)
        );
        const candidate: OperationResolutionCandidate = {
            principal: caller,
            binding: Binding.active(
                workspace,
                SubjectRef.principal(caller),
                domain,
                binding,
                new GrantId(`identity-cache-grant-${this.requests.length}`),
                facetRef
            ),
            pathEpochs: new PathEpochEvidence([
                ScopeEpoch.initial(ScopeRef.tenant(this.tenant)),
                ScopeEpoch.initial(workspace)
            ]),
            watermark: this.state.currentWatermark(caller),
            lease: undefined,
            originalLease: undefined,
            route: new RouteReservationId(`identity-cache-route-${this.requests.length}`),
            package: new PackagePin(
                new PackageId("identity-cache-package"),
                new SemVer("1.0.0"),
                new Digest("d".repeat(64)),
                new Digest("d".repeat(64))
            ),
            placement: new InvocationPlacementPin({
                manifest: ["provider"],
                policy: ["provider"],
                substrate: ["provider"],
                trust: ["provider"],
                selected: "provider"
            }),
            owner: this.actor,
            policies: [],
            turnOwnedSession: false,
            sessionFilesystemTarget: false,
            turnActorAuthorityLocal: false,
            directAuthority: undefined
        };
        return this.candidateOverride?.(candidate) ?? candidate;
    }

    public currentBinding(): Binding | undefined {
        return undefined;
    }
    public currentPath(binding: Binding): PathEpochEvidence {
        const [root, ...rest] = binding.scope.path;
        if (root === undefined) throw new TypeError("Binding scope carries no Workspace path");
        return new PathEpochEvidence([
            ScopeEpoch.initial(root),
            ...rest.map((scope) => ScopeEpoch.initial(scope))
        ]);
    }
    public currentLease(): TurnLease | undefined {
        return undefined;
    }
    public admits(): boolean {
        return false;
    }
    public contributorDomain(): ProtectionDomain | undefined {
        return undefined;
    }
    public admitsInterception(): boolean {
        return false;
    }
    public appendDenial(): void {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Identity cache harness does not persist denials"
        );
    }
    public denialEvidence(): { readonly receipt: PreEffectReceipt; readonly audit: AuditRecord } {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Identity cache harness does not create denial evidence"
        );
    }
    public transaction<Result>(operation: () => Result): Result {
        return operation();
    }
}

function authorityStateContract(name: string, createStore: () => InvalidationWatermarkStore): void {
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
                harness.state.deliverInvalidation(principal, [ScopeEpoch.initial(workspaceScope)]);
                expect(
                    harness.authority.authorizeDirect(resolution, readDescriptor, inputs)
                ).toBeDefined();

                // A relevant higher epoch ends authorization immediately.
                harness.state.deliverInvalidation(principal, [new ScopeEpoch(workspaceScope, 1)]);
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
                expect(harness.state.currentWatermark(principal).epoch(workspaceScope)).toBe(1);
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

                expect(harness.state.currentWatermark(principal).epoch(workspaceScope)).toBe(1);
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

class RecordingWatermarkStore implements InvalidationWatermarkStore {
    public saves = 0;
    readonly #delegate = new MemoryInvalidationWatermarkStore(tenant, owner);

    public load(key: string): InvalidationWatermark | undefined {
        return this.#delegate.load(key);
    }

    public save(watermark: InvalidationWatermark): void {
        this.saves += 1;
        this.#delegate.save(watermark);
    }

    public join(key: string, entries: readonly ScopeEpoch[]): InvalidationWatermark {
        return this.#delegate.join(key, entries);
    }
}

class MiscastDenialHarness extends StateHarness {
    public override denialEvidence(resolution: OperationResolutionState) {
        const evidence = super.denialEvidence(resolution);
        return {
            receipt: new PreEffectReceipt(
                evidence.receipt.id,
                evidence.receipt.invocation,
                0,
                "cancelledPreEffect",
                this.now,
                "cancelled instead of denied"
            ),
            audit: evidence.audit
        };
    }
}

describe("production authority state seams (memory)", () => {
    const createStore = (): InvalidationWatermarkStore =>
        new MemoryInvalidationWatermarkStore(tenant, owner);

    test(
        "serves repeated resolutions from the cache until release invalidates them",
        { tags: "p0" },
        async () => {
            const harness = new StateHarness(createStore());
            const resolution = await harness.resolved();
            expect(harness.resolves).toBe(1);

            // A second resolve for the same Principal and Binding is a cache hit.
            await harness.resolved();
            expect(harness.resolves).toBe(1);

            // Release invalidates the cached candidate, so the next resolve rebuilds.
            harness.authority.release(resolution);
            await harness.resolved();
            expect(harness.resolves).toBe(2);
        }
    );

    test(
        "[C13-AUTH-RESOLUTION-LIFETIME] a bundled resolution cannot outlive its Turn without an explicit release",
        { tags: "p0" },
        async () => {
            const harness = new StateHarness(createStore());
            await harness.resolved();
            expect(harness.resolves).toBe(1);

            // Turn 1 ends (succeed/fail/cancel fences its lease) and Turn 2 claims the
            // same Binding under a fresh LeaseToken for a different Turn — no release()
            // call happens in between, the way §3.4 rule 6's watermark-driven
            // invalidation would.
            const nextTurn = new TurnId("authority-state-next-turn");
            harness.lease = TurnLease.restore(nextTurn, principal, 1, new Date(LEASE_EXPIRY));
            harness.token = { turn: nextTurn, holder: principal, epoch: 1 };

            // A cache that only compared caller/binding identity would still return
            // Turn 1's cached candidate here and succeed. Instead the stale entry fails
            // closed exactly like any other cache/candidate mismatch (§3.4 rule 1) and is
            // evicted; the next lookup finds no entry and rebuilds against Turn 2's
            // current lease. Two denials-then-rebuild in a row would prove nothing about
            // Turn scoping, so asserting the fail-closed step first is what makes this
            // discriminate from a cache that never checked the lease at all.
            await expect(harness.resolved()).rejects.toMatchObject({ code: "authority.denied" });
            expect(harness.resolves).toBe(1);

            await harness.resolved();
            expect(harness.resolves).toBe(2);
        }
    );

    test(
        "[C13-AUTH-PRINCIPAL-REF] rejects an exact cross-Tenant NUL collision without consulting or poisoning the local cache",
        { tags: "p0" },
        async () => {
            const localTenant = new TenantId("tenant:雪");
            const local = new PrincipalRef(localTenant, new PrincipalId("alice\0team"));
            const foreign = new PrincipalRef(
                new TenantId("tenant:雪\0alice"),
                new PrincipalId("team")
            );
            const binding = new BindingName("terminal");
            const harness = new IdentityCacheHarness(localTenant);
            harness.register(local, binding);

            expect(`${local.tenantId.value}\0${local.principalId.value}\0${binding.value}`).toBe(
                `${foreign.tenantId.value}\0${foreign.principalId.value}\0${binding.value}`
            );

            const first = await harness.authority.resolve(local, binding);
            await expect(harness.authority.resolve(foreign, binding)).rejects.toMatchObject({
                code: "authority.denied"
            });
            const cached = await harness.authority.resolve(local, binding);

            expect(first.resolution.principal.equals(local)).toBe(true);
            expect(cached.resolution.principal.equals(local)).toBe(true);
            expect(cached.resolution.binding.name.equals(binding)).toBe(true);
            expect(harness.requests).toHaveLength(1);
        }
    );

    test(
        "keeps same-Tenant Principal and Binding tuples distinct across Unicode and NUL boundaries",
        { tags: "p0" },
        async () => {
            const localTenant = new TenantId("tenant:雪");
            const firstPrincipal = new PrincipalRef(localTenant, new PrincipalId("α"));
            const secondPrincipal = new PrincipalRef(localTenant, new PrincipalId("α\0β"));
            const firstBinding = new BindingName("β\0γ");
            const secondBinding = new BindingName("γ");
            const harness = new IdentityCacheHarness(localTenant);
            harness.register(firstPrincipal, firstBinding);
            harness.register(secondPrincipal, secondBinding);

            expect(
                `${localTenant.value}\0${firstPrincipal.principalId.value}\0${firstBinding.value}`
            ).toBe(
                `${localTenant.value}\0${secondPrincipal.principalId.value}\0${secondBinding.value}`
            );

            const first = await harness.authority.resolve(firstPrincipal, firstBinding);
            const second = await harness.authority.resolve(secondPrincipal, secondBinding);
            const firstCached = await harness.authority.resolve(firstPrincipal, firstBinding);
            const secondCached = await harness.authority.resolve(secondPrincipal, secondBinding);

            expect(first.resolution.principal.equals(firstPrincipal)).toBe(true);
            expect(second.resolution.principal.equals(secondPrincipal)).toBe(true);
            expect(firstCached.resolution.principal.equals(firstPrincipal)).toBe(true);
            expect(secondCached.resolution.principal.equals(secondPrincipal)).toBe(true);
            expect(harness.requests).toHaveLength(2);
        }
    );

    test(
        "fails closed and does not cache a host candidate that disagrees with caller, Tenant, or Binding",
        { tags: "p0" },
        async () => {
            const localTenant = new TenantId("identity-candidate-tenant");
            const caller = new PrincipalRef(localTenant, new PrincipalId("identity-caller"));
            const binding = new BindingName("identity-binding");
            const mismatches: readonly {
                readonly name: string;
                readonly override: (
                    candidate: OperationResolutionCandidate
                ) => OperationResolutionCandidate;
            }[] = [
                {
                    name: "caller",
                    override: (candidate) => ({
                        ...candidate,
                        principal: new PrincipalRef(
                            localTenant,
                            new PrincipalId("substituted-caller")
                        )
                    })
                },
                {
                    name: "Tenant",
                    override: (candidate) => ({
                        ...candidate,
                        principal: new PrincipalRef(
                            new TenantId("substituted-tenant"),
                            caller.principalId
                        )
                    })
                },
                {
                    name: "Binding name",
                    override: (candidate) => ({
                        ...candidate,
                        binding: Binding.active(
                            candidate.binding.scope,
                            candidate.binding.subject,
                            candidate.binding.domain,
                            new BindingName("substituted-binding"),
                            candidate.binding.grantId,
                            candidate.binding.facet
                        )
                    })
                },
                {
                    name: "Binding Tenant",
                    override: (candidate) => {
                        const foreignTenant = new TenantId("foreign-binding-tenant");
                        return {
                            ...candidate,
                            binding: Binding.active(
                                ScopeRef.workspace(
                                    foreignTenant,
                                    new WorkspaceId("foreign-binding-workspace")
                                ),
                                SubjectRef.principal(
                                    new PrincipalRef(foreignTenant, caller.principalId)
                                ),
                                candidate.binding.domain,
                                candidate.binding.name,
                                candidate.binding.grantId,
                                candidate.binding.facet
                            )
                        };
                    }
                }
            ];

            for (const mismatch of mismatches) {
                const harness = new IdentityCacheHarness(localTenant);
                harness.register(caller, binding);
                harness.candidateOverride = mismatch.override;

                expect(
                    harness.state.resolve(caller, binding),
                    `${mismatch.name} state boundary`
                ).toBeUndefined();
                await expect(
                    harness.authority.resolve(caller, binding),
                    mismatch.name
                ).rejects.toMatchObject({ code: "authority.denied" });
                expect(harness.requests, mismatch.name).toHaveLength(2);
            }
        }
    );

    test(
        "fails closed when a previously cached host candidate no longer agrees with its caller",
        { tags: "p0" },
        () => {
            const localTenant = new TenantId("identity-cache-revalidation-tenant");
            const caller = new PrincipalRef(localTenant, new PrincipalId("identity-caller"));
            const binding = new BindingName("identity-binding");
            const harness = new IdentityCacheHarness(localTenant);
            const foreign = new PrincipalRef(
                new TenantId("identity-cache-revalidation-foreign"),
                caller.principalId
            );
            let presentedPrincipal = caller;
            harness.register(caller, binding);
            harness.candidateOverride = (candidate) => ({
                ...candidate,
                get principal(): PrincipalRef {
                    return presentedPrincipal;
                }
            });

            expect(harness.state.resolve(caller, binding)?.principal.equals(caller)).toBe(true);
            presentedPrincipal = foreign;

            expect(harness.state.resolve(caller, binding)).toBeUndefined();
            expect(harness.requests).toHaveLength(1);
        }
    );

    test("returns a cache miss when the host has no candidate", { tags: "p0" }, () => {
        const tenant = new TenantId("identity-cache-miss-tenant");
        const caller = new PrincipalRef(tenant, new PrincipalId("identity-cache-miss-caller"));
        const harness = new IdentityCacheHarness(tenant);

        expect(
            harness.state.resolve(caller, new BindingName("identity-cache-miss"))
        ).toBeUndefined();
        expect(harness.requests).toHaveLength(1);
    });

    test(
        "authorizes a fresh mediated intent through the composed Actor state",
        { tags: "p0" },
        async () => {
            const harness = new StateHarness(createStore());
            const resolution = await harness.resolved();

            expect(harness.state.currentBinding("any-key")).toBe(harness.binding);
            expect(harness.state.admits(resolution, readDescriptor, inputs, harness.now)).toBe(
                true
            );

            const intent = await harness.authority.authorizeMediated(
                resolution,
                readDescriptor,
                inputs
            );
            expect(intent.principal.equals(principal)).toBe(true);
            expect(intent.binding).toBe(resolution.binding);
            expect(intent.domain).toBe(resolution.binding.domain);
            expect(intent.lease?.turn.equals(harness.token.turn)).toBe(true);
            expect(harness.log.receipts).toHaveLength(0);
        }
    );

    test(
        "delegates interception admission and contributor domains to the host",
        { tags: "p0" },
        async () => {
            const harness = new StateHarness(createStore());
            const resolution = await harness.resolved();
            const interceptable = new OperationDescriptor(
                new OperationName("read"),
                "observe",
                schema,
                schema,
                undefined,
                true
            );
            const declaration = new InterceptorDeclaration(
                new InterceptorId("authority-state-interceptor"),
                "operation.before",
                0
            );
            const contributor = new FacetRef("workspace:interceptor-contributor");

            expect(harness.state.contributorDomain(contributor)).toBe(domain);
            expect(
                harness.state.admitsInterception(
                    resolution,
                    contributor,
                    declaration,
                    interceptable
                )
            ).toBe(true);
            expect(
                harness.authority.allowsInterception(
                    resolution,
                    contributor,
                    declaration,
                    facetRef,
                    interceptable
                )
            ).toBe(true);
        }
    );

    test("requires at least one Scope epoch for invalidation delivery", { tags: "p0" }, () => {
        const harness = new StateHarness(createStore());
        let thrown: unknown;
        try {
            harness.state.deliverInvalidation(principal, []);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(AgentCoreError);
        expect(thrown).toMatchObject({ code: "protocol.invalid-state" });
    });

    test(
        "requires a deniedPreEffect Receipt before persisting a stale denial",
        { tags: "p0" },
        async () => {
            const harness = new MiscastDenialHarness(createStore());
            const resolution = await harness.resolved();
            let thrown: unknown;
            try {
                harness.state.observeStale(resolution, readDescriptor, inputs);
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBeInstanceOf(AgentCoreError);
            expect(thrown).toMatchObject({ code: "protocol.invalid-state" });
            expect(harness.log.receipts).toHaveLength(0);
            expect(harness.log.audits).toHaveLength(0);
        }
    );

    test(
        "persists only watermark records that establish or advance holder state",
        { tags: "p0" },
        () => {
            const store = new RecordingWatermarkStore();
            const harness = new StateHarness(store);

            // A holder's first record establishes revision zero, then the advanced join.
            harness.state.deliverInvalidation(principal, [new ScopeEpoch(workspaceScope, 1)]);
            expect(store.saves).toBe(2);

            // An established holder persists only the advanced join.
            harness.state.deliverInvalidation(principal, [new ScopeEpoch(workspaceScope, 2)]);
            expect(store.saves).toBe(3);

            // An unchanged join persists nothing.
            harness.state.deliverInvalidation(principal, [new ScopeEpoch(workspaceScope, 2)]);
            expect(store.saves).toBe(3);
        }
    );

    test(
        "mints operation resolution states only under the Tenant authority capability",
        { tags: "p0" },
        () => {
            const harness = new StateHarness(createStore());
            const candidate = harness.resolve(principal)!;

            expect(
                () =>
                    new OperationResolutionState(
                        candidate,
                        harness.now,
                        new Date(LEASE_EXPIRY),
                        new Date(DEADLINE),
                        Symbol("forged-authority")
                    )
            ).toThrow(TypeError);
        }
    );

    test(
        "resolves mediated-only candidates that carry no direct authority evidence",
        { tags: "p0" },
        async () => {
            const harness = new StateHarness(createStore());
            const base = harness.resolve(principal)!;
            const authority = new TenantOperationAuthority<PrincipalRef>(
                {
                    resolve: () => ({ ...base, directAuthority: undefined }),
                    currentBinding: (key) => harness.state.currentBinding(key),
                    currentPath: (binding) => harness.state.currentPath(binding),
                    currentWatermark: (holder) => harness.state.currentWatermark(holder),
                    currentLease: (token) => harness.state.currentLease(token),
                    admits: (resolution, descriptor, operationInputs, at) =>
                        harness.state.admits(resolution, descriptor, operationInputs, at),
                    contributorDomain: (facet) => harness.state.contributorDomain(facet),
                    admitsInterception: (resolution, contributor, declaration, descriptor) =>
                        harness.state.admitsInterception(
                            resolution,
                            contributor,
                            declaration,
                            descriptor
                        ),
                    release: (resolution) => harness.state.release(resolution),
                    observeStale: (resolution, descriptor, operationInputs) =>
                        harness.state.observeStale(resolution, descriptor, operationInputs)
                },
                () => harness.now
            );

            const resolved = await authority.resolve(principal, bindingName);
            expect(resolved.facet.equals(facetRef)).toBe(true);
            expect(resolved.resolution.directAuthority).toBeUndefined();
            expect(
                authority.authorizeDirect(resolved.resolution, readDescriptor, inputs)
            ).toBeUndefined();
        }
    );
});
