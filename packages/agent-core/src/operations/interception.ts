import { requireSynchronousResult } from "../actors";
import { Digest, compareCanonicalText, encodeCanonicalJson, isObjectRecord } from "../core";
import { AgentCoreError } from "../errors";
import type { TurnId } from "../execution-references";
import {
    InterceptorDeclaration,
    SlotName,
    canonicalFacetData,
    type FacetData,
    type FacetRef,
    type OperationCutPoint,
    type OperationPattern,
    type ProtectionDomain,
    type TurnBoundCutPoint
} from "../facets";
import type { FacetRuntimeHost } from "./lifecycle";
import type { ValidatedFacet } from "./correspondence";
import type {
    InterceptResult,
    Interceptor,
    Operation,
    OperationInterceptContext,
    TurnInterceptContext
} from "./runtime";

export interface InterceptorTrace {
    readonly itemIndex: number;
    readonly interceptor: string;
    readonly contributor: string;
    readonly cutPoint: OperationCutPoint;
    readonly before: Digest;
    readonly after: Digest;
    readonly outcome: "unchanged" | "rewritten";
}

export interface InterceptionResult {
    readonly value: FacetData;
    readonly traces: readonly InterceptorTrace[];
}

export interface InterceptorAuthorityPort<Resolution> {
    /** The protection domain this dispatch — and so every cut point in it — runs in. */
    cutPointDomain(resolution: Resolution): ProtectionDomain;
    /**
     * The protection domain the contributing Facet's code runs in, or undefined when the
     * Facet is placed in no domain this host can name.
     */
    contributorDomain(contributor: FacetRef): ProtectionDomain | undefined;
    allowsInterception(
        resolution: Resolution,
        contributor: FacetRef,
        declaration: InterceptorDeclaration,
        target: FacetRef,
        operation: Operation["descriptor"]
    ): boolean;
}

export class OperationInterceptorRunner<Resolution> {
    public constructor(
        private readonly host: FacetRuntimeHost,
        private readonly authority: InterceptorAuthorityPort<Resolution>
    ) {}

    public hasApplicable(
        resolution: Resolution,
        target: ValidatedFacet,
        operation: Operation
    ): boolean {
        return (
            this.candidates("operation.before", resolution, target, operation).length > 0 ||
            this.candidates("operation.after", resolution, target, operation).length > 0
        );
    }

    public run(
        cutPoint: OperationCutPoint,
        resolution: Resolution,
        target: ValidatedFacet,
        operation: Operation,
        itemIndex: number,
        input: FacetData
    ): InterceptionResult {
        let value = canonicalFacetData(input);
        const traces: InterceptorTrace[] = [];
        for (const candidate of this.candidates(cutPoint, resolution, target, operation)) {
            const before = Digest.sha256(encodeCanonicalJson(value));
            const context: OperationInterceptContext = Object.freeze({
                cutPoint,
                operation: operation.descriptor,
                target: target.ref,
                interceptor: candidate.declaration
            });
            let result;
            try {
                result = requireSynchronousResult(candidate.interceptor.intercept(context, value));
            } catch (error) {
                const detail =
                    error instanceof Error ? error.message : "unknown interceptor failure";
                throw blocked(candidate.declaration, detail);
            }
            if (!isInterceptResult(result)) {
                throw blocked(candidate.declaration, "Interceptor returned an invalid result");
            }
            if (!result.proceed) throw new AgentCoreError("authority.denied", result.reason);
            const next = canonicalFacetData(result.value);
            const after = Digest.sha256(encodeCanonicalJson(next));
            if (candidate.declaration.mode === "gate" && !before.equals(after)) {
                throw blocked(
                    candidate.declaration,
                    "A gate interceptor rewrote the value in flight"
                );
            }
            traces.push(
                Object.freeze({
                    interceptor: candidate.declaration.id.value,
                    contributor: candidate.facet.ref.value,
                    itemIndex,
                    cutPoint,
                    before,
                    after,
                    outcome: before.equals(after) ? "unchanged" : "rewritten"
                })
            );
            value = next;
        }
        return Object.freeze({ value, traces: Object.freeze(traces) });
    }

