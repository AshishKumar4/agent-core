import type { InvocationId } from "../interaction-references";
import type { SlateDeployInvocationIntent, SlateResourceInvocationIntent } from "./intent";
import type { SlateEffectContext } from "./seams";

interface SlateProviderEffectRequest {
    readonly invocationId: InvocationId;
    readonly effectContext: SlateEffectContext;
    readonly idempotencyKey: string;
}

export interface SlateProviderDeploymentRequest
    extends SlateDeployInvocationIntent, SlateProviderEffectRequest {}

export interface SlateProviderDeployment {
    readonly materialization: import("../core").ContentRef;
}

export interface SlateProviderResourceRequest
    extends SlateResourceInvocationIntent, SlateProviderEffectRequest {}

export interface SlateProviderResource {
    readonly materialization: import("../core").ContentRef;
}

export abstract class SlateProvider {
    public abstract deploy(
        request: SlateProviderDeploymentRequest
    ): Promise<SlateProviderDeployment>;

    public abstract reconcileDeployment(
        request: SlateProviderDeploymentRequest
    ): Promise<SlateProviderDeployment>;

    public abstract materializeResource(
        request: SlateProviderResourceRequest
    ): Promise<SlateProviderResource>;

    public abstract reconcileResource(
        request: SlateProviderResourceRequest
    ): Promise<SlateProviderResource>;
}
