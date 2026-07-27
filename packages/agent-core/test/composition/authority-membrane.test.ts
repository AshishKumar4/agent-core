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
    MediatedAuthorityIntent,
    ResolutionStamp,
    ResolvedOperationAuthority,
    TenantOperationAuthority,
    type OperationAuthorityStatePort,
    type OperationResolutionCandidate,
    type OperationResolutionState
} from "../../src/composition";
import { Digest, JsonSchema, Revision, SemVer, encodeCanonicalJson } from "../../src/core";
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
    canonicalFacetData,
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
import { RouteReservationId } from "../../src/interaction-references";
import { InvocationPlacementPin } from "../../src/invocations";

const tenant = new TenantId("membrane-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("membrane-principal"));
const otherPrincipal = new PrincipalRef(tenant, new PrincipalId("membrane-other-principal"));
const owner = new ActorRef("workspace", new ActorId("membrane-owner"));
const otherOwner = new ActorRef("workspace", new ActorId("membrane-other-owner"));
const tenantScope = ScopeRef.tenant(tenant);
const scope = ScopeRef.workspace(tenant, new WorkspaceId("membrane-workspace"));
const subject = SubjectRef.principal(principal.principalId);
const facet = new FacetRef("workspace:membrane");
const otherFacet = new FacetRef("workspace:membrane-other");
const bindingName = new BindingName("membrane");
const otherBindingName = new BindingName("membrane-other");
const grant = new GrantId("membrane-grant");
const domain = new ProtectionDomain("backend", "membrane-domain", "no-secrets");
const binding = Binding.active(scope, subject, domain, bindingName, grant, facet);
const path = new PathEpochEvidence([ScopeEpoch.initial(tenantScope), ScopeEpoch.initial(scope)]);
const watermark = InvalidationWatermark.empty(tenant, owner, principal);
const digest = new Digest("d".repeat(64));
const pin = new PackagePin(new PackageId("membrane-package"), new SemVer("1.0.0"), digest, digest);
const placement = new InvocationPlacementPin({
    manifest: ["bundled"],
    policy: ["bundled"],
    substrate: ["bundled"],
    trust: ["bundled"],
    selected: "bundled"
});
const providerPlacement = new InvocationPlacementPin({
    manifest: ["provider"],
    policy: ["provider"],
    substrate: ["provider"],
    trust: ["provider"],
    selected: "provider"
});

const RESOLVED_AT = new Date(1_000);
const LEASE_EXPIRES_AT = new Date(9_000);
const WINDOW_MS = 50;
const DEADLINE = new Date(RESOLVED_AT.getTime() + WINDOW_MS);

const turn = new TurnId("membrane-turn");
const originalLease = TurnLease.restore(turn, principal, 1, LEASE_EXPIRES_AT);
const leaseToken: LeaseToken = { turn, holder: principal, epoch: 1 };
const route = new RouteReservationId("membrane-route");
const policies: readonly PolicySet[] = [new PolicySet({ maxDirectRevocationWindowMs: WINDOW_MS })];

const schema = new JsonSchema({});
const capability = new CapabilitySpec({
    facetPattern: facet.value,
    impacts: ["observe", "externalSend"]
});
const directAuthority = new ResolvedOperationAuthority(facet, [capability]);
const observe = new OperationDescriptor(new OperationName("read"), "observe", schema, schema);
const interceptable = new OperationDescriptor(
    new OperationName("read"),
    "observe",
    schema,
    schema,
    undefined,
    true
);
const inputs: readonly FacetData[] = [{ channel: "internal" }];

class MembraneState implements OperationAuthorityStatePort<PrincipalRef> {
    public binding: Binding | undefined = binding;
    public path = path;
    public watermark = watermark;
    public lease: TurnLease | undefined = originalLease;
    public admitsOperation = true;
    public contributor: ProtectionDomain | undefined = domain;
    public admitsInterceptor = true;
    public readonly released: OperationResolutionState[] = [];
    public readonly stale: OperationResolutionState[] = [];

    public constructor(private readonly candidate: OperationResolutionCandidate | undefined) {}

    public resolve(): OperationResolutionCandidate | undefined {
        return this.candidate;
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

    public currentLease(): TurnLease | undefined {
        return this.lease;
    }

    public admits(): boolean {
        return this.admitsOperation;
    }

    public contributorDomain(): ProtectionDomain | undefined {
        return this.contributor;
    }

    public admitsInterception(): boolean {
        return this.admitsInterceptor;
    }

    public release(resolution: OperationResolutionState): void {
        this.released.push(resolution);
    }

    public observeStale(resolution: OperationResolutionState): void {
        this.stale.push(resolution);
    }
}

function leasedCandidate(
    overrides: Partial<OperationResolutionCandidate> = {}
): OperationResolutionCandidate {
    return {
        principal,
        binding,
        pathEpochs: path,
        watermark,
        lease: leaseToken,
        originalLease,
        route: undefined,
        package: pin,
        placement,
        owner,
        policies,
        turnOwnedSession: true,
        turnActorAuthorityLocal: true,
        directAuthority,
        ...overrides
    };
}

function routedCandidate(
    overrides: Partial<OperationResolutionCandidate> = {}
): OperationResolutionCandidate {
    return leasedCandidate({
        lease: undefined,
        originalLease: undefined,
        route,
        ...overrides
    });
}

function membrane(
    candidate: OperationResolutionCandidate | undefined,
    now: () => Date = () => RESOLVED_AT
): { readonly state: MembraneState; readonly authority: TenantOperationAuthority<PrincipalRef> } {
    const state = new MembraneState(candidate);
    return { state, authority: new TenantOperationAuthority(state, now) };
}

async function resolveOf(
    candidate: OperationResolutionCandidate,
    now: () => Date = () => RESOLVED_AT
): Promise<{
    readonly state: MembraneState;
    readonly authority: TenantOperationAuthority<PrincipalRef>;
    readonly resolution: OperationResolutionState;
}> {
    const { state, authority } = membrane(candidate, now);
    const { resolution } = await authority.resolve(principal, bindingName);
    return { state, authority, resolution };
}

async function captured(action: () => Promise<unknown>): Promise<unknown> {
    return action().then(
        () => undefined,
        (error: unknown) => error
    );
}

function expectDenied(error: unknown, message: string, reason: string): void {
    expect(error, reason).toBeInstanceOf(AgentCoreError);
    expect(error, reason).toMatchObject({ code: "authority.denied", message });
}

function bindingWith(init: {
    readonly name?: BindingName;
    readonly facet?: FacetRef;
    readonly generation?: number;
    readonly state?: "active" | "inactive";
}): Binding {
    return new Binding(
        scope,
        subject,
        domain,
        init.name ?? bindingName,
        grant,
        init.facet ?? facet,
        init.generation ?? 0,
        init.state ?? "active",
        new Revision(init.generation ?? 0)
    );
}

describe("Tenant operation authority membrane", () => {
    test(
        "resolve denies a missing or non-resolving Binding for the authenticated Principal",
        { tags: "p0" },
        async () => {
            for (const [reason, candidate] of [
                ["no resolver candidate", undefined],
                [
                    "inactive Binding",
                    leasedCandidate({ binding: bindingWith({ state: "inactive" }) })
                ]
            ] as const) {
                const { authority } = membrane(candidate);
                expectDenied(
                    await captured(() => authority.resolve(principal, bindingName)),
                    "Binding does not resolve for the authenticated Principal",
                    reason
                );
            }
        }
    );

    test("resolve denies a non-finite resolution time", { tags: "p0" }, async () => {
        const { authority } = membrane(leasedCandidate(), () => new Date(Number.NaN));
        expectDenied(
            await captured(() => authority.resolve(principal, bindingName)),
            "Authority resolver returned an invalid resolution time",
            "non-finite resolution time"
        );
    });

    test(
        "resolve denies each individually substituted evidence field",
        { tags: "p0" },
        async () => {
            const substitutions: readonly (readonly [string, OperationResolutionCandidate])[] = [
                [
                    "binding name",
                    leasedCandidate({ binding: bindingWith({ name: otherBindingName }) })
                ],
                [
                    "watermark holder",
                    leasedCandidate({
                        watermark: new InvalidationWatermark(
                            tenant,
                            owner,
                            otherPrincipal,
                            [],
                            Revision.initial()
                        )
                    })
                ],
                [
                    "watermark owner",
                    leasedCandidate({
                        watermark: InvalidationWatermark.empty(tenant, otherOwner, principal)
                    })
                ],
                ["lease without its original lease", leasedCandidate({ originalLease: undefined })],
                ["lease alongside a route reservation", leasedCandidate({ route })],
                [
                    "lease held by another Principal",
                    leasedCandidate({
                        lease: { turn, holder: otherPrincipal, epoch: 1 },
                        originalLease: TurnLease.restore(turn, otherPrincipal, 1, LEASE_EXPIRES_AT)
                    })
                ],
                [
                    "direct authority for another Facet",
                    leasedCandidate({
                        directAuthority: new ResolvedOperationAuthority(otherFacet, [capability])
                    })
                ]
            ];

            for (const [reason, candidate] of substitutions) {
                const { authority } = membrane(candidate);
                expectDenied(
                    await captured(() => authority.resolve(principal, bindingName)),
                    "Authority resolver returned substituted resolution evidence",
                    reason
                );
            }
        }
    );

    test("resolve requires the exact current Turn lease", { tags: "p0" }, async () => {
        const mismatches: readonly (readonly [string, TurnLease])[] = [
            ["stale lease epoch", TurnLease.restore(turn, principal, 2, LEASE_EXPIRES_AT)],
            [
                "lease expired at the resolution instant",
                TurnLease.restore(turn, principal, 1, RESOLVED_AT)
            ],
            [
                "lease for another Turn",
                TurnLease.restore(new TurnId("other-turn"), principal, 1, LEASE_EXPIRES_AT)
            ]
        ];

        for (const [reason, lease] of mismatches) {
            const { authority } = membrane(leasedCandidate({ originalLease: lease }));
            expectDenied(
                await captured(() => authority.resolve(principal, bindingName)),
                "Authority resolution requires the exact current Turn lease",
                reason
            );
        }
    });

    test(
        "resolve denies a direct revocation deadline beyond the safe range",
        { tags: "p0" },
        async () => {
            const { authority } = membrane(
                leasedCandidate({
                    policies: [
                        new PolicySet({ maxDirectRevocationWindowMs: Number.MAX_SAFE_INTEGER })
                    ]
                })
            );
            expectDenied(
                await captured(() => authority.resolve(principal, bindingName)),
                "Direct revocation deadline exceeds the safe time range",
                "unsafe deadline"
            );
        }
    );

    test(
        "a leased resolution without a revocation window carries no deadline and stays mediated",
        { tags: "p0" },
        async () => {
            const { authority, resolution } = await resolveOf(
                leasedCandidate({ policies: [new PolicySet({})] })
            );

            expect(resolution.resolutionDeadline).toBeUndefined();
            expect(resolution.originalLeaseExpiresAt).toEqual(LEASE_EXPIRES_AT);
            expect(resolution.resolvedAt).toEqual(RESOLVED_AT);
            expect(resolution.admitsDirectAt(RESOLVED_AT)).toBe(false);
            expect(authority.tier(resolution, observe, false)).toBe("mediated");
            expect(authority.authorizeDirect(resolution, observe, inputs)).toBeUndefined();
        }
    );

    test(
        "a route-scoped resolution carries no lease evidence and never admits direct",
        { tags: "p0" },
        async () => {
            const { authority, resolution } = await resolveOf(routedCandidate());

            expect(resolution.lease).toBeUndefined();
            expect(resolution.route).toBe(route);
            expect(resolution.originalLeaseExpiresAt).toBeUndefined();
            expect(resolution.resolutionDeadline).toBeUndefined();
            expect(resolution.resolvedAt).toEqual(RESOLVED_AT);
            expect(authority.tier(resolution, observe, false)).toBe("mediated");
            expect(authority.authorizeDirect(resolution, observe, inputs)).toBeUndefined();
        }
    );

    test(
        "the direct tier gate requires a lease, local authority, granted capability, and a window",
        { tags: "p0" },
        () => {
            const { authority } = membrane(undefined);

            expect(authority.tier(leasedCandidate(), observe, false)).toBe("direct");
            expect(authority.tier(leasedCandidate(), observe, true)).toBe("mediated");
            expect(authority.tier(leasedCandidate({ lease: undefined }), observe, false)).toBe(
                "mediated"
            );
            expect(
                authority.tier(leasedCandidate({ turnActorAuthorityLocal: false }), observe, false)
            ).toBe("mediated");
            expect(
                authority.tier(leasedCandidate({ directAuthority: undefined }), observe, false)
            ).toBe("mediated");
            expect(authority.tier(leasedCandidate({ policies: [] }), observe, false)).toBe(
                "mediated"
            );
            expect(
                authority.tier(leasedCandidate({ placement: providerPlacement }), observe, false)
            ).toBe("mediated");
        }
    );

    test(
        "direct authorization stamps the exact resolution identity and operation digests",
        { tags: "p0" },
        async () => {
            const { resolution, authority } = await resolveOf(leasedCandidate());

            expect(resolution.resolvedAt).toEqual(RESOLVED_AT);
            expect(resolution.originalLeaseExpiresAt).toEqual(LEASE_EXPIRES_AT);
            expect(resolution.resolutionDeadline).toEqual(DEADLINE);
            expect(resolution.admitsDirectAt(new Date(DEADLINE.getTime() - 1))).toBe(true);
            expect(resolution.admitsDirectAt(DEADLINE)).toBe(false);

            const stamp = authority.authorizeDirect(resolution, observe, inputs);

            expect(stamp).toBeInstanceOf(ResolutionStamp);
            expect(stamp?.principal).toBe(principal);
            expect(stamp?.binding).toBe(binding);
            expect(stamp?.pathEpochs).toBe(path);
            expect(stamp?.lease).toEqual(leaseToken);
            expect(stamp?.originalLeaseExpiresAt).toEqual(LEASE_EXPIRES_AT);
            expect(stamp?.resolvedAt).toEqual(RESOLVED_AT);
            expect(stamp?.resolutionDeadline).toEqual(DEADLINE);
            expect(
                stamp?.operationDigest.equals(Digest.sha256(encodeCanonicalJson(observe.toData())))
            ).toBe(true);
            expect(
                stamp?.inputDigest.equals(
                    Digest.sha256(
                        encodeCanonicalJson(inputs.map((input) => canonicalFacetData(input)))
                    )
                )
            ).toBe(true);
            expect(stamp?.matches(observe, inputs)).toBe(true);
            expect(stamp?.matches(interceptable, inputs)).toBe(false);
            expect(stamp?.matches(observe, [{ channel: "external" }])).toBe(false);
        }
    );

    test(
        "direct authorization refuses every individually stale precondition",
        { tags: "p0" },
        async () => {
            const cases: readonly {
                readonly reason: string;
                readonly candidate?: OperationResolutionCandidate;
                readonly at?: Date;
                readonly mutate?: (state: MembraneState) => void;
            }[] = [
                {
                    reason: "policy tightened the tier to mediated",
                    candidate: leasedCandidate({
                        policies: [
                            new PolicySet({ maxDirectRevocationWindowMs: WINDOW_MS }),
                            new PolicySet({ tiers: { observe: "mediated" } })
                        ]
                    })
                },
                { reason: "the revocation deadline elapsed", at: DEADLINE },
                {
                    reason: "the current watermark belongs to another holder",
                    mutate: (state) => {
                        state.watermark = new InvalidationWatermark(
                            tenant,
                            owner,
                            otherPrincipal,
                            [],
                            Revision.initial()
                        );
                    }
                },
                {
                    reason: "the current watermark belongs to another owner",
                    mutate: (state) => {
                        state.watermark = InvalidationWatermark.empty(
                            tenant,
                            otherOwner,
                            principal
                        );
                    }
                },
                {
                    reason: "the holder watermark advanced past the resolved path",
                    mutate: (state) => {
                        state.watermark = watermark.join([new ScopeEpoch(scope, 1)]);
                    }
                },
                {
                    reason: "the Turn lease is no longer held",
                    mutate: (state) => {
                        state.lease = undefined;
                    }
                },
                {
                    reason: "the Turn lease expired",
                    mutate: (state) => {
                        state.lease = TurnLease.restore(turn, principal, 1, new Date(500));
                    }
                },
                {
                    reason: "the Turn lease was fenced to a newer epoch",
                    mutate: (state) => {
                        state.lease = TurnLease.restore(turn, principal, 2, LEASE_EXPIRES_AT);
                    }
                },
                {
                    reason: "the Grant plane does not admit the Operation",
                    candidate: leasedCandidate({
                        directAuthority: new ResolvedOperationAuthority(facet, [
                            new CapabilitySpec({
                                facetPattern: facet.value,
                                operations: ["send"],
                                impacts: ["observe"]
                            })
                        ])
                    })
                }
            ];

            for (const entry of cases) {
                let at = RESOLVED_AT;
                const { state, authority, resolution } = await resolveOf(
                    entry.candidate ?? leasedCandidate(),
                    () => at
                );
                entry.mutate?.(state);
                if (entry.at !== undefined) at = entry.at;
                expect(
                    authority.authorizeDirect(resolution, observe, inputs),
                    entry.reason
                ).toBeUndefined();
            }
        }
    );

    test(
        "mediated authorization denies every individually stale precondition",
        { tags: "p0" },
        async () => {
            const cases: readonly {
                readonly reason: string;
                readonly mutate: (state: MembraneState) => void;
            }[] = [
                { reason: "the Binding is gone", mutate: (state) => (state.binding = undefined) },
                {
                    reason: "the Binding key changed",
                    mutate: (state) => (state.binding = bindingWith({ name: otherBindingName }))
                },
                {
                    reason: "the Binding generation advanced",
                    mutate: (state) => (state.binding = bindingWith({ generation: 1 }))
                },
                {
                    reason: "the Binding no longer resolves",
                    mutate: (state) => (state.binding = bindingWith({ state: "inactive" }))
                },
                {
                    reason: "the Binding points at another Facet",
                    mutate: (state) => (state.binding = bindingWith({ facet: otherFacet }))
                },
                {
                    reason: "the current path epochs advanced",
                    mutate: (state) => {
                        state.path = new PathEpochEvidence([
                            ScopeEpoch.initial(tenantScope),
                            new ScopeEpoch(scope, 1)
                        ]);
                    }
                },
                {
                    reason: "the holder watermark advanced past the resolved path",
                    mutate: (state) => {
                        state.watermark = watermark.join([new ScopeEpoch(scope, 1)]);
                    }
                },
                {
                    reason: "the Turn lease is no longer held",
                    mutate: (state) => (state.lease = undefined)
                },
                {
                    reason: "the Turn lease was fenced to a newer epoch",
                    mutate: (state) =>
                        (state.lease = TurnLease.restore(turn, principal, 2, LEASE_EXPIRES_AT))
                },
                {
                    reason: "the authority state no longer admits the Operation",
                    mutate: (state) => (state.admitsOperation = false)
                }
            ];

            for (const entry of cases) {
                const { state, authority, resolution } = await resolveOf(leasedCandidate());
                entry.mutate(state);
                expectDenied(
                    await captured(() => authority.authorizeMediated(resolution, observe, inputs)),
                    "Mediated authority intent is stale",
                    entry.reason
                );
                expect(state.stale, entry.reason).toEqual([resolution]);
            }
        }
    );

    test(
        "mediated authorization yields a frozen intent replayed as exact canonical digests",
        { tags: "p0" },
        async () => {
            const { state, authority, resolution } = await resolveOf(leasedCandidate());
            const intent = await authority.authorizeMediated(resolution, observe, inputs);

            expect(intent).toBeInstanceOf(MediatedAuthorityIntent);
            expect(Object.isFrozen(intent)).toBe(true);
            expect(intent).toMatchObject({
                principal,
                binding,
                pathEpochs: path,
                domain,
                packagePin: pin,
                placement,
                owner,
                route: undefined
            });
            expect(intent.lease).toEqual(leaseToken);
            expect(state.stale).toEqual([]);

            const replay = authority.replayBinding(intent, observe);

            expect(replay.principal).toBe(principal);
            expect(replay.execution.kind).toBe("lease");
            expect(
                replay.execution.digest.equals(
                    Digest.sha256(
                        encodeCanonicalJson({
                            epoch: 1,
                            holder: {
                                principal: principal.principalId.value,
                                tenant: tenant.value
                            },
                            turn: turn.value
                        })
                    )
                )
            ).toBe(true);
            expect(
                replay.authorityIdentity.equals(
                    Digest.sha256(
                        encodeCanonicalJson({
                            binding: binding.toData(),
                            domain: {
                                kind: domain.kind,
                                label: domain.label,
                                secretPolicy: domain.secretPolicy
                            },
                            owner: { id: owner.id.value, kind: owner.kind },
                            pathEpochs: path.toData(),
                            principal: {
                                principal: principal.principalId.value,
                                tenant: tenant.value
                            }
                        })
                    )
                )
            ).toBe(true);
            expect(
                replay.packageOperationPin.equals(
                    Digest.sha256(
                        encodeCanonicalJson({
                            descriptor: observe.toData(),
                            facet: facet.value,
                            package: pin.toData(),
                            placement: placement.toData()
                        })
                    )
                )
            ).toBe(true);
        }
    );

    test(
        "a route-scoped mediated intent replays its route reservation digest",
        { tags: "p0" },
        async () => {
            const { authority, resolution } = await resolveOf(routedCandidate());
            const intent = await authority.authorizeMediated(resolution, observe, inputs);

            expect(intent.lease).toBeUndefined();
            expect(intent.route).toBe(route);

            const replay = authority.replayBinding(intent, observe);

            expect(replay.execution.kind).toBe("route");
            expect(
                replay.execution.digest.equals(
                    Digest.sha256(encodeCanonicalJson({ route: route.value }))
                )
            ).toBe(true);
        }
    );

    test("releasing a resolution delegates to the authority state", { tags: "p1" }, async () => {
        const { state, authority, resolution } = await resolveOf(leasedCandidate());

        authority.release(resolution);

        expect(state.released).toEqual([resolution]);
    });

    test(
        "interception requires the exact target, contributor domain, and declaration",
        { tags: "p0" },
        async () => {
            const declaration = new InterceptorDeclaration(
                new InterceptorId("membrane-interceptor"),
                "operation.before",
                0
            );
            const base = await resolveOf(leasedCandidate());

            expect(
                base.authority.allowsInterception(
                    base.resolution,
                    otherFacet,
                    declaration,
                    facet,
                    interceptable
                )
            ).toBe(true);

            const refusals: readonly {
                readonly reason: string;
                readonly target?: FacetRef;
                readonly descriptor?: OperationDescriptor;
                readonly mutate?: (state: MembraneState) => void;
            }[] = [
                { reason: "another target Facet", target: otherFacet },
                { reason: "an uninterceptable Operation", descriptor: observe },
                {
                    reason: "an uninstalled contributor",
                    mutate: (state) => (state.contributor = undefined)
                },
                {
                    reason: "a contributor domain of another kind",
                    mutate: (state) =>
                        (state.contributor = new ProtectionDomain(
                            "frontend",
                            domain.label,
                            "no-secrets"
                        ))
                },
                {
                    reason: "a contributor domain with another label",
                    mutate: (state) =>
                        (state.contributor = new ProtectionDomain(
                            "backend",
                            "membrane-other-domain",
                            "no-secrets"
                        ))
                },
                {
                    reason: "a contributor domain with another secret policy",
                    mutate: (state) =>
                        (state.contributor = new ProtectionDomain(
                            "backend",
                            domain.label,
                            "may-hold-secrets"
                        ))
                },
                {
                    reason: "an authority state that refuses the declaration",
                    mutate: (state) => (state.admitsInterceptor = false)
                }
            ];

            for (const entry of refusals) {
                const { state, authority, resolution } = await resolveOf(leasedCandidate());
                entry.mutate?.(state);
                expect(
                    authority.allowsInterception(
                        resolution,
                        otherFacet,
                        declaration,
                        entry.target ?? facet,
                        entry.descriptor ?? interceptable
                    ),
                    entry.reason
                ).toBe(false);
            }
        }
    );

    test(
        "resolved operation authority admits only inputs every capability covers",
        { tags: "p0" },
        () => {
            const constrained = new ResolvedOperationAuthority(facet, [
                new CapabilitySpec({
                    facetPattern: facet.value,
                    impacts: ["observe"],
                    argumentConstraints: { channel: "internal" }
                })
            ]);

            expect(constrained.admits(observe, [{ channel: "internal" }])).toBe(true);
            expect(
                constrained.admits(observe, [{ channel: "internal" }, { channel: "external" }])
            ).toBe(false);
            expect(constrained.admits(observe, [{ channel: "external" }])).toBe(false);

            expect(directAuthority.admits(observe, [{ channel: "internal" }])).toBe(true);
            expect(directAuthority.admits(observe, [42])).toBe(false);
            expect(directAuthority.admits(observe, [["channel", "internal"]])).toBe(false);

            const alternatives = new ResolvedOperationAuthority(facet, [
                new CapabilitySpec({ facetPattern: otherFacet.value, impacts: ["observe"] }),
                new CapabilitySpec({ facetPattern: facet.value, impacts: ["observe"] })
            ]);
            expect(alternatives.admits(observe, [{ channel: "internal" }])).toBe(true);
            expect(
                new ResolvedOperationAuthority(otherFacet, [capability]).admits(observe, [
                    { channel: "internal" }
                ])
            ).toBe(false);
        }
    );
});