    private candidates(
        cutPoint: OperationCutPoint,
        resolution: Resolution,
        target: ValidatedFacet,
        operation: Operation
    ): readonly RuntimeInterceptor[] {
        const candidates: RuntimeInterceptor[] = [];
        const domain = this.authority.cutPointDomain(resolution);
        for (const facet of this.host.facets()) {
            for (const value of facet.manifest.contributions.get(interceptorSlot) ?? []) {
                const declaration = InterceptorDeclaration.fromData(value);
                if (
                    declaration.cutPoint !== cutPoint ||
                    !matches(declaration.appliesTo.patterns, facet, target, operation)
                ) {
                    continue;
                }
                requireSameDomain(
                    domain,
                    this.authority.contributorDomain(facet.ref),
                    declaration
                );
                const own = facet.ref.equals(target.ref);
                if (!own) {
                    if (operation.descriptor.interceptable === undefined) {
                        throw new AgentCoreError(
                            "authority.denied",
                            `Operation ${operation.descriptor.name.value} is not interceptable`
                        );
                    }
                    if (
                        !this.authority.allowsInterception(
                            resolution,
                            facet.ref,
                            declaration,
                            target.ref,
                            operation.descriptor
                        )
                    ) {
                        throw new AgentCoreError(
                            "authority.denied",
                            `Interceptor ${declaration.id.value} lacks target authority`
                        );
                    }
                }
                const interceptor = facet.interceptor(declaration.id);
                if (interceptor === undefined) {
                    throw new AgentCoreError(
                        "facet.inactive",
                        `Interceptor ${declaration.id.value} is no longer active`
                    );
                }
                candidates.push({ facet, declaration, interceptor });
            }
        }
        return orderSchedule(candidates);
    }
}

/** One Turn-bound interception, attributed exactly as an operation one is (SPEC §4.4 rule 5). */
export interface TurnInterceptorTrace {
    readonly interceptor: string;
    readonly contributor: string;
    readonly cutPoint: TurnBoundCutPoint;
    readonly before: Digest;
    readonly after: Digest;
    readonly outcome: "unchanged" | "rewritten";
}

/**
 * A stop a `turn.step` gate requested: who requested it, and why. It is a refusal the Turn
 * acts on rather than a status the interceptor wrote, because an Interceptor holds no lease
 * and is no CommitWriter (§5.2), so it can end nothing itself.
 */
export interface TurnStopRequest {
    readonly interceptor: string;
    readonly contributor: string;
    readonly reason: string;
}

export interface TurnInterceptionResult {
    readonly value: FacetData;
    readonly traces: readonly TurnInterceptorTrace[];
    /** Present only when a `turn.step` gate requested a stop. */
    readonly stop: TurnStopRequest | undefined;
}

/**
 * Domain facts a Turn-bound cut point needs. There is no target Facet and no Operation
 * here, so rule 2's opt-in has nothing to scope and rule 1's protection domain is the
 * whole of the boundary: a Facet fires at a Turn's cut points because it was placed in
 * that Turn's domain, and for no other reason.
 */
export interface TurnInterceptorDomainPort {
    turnDomain(turn: TurnId): ProtectionDomain;
    contributorDomain(contributor: FacetRef): ProtectionDomain | undefined;
}

/**
 * What a rewrite at one cut point may do to the value in flight. It is applied to every
 * interceptor's answer rather than to the final value, because the clauses it enforces are
 * per-rewriter — a `turn.step` annotation must name the interceptor that appended it, and a
 * malformed answer must not reach the next interceptor as if it were well formed. Refusal
 * is a throw; the runner turns it into a scoped block naming that interceptor.
 */
export type TurnRewriteRule = (
    before: FacetData,
    after: FacetData,
    interceptor: InterceptorDeclaration
) => void;

