import type { ActorRef } from "../actors";
import { Binding, InvalidationWatermark, PathEpochEvidence } from "../authority";
import { Digest, encodeCanonicalJson, type JsonValue } from "../core";
import { evaluatePolicy, mergePolicySets } from "../definition";
import type { PackagePin, PolicySet } from "../definition";
import { AgentCoreError } from "../errors";
import {
    canonicalFacetData,
    CapabilitySpec,
    isFacetDataMap,
    type BindingName,
    type FacetData,
    type FacetRef,
    type InterceptorDeclaration,
    type OperationDescriptor,
    type ProtectionDomain
} from "../facets";
import type { PrincipalRef } from "../identity";
import type { AuthorityResolution, OperationAuthorityPort } from "../operations";
import type { InvocationPlacementPin } from "../invocations";
import type { LeaseToken, TurnLease } from "../agents";
import type { RouteReservationId } from "../interaction-references";
import type { MediatedReplayBinding } from "../operations";

export interface OperationResolutionEvidence {
    readonly principal: PrincipalRef;
    readonly binding: Binding;
    readonly pathEpochs: PathEpochEvidence;
    readonly watermark: InvalidationWatermark;
    readonly lease: LeaseToken | undefined;
    readonly originalLease: TurnLease | undefined;
    readonly route: RouteReservationId | undefined;
    readonly package: PackagePin;
    readonly placement: InvocationPlacementPin;
    readonly owner: ActorRef;
    /**
     * The policy sets governing this resolution's scope chain. Required so a resolver
     * that has no applicable policies states that explicitly with an empty array — an
     * omitted field would be indistinguishable from policies silently not threaded, and
     * policy tightening plus approval requirements would be lost (SPEC §7.2).
     */
    readonly policies: readonly PolicySet[];
    /**
     * True only when the resolver attests that the operation targets an Environment
     * session owned by the current Turn. Lease possession alone does not establish
     * this — a leased Turn can resolve operations against sessions it does not own,
     * and only session-scoped execute is eligible for the direct tier (SPEC §7.2).
     */
    readonly turnOwnedSession: boolean;
    /**
     * True only when the bundled Facet and a versioned Binding projection are local to
     * the Actor that owns the exact Turn lease. Dedicated Run Actors without that
     * projection must mediate even an otherwise direct-eligible operation.
     */
    readonly turnActorAuthorityLocal: boolean;
    /** Effective operation authority captured from the one Grant plane at resolution. */
    readonly directAuthority: ResolvedOperationAuthority | undefined;
}

export interface OperationResolutionCandidate extends OperationResolutionEvidence {}

export class ResolvedOperationAuthority {
    readonly #capabilities: readonly CapabilitySpec[];

    public constructor(
        public readonly facet: FacetRef,
        capabilities: readonly CapabilitySpec[]
    ) {
        this.#capabilities = Object.freeze(
            capabilities.map((capability) => CapabilitySpec.fromData(capability.toData()))
        );
        Object.freeze(this);
    }

    public admits(descriptor: OperationDescriptor, inputs: readonly FacetData[]): boolean {
        return inputs.every((input) => {
            const arguments_ = capabilityArguments(input);
            return (
                arguments_ !== undefined &&
                this.#capabilities.some((capability) =>
                    capability.matches({
                        facet: this.facet.value,
                        operation: descriptor.name.value,
                        impact: descriptor.impact,
                        arguments: arguments_
                    })
                )
            );
        });
    }
}

export class OperationResolutionState implements OperationResolutionEvidence {
    readonly #resolvedAt: number;
    readonly #originalLeaseExpiresAt: number | undefined;
    readonly #resolutionDeadline: number | undefined;

    public constructor(
        evidence: OperationResolutionEvidence,
        resolvedAt: Date,
        originalLeaseExpiresAt: Date | undefined,
        resolutionDeadline: Date | undefined,
        authority: symbol
    ) {
        if (authority !== operationResolutionAuthority) {
            throw new TypeError("Operation resolution state is issued only by Tenant authority");
        }
        this.principal = evidence.principal;
        this.binding = evidence.binding;
        this.pathEpochs = evidence.pathEpochs;
        this.watermark = evidence.watermark;
        this.lease =
            evidence.lease === undefined
                ? undefined
                : Object.freeze({
                      turn: evidence.lease.turn,
                      holder: evidence.lease.holder,
                      epoch: evidence.lease.epoch
                  });
        this.originalLease = evidence.originalLease;
        this.route = evidence.route;
        this.package = evidence.package;
        this.placement = evidence.placement;
        this.owner = evidence.owner;
        this.policies = Object.freeze([...evidence.policies]);
        this.turnOwnedSession = evidence.turnOwnedSession;
        this.turnActorAuthorityLocal = evidence.turnActorAuthorityLocal;
        this.directAuthority = evidence.directAuthority;
        this.#resolvedAt = resolvedAt.getTime();
        this.#originalLeaseExpiresAt = originalLeaseExpiresAt?.getTime();
        this.#resolutionDeadline = resolutionDeadline?.getTime();
        Object.freeze(this);
    }

