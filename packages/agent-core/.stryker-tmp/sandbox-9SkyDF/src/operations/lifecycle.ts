// @ts-nocheck
import { AgentCoreError } from "../errors";
import {
    FacetCorrespondenceValidator,
    type ValidatedFacet,
    type ValidatedFacetRuntime
} from "./correspondence";
import type { Facet, FacetLifecycleContext } from "./runtime";
import type { FacetManifest, FacetRef } from "../facets";

type HostState = "inactive" | "starting" | "active" | "stopping" | "cleanup-required" | "disposed";

export interface FacetRuntimeLease {
    readonly facet: ValidatedFacet;
    release(): void;
}

export class FacetRuntimeHost implements AsyncDisposable {
    readonly #expected: readonly FacetManifest[];
    readonly #roots: readonly Facet[];
    readonly #validator: FacetCorrespondenceValidator;
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
        validator = new FacetCorrespondenceValidator()
    ) {
        this.#expected = Object.freeze([...expected]);
        this.#roots = Object.freeze([...roots]);
        this.#validator = validator;
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
        if (this.#state === "stopping") return this.#transition!;
        const pending = this.#transition;
        const starting = this.#state === "starting";
        const completion = transitionDeferred();
        this.#state = "stopping";
        this.#transition = completion.promise;
        this.#abort.abort();
        void this.stop(pending, starting).then(completion.resolve, completion.reject);
        void completion.promise
            .finally(() => {
                this.#transition = undefined;
            })
            .catch(noop);
        return completion.promise;
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }

    private async start(): Promise<void> {
        const runtime = this.#validator.validate(this.#expected, this.#roots);
        const started: ValidatedFacet[] = [];
        const context = this.context();
        try {
            for (const facet of runtime.facets) {
                started.push(facet);
                await facet.start(context);
                if (context.signal.aborted) throw inactive("Facet activation was cancelled");
            }
            this.#runtime = runtime;
            this.#state = "active";
        } catch (error) {
            const failed = await stopAll(started.reverse(), context);
            this.#cleanup = failed;
            this.#runtime = undefined;
            if (this.#state !== "stopping") {
                this.#state = failed.length === 0 ? "inactive" : "cleanup-required";
            }
            const cleanup =
                failed.length === 0 ? "" : `; ${failed.length} rollback stop hook(s) failed`;
            throw lifecycleFailure(`Facet activation failed${cleanup}`, error);
        }
    }

    private async stop(pending: Promise<void> | undefined, starting: boolean): Promise<void> {
        if (starting) {
            try {
                await pending;
            } catch {}
        }
        await this.waitForDrain();
        const facets = uniqueFacets([...(this.#runtime?.facets ?? []), ...this.#cleanup]).reverse();
        const failures = await stopAll(facets, this.context());
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

async function stopAll(
    facets: readonly ValidatedFacet[],
    context: FacetLifecycleContext
): Promise<ValidatedFacet[]> {
    const failures: ValidatedFacet[] = [];
    for (const facet of facets) {
        try {
            await facet.stop(context);
        } catch {
            failures.push(facet);
        }
    }
    return failures;
}

function uniqueFacets(facets: readonly ValidatedFacet[]): ValidatedFacet[] {
    return [...new Set(facets)];
}

function lifecycleFailure(message: string, cause: unknown): AgentCoreError {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    return inactive(`${message}${detail}`);
}

function inactive(message: string): AgentCoreError {
    return new AgentCoreError("facet.inactive", message);
}

function noop(): void {}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

function transitionDeferred(): {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
} {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((complete, fail) => {
        resolve = complete;
        reject = fail;
    });
    return { promise, resolve, reject };
}
