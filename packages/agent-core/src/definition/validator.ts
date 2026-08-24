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
    type AuthoredCodeBackingId,
    type AuthoredCodeConsumer,
    type FacetData,
    type FacetDataMap,
    type FacetManifest,
    type IsolationMode
} from "../facets";
import { BASE_CONFIG_SCHEMA, composeConfigSchema } from "./config";
import { Blueprint } from "./blueprint";
import { PlatformCompatibility, compatibilityAdmits } from "./compatibility";
import { BlueprintDeclarationCodecPort } from "./declaration";
import { PackageLock, PackagePin } from "./package-lock";
import { BLUEPRINT_CONTRIBUTOR } from "./materialization-kind";
import { MetadataSnapshot, type PackageRelease } from "./package";
import { resolvePackageLock } from "./resolver";
import { ValidationAttestation } from "./attestation";
import { PlacementInput, type PlacementSelection, selectPlacement } from "./placement";
import { compareText } from "./order";
import type { DefinitionPinSet } from "./pins";
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
const OPERATION_DECLARATIONS = new SlotName("operations");
// §4.7 names three consumers of agent-authored code; programmatic tool calling is the
// only one that reaches Operations, so it is the consumer an `operations` availability
// declaration depends on being served.
const AUTHORED_CODE_OPERATION_CONSUMER: AuthoredCodeConsumer = "programmaticToolCall";

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

// The substrate admissible set is the one part of the four-way intersection (SPEC §9.2)
// that genuinely varies by profile (§10.2's Cloudflare rules are not the local
// reference profile's), so it stays an abstract seam. Trust does not vary by profile —
// it is derived from the Blueprint's own policy — so validatePlacements computes it
// directly via PlacementPolicy.trustedModes rather than asking the port for it.
export abstract class PlacementSourcePort {
    public abstract substrateModes(
        release: PackageRelease,
        manifest: FacetManifest
    ): readonly IsolationMode[];

    /**
     * The backing the profile declares for a §4.7 consumer the Blueprint does not map,
     * or nothing when the profile declares no default. It is abstract rather than
     * defaulted because "this profile serves no authored code" is a statement a profile
     * makes, not one the validator may assume on its behalf: the absence is what
     * `C13-FACET-CODE-AVAILABILITY` refuses a `code`-available Operation against.
     */
    public abstract authoredCodeBackingDefault(
        consumer: AuthoredCodeConsumer
    ): AuthoredCodeBackingId | undefined;
}

