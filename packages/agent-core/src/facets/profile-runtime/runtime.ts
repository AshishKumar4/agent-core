import { Digest, isObjectRecord, type JsonSchema, type ObjectRecord } from "../../core";
import type { InvocationId } from "../../interaction-references";
import { EffectAttemptId } from "../../invocation-references";
import { Operation, Surface, type OperationContext, type ProtectedOperationPort } from "../runtime";
import type { OperationDescriptor, SurfaceDescriptor } from "../contribution";
import type { FacetData } from "../data";
import { canonicalFacetData } from "../data";
import type { EventDeclaration } from "../event";
import { BindingName, FacetRef } from "../id";
import type {
    ProfileControlContract,
    ProfileEventContract,
    ProfileOperationContract,
    ProfileOperationResultMode,
    PublicProfileInput
} from "./contract";
import { DetailedProfileError } from "./error";

export class ProfileRuntimeHostBinding {
    public constructor(
        public readonly facet: FacetRef,
        public readonly binding: BindingName
    ) {
        if (facet.constructor !== FacetRef || binding.constructor !== BindingName) {
            throw new TypeError("Profile runtime host identifiers must use exact Facet classes");
        }
        Object.freeze(this);
    }
}

export class EffectDispatchAttempt {
    public constructor(
        public readonly id: EffectAttemptId,
        public readonly ordinal: number,
        public readonly intentDigest: Digest
    ) {
        if (id.constructor !== EffectAttemptId) {
            throw new TypeError("Effect dispatch attempt must use the exact EffectAttemptId class");
        }
        if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
            throw new TypeError(
                "Effect dispatch attempt ordinal must be a non-negative safe integer"
            );
        }
        if (intentDigest.constructor !== Digest) {
            throw new TypeError(
                "Effect dispatch attempt intent digest must use the exact Digest class"
            );
        }
        Object.freeze(this);
    }
}

/**
 * The canonical identity an external effect must carry to its provider transport.
 * Derived once from {@link ProfileEffectContext.dispatch}; a facet never re-reads the
 * individual identity fields. A provider MUST treat `idempotencyKey` as the dedup key
 * for the effect and MUST be able to answer a reconciliation query addressed by
 * `attempt` identity, so that a crash-after-send retry neither duplicates the effect
 * nor leaves it permanently indeterminate (SPEC §7.4).
 */
export class EffectDispatch {
    public constructor(
        public readonly idempotencyKey: string,
        public readonly attempt: EffectDispatchAttempt | undefined = undefined
    ) {
        if (idempotencyKey.length === 0 || idempotencyKey !== idempotencyKey.trim()) {
            throw new TypeError("Effect dispatch idempotency key must be canonical");
        }
        if (attempt !== undefined && attempt.constructor !== EffectDispatchAttempt) {
            throw new TypeError(
                "Effect dispatch attempt must use the exact EffectDispatchAttempt class"
            );
        }
        Object.freeze(this);
    }
}

/**
 * A handler's own bound, as a duration this context will accept. A bound that is not a
 * non-negative safe integer is a caller shape fault, not an operational refusal: there is
 * no invocation state in which it could be the right answer.
 */
function requireBoundMilliseconds(milliseconds: number): number {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new TypeError("Profile effect bound must be a non-negative safe integer");
    }
    return milliseconds;
}

/**
 * The invocation a profile handler is running under, as the handler sees it: the identity an
 * external effect carries to its transport, and the cancellation of the Turn or Run that
 * owns the invocation (SPEC §4.1, C13-FACET-CANCELLATION-REACH).
 *
 * The cancellation is here because a handler that awaits further asynchronous work under
 * its own invocation's lifetime has to pass it on, and a derivation that dropped it left
 * every profile handler unable to — availability at the `Operation.execute` boundary and
 * availability inside the handler that boundary calls are the same requirement, so this
 * context conveys exactly the signal its `OperationContext` conveyed and never a substitute.
 */
