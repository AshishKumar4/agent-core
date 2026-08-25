import { actorObjectName, type ActorObjectIdentity } from "./actor-name.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import {
    CloudflareStubFailure,
    throughFreshStub,
    type CloudflareStubRetryPolicy
} from "./stub-failure.js";

export interface DurableObjectNamespaceLike<ObjectId, Stub> {
    idFromName(name: string): ObjectId;
    get(id: ObjectId): Stub;
    jurisdiction(jurisdiction: string): DurableObjectNamespaceLike<ObjectId, Stub>;
}

export interface ActorNamespaceLocation {
    /** Optional physical namespace selection, independent of Actor name identity data. */
    readonly namespaceJurisdiction?: string;
}

/**
 * Locates a named object through a Workers-shaped namespace seam. This is structural
 * composition only; it is not evidence of compatibility with a real Workers runtime.
 */
export function locateActorObject<ObjectId, Stub>(
    namespace: DurableObjectNamespaceLike<ObjectId, Stub>,
    identity: ActorObjectIdentity,
    errors: CloudflareErrorPort,
    location: ActorNamespaceLocation = {}
): Stub {
    const jurisdiction =
        location.namespaceJurisdiction === undefined
            ? undefined
            : requireJurisdiction(location.namespaceJurisdiction);
    const name = actorObjectName(identity);
    try {
        const selected =
            jurisdiction === undefined ? namespace : namespace.jurisdiction(jurisdiction);
        return selected.get(selected.idFromName(name));
    } catch (cause) {
        // Cloudflare rate-limits new stub lookups per account and documents the refusal as
        // safe to retry after a short wait, so the disposition travels with the failure
        // rather than being flattened into one opaque state.
        const failure = CloudflareStubFailure.classify({ value: cause });
        operationalFailure(
            errors,
            "protocol.invalid-state",
            `Cloudflare Durable Object namespace lookup failed: ${failure.summary}`,
            { value: cause }
        );
    }
}

export interface ActorObjectCallOptions<ObjectId, Stub> {
    readonly namespace: DurableObjectNamespaceLike<ObjectId, Stub>;
    readonly identity: ActorObjectIdentity;
    readonly errors: CloudflareErrorPort;
    readonly policy: CloudflareStubRetryPolicy;
    readonly sleep: (milliseconds: number) => Promise<void>;
    readonly location?: ActorNamespaceLocation;
}

/**
 * Calls one named Actor object, resolving a stub per attempt. Cloudflare documents that
 * many exceptions leave a stub permanently broken, so recovery is a new stub rather than
 * another call on the one that failed; `call` carries the idempotency key that makes the
 * repeat safe, because the platform gives no delivery-once guarantee to lean on.
 */
export async function throughActorObject<ObjectId, Stub, Result>(
    options: ActorObjectCallOptions<ObjectId, Stub>,
    call: (stub: Stub) => Promise<Result>
): Promise<Result> {
    return throughFreshStub(
        {
            stubs: () =>
                locateActorObject(
                    options.namespace,
                    options.identity,
                    options.errors,
                    options.location ?? {}
                ),
            policy: options.policy,
            errors: options.errors,
            sleep: options.sleep
        },
        call
    );
}

function requireJurisdiction(value: string): string {
    if (value.length === 0) {
        throw new TypeError("Durable Object namespace jurisdiction must be non-empty");
    }
    return value;
}
