import { Digest, TextId, type ContentRef } from "../core";
import { AgentCoreError } from "../errors";
import {
    canonicalFacetData,
    type BindingName,
    type FacetPackageId,
    type FacetRef,
    type OperationDescriptor,
    type OperationName,
    type FacetData
} from "../facets";
import type { PrincipalRef } from "../identity";
import type { FacetRuntimeHost } from "./lifecycle";
import type { ValidatedFacet } from "./correspondence";
import {
    OperationInterceptorRunner,
    type InterceptionResult,
    type InterceptorAuthorityPort,
    type InterceptorTrace
} from "./interception";
import type { Operation, OperationContext } from "./runtime";

export class OperationRequestKey extends TextId {
    public constructor(value: string) {
        super(value, "Operation request key");
        Object.freeze(this);
    }
}

export type OperationPayload =
    | { readonly kind: "single"; readonly input: FacetData }
    | { readonly kind: "batch"; readonly inputs: readonly [FacetData, ...FacetData[]] };

export type OperationPayloadShape =
    { readonly kind: "single" } | { readonly kind: "batch"; readonly itemCount: number };

export interface OperationRequest {
    readonly requestKey: OperationRequestKey;
    readonly operation: OperationName;
    readonly payload: OperationPayload;
}

export type OperationDispatchResult =
    | {
          readonly kind: "direct";
          readonly output: FacetData | readonly FacetData[];
      }
    | {
          readonly kind: "mediated";
          readonly output: FacetData | readonly FacetData[];
          readonly evidence: FacetData;
      };

export interface AuthorityResolution<Resolution> {
    readonly facet: FacetRef;
    readonly resolution: Resolution;
}

export type MediatedReplayExecutionIdentity =
    | { readonly kind: "lease"; readonly digest: Digest }
    | { readonly kind: "route"; readonly digest: Digest };

export interface MediatedReplayBinding {
    readonly principal: PrincipalRef;
    readonly authorityIdentity: Digest;
    readonly packageOperationPin: Digest;
    readonly execution: MediatedReplayExecutionIdentity;
}

export interface OperationAuthorityPort<
    Caller,
    Resolution,
    DirectAuthorization,
    MediatedAuthorization
> extends InterceptorAuthorityPort<Resolution> {
    resolve(caller: Caller, binding: BindingName): Promise<AuthorityResolution<Resolution>>;
    tier(
        resolution: Resolution,
        descriptor: OperationDescriptor,
        hasInterceptors: boolean
    ): "direct" | "mediated";
    authorizeDirect(
        resolution: Resolution,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[]
    ): DirectAuthorization | undefined;
    authorizeMediated(
        resolution: Resolution,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[]
    ): Promise<MediatedAuthorization>;
    replayBinding(
        authorization: MediatedAuthorization,
        descriptor: OperationDescriptor
    ): MediatedReplayBinding;
    release(resolution: Resolution): void;
}

export interface MediatedInvocationRequest<Authorization> {
    readonly requestKey: OperationRequestKey;
    readonly facet: FacetRef;
    readonly descriptor: OperationDescriptor;
    readonly shape: OperationPayloadShape;
    readonly inputs: readonly FacetData[];
    readonly authorization: Authorization;
    readonly replayBinding?: MediatedReplayBinding;
    readonly interceptions: readonly (readonly InterceptorTrace[])[];
    execute(itemIndex: number, context: OperationContext): Promise<FacetData>;
}

export interface MediatedInvocationPreflight<Authorization = unknown> {
    readonly requestKey: OperationRequestKey;
    readonly facet: FacetRef;
    readonly descriptor: OperationDescriptor;
    readonly shape: OperationPayloadShape;
    readonly inputs: readonly FacetData[];
    readonly authorization: Authorization;
    readonly replayBinding: MediatedReplayBinding;
}

export interface MediatedInvocationPreparation {
    readonly inputs: readonly FacetData[];
    readonly interceptions: readonly (readonly InterceptorTrace[])[];
}

export type MediatedPreflightResult =
    | { readonly kind: "new"; readonly preparation: MediatedInvocationPreparation }
    | { readonly kind: "replay"; readonly result: OperationDispatchResult };

export interface OperationInterceptionEvidence {
    readonly requestKey: OperationRequestKey;
    readonly facet: FacetRef;
    readonly descriptor: OperationDescriptor;
    readonly shape: OperationPayloadShape;
    readonly traces: readonly (readonly InterceptorTrace[])[];
}

