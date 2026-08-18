import type { ContentStore } from "../content";
import type { Digest } from "../core";
import type { TurnId } from "../execution-references";
import type { InvocationId } from "../interaction-references";
import type { EffectAttemptId } from "../invocation-references";
import type {
    InterceptorDeclaration,
    OperationCutPoint,
    TurnBoundCutPoint
} from "./interceptor";
import type { FacetData } from "./data";
import type { OperationDescriptor, SurfaceDescriptor } from "./contribution";
import type { FacetRef, OperationName, SurfaceId } from "./id";
import type { FacetManifest } from "./manifest";

export interface FacetLifecycleContext {
    readonly signal: AbortSignal;
}

export interface OperationContext {
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly idempotencyKey: string;
    readonly attempt?: OperationAttemptIdentity;
    readonly targetAdmission?: unknown;
    readonly signal: AbortSignal;
    readonly content: ContentStore;
}

export interface OperationAttemptIdentity {
    readonly id: EffectAttemptId;
    readonly ordinal: number;
    readonly intentDigest: Digest;
}

export abstract class Operation<I extends FacetData = FacetData, O extends FacetData = FacetData> {
    public abstract readonly descriptor: OperationDescriptor;
    public abstract execute(context: OperationContext, input: I): Promise<O>;
}

export type ProtectedOperationResult<Receipt> =
    | { readonly kind: "output"; readonly output: FacetData; readonly receipt?: Receipt }
    | { readonly kind: "receipt"; readonly receipt: Receipt };

export interface ProtectedOperationRequest {
    readonly facet: FacetRef;
    readonly binding: import("./id").BindingName;
    readonly operation: Operation;
    readonly input: FacetData;
    readonly resultMode: "output" | "receipt";
}

export abstract class ProtectedOperationPort<Receipt> {
    public abstract invoke(
        request: ProtectedOperationRequest
    ): Promise<ProtectedOperationResult<Receipt>>;
}

/**
 * The two operation cut points, where the value in flight belongs to one Operation of one
 * target Facet and `appliesTo` is the selector that scoped it there (SPEC §4.4).
 */
export interface OperationInterceptContext {
    readonly cutPoint: OperationCutPoint;
    readonly operation: OperationDescriptor;
    readonly target: FacetRef;
    readonly interceptor: InterceptorDeclaration;
}

/**
 * The three Turn-bound cut points. There is no target Operation here, so nothing an
 * `OperationSelector` could name is in flight and the Turn is what the context carries
 * instead: a step, a submission, and a prompt each belong to exactly one Turn, and the
 * refusals at these cut points are all scoped to that Turn (SPEC §4.4, §5.3).
 */
export interface TurnInterceptContext {
    readonly cutPoint: TurnBoundCutPoint;
    readonly turn: TurnId;
    readonly interceptor: InterceptorDeclaration;
}

export type InterceptContext = OperationInterceptContext | TurnInterceptContext;

export type InterceptResult =
    | { readonly proceed: true; readonly value: FacetData }
    | { readonly proceed: false; readonly reason: string };

export abstract class Interceptor {
    public abstract readonly declaration: InterceptorDeclaration;
    public abstract intercept(context: InterceptContext, value: FacetData): InterceptResult;
}

export abstract class Surface {
    public abstract readonly descriptor: SurfaceDescriptor;
    public abstract render(context: OperationContext, input: FacetData): Promise<FacetData>;
}

export abstract class Facet {
    public abstract readonly ref: FacetRef;
    public abstract readonly manifest: FacetManifest;
    public abstract operation(name: OperationName): Operation | undefined;
    public abstract surface(id: SurfaceId): Surface | undefined;
    public abstract interceptor(id: InterceptorDeclaration["id"]): Interceptor | undefined;
    public abstract children(): readonly Facet[];
    public abstract start(context: FacetLifecycleContext): Promise<void>;
    public abstract stop(context: FacetLifecycleContext): Promise<void>;
}
