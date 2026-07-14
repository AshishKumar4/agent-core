import { Contributions, type OperationDescriptor } from "../contribution";

export const SINGLE_TENANT_OPERATIONS: readonly OperationDescriptor[] = Object.freeze([]);
export const SINGLE_TENANT_EVENTS: readonly never[] = Object.freeze([]);
export const SINGLE_TENANT_CONTRIBUTIONS = Contributions.empty();