    public readonly principal: PrincipalRef;
    public readonly binding: Binding;
    public readonly pathEpochs: PathEpochEvidence;
    public readonly watermark: InvalidationWatermark;
    public readonly lease: LeaseToken | undefined;
    public readonly originalLease: TurnLease | undefined;
    public readonly route: RouteReservationId | undefined;
    public readonly package: PackagePin;
    public readonly placement: InvocationPlacementPin;
    public readonly owner: ActorRef;
    public readonly policies: readonly PolicySet[];
    public readonly turnOwnedSession: boolean;
    public readonly turnActorAuthorityLocal: boolean;
    public readonly directAuthority: ResolvedOperationAuthority | undefined;

    public get resolvedAt(): Date {
        return new Date(this.#resolvedAt);
    }

    public get originalLeaseExpiresAt(): Date | undefined {
        return this.#originalLeaseExpiresAt === undefined
            ? undefined
            : new Date(this.#originalLeaseExpiresAt);
    }

    public get resolutionDeadline(): Date | undefined {
        return this.#resolutionDeadline === undefined
            ? undefined
            : new Date(this.#resolutionDeadline);
    }

    public admitsDirectAt(at: Date): boolean {
        return this.#resolutionDeadline !== undefined && at.getTime() < this.#resolutionDeadline;
    }
}

const operationResolutionAuthority = Symbol("operation-resolution-authority");

export interface OperationAuthorityStatePort<Caller> {
    resolve(caller: Caller, binding: BindingName): OperationResolutionCandidate | undefined;
    currentBinding(key: string): Binding | undefined;
    currentPath(binding: Binding): PathEpochEvidence;
    currentWatermark(principal: PrincipalRef): InvalidationWatermark;
    currentLease(token: LeaseToken): TurnLease | undefined;
    admits(
        resolution: OperationResolutionState,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[],
        at: Date
    ): boolean;
    contributorDomain(facet: FacetRef): ProtectionDomain | undefined;
    admitsInterception(
        resolution: OperationResolutionState,
        contributor: FacetRef,
        declaration: InterceptorDeclaration,
        descriptor: OperationDescriptor
    ): boolean;
    release(resolution: OperationResolutionState): void;
    /**
     * Record a stale-authority observation atomically (SPEC §3.4 rule 7): join the
     * current path Scope epochs into the holder watermark map, invalidate the cached
     * resolution, and persist the deniedPreEffect Receipt and AuditRecord with no
     * EffectAttempt. Required — an optional hook would let an implementation silently
     * skip the durable denial evidence, which is the defect class this exists to close.
     */
    observeStale(
        resolution: OperationResolutionState,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[]
    ): void;
}

export class ResolutionStamp {
    public readonly inputDigest: Digest;
    public readonly operationDigest: Digest;
    readonly #originalLeaseExpiresAt: number;
    readonly #resolvedAt: number;
    readonly #resolutionDeadline: number;

    public constructor(
        public readonly principal: PrincipalRef,
        public readonly binding: Binding,
        public readonly pathEpochs: PathEpochEvidence,
        public readonly lease: LeaseToken,
        originalLeaseExpiresAt: Date,
        resolvedAt: Date,
        resolutionDeadline: Date,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[]
    ) {
        this.#originalLeaseExpiresAt = originalLeaseExpiresAt.getTime();
        this.#resolvedAt = resolvedAt.getTime();
        this.#resolutionDeadline = resolutionDeadline.getTime();
        this.operationDigest = Digest.sha256(encodeCanonicalJson(descriptor.toData()));
        this.inputDigest = Digest.sha256(
            encodeCanonicalJson(inputs.map((input) => canonicalFacetData(input)))
        );
        Object.freeze(this);
    }

    public get originalLeaseExpiresAt(): Date {
        return new Date(this.#originalLeaseExpiresAt);
    }

    public get resolvedAt(): Date {
        return new Date(this.#resolvedAt);
    }

    public get resolutionDeadline(): Date {
        return new Date(this.#resolutionDeadline);
    }

    public matches(descriptor: OperationDescriptor, inputs: readonly FacetData[]): boolean {
        return (
            this.operationDigest.equals(Digest.sha256(encodeCanonicalJson(descriptor.toData()))) &&
            this.inputDigest.equals(
                Digest.sha256(encodeCanonicalJson(inputs.map((input) => canonicalFacetData(input))))
            )
        );
    }
}

export class MediatedAuthorityIntent {
    public constructor(
        public readonly principal: PrincipalRef,
        public readonly binding: Binding,
        public readonly pathEpochs: PathEpochEvidence,
        public readonly domain: ProtectionDomain,
        public readonly packagePin: PackagePin,
        public readonly placement: InvocationPlacementPin,
        public readonly owner: ActorRef,
        public readonly lease: LeaseToken | undefined,
        public readonly route: RouteReservationId | undefined
    ) {
        Object.freeze(this);
    }
}

export class TenantOperationAuthority<Caller> implements OperationAuthorityPort<
    Caller,
    OperationResolutionState,
    ResolutionStamp,
    MediatedAuthorityIntent
> {
    public constructor(
        private readonly state: OperationAuthorityStatePort<Caller>,
        private readonly now: () => Date
    ) {}

    public async resolve(
        caller: Caller,
        binding: BindingName
    ): Promise<AuthorityResolution<OperationResolutionState>> {
        const resolution = this.state.resolve(caller, binding);
        if (resolution === undefined || !resolution.binding.resolves) {
            throw denied("Binding does not resolve for the authenticated Principal");
        }
        const derived = deriveResolution(resolution, binding, this.now());
        return Object.freeze({ facet: derived.binding.facet, resolution: derived });
    }

    public tier(
        resolution: OperationResolutionEvidence,
        descriptor: OperationDescriptor,
        hasInterceptors: boolean
    ): "direct" | "mediated" {
        if (
            hasInterceptors ||
            resolution.lease === undefined ||
            !resolution.turnActorAuthorityLocal ||
            resolution.directAuthority === undefined ||
            mergePolicySets(resolution.policies).maxDirectRevocationWindowMs === undefined
        ) {
            return "mediated";
        }
        return evaluatePolicy({
            impact: descriptor.impact,
            turnOwnedSession: resolution.turnOwnedSession,
            placement: resolution.placement.selected,
            policies: resolution.policies
        }).tier;
    }

    public authorizeDirect(
        resolution: OperationResolutionState,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[]
    ): ResolutionStamp | undefined {
        const at = this.now();
        const token = resolution.lease;
        const deadline = resolution.resolutionDeadline;
        const originalLeaseExpiresAt = resolution.originalLeaseExpiresAt;
        const watermark = this.state.currentWatermark(resolution.principal);
        if (
            token === undefined ||
            deadline === undefined ||
            originalLeaseExpiresAt === undefined ||
            !token.holder.equals(resolution.principal) ||
            !resolution.turnActorAuthorityLocal ||
            resolution.placement.selected !== "bundled" ||
            this.tier(resolution, descriptor, false) !== "direct" ||
            !resolution.admitsDirectAt(at) ||
            !watermark.holder.equals(resolution.principal) ||
            !watermark.owner.equals(resolution.owner) ||
            watermarkStale(watermark, resolution.pathEpochs) ||
            this.state.currentLease(token)?.admits(token, at) !== true ||
            resolution.directAuthority?.admits(descriptor, inputs) !== true
        ) {
            return undefined;
        }
        return new ResolutionStamp(
            resolution.principal,
            resolution.binding,
            resolution.pathEpochs,
            token,
            originalLeaseExpiresAt,
            resolution.resolvedAt,
            deadline,
            descriptor,
            inputs
        );
    }

    public async authorizeMediated(
        resolution: OperationResolutionState,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[]
    ): Promise<MediatedAuthorityIntent> {
        const at = this.now();
        if (
            !sameBinding(this.state.currentBinding(resolution.binding.key), resolution.binding) ||
            !this.state.currentPath(resolution.binding).equals(resolution.pathEpochs) ||
            watermarkStale(
                this.state.currentWatermark(resolution.principal),
                resolution.pathEpochs
            ) ||
            (resolution.lease !== undefined &&
                !resolution.lease.holder.equals(resolution.principal)) ||
            (resolution.lease !== undefined &&
                this.state.currentLease(resolution.lease)?.admits(resolution.lease, at) !== true) ||
            !this.state.admits(resolution, descriptor, inputs, at)
        ) {
            this.state.observeStale(resolution, descriptor, inputs);
            throw denied("Mediated authority intent is stale");
        }
        return new MediatedAuthorityIntent(
            resolution.principal,
            resolution.binding,
            resolution.pathEpochs,
            resolution.binding.domain,
            resolution.package,
            resolution.placement,
            resolution.owner,
            resolution.lease,
            resolution.route
        );
    }

    public replayBinding(
        authorization: MediatedAuthorityIntent,
        descriptor: OperationDescriptor
    ): MediatedReplayBinding {
        const execution =
            authorization.lease === undefined
                ? {
                      kind: "route" as const,
                      digest: Digest.sha256(
                          encodeCanonicalJson({ route: authorization.route!.value })
                      )
                  }
                : {
                      kind: "lease" as const,
                      digest: Digest.sha256(
                          encodeCanonicalJson({
                              epoch: authorization.lease.epoch,
                              holder: {
                                  principal: authorization.lease.holder.principalId.value,
                                  tenant: authorization.lease.holder.tenantId.value
                              },
                              turn: authorization.lease.turn.value
                          })
                      )
                  };
        return Object.freeze({
            principal: authorization.principal,
            authorityIdentity: Digest.sha256(
                encodeCanonicalJson({
                    binding: authorization.binding.toData(),
                    domain: {
                        kind: authorization.domain.kind,
                        label: authorization.domain.label,
                        secretPolicy: authorization.domain.secretPolicy
                    },
                    owner: {
                        id: authorization.owner.id.value,
                        kind: authorization.owner.kind
                    },
                    pathEpochs: authorization.pathEpochs.toData(),
                    principal: {
                        principal: authorization.principal.principalId.value,
                        tenant: authorization.principal.tenantId.value
                    }
                })
            ),
            packageOperationPin: Digest.sha256(
                encodeCanonicalJson({
                    descriptor: descriptor.toData(),
                    facet: authorization.binding.facet.value,
                    package: authorization.packagePin.toData(),
                    placement: authorization.placement.toData()
                })
            ),
            execution
        });
    }

    public allowsInterception(
        resolution: OperationResolutionState,
        contributor: FacetRef,
        declaration: InterceptorDeclaration,
        target: FacetRef,
        descriptor: OperationDescriptor
    ): boolean {
        const domain = this.state.contributorDomain(contributor);
        return (
            target.equals(resolution.binding.facet) &&
            domain !== undefined &&
            sameDomain(domain, resolution.binding.domain) &&
            descriptor.interceptable &&
            this.state.admitsInterception(resolution, contributor, declaration, descriptor)
        );
    }

    public release(resolution: OperationResolutionState): void {
        this.state.release(resolution);
    }
}

function deriveResolution(
    candidate: OperationResolutionCandidate,
    name: BindingName,
    resolvedAt: Date
): OperationResolutionState {
    if (!Number.isFinite(resolvedAt.getTime())) {
        throw denied("Authority resolver returned an invalid resolution time");
    }
    if (
        !candidate.binding.name.equals(name) ||
        !candidate.watermark.holder.equals(candidate.principal) ||
        !candidate.watermark.owner.equals(candidate.owner) ||
        (candidate.lease === undefined) !== (candidate.originalLease === undefined) ||
        (candidate.lease === undefined) === (candidate.route === undefined) ||
        (candidate.lease !== undefined && !candidate.lease.holder.equals(candidate.principal)) ||
        (candidate.directAuthority !== undefined &&
            !candidate.directAuthority.facet.equals(candidate.binding.facet))
    ) {
        throw denied("Authority resolver returned substituted resolution evidence");
    }

    let originalLeaseExpiresAt: Date | undefined;
    let resolutionDeadline: Date | undefined;
    if (candidate.lease !== undefined) {
        const originalLease = candidate.originalLease;
        originalLeaseExpiresAt = originalLease?.expiresAt;
        if (
            originalLease === undefined ||
            originalLeaseExpiresAt === undefined ||
            originalLease.admits(candidate.lease, resolvedAt) !== true
        ) {
            throw denied("Authority resolution requires the exact current Turn lease");
        }
        const window = mergePolicySets(candidate.policies).maxDirectRevocationWindowMs;
        if (window !== undefined) {
            const windowDeadline = resolvedAt.getTime() + window;
            if (!Number.isSafeInteger(windowDeadline)) {
                throw denied("Direct revocation deadline exceeds the safe time range");
            }
            resolutionDeadline = new Date(
                Math.min(originalLeaseExpiresAt.getTime(), windowDeadline)
            );
        }
    }
    return new OperationResolutionState(
        candidate,
        resolvedAt,
        originalLeaseExpiresAt,
        resolutionDeadline,
        operationResolutionAuthority
    );
}

function capabilityArguments(input: FacetData): Readonly<Record<string, JsonValue>> | undefined {
    const canonical = canonicalFacetData(input);
    return isFacetDataMap(canonical) ? canonical : undefined;
}

function sameBinding(current: Binding | undefined, expected: Binding): boolean {
    return (
        current !== undefined &&
        current.key === expected.key &&
        current.generation === expected.generation &&
        current.resolves &&
        current.facet.equals(expected.facet)
    );
}

function watermarkStale(watermark: InvalidationWatermark, path: PathEpochEvidence): boolean {
    return path.path.some((entry) => watermark.epoch(entry.scope) > entry.epoch);
}

function sameDomain(left: ProtectionDomain, right: ProtectionDomain): boolean {
    return (
        left.kind === right.kind &&
        left.label === right.label &&
        left.secretPolicy === right.secretPolicy
    );
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}
