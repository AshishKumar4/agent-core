// @ts-nocheck
export { Binding, decodeDomain, domainKey } from "../../src/authority/binding";
export {
    BindingValidationEvidence,
    BindingValidationRequest
} from "../../src/authority/binding-evidence";
export { MemoryBindingStore } from "../../src/authority/binding-store";
export type { BindingStore } from "../../src/authority/binding-store";
export { AuthorityCheckEvidence, AuthorityCheckRequest } from "../../src/authority/evidence";
export { InvalidationWatermark, PathEpochEvidence } from "../../src/authority/epoch";
export { authorityKey } from "../../src/authority/key";
export { TenantAuthorityRuntime, type TenantAuthorityReadStore } from "../../src/authority/runtime";
export {
    MemoryInvalidationWatermarkStore,
    watermarkKey,
    type InvalidationWatermarkStore
} from "../../src/authority/watermark-store";
