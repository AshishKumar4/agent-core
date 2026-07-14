import { R2ContentObjectRepository, type R2BucketLike } from "./content-object.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";

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
            cause
        );
    }
    if (
        typeof bucket !== "object" ||
        bucket === null ||
        typeof bucket.get !== "function" ||
        typeof bucket.put !== "function"
    ) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "R2 content binding has an invalid shape"
        );
    }
    return new R2ContentObjectRepository(bucket, errors);
}