export interface MediatedInvocationResult {
    readonly outputs: readonly FacetData[];
    readonly evidence: FacetData;
}

export interface OperationInvocationPort<DirectAuthorization, MediatedAuthorization> {
    directContext(
        requestKey: OperationRequestKey,
        itemIndex: number,
        shape: OperationPayloadShape,
        authorization: DirectAuthorization
    ): OperationContext;
    prepareMediated(
        request: MediatedInvocationPreflight<MediatedAuthorization>,
        prepare: () => MediatedInvocationPreparation
    ): Promise<MediatedPreflightResult>;
    invoke(
        request: MediatedInvocationRequest<MediatedAuthorization>
    ): Promise<MediatedInvocationResult>;
    recordDirectInterceptions(evidence: OperationInterceptionEvidence): void;
    presentMediated(
        evidence: FacetData,
        outputs: readonly FacetData[],
        present: (itemIndex: number, output: FacetData) => InterceptionResult,
        interceptions: Omit<OperationInterceptionEvidence, "traces">
    ): Promise<readonly FacetData[]>;
}

export abstract class OperationGateway {
    public abstract resolve(binding: BindingName): Promise<ResolvedFacet>;
}

export abstract class ResolvedFacet implements Disposable {
    public abstract readonly facet: FacetRef;
    public abstract readonly package: FacetPackageId;
    public abstract descriptor(name: OperationName): OperationDescriptor | undefined;
    public abstract dispatch(request: OperationRequest): Promise<OperationDispatchResult>;
    public abstract [Symbol.dispose](): void;
}

export class OperationGatewayHost<
    Caller,
    Resolution,
    DirectAuthorization,
    MediatedAuthorization
> extends OperationGateway {
    readonly #interceptors: OperationInterceptorRunner<Resolution>;

    public constructor(
        private readonly caller: Caller,
        private readonly host: FacetRuntimeHost,
        private readonly authority: OperationAuthorityPort<
            Caller,
            Resolution,
            DirectAuthorization,
            MediatedAuthorization
        >,
        private readonly invocations: OperationInvocationPort<
            DirectAuthorization,
            MediatedAuthorization
        >
    ) {
        super();
        this.#interceptors = new OperationInterceptorRunner(host, authority);
    }

    public async resolve(binding: BindingName): Promise<ResolvedFacet> {
        const resolved = await this.authority.resolve(this.caller, binding);
        const facet = this.host.facet(resolved.facet);
        if (facet === undefined) {
            this.authority.release(resolved.resolution);
            throw inactive(`Binding ${binding.value} targets an inactive Facet`);
        }
        return new ProtectedResolvedFacet(
            facet,
            resolved.resolution,
            this.host,
            this.authority,
            this.invocations,
            this.#interceptors
        );
    }
}

class ProtectedResolvedFacet<
    Caller,
    Resolution,
    DirectAuthorization,
    MediatedAuthorization
