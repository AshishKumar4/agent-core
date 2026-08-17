import { requireSynchronousResult } from "../actors";
import { Digest, encodeCanonicalJson, isObjectRecord } from "../core";
import { AgentCoreError } from "../errors";
import {
    InterceptorDeclaration,
    SlotName,
    canonicalFacetData,
    type FacetData,
    type FacetRef,
    type OperationPattern,
    type ProtectionDomain
} from "../facets";
import type { FacetRuntimeHost } from "./lifecycle";
import type { ValidatedFacet } from "./correspondence";
import type { InterceptContext, InterceptResult, Interceptor, Operation } from "./runtime";

export interface InterceptorTrace {
    readonly itemIndex: number;
    readonly interceptor: string;
    readonly contributor: string;
    readonly cutPoint: "operation.before" | "operation.after";
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
        cutPoint: "operation.before" | "operation.after",
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
            const context: InterceptContext = Object.freeze({
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
        cutPoint: "operation.before" | "operation.after",
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
                this.requireSameDomain(domain, facet.ref, declaration);
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
        return candidates.sort(
            (left, right) =>
                left.declaration.modeRank - right.declaration.modeRank ||
                left.declaration.priority - right.declaration.priority ||
                compareText(left.facet.manifest.id.value, right.facet.manifest.id.value) ||
                compareText(left.declaration.id.value, right.declaration.id.value)
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
    private requireSameDomain(
        domain: ProtectionDomain,
        contributor: FacetRef,
        declaration: InterceptorDeclaration
    ): void {
        const contributed = this.authority.contributorDomain(contributor);
        if (contributed === undefined || !contributed.equals(domain)) {
            throw new AgentCoreError(
                "authority.denied",
                `Interceptor ${declaration.id.value} is contributed from another protection domain`
            );
        }
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

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

const interceptorSlot = new SlotName("interceptors");
