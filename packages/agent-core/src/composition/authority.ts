import type { ActorRef } from "../actors";
import { Binding, InvalidationWatermark, PathEpochEvidence } from "../authority";
import { Digest, encodeCanonicalJson } from "../core";
import type { PackagePin } from "../definition";
import { AgentCoreError } from "../errors";
import {
    canonicalFacetData,
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

export interface OperationResolutionState {
    readonly principal: PrincipalRef;
    readonly binding: Binding;
    readonly pathEpochs: PathEpochEvidence;
    readonly watermark: InvalidationWatermark;
    readonly lease: LeaseToken | undefined;
    readonly originalLease: TurnLease | undefined;
    readonly route?: RouteReservationId;
    readonly package: PackagePin;
    readonly placement: InvocationPlacementPin;
    readonly resolvedAt: Date;
    readonly deadline: Date;
    readonly owner: ActorRef;
}

export interface OperationAuthorityStatePort<Caller> {
    resolve(caller: Caller, binding: BindingName): OperationResolutionState | undefined;
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
}

export class ResolutionStamp {
    public readonly inputDigest: Digest;

    public constructor(
        public readonly principal: PrincipalRef,
        public readonly binding: Binding,
        public readonly pathEpochs: PathEpochEvidence,
        public readonly lease: LeaseToken,
        public readonly deadline: Date,
        inputs: readonly FacetData[]
    ) {
        this.inputDigest = Digest.sha256(
            encodeCanonicalJson(inputs.map((input) => canonicalFacetData(input)))
        );
        Object.freeze(this.deadline);
        Object.freeze(this);
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
        requireResolution(resolution, binding);
        return Object.freeze({ facet: resolution.binding.facet, resolution });
    }

    public tier(
        resolution: OperationResolutionState,
        descriptor: OperationDescriptor,
        hasInterceptors: boolean
    ): "direct" | "mediated" {
        const directFloor = descriptor.impact === "observe" || descriptor.impact === "execute";
        return directFloor && resolution.placement.selected === "bundled" && !hasInterceptors
            ? "direct"
            : "mediated";
    }

    public authorizeDirect(
        resolution: OperationResolutionState,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[]
    ): ResolutionStamp | undefined {
        const at = this.now();
        const token = resolution.lease;
        if (
            token === undefined ||
            resolution.placement.selected !== "bundled" ||
            at.getTime() >= resolution.deadline.getTime() ||
            !sameBinding(this.state.currentBinding(resolution.binding.key), resolution.binding) ||
            !this.state.currentPath(resolution.binding).equals(resolution.pathEpochs) ||
            watermarkStale(
                this.state.currentWatermark(resolution.principal),
                resolution.pathEpochs
            ) ||
            this.state.currentLease(token)?.admits(token, at) !== true ||
            !this.state.admits(resolution, descriptor, inputs, at)
        ) {
            return undefined;
        }
        return new ResolutionStamp(
            resolution.principal,
            resolution.binding,
            resolution.pathEpochs,
            token,
            resolution.deadline,
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
            at.getTime() >= resolution.deadline.getTime() ||
            !sameBinding(this.state.currentBinding(resolution.binding.key), resolution.binding) ||
            !this.state.currentPath(resolution.binding).equals(resolution.pathEpochs) ||
            watermarkStale(
                this.state.currentWatermark(resolution.principal),
                resolution.pathEpochs
            ) ||
            (resolution.lease !== undefined &&
                this.state.currentLease(resolution.lease)?.admits(resolution.lease, at) !== true) ||
            !this.state.admits(resolution, descriptor, inputs, at)
        ) {
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
                              holder: authorization.lease.holder.value,
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

function requireResolution(resolution: OperationResolutionState, name: BindingName): void {
    if (
        !resolution.binding.name.equals(name) ||
        !resolution.watermark.holder.equals(resolution.principal) ||
        !resolution.watermark.owner.equals(resolution.owner) ||
        resolution.deadline.getTime() < resolution.resolvedAt.getTime() ||
        (resolution.lease === undefined) !== (resolution.originalLease === undefined) ||
        (resolution.lease === undefined) === (resolution.route === undefined)
    ) {
        throw denied("Authority resolver returned substituted resolution evidence");
    }
    if (
        resolution.lease !== undefined &&
        (resolution.originalLease?.expiresAt === undefined ||
            resolution.originalLease.admits(resolution.lease, resolution.resolvedAt) !== true ||
            resolution.deadline.getTime() > resolution.originalLease.expiresAt.getTime())
    ) {
        throw denied("Resolution deadline exceeds the original Turn lease");
    }
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
