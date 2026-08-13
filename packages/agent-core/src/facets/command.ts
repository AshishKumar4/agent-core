import { isNonempty, JsonSchema } from "../core";
import type { FacetData } from "./data";
import {
    DataRecordCodec,
    dataRecord,
    compareText,
    requireArray,
    requireDataObject,
    requireExactFields,
    requireNonblank,
    requireOptionalString,
    requireSchemaDocument,
    requireString
} from "./data";
import { canonicalTrustTiers, type TrustTier } from "./event";
import { BindingName, OperationRef, SlotName } from "./id";
import { FieldMapping, FieldMove } from "./mapping";
import { BoundOperationRef } from "./operation";

export interface CommandInit {
    readonly name: string;
    readonly title: string;
    readonly help?: string | undefined;
    readonly arguments: JsonSchema;
    readonly operation: OperationRef;
    readonly binding: BindingName;
    readonly mapping?: FieldMapping | undefined;
    readonly acceptedTrust?: readonly [TrustTier, ...TrustTier[]] | undefined;
    readonly completion?: OperationRef | undefined;
    readonly surfaces: readonly SlotName[];
}

export class Command {
    public readonly name: string;
    public readonly title: string;
    public readonly help: string | undefined;
    public readonly arguments: JsonSchema;
    public readonly operation: OperationRef;
    public readonly binding: BindingName;
    public readonly mapping: FieldMapping | undefined;
    public readonly acceptedTrust: readonly [TrustTier, ...TrustTier[]] | undefined;
    public readonly completion: OperationRef | undefined;
    public readonly surfaces: readonly SlotName[];
    public readonly target: BoundOperationRef;

    public constructor(init: CommandInit) {
        requireNonblank(init.name, "Command name");
        requireNonblank(init.title, "Command title");
        if (init.help !== undefined) {
            requireNonblank(init.help, "Command help");
        }
        if (init.surfaces.length === 0) {
            throw new TypeError("Command surfaces must not be empty");
        }
        const surfaces = [...init.surfaces].sort((left, right) =>
            compareText(left.value, right.value)
        );
        if (new Set(surfaces.map((surface) => surface.value)).size !== surfaces.length) {
            throw new TypeError("Command surfaces must be unique");
        }
        this.name = init.name;
        this.title = init.title;
        this.help = init.help;
        this.arguments = init.arguments;
        this.operation = init.operation;
        this.binding = init.binding;
        this.target = new BoundOperationRef(init.binding, init.operation.operation);
        this.mapping = init.mapping;
        this.acceptedTrust =
            init.acceptedTrust === undefined ? undefined : canonicalTrustTiers(init.acceptedTrust);
        this.completion = init.completion;
        this.surfaces = Object.freeze(surfaces);
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): Command {
        const object = requireDataObject(payload, "Command");
        requireExactFields(
            object,
            ["arguments", "binding", "name", "operation", "surfaces", "title"],
            ["acceptedTrust", "completion", "help", "mapping"]
        );
        const acceptedTrustValue = object["acceptedTrust"];
        const acceptedTrust =
            acceptedTrustValue === undefined ? undefined : decodeTrustTiers(acceptedTrustValue);
        const mappingValue = object["mapping"];
        const completion = requireOptionalString(object["completion"], "Command completion");
        const help = requireOptionalString(object["help"], "Command help");
        const mapping =
            mappingValue === undefined
                ? undefined
                : new FieldMapping(
                      requireArray(mappingValue, "Command mapping").map(FieldMove.fromData)
                  );
        return new Command({
            name: requireString(object["name"], "Command name"),
            title: requireString(object["title"], "Command title"),
            arguments: new JsonSchema(
                requireSchemaDocument(object["arguments"], "Command arguments schema")
            ),
            operation: new OperationRef(requireString(object["operation"], "Command operation")),
            binding: new BindingName(requireString(object["binding"], "Command binding")),
            surfaces: requireArray(object["surfaces"], "Command surfaces").map(
                (value) => new SlotName(requireString(value, "Command surface"))
            ),
            help,
            mapping,
            acceptedTrust,
            completion: completion === undefined ? undefined : new OperationRef(completion)
        });
    }

    public static encode(command: Command): Uint8Array {
        return commandCodec.encode(command);
    }

    public static decode(bytes: Uint8Array): Command {
        return commandCodec.decode(bytes);
    }

    public toData(): FacetData {
        return dataRecord({
            arguments: this.arguments.document,
            binding: this.binding.value,
            name: this.name,
            operation: this.operation.value,
            surfaces: this.surfaces.map((surface) => surface.value),
            title: this.title,
            acceptedTrust: this.acceptedTrust,
            completion: this.completion?.value,
            help: this.help,
            mapping: this.mapping?.toData()
        });
    }
}

const commandCodec = new DataRecordCodec(
    "facet.command",
    (command: Command) => command.toData(),
    (payload) => Command.fromData(payload)
);

function decodeTrustTiers(value: FacetData): readonly [TrustTier, ...TrustTier[]] {
    const values = requireArray(value, "Command accepted trust").map(requireTrustTier);
    if (!isNonempty(values)) {
        throw new TypeError("Command accepted trust must not be empty");
    }
    return values;
}

function requireTrustTier(value: FacetData): TrustTier {
    if (
        value === "owner" ||
        value === "authenticated" ||
        value === "external" ||
        value === "self"
    ) {
        return value;
    }
    throw new TypeError("Command trust tier is invalid");
}
