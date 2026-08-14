import type {
    BindingName,
    FacetPackageId,
    FacetRef,
    OperationDescriptor,
    OperationName
} from "../facets";
import { AgentCoreError } from "../errors";
import {
    OperationGateway,
    ResolvedFacet,
    type OperationDispatchResult,
    type OperationRequest
} from "./gateway";

/** Owns every resolved capability acquired through one execution scope. */
export class ResolvedFacetScope implements Disposable {
    readonly #facets = new Set<ScopedResolvedFacet>();
    readonly #onAbort: () => void;
    #disposed = false;

    public constructor(
        private readonly gateway: OperationGateway,
        private readonly signal: AbortSignal
    ) {
        this.#onAbort = () => this[Symbol.dispose]();
        if (signal.aborted) this.#disposed = true;
        else signal.addEventListener("abort", this.#onAbort, { once: true });
    }

    public async resolve(binding: BindingName): Promise<ResolvedFacet> {
        this.requireActive();
        let resolved: ResolvedFacet;
        try {
            resolved = await this.gateway.resolve(binding);
        } catch (error) {
            if (isAuthorityDenied(error)) this[Symbol.dispose]();
            throw error;
        }
        if (this.#disposed) {
            resolved[Symbol.dispose]();
            throw inactive("Resolved Facet scope is disposed");
        }
        const scoped = new ScopedResolvedFacet(
            resolved,
            () => this.#facets.delete(scoped),
            () => this[Symbol.dispose]()
        );
        this.#facets.add(scoped);
        return scoped;
    }

    public [Symbol.dispose](): void {
        if (this.#disposed) return;
        this.#disposed = true;
        this.signal.removeEventListener("abort", this.#onAbort);
        const facets = [...this.#facets].reverse();
        this.#facets.clear();
        for (const facet of facets) facet.disposeFromScope();
    }

    private requireActive(): void {
        if (this.#disposed) throw inactive("Resolved Facet scope is disposed");
    }
}

class ScopedResolvedFacet extends ResolvedFacet {
    #disposed = false;

    public constructor(
        private readonly resolved: ResolvedFacet,
        private readonly release: () => void,
        private readonly authorityDenied: () => void
    ) {
        super();
    }

    public get facet(): FacetRef {
        this.requireActive();
        return this.resolved.facet;
    }

    public get package(): FacetPackageId {
        this.requireActive();
        return this.resolved.package;
    }

    public descriptor(name: OperationName): OperationDescriptor | undefined {
        this.requireActive();
        return this.resolved.descriptor(name);
    }

    public async dispatch(request: OperationRequest): Promise<OperationDispatchResult> {
        this.requireActive();
        try {
            return await this.resolved.dispatch(request);
        } catch (error) {
            if (isAuthorityDenied(error)) this.authorityDenied();
            throw error;
        }
    }

    public [Symbol.dispose](): void {
        if (!this.close()) return;
        this.release();
    }

    public disposeFromScope(): void {
        this.close();
    }

    private close(): boolean {
        if (this.#disposed) return false;
        this.#disposed = true;
        this.resolved[Symbol.dispose]();
        return true;
    }

    private requireActive(): void {
        if (this.#disposed) throw inactive("Resolved Facet is disposed");
    }
}

function inactive(message: string): AgentCoreError {
    return new AgentCoreError("facet.inactive", message);
}

function isAuthorityDenied(error: unknown): error is AgentCoreError {
    return error instanceof AgentCoreError && error.code === "authority.denied";
}
