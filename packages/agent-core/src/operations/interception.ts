import { requireSynchronousResult } from "../actors";
import { Digest, encodeCanonicalJson } from "../core";
import { AgentCoreError } from "../errors";
import {
    InterceptorDeclaration,
    SlotName,
    canonicalFacetData,
    type FacetData,
    type FacetRef,
    type OperationPattern
} from "../facets";
import type { FacetRuntimeHost } from "./lifecycle";
import type { ValidatedFacet } from "./correspondence";
import type { InterceptContext, Interceptor, Operation } from "./runtime";

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
                throw blocked(candidate.declaration, error);
            }
            if (
                typeof result !== "object" ||
                result === null ||
                typeof result.proceed !== "boolean"
            ) {
                throw blocked(
                    candidate.declaration,
                    new TypeError("Interceptor returned an invalid result")
                );
            }
            if (!result.proceed) throw new AgentCoreError("authority.denied", result.reason);
            const next = canonicalFacetData(result.value);
            const after = Digest.sha256(encodeCanonicalJson(next));
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
        for (const facet of this.host.facets()) {
            for (const value of facet.manifest.contributions.get(interceptorSlot) ?? []) {
                const declaration = InterceptorDeclaration.fromData(value);
                if (
                    declaration.cutPoint !== cutPoint ||
                    !matches(declaration.appliesTo.patterns, facet, target, operation)
                ) {
                    continue;
                }
                const own = facet.ref.equals(target.ref);
                if (!own) {
                    if (!operation.descriptor.interceptable) {
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
                const interceptor = facet.interceptor(declaration.id)!;
                candidates.push({ facet, declaration, interceptor });
            }
        }
        return candidates.sort(
            (left, right) =>
                left.declaration.priority - right.declaration.priority ||
                compareText(left.facet.manifest.id.value, right.facet.manifest.id.value) ||
                compareText(left.declaration.id.value, right.declaration.id.value)
        );
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

function blocked(declaration: InterceptorDeclaration, cause: unknown): AgentCoreError {
    const detail = cause instanceof Error ? cause.message : "unknown interceptor failure";
    return new AgentCoreError(
        "authority.denied",
        `Interceptor ${declaration.id.value} blocked the operation: ${detail}`
    );
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

const interceptorSlot = new SlotName("interceptors");
