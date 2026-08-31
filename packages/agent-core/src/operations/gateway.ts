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

export type OperationPayloadCardinality =
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
    readonly cardinality: OperationPayloadCardinality;
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
    readonly cardinality: OperationPayloadCardinality;
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
    readonly cardinality: OperationPayloadCardinality;
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
        cardinality: OperationPayloadCardinality,
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

/**
 * The Invocation plane's detached admission (SPEC §5.6, C13-TURN-HANDLE-DETACHMENT).
 *
 * A detached admission commits the item's effect evidence and stops there: the effect runs
 * later, under the plane that owns the item, and never under the dispatching Turn's live
 * resources. So this seam takes the request the one dispatch assembly composed and returns
 * whatever the Invocation plane says the item became. `Admission` stays opaque here because
 * the answer is that plane's own record shape, and the operations context composes the steps
 * before an effect rather than interpreting the evidence after one.
 */
export interface DetachedInvocationAdmissionPort<MediatedAuthorization, Admission> {
    admitDetached(
        request: MediatedInvocationRequest<MediatedAuthorization>,
        itemIndex: number
    ): Promise<Admission>;
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
        return this.resolveProtected(binding);
    }

    /**
     * Admits one item of a mediated dispatch and detaches its execution (SPEC §5.6).
     *
     * It reaches the item through exactly the assembly `dispatch` reaches an effect through —
     * one authority resolution, one tier decision, one interceptor pass, one preflight — and
     * differs only in the last step: the Invocation plane records the item's admission and
     * runs nothing. The admission is returned rather than handed to a callback, because the
     * caller publishes it and a handle nobody received is an admitted item no Run ever holds.
     *
     * The resolution is released here rather than by the caller: a detached admission is one
     * shot with no dispatch to follow, so nothing outlives this call to dispose.
     */
    public async admitDetached<Admission>(
        binding: BindingName,
        request: OperationRequest,
        itemIndex: number,
        admissions: DetachedInvocationAdmissionPort<MediatedAuthorization, Admission>
    ): Promise<Admission> {
        const resolved = await this.resolveProtected(binding);
        try {
            return await resolved.admitDetached(request, itemIndex, admissions);
        } finally {
            resolved[Symbol.dispose]();
        }
    }

    /**
     * The one resolution both entries are built from. `resolve` widens it to the contract a
     * caller holds, while the detached admission needs the concrete facet: its entry is not on
     * `ResolvedFacet`, because that contract cannot name this host's authorization type and a
     * seam that erased it would admit a port belonging to another authority plane.
     */
    private async resolveProtected(
        binding: BindingName
    ): Promise<
        ProtectedResolvedFacet<Caller, Resolution, DirectAuthorization, MediatedAuthorization>
    > {
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
        return this.underLease(() => this.dispatchWithLease(request));
    }

    /**
     * Admits one item of this dispatch and leaves its execution to the Invocation plane
     * (SPEC §5.6, C13-TURN-HANDLE-DETACHMENT).
     *
     * The steps before the effect are not repeated here: this is the same composition
     * `dispatch` runs, stopped one step earlier. Only the last step differs, and the
     * difference is the whole point — the item's admission becomes durable while the effect
     * has not happened, which is the fact a §5.6 handle names and the one a Receipt cannot
     * state.
     */
    public async admitDetached<Admission>(
        request: OperationRequest,
        itemIndex: number,
        admissions: DetachedInvocationAdmissionPort<MediatedAuthorization, Admission>
    ): Promise<Admission> {
        return this.underLease(() =>
            this.dispatchWithLease(request, Object.freeze({ itemIndex, admissions }))
        );
    }

    /**
     * Holds the Facet runtime for the duration of one call, so a withdrawal drains rather
     * than cutting an in-flight dispatch, and releases the authority resolution once the last
     * in-flight call of a disposed facet has returned (§4.1, C13-FACET-DISPOSAL).
     */
    private async underLease<Result>(work: () => Promise<Result>): Promise<Result> {
        this.requireActive();
        const lease = this.host.acquire(this.runtime.ref, this.runtime);
        if (lease === undefined) throw inactive("Resolved Facet is no longer active");
        this.#inFlight += 1;
        try {
            return await work();
        } finally {
            lease.release();
            this.#inFlight -= 1;
            if (this.#inFlight === 0 && this.#releasePending) this.releaseAuthority();
        }
    }

    private async dispatchWithLease(request: OperationRequest): Promise<OperationDispatchResult>;
    private async dispatchWithLease<Admission>(
        request: OperationRequest,
        detachment: DetachedDispatch<MediatedAuthorization, Admission>
    ): Promise<Admission>;
    private async dispatchWithLease<Admission>(
        request: OperationRequest,
        detachment?: DetachedDispatch<MediatedAuthorization, Admission>
    ): Promise<OperationDispatchResult | Admission> {
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
        if (detachment !== undefined) {
            // Refused before the direct branch runs, not after: a direct call creates no
            // Invocation, EffectAttempt, or Receipt (§7.2), so there is no admitted item to
            // detach and no evidence a Run could ever hold. Refusing after the effect had run
            // would report that nothing was admitted while the effect had already happened.
            requireDetachableItem(detachment.itemIndex, payload, selected);
        }
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
                    payload.cardinality,
                    prepared.map((item) => item.traces)
                )
            );
            const executions = prepared.map((item, itemIndex) =>
                executeOperation(
                    operation,
                    this.invocations.directContext(
                        request.requestKey,
                        itemIndex,
                        payload.cardinality,
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
                payload.cardinality.kind === "single"
                    ? outputs[0]!.value
                    : Object.freeze(outputs.map((item) => item.value));
            this.invocations.recordDirectInterceptions(
                interceptionEvidence(
                    request,
                    this.runtime,
                    operation,
                    payload.cardinality,
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
                cardinality: payload.cardinality,
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
        if (preflight.kind === "replay") {
            if (detachment !== undefined) {
                throw new AgentCoreError(
                    "invocation.invalid",
                    "A detached admission names an OperationRequestKey whose Invocation completed"
                );
            }
            return canonicalReplay(preflight.result, payload.cardinality);
        }
        const prepared = preflight.preparation;
        const mediated: MediatedInvocationRequest<MediatedAuthorization> = {
            requestKey: request.requestKey,
            facet: this.runtime.ref,
            descriptor: operation.descriptor,
            cardinality: payload.cardinality,
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
        };
        if (detachment !== undefined) {
            return detachment.admissions.admitDetached(mediated, detachment.itemIndex);
        }
        const result = await this.invocations.invoke(mediated);
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
                cardinality: payload.cardinality
            })
        );
        const value = payload.cardinality.kind === "single" ? outputs[0]! : Object.freeze(outputs);
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

interface DispatchedPayload {
    readonly cardinality: OperationPayloadCardinality;
    readonly items: readonly FacetData[];
}

/**
 * What one dispatch detaches: which item, and the Invocation plane that admits it. It is
 * module-private because the seam a consumer supplies is the port; a caller that could name
 * this pair could assemble a dispatch whose composition differs from the one §7 describes.
 */
interface DetachedDispatch<MediatedAuthorization, Admission> {
    readonly itemIndex: number;
    readonly admissions: DetachedInvocationAdmissionPort<MediatedAuthorization, Admission>;
}

/**
 * Refuses a detached admission the dispatch cannot answer for, before any effect runs.
 *
 * The mediated tier is a precondition rather than a preference: §5.6 detaches an item whose
 * admission it can name, and only the mediated tier records one. The item index is checked
 * against this dispatch's own payload, so a caller cannot detach an item the request never
 * carried and receive an admission derived from a different item's arguments.
 */
function requireDetachableItem(
    itemIndex: number,
    payload: DispatchedPayload,
    tier: "direct" | "mediated"
): void {
    if (tier !== "mediated") {
        throw new AgentCoreError(
            "invocation.invalid",
            "A detached admission requires the mediated tier, which alone admits an item"
        );
    }
    if (!Number.isSafeInteger(itemIndex) || itemIndex < 0 || itemIndex >= payload.items.length) {
        throw new AgentCoreError(
            "invocation.invalid",
            "A detached admission names an item outside this dispatch's payload"
        );
    }
}

function operationPayload(payload: OperationPayload): DispatchedPayload {
    if (payload.kind === "single") {
        return { cardinality: Object.freeze({ kind: "single" }), items: [payload.input] };
    }
    if (payload.kind === "batch" && Array.isArray(payload.inputs) && payload.inputs.length > 0) {
        return {
            cardinality: Object.freeze({ kind: "batch", itemCount: payload.inputs.length }),
            items: payload.inputs
        };
    }
    throw new AgentCoreError("invocation.invalid", "Operation payload is malformed or empty");
}

function interceptionEvidence(
    request: OperationRequest,
    runtime: ValidatedFacet,
    operation: Operation,
    cardinality: OperationPayloadCardinality,
    traces: readonly (readonly InterceptorTrace[])[]
): OperationInterceptionEvidence {
    return Object.freeze({
        requestKey: request.requestKey,
        facet: runtime.ref,
        descriptor: operation.descriptor,
        cardinality,
        traces: Object.freeze(traces.map((item) => Object.freeze([...item])))
    });
}

function canonicalReplay(
    result: OperationDispatchResult,
    cardinality: OperationPayloadCardinality
): OperationDispatchResult {
    if (result.kind !== "mediated") {
        throw new AgentCoreError("invocation.invalid", "Mediated replay returned a direct result");
    }
    if (
        cardinality.kind === "batch" &&
        (!Array.isArray(result.output) || result.output.length !== cardinality.itemCount)
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
