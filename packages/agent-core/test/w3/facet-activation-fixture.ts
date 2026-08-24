import {
    Contributions,
    Facet,
    FacetManifest,
    type FacetLifecycleContext,
    type FacetRef,
    type Interceptor,
    type InterceptorDeclaration,
    type Operation,
    type OperationName,
    type Surface,
    type SurfaceId
} from "../../src/facets";
import { CompatRange, SemVer } from "../../src/core";

/**
 * A Facet whose `start` runs exactly the caller's materialization body, so an activation
 * test decides for itself whether the body commits, throws after committing, or does
 * nothing.
 */
export function activationFacet(ref: FacetRef, start: () => void): Facet {
    return new ActivationFacet(ref, start);
}

class ActivationFacet extends Facet {
    public readonly manifest: FacetManifest;

    public constructor(
        public readonly ref: FacetRef,
        private readonly body: () => void
    ) {
        super();
        this.manifest = new FacetManifest({
            id: ref.packageId,
            version: new SemVer("1.0.0"),
            compat: new CompatRange("^1.0.0", "^1.0.0"),
            isolation: ["dynamic"],
            bindings: [],
            contributions: new Contributions([])
        });
    }

    public operation(_name: OperationName): Operation | undefined {
        return undefined;
    }

    public surface(_id: SurfaceId): Surface | undefined {
        return undefined;
    }

    public interceptor(_id: InterceptorDeclaration["id"]): Interceptor | undefined {
        return undefined;
    }

    public children(): readonly Facet[] {
        return [];
    }

    public async start(_context: FacetLifecycleContext): Promise<void> {
        this.body();
    }

    public async stop(_context: FacetLifecycleContext): Promise<void> {}
}
