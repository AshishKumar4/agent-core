import { describe, expect, test } from "vitest";
import { CompatRange, SemVer, canonicalTupleKey } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import {
    BindingName,
    BindingRequirement,
    Contributions,
    Facet,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    type FacetLifecycleContext,
    type Interceptor,
    type InterceptorDeclaration,
    type Operation,
    type OperationName,
    type Surface,
    type SurfaceId
} from "../../src/facets";
import { FacetCorrespondenceValidator } from "../../src/operations/correspondence";
import {
    FacetRequirementResolver,
    FacetRuntimeHost,
    FailClosedFacetRequirementResolver
} from "../../src/operations/lifecycle";
import { activationFacet } from "../w3/facet-activation-fixture";

const version = new SemVer("1.0.0");
const compat = new CompatRange("^1.0.0", "^1.0.0");

interface FacetInit {
    readonly ref: string;
    readonly requires?: readonly BindingRequirement[];
    readonly children?: readonly Facet[];
    readonly start?: () => void;
    readonly stop?: () => void;
}

/**
 * A Facet whose manifest declares exactly the requirements a case needs, with the child tree
 * and lifecycle bodies it supplies. `test/w3/facet-activation-fixture.ts` cannot serve here:
 * its manifest declares no Binding requirement and it has no children.
 */
class RequiringFacet extends Facet {
    public readonly ref: FacetRef;
    public readonly manifest: FacetManifest;
    readonly #children: readonly Facet[];
    readonly #start: () => void;
    readonly #stop: () => void;

    public constructor(init: FacetInit) {
        super();
        this.ref = new FacetRef(init.ref);
        this.manifest = new FacetManifest({
            id: this.ref.packageId,
            version,
            compat,
            isolation: ["dynamic"],
            bindings: init.requires ?? [],
            contributions: new Contributions([])
        });
        this.#children = init.children ?? [];
        this.#start = init.start ?? (() => undefined);
        this.#stop = init.stop ?? (() => undefined);
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
        return this.#children;
    }

    public async start(_context: FacetLifecycleContext): Promise<void> {
        this.#start();
    }

    public async stop(_context: FacetLifecycleContext): Promise<void> {
        this.#stop();
    }
}

/**
 * Binding resolution as §3.4 answers it: one exact provider `FacetRef` per (dependent, Binding
 * name) pair, and nothing at all for a pair no Binding covers. Two dependents may hold the
 * same Binding name against different providers, which is the case reliance has to keep apart.
 */
class BoundRequirementResolver extends FacetRequirementResolver {
    readonly #bound = new Map<string, FacetRef>();

    public bind(dependent: FacetRef, name: string, provider: FacetRef): this {
        this.#bound.set(`${dependent.value}|${name}`, provider);
        return this;
    }

    public resolve(dependent: FacetRef, requirement: BindingRequirement): FacetRef | undefined {
        return this.#bound.get(`${dependent.value}|${requirement.name.value}`);
    }
}

function requirement(name: string, facet: string): BindingRequirement {
    return new BindingRequirement(new BindingName(name), new FacetPackageId(facet), compat);
}

/** Pins every manifest the activation installs, children included. */
function hostOf(resolver: FacetRequirementResolver, roots: readonly Facet[]): FacetRuntimeHost {
    const manifests: FacetManifest[] = [];
    const visit = (facet: Facet): void => {
        manifests.push(facet.manifest);
        for (const child of facet.children()) visit(child);
    };
    for (const root of roots) visit(root);
    return new FacetRuntimeHost(manifests, roots, new FacetCorrespondenceValidator(), resolver);
}

function refs(facets: readonly FacetRef[]): readonly string[] {
    return facets.map((ref) => ref.value);
}

