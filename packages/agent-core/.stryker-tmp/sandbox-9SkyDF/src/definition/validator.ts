// @ts-nocheck
import {
    Digest,
    JsonSchema,
    strictJsonSchemaValidator,
    encodeCanonicalJson,
    type JsonSchemaValidator,
    type JsonValue
} from "../core";
import {
    Automation,
    Command,
    EventDeclaration,
    IngressDeclaration,
    InterceptorDeclaration,
    OperationDescriptor,
    Prompt,
    PromptContribution,
    SlotDeclaration,
    SlotName,
    SurfaceDescriptor,
    canonicalFacetData,
    type FacetData,
    type FacetDataMap,
    type FacetManifest
} from "../facets";
import { BASE_CONFIG_SCHEMA, composeConfigSchema } from "./config";
import { Blueprint } from "./blueprint";
import { PlatformCompatibility } from "./compatibility";
import { BlueprintDeclarationCodecPort } from "./declaration";
import { PackageLock, type PackagePin } from "./package-lock";
import { MetadataSnapshot, type PackageRelease } from "./package";
import { resolvePackageLock } from "./resolver";
import { ValidationAttestation } from "./attestation";
import { PlacementInput, type PlacementSelection, selectPlacement } from "./placement";
import { compareText } from "./order";
import { invalidDefinition } from "./error";

