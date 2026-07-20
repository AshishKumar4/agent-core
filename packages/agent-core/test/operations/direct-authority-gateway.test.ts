import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
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
    type OperationResolutionCandidate,
    type OperationResolutionState,
    ResolvedOperationAuthority,
    ResolutionStamp
} from "../../src/composition";
import { MemoryContentStore } from "../../src/content";
import { CompatRange, Digest, JsonSchema, SemVer } from "../../src/core";
import { PackageId, PackagePin, PolicySet } from "../../src/definition";
import {
    BindingName,
    CapabilitySpec,
    Contribution,
    Contributions,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    OperationDescriptor,
    OperationName,
    ProtectionDomain,
    SlotName,
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
import { InvocationPlacementPin } from "../../src/invocations";
import { InvocationId } from "../../src/interaction-references";
import { TurnId, TurnLease, type LeaseToken } from "../../src/agents";
import {
    OperationGatewayHost,
    OperationRequestKey,
    type MediatedInvocationPreflight,
    type MediatedInvocationRequest,
    type MediatedPreflightResult,
    type OperationInterceptionEvidence,
    type OperationInvocationPort,
    type OperationPayloadShape,
    type ResolvedFacet
} from "../../src/operations/gateway";
import { FacetRuntimeHost } from "../../src/operations/lifecycle";
import { Facet, Operation, type OperationContext } from "../../src/operations/runtime";

const tenant = new TenantId("direct-gateway-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("direct-gateway-principal"));
const owner = new ActorRef("workspace", new ActorId("direct-gateway-owner"));
const tenantScope = ScopeRef.tenant(tenant);
const workspaceScope = ScopeRef.workspace(tenant, new WorkspaceId("direct-gateway-workspace"));
const unrelatedScope = ScopeRef.workspace(tenant, new WorkspaceId("direct-gateway-unrelated"));
const facetRef = new FacetRef("workspace:direct-gateway");
const bindingName = new BindingName("direct-gateway");
const domain = new ProtectionDomain("backend", "direct-gateway", "may-hold-secrets");
const objectSchema = new JsonSchema({ type: "object" });
const readDescriptor = descriptor("read");
const substitutedDescriptor = descriptor("substituted");

describe("direct authority through the protected Operation gateway", () => {
    test(
        "uses delayed watermark, exact lease, and immutable deadline cutoffs before execution",
        { tags: "p0" },
        async () => {
            const harness = await DirectGatewayHarness.create();
            using resolved = await harness.gateway.resolve(bindingName);

            await expect(harness.dispatch(resolved, "read", "allowed-1")).resolves.toMatchObject({
                kind: "direct"
            });
            expect(harness.executions).toBe(1);

            harness.state.advanceCanonicalAuthority();
            await expect(harness.dispatch(resolved, "read", "delayed")).resolves.toMatchObject({
                kind: "direct"
            });
            expect(harness.executions).toBe(2);

            harness.state.deliver(unrelatedScope, 100);
            await expect(harness.dispatch(resolved, "read", "unrelated")).resolves.toMatchObject({
                kind: "direct"
            });
            expect(harness.executions).toBe(3);

            harness.state.deliver(workspaceScope, 1);
            await expect(harness.dispatch(resolved, "read", "delivered")).rejects.toMatchObject({
                code: "authority.denied"
            });
            expect(harness.executions).toBe(3);
            await harness.dispose();
        }
    );

    test(
        "rejects wrong Turn, holder tenant, and epoch through the same gateway",
        { tags: "p0" },
        async () => {
            for (const replacement of [
                (_harness: DirectGatewayHarness) =>
                    TurnLease.restore(
                        new TurnId("direct-gateway-other-turn"),
                        principal,
                        1,
                        new Date(100)
                    ),
                (harness: DirectGatewayHarness) =>
                    TurnLease.restore(
                        harness.state.lease.turn,
                        new PrincipalRef(
                            new TenantId("direct-gateway-foreign-tenant"),
                            principal.principalId
                        ),
                        1,
                        new Date(100)
                    ),
                (harness: DirectGatewayHarness) =>
                    TurnLease.restore(harness.state.lease.turn, principal, 2, new Date(100))
            ]) {
                const harness = await DirectGatewayHarness.create();
                using resolved = await harness.gateway.resolve(bindingName);
                harness.state.lease = replacement(harness);

                await expect(harness.dispatch(resolved, "read", "rejected")).rejects.toMatchObject({
                    code: "authority.denied"
                });
                expect(harness.executions).toBe(0);
                await harness.dispose();
            }
        }
    );

    test(
        "derives the minimum deadline once and cannot be extended by renewal or mutation",
        { tags: "p0" },
        async () => {
            const harness = await DirectGatewayHarness.create({ now: 10, window: 20 });
            const candidateToken = harness.state.token;
            const candidatePolicies = harness.state.policies;
            using resolved = await harness.gateway.resolve(bindingName);
            const state = (await harness.authority.resolve(principal, bindingName)).resolution;

            expect(state.resolvedAt).toEqual(new Date(10));
            expect(state.originalLeaseExpiresAt).toEqual(new Date(100));
            expect(state.resolutionDeadline).toEqual(new Date(30));
            state.resolutionDeadline!.setTime(10_000);
            state.originalLeaseExpiresAt!.setTime(10_000);
            candidateToken.epoch = 99;
            candidatePolicies[0] = new PolicySet({ maxDirectRevocationWindowMs: 1_000 });

            harness.state.lease = harness.state.lease.renew(principal, 1, new Date(20), new Date(500));
            harness.now = 29;
            await expect(harness.dispatch(resolved, "read", "before")).resolves.toMatchObject({
                kind: "direct"
            });
            harness.now = 30;
            await expect(harness.dispatch(resolved, "read", "boundary")).rejects.toMatchObject({
                code: "authority.denied"
            });
            expect(harness.executions).toBe(1);
            await harness.dispose();
        }
    );

    test(
        "binds immutable resolution authority and call stamps to descriptor and canonical input",
        { tags: "p0" },
        async () => {
            const harness = await DirectGatewayHarness.create();
            using resolved = await harness.gateway.resolve(bindingName);

            await harness.dispatch(resolved, "read", "bound");
            const stamp = harness.invocations.lastDirect!;
            expect(stamp.matches(readDescriptor, [{ channel: "internal", marker: "bound" }])).toBe(
                true
            );
            expect(
                stamp.matches(substitutedDescriptor, [{ channel: "internal", marker: "bound" }])
            ).toBe(false);
            expect(stamp.matches(readDescriptor, [{ channel: "external" }])).toBe(false);

            await expect(
                harness.dispatch(resolved, "substituted", "descriptor")
            ).rejects.toMatchObject({ code: "authority.denied" });
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("direct-external-input"),
                    operation: new OperationName("read"),
                    payload: { kind: "single", input: { channel: "external" } }
                })
            ).rejects.toMatchObject({ code: "authority.denied" });
            expect(harness.executions).toBe(1);
            await harness.dispose();
        }
    );

    test(
        "tightens to mediated when the Turn Actor lacks local versioned Binding authority",
        { tags: "p0" },
        async () => {
            const harness = await DirectGatewayHarness.create({ turnActorAuthorityLocal: false });
            using resolved = await harness.gateway.resolve(bindingName);

            await expect(harness.dispatch(resolved, "read", "mediated")).resolves.toMatchObject({
                kind: "mediated"
            });
            expect(harness.invocations.directCalls).toBe(0);
            expect(harness.invocations.mediatedCalls).toBe(1);
            expect(harness.executions).toBe(1);
            await harness.dispose();
        }
    );

    test("rejects an unsafe resolvedAt plus policy window", { tags: "p0" }, async () => {
        const harness = await DirectGatewayHarness.create({
            now: 8_000_000_000_000_000,
            leaseExpiry: 8_500_000_000_000_000,
            window: 1_100_000_000_000_000
        });
        await expect(harness.gateway.resolve(bindingName)).rejects.toMatchObject({
            code: "authority.denied"
        });
        await harness.dispose();
    });
});

