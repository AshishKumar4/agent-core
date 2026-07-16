// @ts-nocheck
import type { JsonSchema } from "../../core";
import { OperationDescriptor } from "../contribution";
import type { FacetData } from "../data";
import type { EventDeclaration } from "../event";
import { OperationName } from "../id";
import type { ProfileWireCodec } from "./wire";

export interface PublicProfileInput {
    readonly authority?: never;
    readonly trust?: never;
    readonly lease?: never;
    readonly impact?: never;
    readonly invocationId?: never;
    readonly receiptId?: never;
    readonly provenance?: never;
}

export type ProfileOperationResultMode = "output" | "receipt";

export class ProfileOperationContract<
    Name extends string,
    Input,
    Output,
    ResultMode extends ProfileOperationResultMode = "output"
> {
    declare public readonly __input: Input;
    declare public readonly __output: Output;

    public constructor(
        public readonly name: Name,
        public readonly descriptor: OperationDescriptor,
        public readonly inputCodec: ProfileWireCodec<Input>,
        public readonly outputCodec: ProfileWireCodec<Output>,
        public readonly resultMode: ResultMode
    ) {
        if (descriptor.name.value !== name) {
            throw new TypeError("Profile operation contract name must match its descriptor");
        }
        descriptor.input.assertValid();
        descriptor.output.assertValid();
        Object.freeze(this);
    }

    public encodeInput(input: Input): FacetData {
        return this.inputCodec.encode(input);
    }
    public decodeInput(data: FacetData): Input {
        return this.inputCodec.decode(data);
    }
    public encodeOutput(output: Output): FacetData {
        return this.outputCodec.encode(output);
    }
    public decodeOutput(data: FacetData): Output {
        return this.outputCodec.decode(data);
    }

    public alias<Alias extends string>(
        name: Alias
    ): ProfileOperationContract<Alias, Input, Output, ResultMode> {
        return new ProfileOperationContract(
            name,
            new OperationDescriptor(
                new OperationName(name),
                this.descriptor.impact,
                this.descriptor.input,
                this.descriptor.output,
                this.descriptor.help,
                this.descriptor.interceptable
            ),
            this.inputCodec,
            this.outputCodec,
            this.resultMode
        );
    }
}

export class ProfileEventContract<Kind extends string, Payload extends PublicProfileInput> {
    declare public readonly __payload: Payload;

    public constructor(
        public readonly kind: Kind,
        public readonly declaration: EventDeclaration,
        public readonly payloadCodec: ProfileWireCodec<Payload>
    ) {
        if (declaration.kind.value !== kind) {
            throw new TypeError("Profile Event contract kind must match its declaration");
        }
        declaration.payload.assertValid();
        Object.freeze(this);
    }

    public encodePayload(payload: Payload): FacetData {
        return this.payloadCodec.encode(payload);
    }
    public decodePayload(data: FacetData): Payload {
        return this.payloadCodec.decode(data);
    }
}

export class ProfileControlContract<Name extends string, Input extends PublicProfileInput, Output> {
    declare public readonly __input: Input;
    declare public readonly __output: Output;

    public constructor(
        public readonly name: Name,
        public readonly input: JsonSchema,
        public readonly output: JsonSchema,
        public readonly inputCodec: ProfileWireCodec<Input>,
        public readonly outputCodec: ProfileWireCodec<Output>
    ) {
        if (name.trim().length === 0 || name !== name.trim()) {
            throw new TypeError("Profile control contract name must be canonical");
        }
        input.assertValid();
        output.assertValid();
        Object.freeze(this);
    }

    public encodeInput(input: Input): FacetData {
        return this.inputCodec.encode(input);
    }
    public decodeInput(data: FacetData): Input {
        return this.inputCodec.decode(data);
    }
    public encodeOutput(output: Output): FacetData {
        return this.outputCodec.encode(output);
    }
    public decodeOutput(data: FacetData): Output {
        return this.outputCodec.decode(data);
    }
}

export type AnyProfileOperationContract = Pick<
    ProfileOperationContract<string, unknown, unknown, ProfileOperationResultMode>,
    "name" | "descriptor" | "resultMode"
>;

export type ProfileOperationInput<Contract> =
    Contract extends ProfileOperationContract<
        string,
        infer Input,
        unknown,
        ProfileOperationResultMode
    >
        ? Input
        : never;

export type ProfileOperationOutput<Contract> =
    Contract extends ProfileOperationContract<
        string,
        unknown,
        infer Output,
        ProfileOperationResultMode
    >
        ? Output
        : never;

export type ProfileOperationResult<Contract, Receipt> =
    Contract extends ProfileOperationContract<string, unknown, infer Output, infer ResultMode>
        ? ResultMode extends "receipt"
            ? Receipt
            : Output
        : never;

export type ProfileEventPayload<Contract> =
    Contract extends ProfileEventContract<string, infer Payload> ? Payload : never;

export type ProfileControlInput<Contract> =
    Contract extends ProfileControlContract<string, infer Input, unknown> ? Input : never;

export type ProfileControlOutput<Contract> =
    Contract extends ProfileControlContract<string, PublicProfileInput, infer Output>
        ? Output
        : never;

export type ProfileHandler<Input, Output, Context = void> = (
    input: Input,
    context: Context
) => Output | Promise<Output>;
