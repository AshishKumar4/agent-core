import { AgentCoreError, TextId } from "@agent-core/core";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import { isPlatformObject } from "./platform-value.js";

/**
 * Cloudflare's *Durable Object facet* is not the Facet of SPEC §4. It is a dynamically
 * loaded `DurableObject` class running as a child of the object that loaded it, with a
 * SQLite database of its own that the supervisor cannot read. The two words collide;
 * the concepts do not. Everything in this module means Cloudflare's.
 *
 * The class a facet runs comes from `getDurableObjectClass` on a Worker Loader stub, so
 * the isolate is the `workerLoader` isolate this profile already offers as a §4.7
 * backing — same `globalOutbound: null`, same compatibility flags, same resource bound.
 * What a facet adds is durable state and a lifetime, which is why hosting one is a
 * storage substrate of that backing rather than a backing of its own.
 */

/** The name a `dynamic` domain's private store is addressed by inside its hosting object. */
export class DynamicDomainName extends TextId {
    public constructor(value: string) {
        super(value, "Dynamic domain name");
    }
}

/**
 * Everything the supervisor tells the platform about a domain it is starting: the loaded
 * class, and optionally the id the child sees as its own `ctx.id`. There is deliberately
 * no third field. The supervisor's own storage never appears here, which is what keeps
 * the two databases unreachable from each other in both directions.
 */
export interface DynamicDomainStartup<Class> {
    readonly class: Class;
    readonly id?: string;
}

/** The platform's `ctx.facets`, narrowed to the verbs this adapter uses. */
export interface DurableObjectFacetsLike<Stub, Class> {
    get(
        name: string,
        startup: () => DynamicDomainStartup<Class> | Promise<DynamicDomainStartup<Class>>
    ): Stub;
    abort(name: string, reason: AgentCoreError): void;
    delete(name: string): void;
}

/**
 * Hosting a `dynamic` domain that holds durable state (SPEC §10.2).
 *
 * The platform gives the two lifecycle acts adjacent names and opposite consequences:
 * `abort` stops a facet and keeps its database, `delete` stops it and destroys it. This
 * seam renames them for what they mean to this document — `suspend` and `retire` — and
 * exposes no third verb, because the failure this costs elsewhere is a suspended domain
 * whose database survives with nothing left that names it.
 *
 * It also exposes no reader of the domain's store. That is not an omission to be filled
 * in later: a record the hosting Actor cannot read is a record it cannot reconcile,
 * export, or repair, so the store holds the loaded code's own state and nothing whose
 * owning Actor is anybody else (§8.4).
 */
export class DurableObjectFacetHost<Stub, Class> {
    public constructor(
        private readonly facets: DurableObjectFacetsLike<Stub, Class>,
        private readonly errors: CloudflareErrorPort
    ) {}

    /**
     * Starts the domain, or returns a stub to the one already running under this name.
     * The platform invokes `startup` only when it has no live domain to hand back, so a
     * caller cannot tell from the call whether the code was loaded again.
     */
    public open(
        name: DynamicDomainName,
        startup: () => DynamicDomainStartup<Class> | Promise<DynamicDomainStartup<Class>>
    ): Stub {
        return this.facets.get(name.value, async () =>
            sealedStartup(await startup(), this.errors)
        );
    }

    /**
     * Stops the domain and invalidates every stub, which then throw `reason`. Its store
     * survives, so this is the code-update act: suspend the domain running the old class
     * and `open` it again with the new one. The reason is a coded domain error because a
     * caller holding an invalidated stub sees it in place of the call's own failure, and
     * an uncoded value there is a failure the caller cannot classify.
     */
    public suspend(name: DynamicDomainName, reason: AgentCoreError): void {
        this.facets.abort(name.value, reason);
    }

    /**
     * Stops the domain and destroys its store. This is the act a withdrawal performs
     * (§4.1): the composition record the domain served is gone, so nothing names the
     * store any more and suspending would leave it durable and unreachable.
     */
    public retire(name: DynamicDomainName): void {
        this.facets.delete(name.value);
    }
}

/**
 * Exactly the two admissible fields, rebuilt rather than forwarded. A startup record
 * assembled elsewhere is the one place a supervisor's own handle could reach a child
 * that the supervisor is not allowed to read back from.
 */
function sealedStartup<Class>(
    requested: DynamicDomainStartup<Class>,
    errors: CloudflareErrorPort
): DynamicDomainStartup<Class> {
    if (!isPlatformObject(requested) || requested.class === undefined) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "Dynamic domain startup names no loaded class"
        );
    }
    return Object.freeze(
        requested.id === undefined
            ? { class: requested.class }
            : { class: requested.class, id: requested.id }
    );
}
