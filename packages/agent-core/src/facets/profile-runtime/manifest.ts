import { JsonSchema, type CompatRange, type SemVer } from "../../core";
import { Command } from "../command";
import { Contributions, OperationDescriptor } from "../contribution";
import { EventDeclaration } from "../event";
import type { FacetPackageId } from "../id";
import type { BindingRequirement, IsolationMode } from "../manifest";
import { FacetManifest } from "../manifest";
import { Prompt, PromptContribution } from "../prompt";
import { SlotDeclaration } from "../slot";
import { DetailedProfileError } from "./error";

const CORE_CONTRIBUTION_SLOTS = new Set([
    "automations",
    "commands",
    "events",
    "ingress",
    "interceptors",
    "operations",
    "prompt",
    "settings",
    "slots",
    "surfaces"
]);

export interface StandardProfileManifestInit {
    readonly id: FacetPackageId;
    readonly version: SemVer;
    readonly compat: CompatRange;
    readonly bindings: readonly BindingRequirement[];
    readonly configSchema?: JsonSchema;
}

export interface StandardProfileManifestDefinition {
    readonly isolation: readonly [IsolationMode, ...IsolationMode[]];
    readonly contributions: Contributions;
    readonly requiredBindings?: readonly string[];
    readonly configConstraint?: JsonSchema;
}

export function createStandardProfileManifest(
    init: StandardProfileManifestInit,
    definition: StandardProfileManifestDefinition
): FacetManifest {
    const bindingNames = new Set(init.bindings.map((binding) => binding.name.value));
    for (const required of definition.requiredBindings ?? []) {
        if (!bindingNames.has(required)) {
            throw invalidManifest(`Standard profile manifest requires binding ${required}`);
        }
    }
    validateContributions(definition.contributions);
    const configSchema = composeConfigSchema(definition.configConstraint, init.configSchema);
    configSchema?.assertValid();
    return new FacetManifest({
        id: init.id,
        version: init.version,
        compat: init.compat,
        isolation: definition.isolation,
        bindings: init.bindings,
        contributions: definition.contributions,
        ...(configSchema === undefined ? {} : { configSchema })
    });
}

function composeConfigSchema(
    constraint: JsonSchema | undefined,
    supplied: JsonSchema | undefined
): JsonSchema | undefined {
    if (constraint === undefined) return supplied;
    if (supplied === undefined) return constraint;
    return new JsonSchema({ allOf: [constraint.document, supplied.document] });
}

function validateContributions(contributions: Contributions): void {
    const declaredSlots = new Map<string, SlotDeclaration>();
    for (const entry of contributions.entries.find(
        (contribution) => contribution.slot.value === "slots"
    )?.entries ?? []) {
        const declaration = SlotDeclaration.fromData(entry);
        declaration.entrySchema.assertValid();
        declaredSlots.set(declaration.name.value, declaration);
    }
    for (const contribution of contributions.entries) {
        for (const entry of contribution.entries) {
            validateCoreContribution(contribution.slot.value, entry);
            if (!CORE_CONTRIBUTION_SLOTS.has(contribution.slot.value)) {
                const declaration = declaredSlots.get(contribution.slot.value);
                if (declaration === undefined) {
                    throw invalidManifest(
                        `Standard profile contribution targets undeclared slot ${contribution.slot.value}`
                    );
                }
                if (!declaration.entrySchema.accepts(entry)) {
                    throw invalidManifest(
                        `Standard profile contribution does not match slot ${contribution.slot.value}`
                    );
                }
            }
        }
    }
}

function validateCoreContribution(slot: string, entry: import("../data").FacetData): void {
    switch (slot) {
        case "commands":
            Command.fromData(entry).arguments.assertValid();
            break;
        case "events":
            EventDeclaration.fromData(entry).payload.assertValid();
            break;
        case "operations": {
            const operation = OperationDescriptor.fromData(entry);
            operation.input.assertValid();
            operation.output.assertValid();
            break;
        }
        case "prompt": {
            if (!Array.isArray(entry)) {
                throw invalidManifest("Prompt contribution must be an array");
            }
            new PromptContribution(entry.map(Prompt.fromData));
            break;
        }
        case "slots":
            SlotDeclaration.fromData(entry).entrySchema.assertValid();
            break;
    }
}

function invalidManifest(message: string): DetailedProfileError<"manifest.invalid"> {
    return new DetailedProfileError("protocol.invalid-state", "manifest.invalid", message);
}
