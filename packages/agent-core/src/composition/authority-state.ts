import type { ActorRef } from "../actors";
import type { Binding, InvalidationWatermarkStore } from "../authority";
import {
    InvalidationWatermark,
    PathEpochEvidence,
    watermarkKey,
    type ScopeEpoch
} from "../authority";
import { encodeCanonicalJson } from "../core";
import { AgentCoreError } from "../errors";
import type {
    BindingName,
    FacetData,
    FacetRef,
    InterceptorDeclaration,
    OperationDescriptor,
    ProtectionDomain
} from "../facets";
import type { PrincipalRef, TenantId } from "../identity";
import type { AuditRecord, PreEffectReceipt } from "../invocations";
import type { TurnLease } from "../agents";
import type { LeaseToken } from "../protocol";
import type {
    OperationAuthorityStatePort,
    OperationResolutionCandidate,
    OperationResolutionState
} from "./authority";

/**
 * The host-specific inputs an Actor's authority state composes: how resolution
 * candidates are built from materialized Bindings, where the current Turn lease
 * lives, which policy admits an operation, and how a denial persists. Each is a
 * real boundary — everything the §3.4 rules constrain stays in the state
 * service itself.
 */
export interface ActorAuthorityHost {
    resolve(caller: PrincipalRef, binding: BindingName): OperationResolutionCandidate | undefined;
    currentBinding(key: string): Binding | undefined;
    currentPath(binding: Binding): PathEpochEvidence;
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
    /**
     * Persist the deniedPreEffect Receipt and its AuditRecord in the SAME Actor
     * transaction that advanced the watermark. Called at most once per stale
     * observation; must not create an EffectAttempt.
     */
    appendDenial(receipt: PreEffectReceipt, audit: AuditRecord): void;
    denialEvidence(
        resolution: OperationResolutionState,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[]
    ): { readonly receipt: PreEffectReceipt; readonly audit: AuditRecord };
    transaction<Result>(operation: () => Result): Result;
}

/**
 * Production Actor-local authority state (§3.4 rules 6–8). One durable
 * per-holder watermark store backs BOTH invalidation delivery and mediated
 * stale observation; a stale observation atomically joins the current path
 * epochs into the holder watermark, invalidates the cached resolution, and
 * persists the deniedPreEffect evidence with no EffectAttempt — all in one
 * Actor transaction, so a rollback leaves no partial denial. The resolution
 * cache itself is scoped to the exact current Turn lease (rule 8): a cache
 * hit revalidates its candidate's LeaseToken against the host's live lease
 * state, so a `bundled` resolution cannot outlive its Turn merely because
 * nothing happened to look it up again in the meantime.
 */
export class ActorAuthorityState implements OperationAuthorityStatePort<PrincipalRef> {
    readonly #cache = new Map<string, OperationResolutionCandidate>();

    public constructor(
        private readonly tenant: TenantId,
        private readonly owner: ActorRef,
        private readonly watermarks: InvalidationWatermarkStore,
        private readonly host: ActorAuthorityHost,
        private readonly now: () => Date
    ) {}

    public resolve(
        caller: PrincipalRef,
        binding: BindingName
    ): OperationResolutionCandidate | undefined {
        if (!caller.tenantId.equals(this.tenant)) return undefined;
        const key = resolutionCacheKey(caller, binding);
        const cached = this.#cache.get(key);
        if (cached !== undefined) {
            if (this.matches(caller, binding, cached)) return cached;
            this.#cache.delete(key);
            return undefined;
        }
        const candidate = this.host.resolve(caller, binding);
        if (candidate === undefined || !this.matches(caller, binding, candidate)) return undefined;
        this.#cache.set(key, candidate);
        return candidate;
    }

    public currentBinding(key: string): Binding | undefined {
        return this.host.currentBinding(key);
    }

    public currentPath(binding: Binding): PathEpochEvidence {
        return this.host.currentPath(binding);
    }

    public currentWatermark(principal: PrincipalRef): InvalidationWatermark {
        const empty = InvalidationWatermark.empty(this.tenant, this.owner, principal);
        return this.watermarks.load(watermarkKey(empty)) ?? empty;
    }

    public currentLease(token: LeaseToken): TurnLease | undefined {
        return this.host.currentLease(token);
    }

    public admits(
        resolution: OperationResolutionState,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[],
        at: Date
    ): boolean {
        return this.host.admits(resolution, descriptor, inputs, at);
    }