export const CORE_SLOT_NAMES = new Set([
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
const SLOT_DECLARATIONS = new SlotName("slots");

export interface BlueprintValidatorOptions {
    readonly lock: PackageLock;
    readonly releases: readonly PackageRelease[];
    readonly target: PlatformCompatibility;
    readonly declarationCodecs?: BlueprintDeclarationCodecPort;
    readonly placement: PlacementSourcePort;
    readonly schemaValidator?: JsonSchemaValidator;
    readonly baseConfigSchema?: JsonSchema;
    readonly coreSlots?: readonly SlotDeclaration[];
}

export interface ValidatedPlacement {
    readonly packageId: PackagePin["id"]["value"];
    readonly facetId: FacetManifest["id"]["value"];
    readonly facetVersion: string;
    readonly selection: PlacementSelection;
}

export abstract class PlacementSourcePort {
    public abstract sources(
        release: PackageRelease,
        manifest: FacetManifest
    ): {
        readonly substrate: readonly import("../facets").IsolationMode[];
        readonly trust: readonly import("../facets").IsolationMode[];
    };
}

export interface ValidatedContribution {
    readonly contributor: string;
    readonly index: number;
    readonly slot: string;
    readonly value: FacetData;
}

interface ValidatedBlueprintInit {
    readonly blueprint: Blueprint;
    readonly lock: PackageLock;
    readonly configSchema: JsonSchema;
    readonly declarations: readonly ValidatedContribution[];
    readonly releases: readonly PackageRelease[];
    readonly attestation: ValidationAttestation;
    readonly placements: readonly ValidatedPlacement[];
}

export class ValidatedBlueprint {
    readonly #blueprint: Blueprint;
    readonly #lock: PackageLock;
    readonly #configSchema: JsonSchema;
    readonly #declarations: readonly ValidatedContribution[];
    readonly #releases: readonly PackageRelease[];
    readonly #attestation: ValidationAttestation;
    readonly #placements: readonly ValidatedPlacement[];
    readonly #bytes: Uint8Array;
    public readonly digest: Digest;

    private constructor(init: ValidatedBlueprintInit) {
        this.#blueprint = init.blueprint;
        this.#lock = init.lock;
        this.#configSchema = init.configSchema;
        this.#declarations = Object.freeze(
            init.declarations.map((declaration) =>
                Object.freeze({
                    contributor: declaration.contributor,
                    index: declaration.index,
                    slot: declaration.slot,
                    value: canonicalFacetData(declaration.value)
                })
            )
        );
        this.#bytes = encodeCanonicalJson({
            blueprint: init.blueprint.toData(),
            lock: init.lock.toData(),
            releases: init.releases.map((release) => release.toData())
        });
        this.digest = Digest.sha256(this.#bytes);
        this.#releases = Object.freeze([...init.releases]);
        this.#attestation = init.attestation;
        this.#placements = Object.freeze([...init.placements]);
        Object.freeze(this);
    }

    public static validate(
        blueprint: Blueprint,
        options: BlueprintValidatorOptions
    ): ValidatedBlueprint {
        const releases = exactLockedReleases(blueprint, options.lock, options.releases);
        if (!options.lock.target.equals(options.target)) {
            throw invalidDefinition(
                "PackageLock compatibility target does not match the current platform"
            );
        }
        const configSchema = composeConfigSchema(
            options.baseConfigSchema ?? BASE_CONFIG_SCHEMA,
            releases
        );
        const settings = settingsData(blueprint, releases);
        const schemaValidator = options.schemaValidator ?? strictJsonSchemaValidator;
        if (!configSchema.accepts(settings, schemaValidator)) {
            throw invalidDefinition(
                "Blueprint package config does not match the composed config schema"
            );
        }
        validateOwnerDeclarations(blueprint, options.declarationCodecs);
        const declarations = validateDeclarations(
            blueprint,
            releases,
            schemaValidator,
            options.coreSlots ?? []
        );
        const placements = validatePlacements(blueprint, releases, options.placement);
        const blueprintDigest = Digest.sha256(Blueprint.encode(blueprint));
        const declarationDigest = Digest.sha256(
            encodeCanonicalJson(
                declarations.map((declaration) => ({
                    contributor: declaration.contributor,
                    index: declaration.index,
                    slot: declaration.slot,
                    value: declaration.value
                }))
            )
        );
        const configSchemaDigest = Digest.sha256(encodeCanonicalJson(configSchema.document));
        const definitionDigest = Digest.sha256(
            encodeCanonicalJson({
                blueprint: blueprint.toData(),
                lock: options.lock.toData(),
                releases: releases.map((release) => release.toData())
            })
        );
        const attestation = new ValidationAttestation({
            definitionDigest,
            blueprintDigest,
            packageLockDigest: options.lock.digest,
            snapshotDigest: options.lock.snapshotDigest,
            configSchemaDigest,
            declarationDigest,
            placementDigest: Digest.sha256(
                encodeCanonicalJson(
                    placements.map((placement) => ({
                        facetId: placement.facetId,
                        facetVersion: placement.facetVersion,
                        packageId: placement.packageId,
                        selection: placementData(placement.selection)
                    }))
                )
            ),
            target: options.target
        });
        return new ValidatedBlueprint({
            blueprint,
            lock: options.lock,
            configSchema,
            declarations,
            releases,
            attestation,
            placements
        });
    }

    public get blueprint(): Blueprint {
        return this.#blueprint;
    }

    public get lock(): PackageLock {
        return this.#lock;
    }

    public get configSchema(): JsonSchema {
        return this.#configSchema;
    }

    public get declarations(): readonly ValidatedContribution[] {
        return this.#declarations;
    }

    public get releases(): readonly PackageRelease[] {
        return this.#releases;
    }

    public get attestation(): ValidationAttestation {
        return this.#attestation;
    }

    public get placements(): readonly ValidatedPlacement[] {
        return this.#placements;
    }

    public bytes(): Uint8Array {
        return this.#bytes.slice();
    }
}

function validatePlacements(
    blueprint: Blueprint,
    releases: readonly PackageRelease[],
    source: PlacementSourcePort
): readonly ValidatedPlacement[] {
    const placements = releases.flatMap((release) =>
        release.manifests.map((manifest) => {
            const supplied = source.sources(release, manifest);
            const selected = selectPlacement(
                new PlacementInput({
                    manifest: manifest.isolation,
                    policy: blueprint.policies.placement.allowed,
                    substrate: supplied.substrate,
                    trust: supplied.trust
                })
            );
            return Object.freeze({
                packageId: release.id.value,
                facetId: manifest.id.value,
                facetVersion: manifest.version.toString(),
                selection: selected
            });
        })
    );
    placements.sort(
        (left, right) =>
            compareText(left.packageId, right.packageId) ||
            compareText(left.facetId, right.facetId) ||
            compareText(left.facetVersion, right.facetVersion)
    );
    return Object.freeze(placements);
}

