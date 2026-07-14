import type { JsonValue } from "../../core";
import { Contributions, Contribution, OperationDescriptor } from "../contribution";
import { requireDataObject } from "../data";
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

function operation<Name extends string, Input extends PublicProfileInput>(
    name: Name,
    impact: "mutate" | "delegate" | "administer",
    property: string
): ProfileOperationContract<Name, Input, JsonValue> {
    const input = strictObjectSchema({ [property]: {} }, [property]);
    return new ProfileOperationContract(
        name,
        new OperationDescriptor(new OperationName(name), impact, input, schema({})),
        profileWireCodec(
            (value) => ({ [property]: value[property as keyof Input] as JsonValue }),
            (data) =>
                ({
                    [property]: requireDataObject(data, `Self ${name} input`)[property]!
                }) as unknown as Input
        ),
        facetDataWireCodec<JsonValue>(),
        "output"
    );
}

export const SELF_OPERATION_CONTRACTS = Object.freeze({
    checkpoint: operation<"checkpoint", SelfCheckpointInput>("checkpoint", "mutate", "checkpoint"),
    commitMessage: operation<"commitMessage", SelfCommitMessageInput>(
        "commitMessage",
        "mutate",
        "message"
    ),
    spawn: operation<"spawn", SelfSpawnInput>("spawn", "delegate", "child"),
    finish: operation<"finish", SelfFinishInput>("finish", "mutate", "result"),
    proposeMigration: operation<"proposeMigration", SelfMigrationInput>(
        "proposeMigration",
        "administer",
        "migration"
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