export class ProfileEffectContext {
    public constructor(
        public readonly cancellation: AbortSignal,
        public readonly invocation: InvocationId,
        public readonly itemIndex: number,
        public readonly idempotencyKey: string,
        public readonly attempt: EffectAttemptId | undefined,
        public readonly attemptOrdinal: number | undefined,
        public readonly intentDigest: Digest | undefined,
        public readonly targetAdmission: ObjectRecord | undefined = undefined
    ) {
        if (!(cancellation instanceof AbortSignal)) {
            throw new TypeError("Profile effect cancellation must be the invocation's own signal");
        }
        if (!Number.isSafeInteger(itemIndex) || itemIndex < 0) {
            throw new TypeError("Profile effect item index must be a non-negative safe integer");
        }
        if (idempotencyKey.length === 0 || idempotencyKey !== idempotencyKey.trim()) {
            throw new TypeError("Profile effect idempotency key must be canonical");
        }
        const attempted =
            attempt !== undefined || attemptOrdinal !== undefined || intentDigest !== undefined;
        if (
            attempted &&
            (attempt === undefined || attemptOrdinal === undefined || intentDigest === undefined)
        ) {
            throw new TypeError("Profile effect attempt identity must be complete");
        }
        if (
            attemptOrdinal !== undefined &&
            (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 0)
        ) {
            throw new TypeError(
                "Profile effect attempt ordinal must be a non-negative safe integer"
            );
        }
        Object.freeze(this);
    }

    public static fromOperation(context: OperationContext): ProfileEffectContext {
        const admission = context.targetAdmission;
        return new ProfileEffectContext(
            context.signal,
            context.invocation,
            context.itemIndex,
            context.idempotencyKey,
            context.attempt?.id,
            context.attempt?.ordinal,
            context.attempt?.intentDigest,
            isObjectRecord(admission) ? admission : undefined
        );
    }

    /**
     * A bound of the handler's own that stays linked to the cancellation it derived from
     * (SPEC §4.1): the returned signal aborts when this bound elapses *or* when the
     * invocation's cancellation fires. A handler that built an independent timer would
     * satisfy its own seam while dropping cancellation at the next one, so deriving a
     * narrower deadline goes through here and carries the upstream link with it.
     */
    public bound(milliseconds: number): AbortSignal {
        return AbortSignal.any([
            this.cancellation,
            AbortSignal.timeout(requireBoundMilliseconds(milliseconds))
        ]);
    }

    public dispatch(): EffectDispatch {
        const attempt =
            this.attempt !== undefined &&
            this.attemptOrdinal !== undefined &&
            this.intentDigest !== undefined
                ? new EffectDispatchAttempt(this.attempt, this.attemptOrdinal, this.intentDigest)
                : undefined;
        return new EffectDispatch(this.idempotencyKey, attempt);
    }
}

export interface ProfileOperationAdmission {
    readonly descriptor: OperationDescriptor;
    readonly resultMode: ProfileOperationResultMode;
}

export interface ProfileControlAdmission {
    readonly name: string;
    readonly input: JsonSchema;
    readonly output: JsonSchema;
}

export abstract class ProfileRuntimeEffectsPort<Receipt = unknown> {
    public abstract emit(
        host: ProfileRuntimeHostBinding,
        declaration: EventDeclaration,
        payload: FacetData,
        cause: Receipt
    ): Promise<void>;

    public abstract control(
        host: ProfileRuntimeHostBinding,
        control: ProfileControlAdmission,
        input: FacetData,
        execute: (input: FacetData) => Promise<FacetData>
    ): Promise<FacetData>;

    public abstract render(
        host: ProfileRuntimeHostBinding,
        descriptor: SurfaceDescriptor,
        context: OperationContext,
        input: FacetData
    ): Promise<FacetData>;
}

export class ProtectedProfileRuntimePort<Receipt> {
    #active = false;

    public constructor(
        public readonly host: ProfileRuntimeHostBinding,
        private readonly operations: ProtectedOperationPort<Receipt>,
        private readonly effects: ProfileRuntimeEffectsPort<Receipt>
    ) {
        Object.freeze(this);
    }

    public get active(): boolean {
        return this.#active;
    }