    public contributorDomain(facet: FacetRef): ProtectionDomain | undefined {
        return this.host.contributorDomain(facet);
    }

    public admitsInterception(
        resolution: OperationResolutionState,
        contributor: FacetRef,
        declaration: InterceptorDeclaration,
        descriptor: OperationDescriptor
    ): boolean {
        return this.host.admitsInterception(resolution, contributor, declaration, descriptor);
    }

    public release(resolution: OperationResolutionState): void {
        this.invalidate(resolution.principal, resolution.binding.name);
    }

    /**
     * Invalidation delivery (§3.4 rule 6): join delivered Scope epochs into the
     * holder's watermark. Delivery and stale observation share the one store, so
     * a delivered higher epoch immediately ends direct authorization for every
     * cached resolution whose path it dominates.
     */
    public deliverInvalidation(
        principal: PrincipalRef,
        entries: readonly ScopeEpoch[]
    ): InvalidationWatermark {
        if (entries.length === 0) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Invalidation delivery requires at least one Scope epoch"
            );
        }
        return this.host.transaction(() => {
            const joined = this.join(principal, entries);
            this.#cache.clear();
            return joined;
        });
    }

    public observeStale(
        resolution: OperationResolutionState,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[]
    ): void {
        this.host.transaction(() => {
            this.join(resolution.principal, this.host.currentPath(resolution.binding).path);
            this.invalidate(resolution.principal, resolution.binding.name);
            const evidence = this.host.denialEvidence(resolution, descriptor, inputs);
            if (evidence.receipt.outcome !== "deniedPreEffect") {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Stale observation must record a deniedPreEffect Receipt"
                );
            }
            this.host.appendDenial(evidence.receipt, evidence.audit);
        });
    }

    private join(principal: PrincipalRef, entries: readonly ScopeEpoch[]): InvalidationWatermark {
        const empty = InvalidationWatermark.empty(this.tenant, this.owner, principal);
        const stored = this.watermarks.load(watermarkKey(empty));
        const current = stored ?? empty;
        const joined = current.join(entries);
        // A holder's first record establishes revision zero before any join can
        // advance it; an unchanged join persists nothing.
        if (stored === undefined) this.watermarks.save(current);
        if (joined !== current) this.watermarks.save(joined);
        return joined;
    }

    private invalidate(principal: PrincipalRef, binding: BindingName): void {
        this.#cache.delete(resolutionCacheKey(principal, binding));
    }

    private matches(
        caller: PrincipalRef,
        name: BindingName,
        candidate: OperationResolutionCandidate
    ): boolean {
        return (
            candidate.principal.tenantId.equals(this.tenant) &&
            candidate.principal.principalId.equals(caller.principalId) &&
            candidate.binding.name.equals(name) &&
            candidate.binding.scope.tenantId.equals(this.tenant) &&
            candidate.binding.scope.equals(candidate.pathEpochs.target.scope) &&
            candidate.watermark.ownerTenant.equals(this.tenant) &&
            this.leaseCurrent(candidate)
        );
    }

    /**
     * SPEC §3.4 rule 8: a `bundled` resolution lasts no longer than its exact Turn and
     * deadline. A cached candidate stores the LeaseToken observed when it was built, so
     * without this check a cache hit could keep serving that Turn's authority after the
     * Turn fenced, was reclaimed by another holder, or expired — every later lookup would
     * have to be caught by unrelated downstream checks instead of by the cache's own
     * lifetime. This asks the host for the *current* lease behind the exact token the
     * candidate carries, so fencing, reclaiming, or completing that Turn invalidates the
     * cache entry immediately rather than only at the next `authorizeDirect` call. A
     * candidate with no lease (route-based, no-Turn mediation) has nothing to expire here.
     */
    private leaseCurrent(candidate: OperationResolutionCandidate): boolean {
        if (candidate.lease === undefined) return true;
        return this.host.currentLease(candidate.lease)?.admits(candidate.lease, this.now()) === true;
    }
}

const cacheKeyDecoder = new TextDecoder("utf-8", { fatal: true });

function resolutionCacheKey(caller: PrincipalRef, binding: BindingName): string {
    return cacheKeyDecoder.decode(
        encodeCanonicalJson([caller.tenantId.value, caller.principalId.value, binding.value])
    );
}