class DirectAuthorityState implements OperationAuthorityStatePort<PrincipalRef> {
    public binding = Binding.active(
        workspaceScope,
        SubjectRef.principal(principal.principalId),
        domain,
        bindingName,
        new GrantId("direct-gateway-grant"),
        facetRef
    );
    public path = new PathEpochEvidence([
        ScopeEpoch.initial(tenantScope),
        ScopeEpoch.initial(workspaceScope)
    ]);
    public watermark = InvalidationWatermark.empty(tenant, owner, principal);
    public lease: TurnLease;
    public readonly token: { turn: TurnId; holder: PrincipalRef; epoch: number };
    public readonly policies: PolicySet[];

    public constructor(
        leaseExpiry: number,
        window: number,
        private readonly turnActorAuthorityLocal: boolean
    ) {
        this.lease = TurnLease.restore(
            new TurnId("direct-gateway-turn"),
            principal,
            1,
            new Date(leaseExpiry)
        );
        this.token = { turn: this.lease.turn, holder: principal, epoch: 1 };
        this.policies = [new PolicySet({ maxDirectRevocationWindowMs: window })];
    }

    public resolve(caller: PrincipalRef): OperationResolutionCandidate | undefined {
        if (!caller.equals(principal)) return undefined;
        return {
            principal,
            binding: this.binding,
            pathEpochs: this.path,
            watermark: this.watermark,
            lease: this.token,
            originalLease: this.lease,
            route: undefined,
            package: packagePin(),
            placement: bundledPlacement(),
            owner,
            policies: this.policies,
            turnOwnedSession: true,
            turnActorAuthorityLocal: this.turnActorAuthorityLocal,
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
    public currentWatermark(): InvalidationWatermark {
        return this.watermark;
    }
    public currentLease(_token: LeaseToken): TurnLease | undefined {
        return this.lease;
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
    public release(_resolution: OperationResolutionState): void {}
    public observeStale(): void {}

    public advanceCanonicalAuthority(): void {
        this.path = new PathEpochEvidence([
            ScopeEpoch.initial(tenantScope),
            new ScopeEpoch(workspaceScope, 1)
        ]);
        this.binding = this.binding.deactivate();
    }

    public deliver(scope: ScopeRef, epoch: number): void {
        this.watermark = this.watermark.join([new ScopeEpoch(scope, epoch)]);
    }
}

class DirectGatewayHarness {
    public executions = 0;
    public now: number;
    public readonly state: DirectAuthorityState;
    public readonly invocations = new GatewayInvocations();
    public readonly authority: TenantOperationAuthority<PrincipalRef>;
    public readonly gateway: OperationGatewayHost<
        PrincipalRef,
        OperationResolutionState,
        ResolutionStamp,
        import("../../src/composition").MediatedAuthorityIntent
    >;

    readonly #host: FacetRuntimeHost;

    private constructor(init: {
        readonly now: number;
        readonly leaseExpiry: number;
        readonly window: number;
        readonly turnActorAuthorityLocal: boolean;
    }) {
        this.now = init.now;
        this.state = new DirectAuthorityState(
            init.leaseExpiry,
            init.window,
            init.turnActorAuthorityLocal
        );
        const manifest = operationManifest([readDescriptor, substitutedDescriptor]);
        const facet = new GatewayFacet(manifest, (input) => {
            this.executions += 1;
            return Promise.resolve(input);
        });
        this.#host = new FacetRuntimeHost([manifest], [facet]);
        this.authority = new TenantOperationAuthority(this.state, () => new Date(this.now));
        this.gateway = new OperationGatewayHost<
            PrincipalRef,
            OperationResolutionState,
            ResolutionStamp,
            import("../../src/composition").MediatedAuthorityIntent
        >(
            principal,
            this.#host,
            this.authority,
            this.invocations
        );
    }

    public static async create(
        overrides: Partial<{
            readonly now: number;
            readonly leaseExpiry: number;
            readonly window: number;
            readonly turnActorAuthorityLocal: boolean;
        }> = {}
    ): Promise<DirectGatewayHarness> {
        const harness = new DirectGatewayHarness({
            now: overrides.now ?? 10,
            leaseExpiry: overrides.leaseExpiry ?? 100,
            window: overrides.window ?? 50,
            turnActorAuthorityLocal: overrides.turnActorAuthorityLocal ?? true
        });
        await harness.#host.activate();
        return harness;
    }

    public async dispatch(
        resolved: ResolvedFacet,
        operation: string,
        marker: string
    ) {
        const result = await resolved.dispatch({
            requestKey: new OperationRequestKey(`direct-${operation}-${marker}`),
            operation: new OperationName(operation),
            payload: { kind: "single", input: { channel: "internal", marker } }
        });
        return result;
    }

    public dispose(): Promise<void> {
        return this.#host.dispose();
    }
}

class GatewayInvocations
    implements
        OperationInvocationPort<
            ResolutionStamp,
            import("../../src/composition").MediatedAuthorityIntent
        >
{
    public directCalls = 0;
    public mediatedCalls = 0;
    public lastDirect: ResolutionStamp | undefined;

    public directContext(
        requestKey: OperationRequestKey,
        itemIndex: number,
        _shape: OperationPayloadShape,
        authorization: ResolutionStamp
    ): OperationContext {
        this.directCalls += 1;
        this.lastDirect = authorization;
        return operationContext(requestKey, itemIndex);
    }

    public async prepareMediated(
        _request: MediatedInvocationPreflight<import("../../src/composition").MediatedAuthorityIntent>,
        prepare: () => import("../../src/operations/gateway").MediatedInvocationPreparation
    ): Promise<MediatedPreflightResult> {
        return { kind: "new", preparation: prepare() };
    }

    public async invoke(
        request: MediatedInvocationRequest<import("../../src/composition").MediatedAuthorityIntent>
    ) {
        this.mediatedCalls += 1;
        const outputs = await Promise.all(
            request.inputs.map((_input, itemIndex) =>
                request.execute(itemIndex, operationContext(request.requestKey, itemIndex))
            )
        );
        return { outputs, evidence: { mediated: true } };
    }

    public recordDirectInterceptions(_evidence: OperationInterceptionEvidence): void {}

    public async presentMediated(
        _evidence: FacetData,
        outputs: readonly FacetData[],
        present: (
            itemIndex: number,
            output: FacetData
        ) => { readonly value: FacetData; readonly traces: readonly [] }
    ): Promise<readonly FacetData[]> {
        return outputs.map((output, itemIndex) => present(itemIndex, output).value);
    }
}

class GatewayFacet extends Facet {
    public readonly ref = facetRef;

    public constructor(
        public readonly manifest: FacetManifest,
        private readonly handler: (input: FacetData) => Promise<FacetData>
    ) {
        super();
    }

    public operation(name: OperationName): Operation | undefined {
        const declared = [readDescriptor, substitutedDescriptor].find((entry) =>
            entry.name.equals(name)
        );
        return declared === undefined ? undefined : new GatewayOperation(declared, this.handler);
    }

    public surface(): undefined {
        return undefined;
    }

    public interceptor(): undefined {
        return undefined;
    }

    public children(): readonly Facet[] {
        return [];
    }

    public async start(): Promise<void> {}

    public async stop(): Promise<void> {}
}

class GatewayOperation extends Operation {
    public constructor(
        public readonly descriptor: OperationDescriptor,
        private readonly handler: (input: FacetData) => Promise<FacetData>
    ) {
        super();
    }

    public execute(_context: OperationContext, input: FacetData): Promise<FacetData> {
        return this.handler(input);
    }
}

function descriptor(name: string): OperationDescriptor {
    return new OperationDescriptor(
        new OperationName(name),
        "observe",
        objectSchema,
        objectSchema
    );
}

function operationManifest(descriptors: readonly OperationDescriptor[]): FacetManifest {
    return new FacetManifest({
        id: new FacetPackageId("direct.gateway"),
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["bundled"],
        bindings: [],
        contributions: new Contributions([
            new Contribution(
                new SlotName("operations"),
                descriptors.map((entry) => entry.toData())
            )
        ])
    });
}

function bundledPlacement(): InvocationPlacementPin {
    return new InvocationPlacementPin({
        manifest: ["bundled"],
        policy: ["bundled"],
        substrate: ["bundled"],
        trust: ["bundled"],
        selected: "bundled"
    });
}

function packagePin(): PackagePin {
    const digest = new Digest("d".repeat(64));
    return new PackagePin(new PackageId("direct-gateway-package"), new SemVer("1.0.0"), digest, digest);
}

function operationContext(requestKey: OperationRequestKey, itemIndex: number): OperationContext {
    return Object.freeze({
        invocation: new InvocationId(`direct-gateway:${requestKey.value}:${itemIndex}`),
        itemIndex,
        idempotencyKey: `${requestKey.value}:${itemIndex}`,
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    });
}