function placementData(selection: PlacementSelection): JsonValue {
    return {
        manifest: selection.manifest,
        policy: selection.policy,
        selected: selection.selected,
        substrate: selection.substrate,
        trust: selection.trust
    };
}

export class BlueprintValidator {
    public constructor(private readonly options: BlueprintValidatorOptions) {
        Object.freeze(this);
    }

    public validate(blueprint: Blueprint): ValidatedBlueprint {
        return ValidatedBlueprint.validate(blueprint, this.options);
    }
}

export function validateBlueprint(
    blueprint: Blueprint,
    options: BlueprintValidatorOptions
): ValidatedBlueprint {
    return ValidatedBlueprint.validate(blueprint, options);
}

function exactLockedReleases(
    blueprint: Blueprint,
    lock: PackageLock,
    releases: readonly PackageRelease[]
): readonly PackageRelease[] {
    const snapshot = new MetadataSnapshot({
        revision: lock.snapshotRevision,
        digest: lock.snapshotDigest,
        releases
    });
    const resolved = resolvePackageLock(
        snapshot,
        blueprint.packages.map((install) => install.request),
        lock.target
    );
    if (!bytesEqual(PackageLock.encode(resolved), PackageLock.encode(lock))) {
        throw invalidDefinition(
            "PackageLock does not match deterministic resolution of its metadata snapshot"
        );
    }
    return Object.freeze(
        lock.packages.map((pin) => {
            const release = snapshot.releases.find((candidate) => matchesPin(candidate, pin));
            if (release === undefined) {
                throw invalidDefinition(`Package metadata does not match lock pin ${pin.id.value}`);
            }
            return release;
        })
    );
}

function matchesPin(release: PackageRelease, pin: PackagePin): boolean {
    return (
        release.id.equals(pin.id) &&
        release.version.equals(pin.version) &&
        release.manifestDigest.equals(pin.manifestDigest) &&
        release.codeDigest.equals(pin.codeDigest)
    );
}

function settingsData(blueprint: Blueprint, releases: readonly PackageRelease[]): FacetDataMap {
    const roots = new Map(
        blueprint.packages.map((install) => [install.request.id.value, install.config.toData()])
    );
    return Object.fromEntries(
        releases.map((release) => [release.id.value, roots.get(release.id.value) ?? {}])
    );
}

function validateDeclarations(
    blueprint: Blueprint,
    releases: readonly PackageRelease[],
    schemaValidator: JsonSchemaValidator,
    coreSlots: readonly SlotDeclaration[]
): readonly ValidatedContribution[] {
    const slots = new Map<string, SlotDeclaration>();
    for (const slot of coreSlots) {
        addSlot(slots, slot, "Core slot");
    }
    for (const data of blueprint.slots ?? []) {
        const slot = SlotDeclaration.fromData(data);
        rejectCoreSlotRedefinition(slot);
        addSlot(slots, slot, "Blueprint slot");
    }

    const manifests = releases.flatMap((release) => release.manifests).sort(compareManifests);
    for (const manifest of manifests) {
        for (const value of manifest.contributions.get(SLOT_DECLARATIONS) ?? []) {
            const slot = SlotDeclaration.fromData(value);
            rejectCoreSlotRedefinition(slot);
            addSlot(slots, slot, `Package ${manifest.id.value} slot`);
        }
    }

    const declarations: ValidatedContribution[] = [];
    for (const manifest of manifests) {
        for (const contribution of manifest.contributions.entries) {
            for (const [index, value] of contribution.entries.entries()) {
                if (CORE_SLOT_NAMES.has(contribution.slot.value)) {
                    validateCoreContribution(contribution.slot.value, value);
                }
                const slot = slots.get(contribution.slot.value);
                if (!CORE_SLOT_NAMES.has(contribution.slot.value) && slot === undefined) {
                    throw invalidDefinition(
                        `Contribution targets undeclared slot ${contribution.slot.value}`
                    );
                }
                if (slot !== undefined && !slot.entrySchema.accepts(value, schemaValidator)) {
                    throw invalidDefinition(
                        `Contribution does not match slot ${contribution.slot.value}`
                    );
                }
                declarations.push({
                    contributor: manifest.id.value,
                    index,
                    slot: contribution.slot.value,
                    value
                });
            }
        }
    }
    validateCommandSurfaceSlots(manifests, slots);
    declarations.sort(compareDeclarations);
    return Object.freeze(declarations);
}