/**
 * The seam the executor reaches the Turn-bound cut points through (SPEC §4.4, §5.6). It is
 * value-agnostic on purpose: the records a prompt section or a step context is made of
 * belong to the execution layer, so the projection to and from `FacetData` stays there and
 * this port carries only the schedule.
 */
export abstract class TurnCutPointPort {
    public abstract run(
        cutPoint: TurnBoundCutPoint,
        turn: TurnId,
        value: FacetData,
        admit: TurnRewriteRule
    ): TurnInterceptionResult;
}

export class TurnInterceptorRunner extends TurnCutPointPort {
    public constructor(
        private readonly host: FacetRuntimeHost,
        private readonly domains: TurnInterceptorDomainPort
    ) {
        super();
    }

    public override run(
        cutPoint: TurnBoundCutPoint,
        turn: TurnId,
        input: FacetData,
        admit: TurnRewriteRule
    ): TurnInterceptionResult {
        let value = canonicalFacetData(input);
        const traces: TurnInterceptorTrace[] = [];
        for (const candidate of this.candidates(cutPoint, turn)) {
            const before = Digest.sha256(encodeCanonicalJson(value));
            const context: TurnInterceptContext = Object.freeze({
                cutPoint,
                turn,
                interceptor: candidate.declaration
            });
            let result;
            try {
                result = requireSynchronousResult(candidate.interceptor.intercept(context, value));
            } catch (error) {
                const detail =
                    error instanceof Error ? error.message : "unknown interceptor failure";
                throw turnBlocked(candidate.declaration, cutPoint, detail);
            }
            if (!isInterceptResult(result)) {
                throw turnBlocked(
                    candidate.declaration,
                    cutPoint,
                    "Interceptor returned an invalid result"
                );
            }
            if (!result.proceed) {
                // §4.4 gives `turn.step` a *requested* stop and the other two an outright
                // block, and the difference is which side owns what happens next. A refused
                // submission never becomes durable and a refused prompt was never sent, so
                // there is nothing left to decide; a Turn that must still terminalize under
                // its own lease is the one case where the refusal has to be returned.
                if (cutPoint !== "turn.step") {
                    throw new AgentCoreError("authority.denied", result.reason);
                }
                return Object.freeze({
                    value,
                    traces: Object.freeze(traces),
                    stop: Object.freeze({
                        interceptor: candidate.declaration.id.value,
                        contributor: candidate.facet.ref.value,
                        reason: result.reason
                    })
                });
            }
            const next = canonicalFacetData(result.value);
            const after = Digest.sha256(encodeCanonicalJson(next));
            if (candidate.declaration.mode === "gate" && !before.equals(after)) {
                throw turnBlocked(
                    candidate.declaration,
                    cutPoint,
                    "A gate interceptor rewrote the value in flight"
                );
            }
            try {
                admit(value, next, candidate.declaration);
            } catch (error) {
                const detail = error instanceof Error ? error.message : "invalid rewrite";
                throw turnBlocked(candidate.declaration, cutPoint, detail);
            }
            traces.push(
                Object.freeze({
                    interceptor: candidate.declaration.id.value,
                    contributor: candidate.facet.ref.value,
                    cutPoint,
                    before,
                    after,
                    outcome: before.equals(after) ? "unchanged" : "rewritten"
                })
            );
            value = next;
        }
        return Object.freeze({ value, traces: Object.freeze(traces), stop: undefined });
    }

    private candidates(
        cutPoint: TurnBoundCutPoint,
        turn: TurnId
    ): readonly RuntimeInterceptor[] {
        const domain = this.domains.turnDomain(turn);
        const candidates: RuntimeInterceptor[] = [];
        for (const facet of this.host.facets()) {
            for (const value of facet.manifest.contributions.get(interceptorSlot) ?? []) {
                const declaration = InterceptorDeclaration.fromData(value);
                if (declaration.cutPoint !== cutPoint) continue;
                requireSameDomain(
                    domain,
                    this.domains.contributorDomain(facet.ref),
                    declaration
                );
                const interceptor = facet.interceptor(declaration.id);
                if (interceptor === undefined) {
                    throw new AgentCoreError(
                        "facet.inactive",
                        `Interceptor ${declaration.id.value} is no longer active`
                    );
                }
                candidates.push({ facet, declaration, interceptor });
            }
        }
        return orderSchedule(candidates);
    }
}

