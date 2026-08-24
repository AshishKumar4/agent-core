import { canonicalTupleKey } from "../core";
import { AgentCoreError } from "../errors";
import {
    FacetCorrespondenceValidator,
    type ValidatedFacet,
    type ValidatedFacetRuntime
} from "./correspondence";
import type { Facet, FacetLifecycleContext } from "./runtime";
import type { BindingRequirement, FacetManifest, FacetRef } from "../facets";

type HostState = "inactive" | "starting" | "active" | "stopping" | "cleanup-required" | "disposed";

export interface FacetRuntimeLease {
    readonly facet: ValidatedFacet;
    release(): void;
}

/**
 * The seam to §3.4 Binding resolution. A declared `BindingRequirement` resolves through the
 * Grant plane to an exact `FacetRef` in an exact protection domain and never to a name, so
 * this answers with that ref and nothing else: the authority plane stays outside
 * `src/operations`, and reliance keys on what the dependent actually reached.
 */
export abstract class FacetRequirementResolver {
    /** The exact live provider a declared requirement resolves to (SPEC §3.4), or nothing. */
    public abstract resolve(
        dependent: FacetRef,
        requirement: BindingRequirement
    ): FacetRef | undefined;
}

/**
 * Resolves nothing, so a host assembled without a Grant plane refuses every manifest that
 * declares a `BindingRequirement` rather than starting it degraded (SPEC §4.1). A manifest
 * declaring none activates unchanged.
 */
export class FailClosedFacetRequirementResolver extends FacetRequirementResolver {
    public resolve(): undefined {
        return undefined;
    }
}

export class FacetRuntimeHost implements AsyncDisposable {
    readonly #expected: readonly FacetManifest[];
    readonly #roots: readonly Facet[];
    readonly #validator: FacetCorrespondenceValidator;
    readonly #requirements: FacetRequirementResolver;
    readonly #reliance = new FacetReliance();
    readonly #abort = new AbortController();
    #runtime: ValidatedFacetRuntime | undefined;
    #state: HostState = "inactive";
    #transition: Promise<void> | undefined;
    #inFlight = 0;
    #drain: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;
    #cleanup: ValidatedFacet[] = [];

    public constructor(
        expected: readonly FacetManifest[],
        roots: readonly Facet[],
        validator = new FacetCorrespondenceValidator(),
        requirements: FacetRequirementResolver = new FailClosedFacetRequirementResolver()
    ) {
        this.#expected = Object.freeze([...expected]);
        this.#roots = Object.freeze([...roots]);
        this.#validator = validator;
        this.#requirements = requirements;
    }

    public get active(): boolean {
        return this.#state === "active";
    }

