import {
    BindingId,
    BindingRecord,
    GrantId,
    GrantRecord,
    ResolvedBinding,
    type AuthorityVerifier,
    type BindingAuthority,
    type BindingResolver,
    type FacetRegistry
} from "../authority";
import { FacetSet } from "../facets";
import type {
    BindingName,
    Facet,
    PromptContribution,
    SurfaceSet
} from "../facets";
import { OperationCatalog } from "../facets";
import { Revision } from "../record";

export class BindingSet implements AuthorityVerifier {
    public readonly bindings: readonly ResolvedBinding[];

    public constructor(bindings: readonly ResolvedBinding[]) {
        this.bindings = Object.freeze([...bindings]);
        this.ensureUniqueBindingNames();
    }

    public static empty(): BindingSet {
        return emptyBindingSet;
    }

    public static of(facets: readonly Facet[]): BindingSet {
        return new BindingSet(facets.map(bindingFromFacet));
    }

    public static fromFacets(facets: FacetSet): BindingSet {
        return BindingSet.of(facets.facets);
    }

    public static fromBindings(bindings: readonly ResolvedBinding[]): BindingSet {
        return new BindingSet(bindings);
    }

    public static async fromResolver(
        resolver: BindingResolver,
        registry: FacetRegistry
    ): Promise<BindingSet> {
        return BindingSet.fromBindings(await resolver.resolve(registry));
    }

    public get facets(): FacetSet {
        return FacetSet.of(this.bindings.map(binding => binding.facet));
    }

    public resolve(name: BindingName): Facet | undefined {
        const binding = this.resolveBinding(name);
        if (binding === undefined || !binding.live) {
            return undefined;
        }

        return binding.facet;
    }

    public resolveBinding(name: BindingName): ResolvedBinding | undefined {
        return this.bindings.find(binding => binding.name.equals(name));
    }

    public authorityFor(name: BindingName) {
        return this.resolveBinding(name)?.authority;
    }

    public permits(authority: BindingAuthority): boolean {
        const binding = this.bindings.find(candidate => candidate.id.equals(authority.bindingId));
        return binding !== undefined
            && binding.live
            && binding.authority.matches(authority);
    }

    public prompt(): PromptContribution {
        return this.facets.prompt();
    }

    public operations(): OperationCatalog {
        return this.bindings.reduce(
            (catalog, binding) => catalog.merge(binding.operations()),
            OperationCatalog.empty()
        );
    }

    public surfaces(): SurfaceSet {
        return this.facets.surfaces();
    }

    public merge(other: BindingSet): BindingSet {
        return BindingSet.fromBindings([
            ...this.bindings,
            ...other.bindings
        ]);
    }

    private ensureUniqueBindingNames(): void {
        const names = new Set<string>();

        for (const binding of this.bindings) {
            const name = binding.name.value;
            if (names.has(name)) {
                throw new TypeError("Runtime binding names must be unique");
            }

            names.add(name);
        }
    }
}

const emptyBindingSet = new BindingSet([]);

function bindingFromFacet(facet: Facet): ResolvedBinding {
    const revision = Revision.initial();
    const grant = new GrantRecord(
        new GrantId(`grant-${facet.id.value}`),
        facet.domain,
        "active",
        revision
    );

    return new ResolvedBinding(
        new BindingRecord(
            new BindingId(`binding-${facet.id.value}`),
            facet.name,
            grant.id,
            revision
        ),
        grant,
        facet
    );
}