describe("W3 Facet dependency order", () => {
    test(
        "[C13-FACET-DEPENDENCY-ORDER] never starts a Facet whose requirement no Binding satisfies",
        { tags: "p0" },
        async () => {
            const started: string[] = [];
            const provider = new RequiringFacet({
                ref: "acme.provider:alpha",
                start: () => started.push("provider")
            });
            const dependent = new RequiringFacet({
                ref: "acme.dependent:main",
                requires: [requirement("capability", "acme.provider")],
                start: () => started.push("dependent")
            });
            const host = hostOf(new BoundRequirementResolver(), [provider, dependent]);

            await expect(host.activate()).rejects.toMatchObject({
                code: "binding.invalid",
                message:
                    'Facet requirement ["agent-core.facet.rejected-install.v1",' +
                    '"acme.dependent:main","capability","acme.provider",null] ' +
                    "is a rejected install: no Binding satisfies it"
            });
            expect(started).toEqual([]);
            expect(host.active).toBe(false);
            expect(host.relianceOf(dependent.ref)).toEqual([]);
            expect(host.reliedUponBy(provider.ref)).toEqual([]);
        }
    );

    test(
        "[C13-FACET-DEPENDENCY-ORDER] starts no Facet at all when one requirement is unresolved",
        { tags: "p0" },
        async () => {
            const started: string[] = [];
            const provider = new RequiringFacet({
                ref: "acme.provider:alpha",
                start: () => started.push("provider")
            });
            const resolved = new RequiringFacet({
                ref: "acme.dependent:main",
                requires: [requirement("capability", "acme.provider")],
                start: () => started.push("resolved")
            });
            const unresolved = new RequiringFacet({
                ref: "acme.observer:main",
                requires: [requirement("capability", "acme.provider")],
                start: () => started.push("unresolved")
            });
            const resolver = new BoundRequirementResolver().bind(
                resolved.ref,
                "capability",
                provider.ref
            );
            const host = hostOf(resolver, [provider, resolved, unresolved]);

            await expect(host.activate()).rejects.toMatchObject({ code: "binding.invalid" });
            expect(started).toEqual([]);
            expect(host.facets()).toEqual([]);
            expect(host.relianceOf(resolved.ref)).toEqual([]);
            expect(host.reliedUponBy(provider.ref)).toEqual([]);
        }
    );

    test(
        "[C13-FACET-DEPENDENCY-ORDER] records reliance on the exact provider the requirement reached",
        { tags: "p1" },
        async () => {
            const started: string[] = [];
            const provider = new RequiringFacet({
                ref: "acme.provider:alpha",
                start: () => started.push("provider")
            });
            const dependent = new RequiringFacet({
                ref: "acme.dependent:main",
                requires: [requirement("capability", "acme.provider")],
                start: () => started.push("dependent")
            });
            const resolver = new BoundRequirementResolver().bind(
                dependent.ref,
                "capability",
                provider.ref
            );
            const host = hostOf(resolver, [provider, dependent]);

            await host.activate();

            expect(started).toEqual(["provider", "dependent"]);
            expect(refs(host.relianceOf(dependent.ref))).toEqual(["acme.provider:alpha"]);
            expect(refs(host.reliedUponBy(provider.ref))).toEqual(["acme.dependent:main"]);
            expect(host.relianceOf(provider.ref)).toEqual([]);
            expect(host.reliedUponBy(dependent.ref)).toEqual([]);
        }
    );

    test(
        "[C13-FACET-DEPENDENCY-ORDER] a second Facet answering the same Binding name neither satisfies nor discharges",
        { tags: "p0" },
        async () => {
            // Two Facets cannot share one FacetPackageId in one activation — correspondence
            // refuses two manifests of one package — so the second provider carries its own
            // package id at the same compatible version. Both are bound to the same Binding
            // name, which is the only way the SPEC's "same capability" case is representable.
            const held = requirement("capability", "acme.provider");
            const mirrored = requirement("capability", "acme.provider-mirror");
            expect(held.name.equals(mirrored.name)).toBe(true);
            expect(mirrored.compat.spec).toBe(held.compat.spec);

            const started: string[] = [];
            const alpha = new RequiringFacet({
                ref: "acme.provider:alpha",
                start: () => started.push("alpha")
            });
            const beta = new RequiringFacet({
                ref: "acme.provider-mirror:beta",
                start: () => started.push("beta")
            });
            const dependent = new RequiringFacet({
                ref: "acme.dependent:main",
                requires: [held],
                start: () => started.push("dependent")
            });
            const observer = new RequiringFacet({
                ref: "acme.observer:main",
                requires: [mirrored],
                start: () => started.push("observer")
            });
            const roots = [alpha, beta, dependent, observer];

            const unsatisfied = new BoundRequirementResolver().bind(
                observer.ref,
                "capability",
                beta.ref
            );
            const refused = hostOf(unsatisfied, roots);
            await expect(refused.activate()).rejects.toMatchObject({ code: "binding.invalid" });
            expect(started).toEqual([]);

            const resolver = new BoundRequirementResolver()
                .bind(dependent.ref, "capability", alpha.ref)
                .bind(observer.ref, "capability", beta.ref);
            const host = hostOf(resolver, roots);
            await host.activate();

            expect(started).toEqual(["alpha", "beta", "dependent", "observer"]);
            expect(refs(host.relianceOf(dependent.ref))).toEqual(["acme.provider:alpha"]);
            expect(refs(host.relianceOf(observer.ref))).toEqual(["acme.provider-mirror:beta"]);
            expect(refs(host.reliedUponBy(alpha.ref))).toEqual(["acme.dependent:main"]);
            expect(refs(host.reliedUponBy(beta.ref))).toEqual(["acme.observer:main"]);
        }
    );

    test(
        "[C13-FACET-DEPENDENCY-ORDER] holds a provider by resolved requirements, not by the child tree",
        { tags: "p1" },
        async () => {
            const aux = new RequiringFacet({ ref: "acme.other:aux" });
            const child = new RequiringFacet({
                ref: "acme.child:leaf",
                requires: [requirement("aux", "acme.other")]
            });
            const parent = new RequiringFacet({ ref: "acme.parent:root", children: [child] });
            const consumer = new RequiringFacet({
                ref: "acme.consumer:main",
                requires: [requirement("parent", "acme.parent")]
            });
            const resolver = new BoundRequirementResolver()
                .bind(child.ref, "aux", aux.ref)
                .bind(consumer.ref, "parent", parent.ref);
            const host = hostOf(resolver, [aux, parent, consumer]);

            await host.activate();

            expect(refs(host.relianceOf(child.ref))).toEqual(["acme.other:aux"]);
            expect(refs(host.reliedUponBy(parent.ref))).toEqual(["acme.consumer:main"]);
            expect(refs(host.reliedUponBy(aux.ref))).toEqual(["acme.child:leaf"]);
            expect(host.relianceOf(parent.ref)).toEqual([]);
        }
    );

    test(
        "[C13-FACET-DEPENDENCY-ORDER] keeps a stopping Facet's provider resolved for the whole of its stop",
        { tags: "p1" },
        async () => {
            const stopped: string[] = [];
            const observations: {
                readonly providers: readonly string[];
                readonly dependents: readonly string[];
                readonly installed: boolean;
            }[] = [];
            let observe: () => void = () => undefined;
            const dependent = new RequiringFacet({
                ref: "acme.dependent:main",
                requires: [requirement("capability", "acme.provider")],
                stop: () => {
                    stopped.push("dependent");
                    observe();
                }
            });
            const provider = new RequiringFacet({
                ref: "acme.provider:alpha",
                stop: () => stopped.push("provider")
            });
            const resolver = new BoundRequirementResolver().bind(
                dependent.ref,
                "capability",
                provider.ref
            );
            // Roots in this order stop the provider first, so the dependent has to still reach a
            // provider that has already departed.
            const host = hostOf(resolver, [dependent, provider]);
            observe = () => {
                observations.push({
                    providers: refs(host.relianceOf(dependent.ref)),
                    dependents: refs(host.reliedUponBy(provider.ref)),
                    installed: host.facets().some((facet) => facet.ref.equals(provider.ref))
                });
            };

            await host.activate();
            await host.dispose();

            expect(stopped).toEqual(["provider", "dependent"]);
            expect(observations).toEqual([
                {
                    providers: ["acme.provider:alpha"],
                    dependents: ["acme.dependent:main"],
                    installed: true
                }
            ]);
            expect(host.relianceOf(dependent.ref)).toEqual([]);
            expect(host.reliedUponBy(provider.ref)).toEqual([]);
        }
    );

    test(
        "[C13-FACET-DEPENDENCY-ORDER] activates a Facet declaring no requirement against the fail-closed default",
        { tags: "p0" },
        async () => {
            let started = 0;
            const idle = activationFacet(new FacetRef("workspace:idle"), () => {
                started += 1;
            });
            const host = new FacetRuntimeHost([idle.manifest], [idle]);

            await host.activate();

            expect(host.active).toBe(true);
            expect(started).toBe(1);
            expect(host.relianceOf(idle.ref)).toEqual([]);
            await host.dispose();

            const requiring = new RequiringFacet({
                ref: "acme.dependent:main",
                requires: [requirement("capability", "acme.provider")],
                start: () => {
                    started += 1;
                }
            });
            const refused = new FacetRuntimeHost([requiring.manifest], [requiring]);

            await expect(refused.activate()).rejects.toMatchObject({ code: "binding.invalid" });
            expect(started).toBe(1);
            expect(new FailClosedFacetRequirementResolver().resolve()).toBeUndefined();
        }
    );
    test(
        "[C13-FACET-DEPENDENCY-ORDER] identifies a rejected install by an injective tuple, not by concatenation",
        { tags: "p1" },
        async () => {
            // The refusal names four ids. Canonical JSON keeps their boundaries, so no two
            // different rejections can spell the same identity; a delimiter join could.
            const naive = (parts: readonly string[]): string => parts.join(",");
            const left = ["dependent,capability", "acme.provider"];
            const right = ["dependent", "capability,acme.provider"];
            expect(naive(left)).toBe(naive(right));
            expect(canonicalTupleKey("agent-core.facet.rejected-install.v1", left)).not.toBe(
                canonicalTupleKey("agent-core.facet.rejected-install.v1", right)
            );

            // And the seam spends that identity rather than interpolated text: two
            // activations differing in exactly one component refuse distinguishably.
            const refusals: string[] = [];
            for (const facet of ["acme.provider", "acme.other"]) {
                const dependent = new RequiringFacet({
                    ref: "acme.dependent:main",
                    requires: [requirement("capability", facet)]
                });
                refusals.push(
                    await refusalMessage(hostOf(new BoundRequirementResolver(), [dependent]))
                );
            }
            expect(refusals[0]).not.toBe(refusals[1]);
            expect(new Set(refusals).size).toBe(2);
        }
    );
});

/** The refusal one rejected activation reports, so a test can compare two of them. */
async function refusalMessage(host: FacetRuntimeHost): Promise<string> {
    try {
        await host.activate();
    } catch (error) {
        if (error instanceof AgentCoreError) return error.message;
        throw error;
    }
    return expect.unreachable("expected the activation to be a rejected install");
}