export interface ValidatedContribution {
    readonly contributor: string;
    readonly index: number;
    readonly slot: string;
    readonly value: FacetData;
    /**
     * The §4.2 source pin of the release the contribution was read from. Declaration
     * validation sets it for every manifest contribution; only the Blueprint's own
     * slot projections (plan.ts) go without one, because a Blueprint-declared slot is
     * read from no release.
     */
    readonly package?: PackagePin;
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
                    value: canonicalFacetData(declaration.value),
                    ...(declaration.package && { package: declaration.package })
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
            options.coreSlots ?? [],
            options.placement
        );
        validateReliance(releases, options.target);
        const placements = validatePlacements(blueprint, releases, options.placement);
        const blueprintDigest = Digest.sha256(Blueprint.encode(blueprint));
        const declarationDigest = Digest.sha256(
            encodeCanonicalJson(
                declarations.map((declaration) => ({
                    contributor: declaration.contributor,
                    index: declaration.index,
                    slot: declaration.slot,
                    value: declaration.value,
                    ...(declaration.package && { package: declaration.package.toData() })
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

    /**
     * Refuse a pinned Package closure that is not this Blueprint's closure (SPEC §9.1).
     * `validate` has already proven `lock` is the deterministic resolution of the declared
     * dependency relation from the Blueprint's own `packages` list, so equality against
     * `lock.packages` is equality against the transitive closure resolved to exact
     * versions — a pinned closure needs no second derivation to be checkable. A pin set
     * that merely looks complete is refused by the member it diverges on: naming a Package
     * the closure does not resolve, and pinning a resolved Package at another release, are
     * different errors and get different refusals.
     */
    public requirePinnedClosure(pins: DefinitionPinSet): void {
        const declaredVersion = this.#blueprint.meta.version;
        if (
            !pins.blueprint.version.equals(declaredVersion) ||
            !pins.blueprint.digest.equals(this.#attestation.blueprintDigest)
        ) {
            throw invalidDefinition(
                `Pinned Blueprint ${pins.blueprint.version.toString()} is not the validated Blueprint ${declaredVersion.toString()}`
            );
        }
        const closure = this.#lock.packages;
        for (const pin of pins.packages) {
            const declared = closure.find((candidate) => candidate.id.equals(pin.id));
            if (declared === undefined) {
                throw invalidDefinition(
                    `Pinned Package ${pin.id.value} is outside the declared closure`
                );
            }
            if (!declared.equals(pin)) {
                throw invalidDefinition(
                    `Pinned Package ${pin.id.value} is pinned at a release the declared closure does not resolve`
                );
            }
        }
        const absent = closure.find(
            (declared) => !pins.packages.some((pin) => pin.id.equals(declared.id))
        );
        if (absent !== undefined) {
            throw invalidDefinition(
                `Declared closure member ${absent.id.value} is absent from the pinned closure`
            );
        }
        // Every declared member is pinned and every pin is a declared member, so a count
        // above the closure's can only be one Package pinned twice.
        if (pins.packages.length !== closure.length) {
            throw invalidDefinition("Pinned Package closure repeats a Package ID");
        }
    }
}

function validatePlacements(
    blueprint: Blueprint,
    releases: readonly PackageRelease[],
    source: PlacementSourcePort
): readonly ValidatedPlacement[] {
    const placements = releases.flatMap((release) =>
        release.manifests.map((manifest) => {
            const selected = selectPlacement(
                new PlacementInput({
                    manifest: manifest.isolation,
                    policy: blueprint.policies.placement.allowed,
                    substrate: source.substrateModes(release, manifest),
                    trust: blueprint.policies.placement.trustedModes(release.id)
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
    // Already canonical by (packageId, facetId, facetVersion): PackageLock sorts its pins
    // by package ID and PackageRelease sorts its manifests by ID then version, so the
    // flat map walks those two orders in that order. Re-sorting here would only restate
    // it, and the placement digest depends on the two sorts either way.
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

function releasePin(release: PackageRelease): PackagePin {
    // exactLockedReleases has matched every release against its lock pin on all four
    // identity fields, so the pin derived here is that lock pin.
    return new PackagePin(release.id, release.version, release.manifestDigest, release.codeDigest);
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
    coreSlots: readonly SlotDeclaration[],
    placement: PlacementSourcePort
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

    const manifests = releases
        .flatMap((release) =>
            release.manifests.map((manifest) => ({ manifest, pin: releasePin(release) }))
        )
        .sort((left, right) => compareManifests(left.manifest, right.manifest));
    for (const { manifest } of manifests) {
        if (manifest.id.value === BLUEPRINT_CONTRIBUTOR) {
            throw invalidDefinition(
                `Facet id ${BLUEPRINT_CONTRIBUTOR} is reserved for Blueprint-declared slots`
            );
        }
    }
    for (const { manifest } of manifests) {
        for (const value of manifest.contributions.get(SLOT_DECLARATIONS) ?? []) {
            const slot = SlotDeclaration.fromData(value);
            rejectCoreSlotRedefinition(slot);
            addSlot(slots, slot, `Package ${manifest.id.value} slot`);
        }
    }

    const declarations: ValidatedContribution[] = [];
    for (const { manifest, pin } of manifests) {
        for (const contribution of manifest.contributions.entries) {
            for (const [index, value] of contribution.entries.entries()) {
                validateCoreContribution(contribution.slot.value, value);
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
                    value,
                    package: pin
                });
            }
        }
    }
    const facets = manifests.map(({ manifest }) => manifest);
    validateCommandSurfaceSlots(facets, slots);
    validateAuthoredCodeAvailability(blueprint, facets, placement);
    declarations.sort(compareDeclarations);
    return Object.freeze(declarations);
}

// The switch selects the kinds it knows how to check, so it needs no caller-side test
// against CORE_SLOT_NAMES: a contribution to any other slot matches no case. Two core
// kinds are absent on purpose. A "settings" contribution is validated by
// composeConfigSchema, which reads every one of them as a schema fragment before this
// runs and refuses a non-document with the same words; a "slots" contribution is
// validated by the SlotDeclaration.fromData pass above, which decodes every one of them
// to register the slot. Repeating either here would decide nothing.
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

/**
 * SPEC §4.7 / C13-FACET-CODE-AVAILABILITY: an Operation the model is offered and an
 * isolate cannot reach is a catalog that was already wrong when it was assembled, so a
 * `code`- or `both`-available Operation is refused here rather than at the first
 * submission that needs it.
 *
 * Whether the platform serves programmatic tool calling is one fact about the Blueprint
 * and the profile, not one per Operation, so it is decided once. When it is served the
 * declarations need no walk at all; when it is not, the walk names the first Operation
 * that depends on it in canonical manifest order.
 */
function validateAuthoredCodeAvailability(
    blueprint: Blueprint,
    manifests: readonly FacetManifest[],
    placement: PlacementSourcePort
): void {
    // SPEC §4.7 gives a consumer's backing exactly two sources — the Blueprint's declared
    // mapping, or the profile's declared default — and no third outcome. `backingFor`
    // cannot answer this, because it takes the default as a required argument: asking it
    // would mean inventing the very backing whose absence is the refusal.
    const served =
        blueprint.policies.placement.backings.consumers.includes(
            AUTHORED_CODE_OPERATION_CONSUMER
        ) || placement.authoredCodeBackingDefault(AUTHORED_CODE_OPERATION_CONSUMER) !== undefined;
    if (served) return;
    for (const manifest of manifests) {
        for (const value of manifest.contributions.get(OPERATION_DECLARATIONS) ?? []) {
            const descriptor = OperationDescriptor.fromData(value);
            if (descriptor.availability.reachableByAuthoredCode) {
                throw invalidDefinition(
                    `Facet ${manifest.id.value} Operation ${descriptor.name.value} declares ${descriptor.availability.label} availability to agent-authored code, but no backing serves the ${AUTHORED_CODE_OPERATION_CONSUMER} consumer`
                );
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

/**
 * SPEC §4.1 / C13-FACET-DEPENDENCY-ORDER: reliance is computable before any package code
 * loads from the installed manifests' `BindingRequirement`s, so a reliance cycle rejects
 * the Blueprint here rather than deadlocking a live reconciliation.
 *
 * Two boundaries fix what this may decide. Reliance is over `FacetPackageId`s and the
 * Package dependency relation is over `PackageId`s: §9.1 permits a cyclic Package
 * dependency, and a host MUST NOT derive either relation from the other, so a requirement
 * naming a Facet this closure does not install is not a defect — the provider it resolves
 * to is a live `FacetRef` on the §3.4 Grant plane, which is why an unsatisfied requirement
 * is gated at `start` and never guessed at from the closure. What is decidable from data
 * alone is whether a requirement's own declared spec/host range admits the platform the
 * Blueprint is validated for, and whether the requirements the installed manifests declare
 * close a cycle among themselves.
 *
 * Every requirement's range is decided before any cycle is reported, so one closure always
 * yields one refusal.
 */
function validateReliance(
    releases: readonly PackageRelease[],
    target: PlatformCompatibility
): void {
    const manifests = releases.flatMap((release) => release.manifests).sort(compareManifests);
    for (const manifest of manifests) {
        for (const requirement of manifest.bindings) {
            // A requirement is compatibility-ranged exactly as a manifest is (SPEC §4.1),
            // and package resolution already proved every manifest's range against this
            // target, so the requirement's own range is the one fact left to decide.
            if (!compatibilityAdmits(requirement.compat, target)) {
                throw invalidDefinition(
                    `Facet ${manifest.id.value} requires Binding ${requirement.name.value} from Facet ${requirement.facet.value} at spec ${requirement.compat.spec} host ${requirement.compat.host}, which the validated platform spec ${target.spec.toString()} host ${target.host.toString()} does not admit`
                );
            }
        }
    }
    const cycle = findRelianceCycle(relianceGraph(manifests));
    if (cycle !== undefined) {
        // A cycle of length one is a manifest requiring itself; rendering the entry point
        // twice states both cases with one shape.
        throw invalidDefinition(
            `Facet reliance cycle ${[...cycle, ...cycle.slice(0, 1)].join(" -> ")}`
        );
    }
}

// Out-edges per Facet id, deduplicated and sorted, over manifests already in canonical
// order. Two manifests sharing an id are one node: a requirement of either version holds
// the same Facet, so a cycle through either is a cycle. A requirement naming a Facet this
// closure does not install is a target with no out-edges, so it closes nothing — the only
// cycles this finds are the ones the installed manifests declare among themselves.
function relianceGraph(
    manifests: readonly FacetManifest[]
): ReadonlyMap<string, readonly string[]> {
    const graph = new Map<string, string[]>();
    for (const manifest of manifests) {
        const edges = graph.get(manifest.id.value) ?? [];
        for (const requirement of manifest.bindings) {
            if (!edges.includes(requirement.facet.value)) {
                edges.push(requirement.facet.value);
            }
        }
        graph.set(manifest.id.value, edges.sort(compareText));
    }
    return graph;
}

// Depth-first search over canonically ordered nodes and canonically ordered edges, so the
// cycle found is a function of the closure alone.
function findRelianceCycle(
    graph: ReadonlyMap<string, readonly string[]>
): readonly string[] | undefined {
    const settled = new Set<string>();
    const walking = new Set<string>();
    const path: string[] = [];
    const visit = (node: string): readonly string[] | undefined => {
        if (walking.has(node)) return canonicalCycle(path.slice(path.indexOf(node)));
        if (settled.has(node)) return undefined;
        walking.add(node);
        path.push(node);
        for (const next of graph.get(node) ?? []) {
            const cycle = visit(next);
            if (cycle !== undefined) return cycle;
        }
        path.pop();
        walking.delete(node);
        settled.add(node);
        return undefined;
    };
    for (const node of graph.keys()) {
        const cycle = visit(node);
        if (cycle !== undefined) return cycle;
    }
    return undefined;
}

// One cycle is discoverable from any of its members, so it is named from its lowest id.
// `cycle` is the nonempty search path from the repeated node, so the fold has a subject.
function canonicalCycle(cycle: readonly string[]): readonly string[] {
    const lowest = cycle.reduce((left, right) => (compareText(right, left) < 0 ? right : left));
    const start = cycle.indexOf(lowest);
    return [...cycle.slice(start), ...cycle.slice(0, start)];
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