    public activate(): void {
        this.#active = true;
    }

    public deactivate(): void {
        this.#active = false;
    }

    public operation<Name extends string, Input, Output, Mode extends ProfileOperationResultMode>(
        contract: ProfileOperationContract<Name, Input, Output, Mode>,
        handler: (input: Input, context: ProfileEffectContext) => Output | Promise<Output>
    ): Operation {
        return new ProfileOperationRuntime(contract, handler);
    }

    public surface(descriptor: SurfaceDescriptor): Surface {
        return new ProfileSurfaceRuntime(this.host, descriptor, this.effects);
    }

    public async invoke<
        Name extends string,
        Input,
        Output,
        Mode extends ProfileOperationResultMode
    >(
        contract: ProfileOperationContract<Name, Input, Output, Mode>,
        input: Input,
        handler: (input: Input, context: ProfileEffectContext) => Output | Promise<Output>
    ): Promise<Mode extends "receipt" ? Receipt : Output> {
        const result = await this.invokeRaw(contract, input, handler);
        if (contract.resultMode === "receipt") {
            if (result.kind !== "receipt") {
                throw invalidOutput("Protected Operation port omitted the operation Receipt");
            }
            // SAFETY: contract.resultMode is the runtime witness of Mode, and this branch
            // runs only where it equals "receipt", so Mode is "receipt" and the conditional
            // return type is Receipt — which the kind check above has just established.
            return result.receipt as Mode extends "receipt" ? Receipt : Output;
        }
        if (result.kind !== "output") {
            throw invalidOutput(
                "Protected Operation port returned a Receipt for an output Operation"
            );
        }
        const encodedOutput = validateCanonical(
            result.output,
            contract.descriptor.output,
            "output"
        );
        // SAFETY: contract.resultMode is the runtime witness of Mode and the receipt branch
        // above returned, so Mode is "output" here and the conditional return type is Output —
        // which is what contract.outputCodec decodes.
        return decode(contract.outputCodec, encodedOutput, "output") as Mode extends "receipt"
            ? Receipt
            : Output;
    }

    public async invokeWithReceipt<Name extends string, Input, Output>(
        contract: ProfileOperationContract<Name, Input, Output, "output">,
        input: Input,
        handler: (input: Input, context: ProfileEffectContext) => Output | Promise<Output>
    ): Promise<{ readonly output: Output; readonly receipt: Receipt }> {
        const result = await this.invokeRaw(contract, input, handler);
        if (result.kind !== "output" || result.receipt === undefined) {
            throw invalidOutput("Protected Operation port omitted source Event Receipt evidence");
        }
        const encodedOutput = validateCanonical(
            result.output,
            contract.descriptor.output,
            "output"
        );
        return Object.freeze({
            output: decode(contract.outputCodec, encodedOutput, "output"),
            receipt: result.receipt
        });
    }

    public emit<Kind extends string, Payload extends PublicProfileInput>(
        contract: ProfileEventContract<Kind, Payload>,
        payload: Payload,
        cause: Receipt
    ): Promise<void> {
        this.requireActive();
        const encoded = encodeAndValidate(
            contract.payloadCodec,
            contract.declaration.payload,
            payload,
            "input"
        );
        return this.effects.emit(this.host, contract.declaration, encoded, cause);
    }

    public async control<Name extends string, Input extends PublicProfileInput, Output>(
        contract: ProfileControlContract<Name, Input, Output>,
        input: Input,
        handler: (input: Input) => Output | Promise<Output>
    ): Promise<Output> {
        this.requireActive();
        const encodedInput = encodeAndValidate(contract.inputCodec, contract.input, input, "input");
        const output = await this.effects.control(
            this.host,
            Object.freeze({ name: contract.name, input: contract.input, output: contract.output }),
            encodedInput,
            async (admittedInput) => {
                const canonicalInput = validateCanonical(admittedInput, contract.input, "input");
                const typedInput = decode(contract.inputCodec, canonicalInput, "input");
                const typedOutput = await handler(typedInput);
                return encodeAndValidate(
                    contract.outputCodec,
                    contract.output,
                    typedOutput,
                    "output"
                );
            }
        );
        const canonicalOutput = validateCanonical(output, contract.output, "output");
        return decode(contract.outputCodec, canonicalOutput, "output");
    }