> extends ResolvedFacet {
    #disposed = false;
    #inFlight = 0;
    #releasePending = false;

    public constructor(
        private readonly runtime: ValidatedFacet,
        private readonly resolution: Resolution,
        private readonly host: FacetRuntimeHost,
        private readonly authority: OperationAuthorityPort<
            Caller,
            Resolution,
            DirectAuthorization,
            MediatedAuthorization
        >,
        private readonly invocations: OperationInvocationPort<
            DirectAuthorization,
            MediatedAuthorization
        >,
        private readonly interceptors: OperationInterceptorRunner<Resolution>
    ) {
        super();
    }

    public get facet(): FacetRef {
        return this.runtime.ref;
    }

    public get package(): FacetPackageId {
        return this.runtime.manifest.id;
    }

    public descriptor(name: OperationName): OperationDescriptor | undefined {
        return this.declaredOperation(name)?.descriptor;
    }

    public async dispatch(request: OperationRequest): Promise<OperationDispatchResult> {
        this.requireActive();
        const lease = this.host.acquire(this.runtime.ref, this.runtime);
        if (lease === undefined) throw inactive("Resolved Facet is no longer active");
        this.#inFlight += 1;
        try {
            return await this.dispatchWithLease(request);
        } finally {
            lease.release();
            this.#inFlight -= 1;
            if (this.#inFlight === 0 && this.#releasePending) this.releaseAuthority();
        }
    }

    private async dispatchWithLease(request: OperationRequest): Promise<OperationDispatchResult> {
        const operation = this.declaredOperation(request.operation);
        if (operation === undefined) {
            throw new AgentCoreError(
                "operation.missing",
                `Operation ${request.operation.value} is not declared`
            );
        }
        const payload = operationPayload(request.payload);
        const inputs = payload.items.map((item) => this.validateInput(operation, item));
        const selected = this.authority.tier(
            this.resolution,
            operation.descriptor,
            this.interceptors.hasApplicable(this.resolution, this.runtime, operation)
        );
        if (selected === "direct") {
            const prepared = inputs.map((item, itemIndex) =>
                this.prepare(operation, item, itemIndex)
            );
            const authorization = this.authority.authorizeDirect(
                this.resolution,
                operation.descriptor,
                prepared.map((item) => item.value)
            );
            if (authorization === undefined)
                throw new AgentCoreError("authority.denied", "Direct operation denied");
            this.invocations.recordDirectInterceptions(
                interceptionEvidence(
                    request,
                    this.runtime,
                    operation,
                    payload.shape,
                    prepared.map((item) => item.traces)
                )
            );
            const executions = prepared.map((item, itemIndex) =>
                executeOperation(
                    operation,
                    this.invocations.directContext(
                        request.requestKey,
                        itemIndex,
                        payload.shape,
                        authorization
                    ),
                    item.value
                )
            );
            const rawOutputs = await Promise.all(executions);
            const outputs = rawOutputs.map((output, itemIndex) =>
                this.present(operation, output, itemIndex)
            );
            const value =
                payload.shape.kind === "single"
                    ? outputs[0]!.value
                    : Object.freeze(outputs.map((item) => item.value));
            this.invocations.recordDirectInterceptions(
                interceptionEvidence(
                    request,
                    this.runtime,
                    operation,
                    payload.shape,
                    outputs.map((item) => item.traces)
                )
            );
            return Object.freeze({ kind: "direct", output: value });
        }
        const authorization = await this.authority.authorizeMediated(
            this.resolution,
            operation.descriptor,
            inputs
        );
        const replayBinding = this.authority.replayBinding(authorization, operation.descriptor);
        const preflight = await this.invocations.prepareMediated(
            {
                requestKey: request.requestKey,
                facet: this.runtime.ref,
                descriptor: operation.descriptor,
                shape: payload.shape,
                inputs: Object.freeze(inputs),
                authorization,
                replayBinding
            },
            () => {
                const prepared = inputs.map((item, itemIndex) =>
                    this.prepare(operation, item, itemIndex)
                );
                return Object.freeze({
                    inputs: Object.freeze(prepared.map((item) => item.value)),
                    interceptions: Object.freeze(prepared.map((item) => item.traces))
                });
            }
        );
        if (preflight.kind === "replay") return canonicalReplay(preflight.result, payload.shape);
        const prepared = preflight.preparation;
        const result = await this.invocations.invoke({
            requestKey: request.requestKey,
            facet: this.runtime.ref,
            descriptor: operation.descriptor,
            shape: payload.shape,
            inputs: prepared.inputs,
            authorization,
            replayBinding,
            interceptions: prepared.interceptions,
            execute: (itemIndex, context) => {
                const item = prepared.inputs[itemIndex];
                if (item === undefined) {
                    throw new AgentCoreError(
                        "invocation.invalid",
                        "Invocation requested an unknown item"
                    );
                }
                return executeOperation(operation, context, item);
            }
        });
        if (result.outputs.length !== prepared.inputs.length) {
            throw new AgentCoreError(
                "invocation.invalid",
                "Invocation returned the wrong item count"
            );
        }
        const evidence = canonicalFacetData(result.evidence);
        const outputs = await this.invocations.presentMediated(
            evidence,
            result.outputs,
            (itemIndex, output) => this.present(operation, output, itemIndex),
            Object.freeze({
                requestKey: request.requestKey,
                facet: this.runtime.ref,
                descriptor: operation.descriptor,
                shape: payload.shape
            })
        );
        const value = payload.shape.kind === "single" ? outputs[0]! : Object.freeze(outputs);
        return Object.freeze({ kind: "mediated", output: value, evidence });
    }

    public [Symbol.dispose](): void {
        if (this.#disposed) return;
        this.#disposed = true;
        if (this.#inFlight === 0) this.releaseAuthority();
        else this.#releasePending = true;
    }

    private validateInput(operation: Operation, rawInput: FacetData): FacetData {
        const input = canonicalFacetData(rawInput);
        if (!operation.descriptor.input.accepts(input)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Operation input does not match its schema"
            );
        }
        return input;
    }

    private prepare(
        operation: Operation,
        input: FacetData,
        itemIndex: number
    ): { readonly value: FacetData; readonly traces: readonly InterceptorTrace[] } {
        const before = this.interceptors.run(
            "operation.before",
            this.resolution,
            this.runtime,
            operation,
            itemIndex,
            input
        );
        if (!operation.descriptor.input.accepts(before.value)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Intercepted input does not match its schema"
            );
        }
        return before;
    }

    private present(
        operation: Operation,
        rawOutput: FacetData,
        itemIndex: number
    ): { readonly value: FacetData; readonly traces: readonly InterceptorTrace[] } {
        const output = canonicalFacetData(rawOutput);
        if (!operation.descriptor.output.accepts(output)) {
            throw new AgentCoreError(
                "operation.invalid-output",
                "Operation output does not match its schema"
            );
        }
        const after = this.interceptors.run(
            "operation.after",
            this.resolution,
            this.runtime,
            operation,
            itemIndex,
            output
        );
        if (!operation.descriptor.output.accepts(after.value)) {
            throw new AgentCoreError(
                "operation.invalid-output",
                "Intercepted output does not match its schema"
            );
        }
        return after;
    }

    private declaredOperation(name: OperationName): Operation | undefined {
        this.requireActive();
        return this.runtime.operation(name);
    }

    private requireActive(): void {
        if (this.#disposed) throw inactive("Resolved Facet is disposed");
        if (this.host.facet(this.runtime.ref) !== this.runtime) {
            throw inactive("Resolved Facet is no longer active");
        }
    }

    private releaseAuthority(): void {
        this.#releasePending = false;
        this.authority.release(this.resolution);
    }
}

export class ConfirmedOperationFailure extends AgentCoreError {
    public constructor(
        message: string,
        public readonly evidence: ContentRef
    ) {
        super("invocation.invalid", message);
        Object.freeze(evidence);
        Object.freeze(this);
    }
}

function operationPayload(payload: OperationPayload): {
    readonly shape: OperationPayloadShape;
    readonly items: readonly FacetData[];
} {
    if (payload.kind === "single") {
        return { shape: Object.freeze({ kind: "single" }), items: [payload.input] };
    }
    if (payload.kind === "batch" && Array.isArray(payload.inputs) && payload.inputs.length > 0) {
        return {
            shape: Object.freeze({ kind: "batch", itemCount: payload.inputs.length }),
            items: payload.inputs
        };
    }
    throw new AgentCoreError("invocation.invalid", "Operation payload is malformed or empty");
}

function interceptionEvidence(
    request: OperationRequest,
    runtime: ValidatedFacet,
    operation: Operation,
    shape: OperationPayloadShape,
    traces: readonly (readonly InterceptorTrace[])[]
): OperationInterceptionEvidence {
    return Object.freeze({
        requestKey: request.requestKey,
        facet: runtime.ref,
        descriptor: operation.descriptor,
        shape,
        traces: Object.freeze(traces.map((item) => Object.freeze([...item])))
    });
}

function canonicalReplay(
    result: OperationDispatchResult,
    shape: OperationPayloadShape
): OperationDispatchResult {
    if (result.kind !== "mediated") {
        throw new AgentCoreError("invocation.invalid", "Mediated replay returned a direct result");
    }
    if (
        shape.kind === "batch" &&
        (!Array.isArray(result.output) || result.output.length !== shape.itemCount)
    ) {
        throw new AgentCoreError(
            "invocation.invalid",
            "Mediated replay returned the wrong payload shape"
        );
    }
    return Object.freeze({
        kind: "mediated",
        output: canonicalFacetData(result.output),
        evidence: canonicalFacetData(result.evidence)
    });
}

async function executeOperation(
    operation: Operation,
    context: OperationContext,
    input: FacetData
): Promise<FacetData> {
    try {
        return await operation.execute(context, input);
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError("invocation.invalid", "Operation handler failed");
    }
}

function inactive(message: string): AgentCoreError {
    return new AgentCoreError("facet.inactive", message);
}