    public activate(): Promise<void> {
        if (this.#state === "active") return Promise.resolve();
        if (this.#state === "disposed") return Promise.reject(inactive("Facet host is disposed"));
        if (this.#state === "stopping") return Promise.reject(inactive("Facet host is stopping"));
        if (this.#state === "cleanup-required") {
            return Promise.reject(inactive("Facet host requires cleanup before reactivation"));
        }
        if (this.#transition !== undefined) return this.#transition;
        this.#state = "starting";
        const transition = this.start();
        this.#transition = transition;
        void transition
            .finally(() => {
                if (this.#transition === transition) this.#transition = undefined;
            })
            .catch(noop);
        return transition;
    }

    public facet(ref: FacetRef): ValidatedFacet | undefined {
        if (this.#state !== "active") return undefined;
        return this.#runtime?.facets.find((facet) => facet.ref.equals(ref));
    }

    public facets(): readonly ValidatedFacet[] {
        return this.#state === "active" || this.#state === "stopping"
            ? (this.#runtime?.facets ?? [])
            : [];
    }

    /**
     * The exact provider `FacetRef` this Facet's declared requirements resolved to, one entry
     * per distinct provider in manifest binding order (SPEC §4.1). Empty for a Facet that
     * declares no requirement, and for one whose own `stop` has returned.
     */
    public relianceOf(dependent: FacetRef): readonly FacetRef[] {
        return this.#reliance.providers(dependent);
    }

    /**
     * Every Facet still holding this exact provider through a resolved requirement. A Facet
     * answering the same Binding name from another `FacetRef` is not among them, and a Facet's
     * position in the child tree never puts it here (SPEC §4.1).
     */
    public reliedUponBy(provider: FacetRef): readonly FacetRef[] {
        return this.#reliance.dependents(provider);
    }

    public acquire(ref: FacetRef, expected: ValidatedFacet): FacetRuntimeLease | undefined {
        const facet = this.facet(ref);
        if (facet !== expected) return undefined;
        this.#inFlight += 1;
        let released = false;
        return Object.freeze({
            facet,
            release: () => {
                if (released) return;
                released = true;
                this.#inFlight -= 1;
                if (this.#inFlight === 0) {
                    this.#drain?.resolve();
                    this.#drain = undefined;
                }
            }
        });
    }

    public dispose(): Promise<void> {
        if (this.#state === "disposed") return Promise.resolve();
        if (this.#state === "stopping") {
            const transition = this.#transition;
            if (transition === undefined) {
                return Promise.reject(inactive("Facet host stopping transition is missing"));
            }
            return transition;
        }
        const pending = this.#transition;
        const starting = this.#state === "starting";
        this.#state = "stopping";
        const transition = this.stop(pending, starting);
        this.#transition = transition;
        this.#abort.abort();
        void transition
            .finally(() => {
                this.#transition = undefined;
            })
            .catch(noop);
        return transition;
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }

    private async start(): Promise<void> {
        const runtime = this.#validator.validate(this.#expected, this.#roots);
        const resolved = this.resolveRequirements(runtime);
        const started: ValidatedFacet[] = [];
        const context = this.context();
        try {
            for (const resolution of resolved) {
                started.push(resolution.facet);
                this.#reliance.record(resolution);
                await resolution.facet.start(context);
                if (context.signal.aborted) throw inactive("Facet activation was cancelled");
            }
            this.#runtime = runtime;
            this.#state = "active";
        } catch (error) {
            const failed = await stopAll(started.reverse(), context, this.#reliance);
            this.#cleanup = failed;
            this.#runtime = undefined;
            if (this.#state !== "stopping") {
                this.#state = failed.length === 0 ? "inactive" : "cleanup-required";
            }
            const cleanup =
                failed.length === 0 ? "" : `; ${failed.length} rollback stop hook(s) failed`;
            const detail = error instanceof Error ? `: ${error.message}` : "";
            throw inactive(`Facet activation failed${cleanup}${detail}`);
        }
    }

    /**
     * SPEC §4.1: `start` is not called until every declared `BindingRequirement` resolves to a
     * live provider. The pass covers the whole activation before any Facet starts, so an
     * unresolvable requirement is a rejected install rather than a runtime failure found after
     * a partial start, and no Facet in the activation starts degraded.
     */
    private resolveRequirements(runtime: ValidatedFacetRuntime): readonly ResolvedRequirements[] {
        const installed = new Set(runtime.facets.map((facet) => facet.ref.value));
        const resolved: ResolvedRequirements[] = [];
        for (const facet of runtime.facets) {
            const providers: FacetRef[] = [];
            for (const requirement of facet.manifest.bindings) {
                // Binding resolution and its compatibility, trust, and epoch evidence belong to
                // §3.4. The host owns liveness alone, and refuses an answer naming a Facet this
                // activation does not install.
                const provider = this.#requirements.resolve(facet.ref, requirement);
                if (provider === undefined || !installed.has(provider.value)) {
                    // Nothing started and nothing was materialized, so the host is left exactly
                    // as inactive as `activate` found it. This pass runs before the first
                    // `await`, so no other transition can be in flight here.
                    this.#state = "inactive";
                    throw rejectedInstall(facet.ref, requirement, provider);
                }
                if (!providers.some((candidate) => candidate.equals(provider))) {
                    providers.push(provider);
                }
            }
            resolved.push({ facet, providers: Object.freeze(providers) });
        }
        return resolved;
    }

    private async stop(pending: Promise<void> | undefined, starting: boolean): Promise<void> {
        if (starting) {
            try {
                await pending;
            } catch {}
        }
        await this.waitForDrain();
        const facets = uniqueFacets([...(this.#runtime?.facets ?? []), ...this.#cleanup]).reverse();
        const failures = await stopAll(facets, this.context(), this.#reliance);
        this.#runtime = undefined;
        this.#cleanup = failures;
        this.#state = failures.length === 0 ? "disposed" : "cleanup-required";
        if (failures.length > 0) throw inactive(`${failures.length} Facet stop hook(s) failed`);
    }

    private context(): FacetLifecycleContext {
        return Object.freeze({ signal: this.#abort.signal });
    }

    private waitForDrain(): Promise<void> {
        if (this.#inFlight === 0) return Promise.resolve();
        this.#drain ??= deferred();
        return this.#drain.promise;
    }
}

const noReliance: readonly FacetRef[] = Object.freeze([]);

/** One Facet of an activation and the exact providers its declared requirements reached. */
interface ResolvedRequirements {
    readonly facet: ValidatedFacet;
    readonly providers: readonly FacetRef[];
}

/**
 * The live reliance edges, keyed by the Facet holding them. SPEC §4.1 releases a Facet's edges
 * only once its own `stop` has returned, so a provider that stopped first is still the provider
 * that dependent reached, and reliance never outlives the dependent that recorded it.
 */
class FacetReliance {
    readonly #edges = new Map<string, ResolvedRequirements>();

    public record(resolution: ResolvedRequirements): void {
        this.#edges.set(resolution.facet.ref.value, resolution);
    }

    public release(dependent: FacetRef): void {
        this.#edges.delete(dependent.value);
    }

    public providers(dependent: FacetRef): readonly FacetRef[] {
        return this.#edges.get(dependent.value)?.providers ?? noReliance;
    }

    public dependents(provider: FacetRef): readonly FacetRef[] {
        const dependents: FacetRef[] = [];
        for (const edge of this.#edges.values()) {
            if (edge.providers.some((candidate) => candidate.equals(provider))) {
                dependents.push(edge.facet.ref);
            }
        }
        return Object.freeze(dependents);
    }
}

async function stopAll(
    facets: readonly ValidatedFacet[],
    context: FacetLifecycleContext,
    reliance: FacetReliance
): Promise<ValidatedFacet[]> {
    const failures: ValidatedFacet[] = [];
    for (const facet of facets) {
        try {
            await facet.stop(context);
        } catch {
            failures.push(facet);
        } finally {
            // SPEC §4.1: a Facet keeps resolving its own requirements for the whole of its own
            // teardown, so its edges drop only once its `stop` has returned.
            reliance.release(facet.ref);
        }
    }
    return failures;
}

function uniqueFacets(facets: readonly ValidatedFacet[]): ValidatedFacet[] {
    return [...new Set(facets)];
}

function inactive(message: string): AgentCoreError {
    return new AgentCoreError("facet.inactive", message);
}

/**
 * SPEC §4.1: a requirement no Binding satisfies is a rejected install rather than a runtime
 * failure, so it names the exact dependent and requirement and is raised before any Facet in
 * the activation starts.
 *
 * The refusal names a composite of four ids, and two different refusals must never read as
 * the same one, so the identity is a canonical tuple rather than interpolated text: a
 * BindingName or a FacetRef containing a delimiter would otherwise let one rejection be
 * spelled by another combination of ids.
 */
function rejectedInstall(
    dependent: FacetRef,
    requirement: BindingRequirement,
    provider: FacetRef | undefined
): AgentCoreError {
    const identity = canonicalTupleKey("agent-core.facet.rejected-install.v1", [
        dependent.value,
        requirement.name.value,
        requirement.facet.value,
        provider === undefined ? null : provider.value
    ]);
    const answer =
        provider === undefined
            ? "no Binding satisfies it"
            : "it resolves to a Facet this activation does not install";
    return new AgentCoreError(
        "binding.invalid",
        `Facet requirement ${identity} is a rejected install: ${answer}`
    );
}

function noop(): void {}

interface Completion {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

function deferred(): Completion {
    let resolve: (() => void) | undefined;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    if (resolve === undefined) {
        throw inactive("Facet drain completion was not initialized");
    }
    return { promise, resolve };
}