interface RuntimeInterceptor {
    readonly facet: ValidatedFacet;
    readonly declaration: InterceptorDeclaration;
    readonly interceptor: Interceptor;
}

function matches(
    patterns: readonly OperationPattern[],
    contributor: ValidatedFacet,
    target: ValidatedFacet,
    operation: Operation
): boolean {
    return patterns.some((pattern) => {
        const facetMatches =
            pattern.facet === undefined
                ? contributor.ref.equals(target.ref)
                : prefixMatches(pattern.facet.value, target.manifest.id.value);
        return facetMatches && prefixMatches(pattern.operation, operation.descriptor.name.value);
    });
}

function prefixMatches(pattern: string, value: string): boolean {
    return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

// A contributed Interceptor is third-party code, so its answer is checked rather than
// trusted: `result` carries the declared union's type without its guarantee.
function isInterceptResult(value: InterceptResult): boolean {
    return isObjectRecord(value) && (value["proceed"] === true || value["proceed"] === false);
}

function blocked(declaration: InterceptorDeclaration, detail: string): AgentCoreError {
    return new AgentCoreError(
        "authority.denied",
        `Interceptor ${declaration.id.value} blocked the operation: ${detail}`
    );
}

function turnBlocked(
    declaration: InterceptorDeclaration,
    cutPoint: TurnBoundCutPoint,
    detail: string
): AgentCoreError {
    return new AgentCoreError(
        "authority.denied",
        `Interceptor ${declaration.id.value} blocked ${cutPoint}: ${detail}`
    );
}

/**
 * SPEC §4.4 rule 3's total order, realized once for every cut point. The banded key is
 * ascending `(mode, priority, facetId, interceptorId)`, and `mode` dominates: sharing one
 * cut point between independently authored Facets does not mean sharing a numeric scale,
 * so a later contributor's priority must not be able to reorder a semantic decision. One
 * implementation is what makes the Turn-bound cut points ordered by the same relation the
 * operation ones are rather than by a second one that agrees today.
 */
function orderSchedule(candidates: RuntimeInterceptor[]): readonly RuntimeInterceptor[] {
    return candidates.sort(
        (left, right) =>
            left.declaration.modeRank - right.declaration.modeRank ||
            left.declaration.priority - right.declaration.priority ||
            compareCanonicalText(left.facet.manifest.id.value, right.facet.manifest.id.value) ||
            compareCanonicalText(left.declaration.id.value, right.declaration.id.value)
    );
}

/**
 * SPEC §4.4 rule 1: an Interceptor is a synchronous in-process hook, so it may only
 * run where its contributing Facet's own code runs. A contributor placed in another
 * protection domain — `provider` behind a stub, `dynamic` in a fresh isolate — has
 * nothing in this process to call, and reaching whatever the stub exposes would run
 * the wrong code inside the cut point's domain. The refusal is not an authority
 * answer: rule 2 makes sharing a domain confer no interception rights, and holding
 * a Grant confers no domain, so the two are decided separately. Crossing a domain
 * is what asynchronous Events are for.
 *
 * Skipping instead of refusing would silently drop a veto the platform declared,
 * which is the one failure this hook exists to prevent.
 */
function requireSameDomain(
    domain: ProtectionDomain,
    contributed: ProtectionDomain | undefined,
    declaration: InterceptorDeclaration
): void {
    if (contributed === undefined || !contributed.equals(domain)) {
        throw new AgentCoreError(
            "authority.denied",
            `Interceptor ${declaration.id.value} is contributed from another protection domain`
        );
    }
}

const interceptorSlot = new SlotName("interceptors");
