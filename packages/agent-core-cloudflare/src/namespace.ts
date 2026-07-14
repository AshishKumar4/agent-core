import { actorObjectName, type ActorObjectIdentity } from "./actor-name.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";

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
        operationalFailure(
            errors,
            "protocol.invalid-state",
            "Cloudflare Durable Object namespace lookup failed",
            cause
        );
    }
}

function requireJurisdiction(value: string): string {
    if (value.length === 0) {
        throw new TypeError("Durable Object namespace jurisdiction must be non-empty");
    }
    return value;
}
