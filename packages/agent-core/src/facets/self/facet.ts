import type { JsonValue } from "../../core";
import { Contributions, Contribution, OperationDescriptor } from "../contribution";
import { requireDataObject, type FacetData, type FacetDataMap } from "../data";
import { OperationName, SlotName } from "../id";
import type { FacetManifest } from "../manifest";
import {
    ProfileOperationContract,
    InternalProfileFacetRuntime,
    facetDataWireCodec,
    profileWireCodec,
    type ProtectedProfileRuntimePort,
    type PublicProfileInput,
    schema,
    strictObjectSchema
} from "../profile-runtime";

export interface SelfCheckpointInput extends PublicProfileInput {
    readonly checkpoint: JsonValue;
}

export interface SelfCommitMessageInput extends PublicProfileInput {
    readonly message: JsonValue;
}

export interface SelfSpawnInput extends PublicProfileInput {
    readonly child: JsonValue;
}

export interface SelfFinishInput extends PublicProfileInput {
    readonly result: JsonValue;
}

export interface SelfMigrationInput extends PublicProfileInput {
    readonly migration: JsonValue;
}

export abstract class SelfRunDependency {
    public abstract checkpoint(input: SelfCheckpointInput): Promise<JsonValue>;
    public abstract commitMessage(input: SelfCommitMessageInput): Promise<JsonValue>;
    public abstract spawn(input: SelfSpawnInput): Promise<JsonValue>;
    public abstract finish(input: SelfFinishInput): Promise<JsonValue>;
    public abstract proposeMigration(input: SelfMigrationInput): Promise<JsonValue>;
}

// The wire property is the single field the Operation's input carries. Constraining Input
// to carry that exact property is what stops a contract from describing one field and
// decoding another: the caller's own builder has to produce the Input, so a contract whose
// schema names one field and whose builder writes a different one does not compile.
function operation<
    Name extends string,
    Property extends string,
    Input extends PublicProfileInput & { readonly [Key in Property]: JsonValue }
>(
    name: Name,
    impact: "mutate" | "delegate" | "administer",
    property: Property,
    build: (value: JsonValue) => Input
): ProfileOperationContract<Name, Input, JsonValue> {
    const input = strictObjectSchema({ [property]: {} }, [property]);
    return new ProfileOperationContract(
        name,
        new OperationDescriptor(new OperationName(name), impact, input, schema({})),
        profileWireCodec(
            (value) => ({ [property]: value[property] }),
            (data) =>
                build(
                    requireField(
                        requireDataObject(data, `Self ${name} input`),
                        property,
                        `Self ${name} input`
                    )
                )
        ),
        facetDataWireCodec(),
        "output"
    );
}

function requireField(input: FacetDataMap, property: string, subject: string): FacetData {
    const value = input[property];
    if (value === undefined) throw new TypeError(`${subject} must carry ${property}`);
    return value;
}

export const SELF_OPERATION_CONTRACTS = Object.freeze({
    checkpoint: operation<"checkpoint", "checkpoint", SelfCheckpointInput>(
        "checkpoint",
        "mutate",
        "checkpoint",
        (checkpoint) => ({ checkpoint })
    ),
    commitMessage: operation<"commitMessage", "message", SelfCommitMessageInput>(
        "commitMessage",
        "mutate",
        "message",
        (message) => ({ message })
    ),
    spawn: operation<"spawn", "child", SelfSpawnInput>("spawn", "delegate", "child", (child) => ({
        child
    })),
    finish: operation<"finish", "result", SelfFinishInput>(
        "finish",
        "mutate",
        "result",
        (result) => ({ result })
    ),
    proposeMigration: operation<"proposeMigration", "migration", SelfMigrationInput>(
        "proposeMigration",
        "administer",
        "migration",
        (migration) => ({ migration })
    )
});

export const SELF_OPERATIONS: readonly OperationDescriptor[] = Object.freeze(
    Object.values(SELF_OPERATION_CONTRACTS).map((contract) => contract.descriptor)
);
export const SELF_CONTRIBUTIONS = new Contributions([
    new Contribution(
        new SlotName("operations"),
        SELF_OPERATIONS.map((operation) => operation.toData())
    )
]);

export class SelfFacet<Receipt> {
    public static readonly operations = SELF_OPERATIONS;

    public constructor(
        private readonly runtime: ProtectedProfileRuntimePort<Receipt>,
        private readonly run: SelfRunDependency
    ) {}

    public asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime {
        return new InternalProfileFacetRuntime({
            manifest,
            runtime: this.runtime,
            operations: [
                this.runtime.operation(SELF_OPERATION_CONTRACTS.checkpoint, (input) =>
                    this.run.checkpoint(input)
                ),
                this.runtime.operation(SELF_OPERATION_CONTRACTS.commitMessage, (input) =>
                    this.run.commitMessage(input)
                ),
                this.runtime.operation(SELF_OPERATION_CONTRACTS.spawn, (input) =>
                    this.run.spawn(input)
                ),
                this.runtime.operation(SELF_OPERATION_CONTRACTS.finish, (input) =>
                    this.run.finish(input)
                ),
                this.runtime.operation(SELF_OPERATION_CONTRACTS.proposeMigration, (input) =>
                    this.run.proposeMigration(input)
                )
            ]
        });
    }

    public checkpoint(input: SelfCheckpointInput): Promise<JsonValue> {
        return this.runtime.invoke(SELF_OPERATION_CONTRACTS.checkpoint, input, (admitted) =>
            this.run.checkpoint(admitted)
        );
    }

    public commitMessage(input: SelfCommitMessageInput): Promise<JsonValue> {
        return this.runtime.invoke(SELF_OPERATION_CONTRACTS.commitMessage, input, (admitted) =>
            this.run.commitMessage(admitted)
        );
    }

    public spawn(input: SelfSpawnInput): Promise<JsonValue> {
        return this.runtime.invoke(SELF_OPERATION_CONTRACTS.spawn, input, (admitted) =>
            this.run.spawn(admitted)
        );
    }

    public finish(input: SelfFinishInput): Promise<JsonValue> {
        return this.runtime.invoke(SELF_OPERATION_CONTRACTS.finish, input, (admitted) =>
            this.run.finish(admitted)
        );
    }

    public proposeMigration(input: SelfMigrationInput): Promise<JsonValue> {
        return this.runtime.invoke(SELF_OPERATION_CONTRACTS.proposeMigration, input, (admitted) =>
            this.run.proposeMigration(admitted)
        );
    }
}
