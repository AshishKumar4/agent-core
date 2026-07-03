import type { OperationContext } from "../operations/context";
import type { BindingAuthority } from "../authority";
import { AgentCoreError, invariant } from "../errors";
import type { FacetData, FacetDataSchema } from "./data";
import type { BindingName, FacetOperationName } from "./id";
import type { InvocationImpact } from "../invocations";

export class OperationAddress {
    public constructor(
        public readonly bindingName: BindingName,
        public readonly operationName: FacetOperationName
    ) {
    }

    public equals(other: OperationAddress): boolean {
        return this.bindingName.equals(other.bindingName)
            && this.operationName.equals(other.operationName);
    }
}

export class OperationDescriptor<
    Input extends FacetData = FacetData,
    Output extends FacetData = FacetData
> {
    public constructor(
        public readonly name: FacetOperationName,
        public readonly description: string,
        public readonly impact: InvocationImpact,
        public readonly input: FacetDataSchema<Input>,
        public readonly output: FacetDataSchema<Output>
    ) {
        if (description.length === 0) {
            throw new TypeError("Operation description must not be empty");
        }
    }
}

export abstract class Operation<
    Input extends FacetData = FacetData,
    Output extends FacetData = FacetData
> {
    protected constructor(public readonly descriptor: OperationDescriptor<Input, Output>) {
    }

    public get name(): FacetOperationName {
        return this.descriptor.name;
    }

    public get description(): string {
        return this.descriptor.description;
    }

    public get impact(): InvocationImpact {
        return this.descriptor.impact;
    }

    public abstract execute(
        context: OperationContext,
        input: Input
    ): Promise<Output>;
}

export abstract class FacetOperationHandler<
    Input extends FacetData,
    Output extends FacetData
> {
    public abstract execute(
        context: OperationContext,
        input: Input
    ): Promise<Output>;
}

export class FacetOperation<
    Input extends FacetData = FacetData,
    Output extends FacetData = FacetData
> extends Operation<Input, Output> {
    public constructor(
        descriptor: OperationDescriptor<Input, Output>,
        private readonly handler: FacetOperationHandler<Input, Output>
    ) {
        super(descriptor);
    }

    public async execute(
        context: OperationContext,
        input: Input
    ): Promise<Output> {
        invariant(
            this.descriptor.input.accepts(input),
            "operation.invalid-input",
            `Operation ${this.name.value} received invalid input`
        );

        const output = await this.handler.execute(context, input);
        invariant(
            this.descriptor.output.accepts(output),
            "operation.invalid-output",
            `Operation ${this.name.value} produced invalid output`
        );

        return output;
    }
}

export class OperationSet {
    public readonly operations: readonly Operation[];

    public constructor(operations: readonly Operation[]) {
        ensureUniqueOperationNames(operations);
        this.operations = Object.freeze([...operations]);
    }

    public static empty(): OperationSet {
        return emptyOperationSet;
    }

    public static of(operations: readonly Operation[]): OperationSet {
        return new OperationSet(operations);
    }

    public merge(other: OperationSet): OperationSet {
        return new OperationSet([...this.operations, ...other.operations]);
    }
}

export class OperationBinding<
    Input extends FacetData = FacetData,
    Output extends FacetData = FacetData
> {
    public readonly authority?: BindingAuthority;

    public constructor(
        public readonly address: OperationAddress,
        public readonly operation: Operation<Input, Output>,
        authority: BindingAuthority | undefined,
        private readonly available: () => boolean = alwaysAvailable
    ) {
        if (authority !== undefined) {
            this.authority = authority;
        }

        if (!address.operationName.equals(operation.name)) {
            throw new TypeError("Operation binding address must match the operation name");
        }
    }

    public get bindingName(): BindingName {
        return this.address.bindingName;
    }

    public get name(): FacetOperationName {
        return this.address.operationName;
    }

    public get description(): string {
        return this.operation.description;
    }

    public get descriptor(): OperationDescriptor<Input, Output> {
        return this.operation.descriptor;
    }

    public async execute(
        context: OperationContext,
        input: Input
    ): Promise<Output> {
        if (this.authority === undefined) {
            throw new AgentCoreError("authority.denied", "Operation execution requires bound authority");
        }

        if (!context.permits(this.authority)) {
            throw new AgentCoreError("authority.denied", "Operation invocation requires matching Binding authority");
        }

        if (!this.available()) {
            throw new AgentCoreError("facet.inactive", "Operation execution requires an active Facet");
        }

        return await this.operation.execute(context, input);
    }
}

export class OperationCatalog {
    public readonly operations: readonly OperationBinding[];

    public constructor(operations: readonly OperationBinding[]) {
        ensureUniqueOperationAddresses(operations);
        this.operations = Object.freeze([...operations]);
    }

    public static empty(): OperationCatalog {
        return emptyOperationCatalog;
    }

    public static of(
        bindingName: BindingName,
        operations: readonly Operation[],
        authority: BindingAuthority | undefined = undefined,
        available: () => boolean = alwaysAvailable
    ): OperationCatalog {
        return new OperationCatalog(operations.map(operation => new OperationBinding(
            new OperationAddress(bindingName, operation.name),
            operation,
            authority,
            available
        )));
    }

    public static from(
        bindingName: BindingName,
        operations: OperationSet,
        authority: BindingAuthority | undefined = undefined,
        available: () => boolean = alwaysAvailable
    ): OperationCatalog {
        return OperationCatalog.of(bindingName, operations.operations, authority, available);
    }

    public merge(other: OperationCatalog): OperationCatalog {
        return new OperationCatalog([...this.operations, ...other.operations]);
    }

    public resolve(address: OperationAddress): OperationBinding | undefined {
        return this.operations.find(operation => operation.address.equals(address));
    }
}

function ensureUniqueOperationNames(operations: readonly Operation[]): void {
    const names = new Set<string>();

    for (const operation of operations) {
        const name = operation.name.value;
        if (names.has(name)) {
            throw new TypeError(`Facet operations must have unique names: ${name}`);
        }

        names.add(name);
    }
}

function ensureUniqueOperationAddresses(operations: readonly OperationBinding[]): void {
    const addresses = new Set<string>();

    for (const operation of operations) {
        const key = operationAddressKey(operation.address);
        if (addresses.has(key)) {
            throw new TypeError("Operation addresses must be unique");
        }

        addresses.add(key);
    }
}

function operationAddressKey(address: OperationAddress): string {
    return `${address.bindingName.value.length}:${address.bindingName.value}${address.operationName.value}`;
}

const emptyOperationSet = new OperationSet([]);
const emptyOperationCatalog = new OperationCatalog([]);

function alwaysAvailable(): boolean {
    return true;
}