function validateCoreContribution(slot: string, value: FacetData): void {
    switch (slot) {
        case "automations":
            Automation.fromData(value);
            break;
        case "commands":
            Command.fromData(value);
            break;
        case "events":
            EventDeclaration.fromData(value);
            break;
        case "ingress":
            IngressDeclaration.fromData(value);
            break;
        case "interceptors":
            InterceptorDeclaration.fromData(value);
            break;
        case "operations":
            OperationDescriptor.fromData(value);
            break;
        case "prompt":
            validatePromptContribution(value);
            break;
        case "settings":
            requireSchemaDocument(value);
            break;
        case "slots":
            SlotDeclaration.fromData(value);
            break;
        case "surfaces":
            SurfaceDescriptor.fromData(value);
            break;
    }
}

function validatePromptContribution(value: FacetData): void {
    if (!Array.isArray(value)) {
        throw invalidDefinition("Prompt contribution must be an array");
    }
    new PromptContribution(value.map(Prompt.fromData));
}

function validateCommandSurfaceSlots(
    manifests: readonly FacetManifest[],
    slots: ReadonlyMap<string, SlotDeclaration>
): void {
    for (const manifest of manifests) {
        for (const value of manifest.contributions.get(new SlotName("commands")) ?? []) {
            const command = Command.fromData(value);
            for (const surface of command.surfaces) {
                if (!CORE_SLOT_NAMES.has(surface.value) && !slots.has(surface.value)) {
                    throw invalidDefinition(
                        `Command ${command.name} targets undeclared surface slot ${surface.value}`
                    );
                }
            }
        }
    }
}

function addSlot(
    slots: Map<string, SlotDeclaration>,
    slot: SlotDeclaration,
    subject: string
): void {
    slot.entrySchema.assertValid();
    if (slots.has(slot.name.value)) {
        throw invalidDefinition(`${subject} duplicates slot ${slot.name.value}`);
    }
    slots.set(slot.name.value, slot);
}

function rejectCoreSlotRedefinition(slot: SlotDeclaration): void {
    if (CORE_SLOT_NAMES.has(slot.name.value)) {
        throw invalidDefinition(`Core slot ${slot.name.value} cannot be redefined`);
    }
}

function validateOwnerDeclarations(
    blueprint: Blueprint,
    codecs: BlueprintDeclarationCodecPort | undefined
): void {
    const declarations = [
        ["scopes", blueprint.scopes === undefined ? [] : [blueprint.scopes]],
        ["agents", blueprint.agents],
        ["slots", blueprint.slots ?? []],
        ["subscriptions", blueprint.subscriptions ?? []],
        ["environments", blueprint.environments ?? []],
        ["surfaces", blueprint.surfaces === undefined ? [] : [blueprint.surfaces]]
    ] as const;
    for (const [field, values] of declarations) {
        for (const value of values) {
            if (codecs === undefined) {
                throw invalidDefinition(
                    `Blueprint ${field} requires an owner-published declaration codec`
                );
            }
            const canonical = codecs.canonicalize(field, value);
            if (!bytesEqual(encodeCanonicalJson(canonical), encodeCanonicalJson(value))) {
                throw invalidDefinition(
                    `Blueprint ${field} declaration is not canonical for its owner codec`
                );
            }
        }
    }
}

function requireSchemaDocument(value: FacetData): void {
    if (typeof value === "boolean") return;
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw invalidDefinition("Settings contribution must be a JSON Schema object or boolean");
    }
    new JsonSchema(value as FacetDataMap);
}

function compareManifests(left: FacetManifest, right: FacetManifest): number {
    return (
        compareText(left.id.value, right.id.value) ||
        compareText(left.version.toString(), right.version.toString())
    );
}

function compareDeclarations(left: ValidatedContribution, right: ValidatedContribution): number {
    return (
        compareText(left.contributor, right.contributor) ||
        compareText(left.slot, right.slot) ||
        left.index - right.index
    );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}
