import type { TenantId } from "@agent-core/core";
import { R2ContentObjectRepository, R2ContentStore, type R2BucketLike } from "./content-object.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import { isPlatformMethod, isPlatformObject } from "./platform-value.js";

export type R2BucketBinding<Environment> = (environment: Environment) => R2BucketLike;

export function contentRepositoryFromR2Binding<Environment>(
    environment: Environment,
    binding: R2BucketBinding<Environment>,
    errors: CloudflareErrorPort
): R2ContentObjectRepository {
    let bucket: R2BucketLike;
    try {
        bucket = binding(environment);
    } catch (cause) {
        operationalFailure(
            errors,
            "protocol.invalid-state",
            "R2 content binding resolution failed",
            { value: cause }
        );
    }
    if (
        !isPlatformObject(bucket) ||
        !isPlatformMethod(bucket.get) ||
        !isPlatformMethod(bucket.head) ||
        !isPlatformMethod(bucket.put)
    ) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "R2 content binding has an invalid shape"
        );
    }
    return new R2ContentObjectRepository(bucket, errors);
}

/**
 * The same binding as one Tenant's §8.2 ContentStore. A caller that resolves ContentRefs
 * wants this rather than the object repository: the repository addresses objects by Tenant
 * and digest, while a store is already bound to its Tenant and speaks the seam every other
 * substrate in this repository implements.
 */
export function contentStoreFromR2Binding<Environment>(
    environment: Environment,
    binding: R2BucketBinding<Environment>,
    tenantId: TenantId,
    errors: CloudflareErrorPort
): R2ContentStore {
    return new R2ContentStore(
        contentRepositoryFromR2Binding(environment, binding, errors),
        tenantId,
        errors
    );
}