    private requireActive(): void {
        if (!this.#active) {
            throw new DetailedProfileError(
                "facet.inactive",
                "facet.inactive",
                "Profile Facet runtime is inactive"
            );
        }
    }

    private async invokeRaw<
        Name extends string,
        Input,
        Output,
        Mode extends ProfileOperationResultMode
    >(
        contract: ProfileOperationContract<Name, Input, Output, Mode>,
        input: Input,
        handler: (input: Input, context: ProfileEffectContext) => Output | Promise<Output>
    ) {
        this.requireActive();
        const encodedInput = encodeAndValidate(
            contract.inputCodec,
            contract.descriptor.input,
            input,
            "input"
        );
        return this.operations.invoke({
            facet: this.host.facet,
            binding: this.host.binding,
            operation: this.operation(contract, handler),
            input: encodedInput,
            resultMode: contract.resultMode
        });
    }
}

class ProfileOperationRuntime<
    Name extends string,
    Input,
    Output,
    Mode extends ProfileOperationResultMode
> extends Operation {
    public readonly descriptor: OperationDescriptor;

    public constructor(
        private readonly contract: ProfileOperationContract<Name, Input, Output, Mode>,
        private readonly handler: (
            input: Input,
            context: ProfileEffectContext
        ) => Output | Promise<Output>
    ) {
        super();
        this.descriptor = contract.descriptor;
    }

    public async execute(context: OperationContext, input: FacetData): Promise<FacetData> {
        const canonicalInput = validateCanonical(input, this.descriptor.input, "input");
        const typedInput = decode(this.contract.inputCodec, canonicalInput, "input");
        const output = await this.handler(typedInput, ProfileEffectContext.fromOperation(context));
        return encodeAndValidate(
            this.contract.outputCodec,
            this.descriptor.output,
            output,
            "output"
        );
    }
}

class ProfileSurfaceRuntime extends Surface {
    public constructor(
        private readonly host: ProfileRuntimeHostBinding,
        public readonly descriptor: SurfaceDescriptor,
        private readonly effects: ProfileRuntimeEffectsPort
    ) {
        super();
    }

    public render(context: OperationContext, input: FacetData): Promise<FacetData> {
        return this.effects.render(this.host, this.descriptor, context, canonicalFacetData(input));
    }
}

function encodeAndValidate<Value>(
    codec: { encode(value: Value): FacetData },
    schema: JsonSchema,
    value: Value,
    direction: "input" | "output"
): FacetData {
    let encoded: FacetData;
    try {
        encoded = codec.encode(value);
    } catch {
        throw direction === "input"
            ? invalidInput("Profile input encoding failed")
            : invalidOutput("Profile output encoding failed");
    }
    return validateCanonical(encoded, schema, direction);
}

function validateCanonical(
    data: FacetData,
    schema: JsonSchema,
    direction: "input" | "output"
): FacetData {
    const canonical = canonicalFacetData(data);
    if (!schema.accepts(canonical)) {
        throw direction === "input"
            ? invalidInput("Profile input does not match its Operation schema")
            : invalidOutput("Profile output does not match its Operation schema");
    }
    return canonical;
}

function decode<Value>(
    codec: { decode(data: FacetData): Value },
    data: FacetData,
    direction: "input" | "output"
): Value {
    try {
        return codec.decode(data);
    } catch {
        throw direction === "input"
            ? invalidInput("Profile input decoding failed")
            : invalidOutput("Profile output decoding failed");
    }
}

function invalidInput(message: string): DetailedProfileError<"wire.input"> {
    return new DetailedProfileError("operation.invalid-input", "wire.input", message);
}

function invalidOutput(message: string): DetailedProfileError<"wire.output"> {
    return new DetailedProfileError("operation.invalid-output", "wire.output", message);
}
