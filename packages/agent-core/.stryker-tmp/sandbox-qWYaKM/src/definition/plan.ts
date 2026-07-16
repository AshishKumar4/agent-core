// @ts-nocheck
import { ActorId, ActorRef, type ActorKind } from "../actors";
import {
    Digest,
    RecordCodec,
    decodeCanonicalJson,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue
} from "../core";
import { Command, SlotDeclaration, type FacetManifest, type IsolationMode } from "../facets";
import { Blueprint } from "./blueprint";
import {
    canonicalMaterializationDesired,
    validateMaterializationKind
} from "./materialization-kind";
import { ManagedOrigin } from "./origin";
import { PLACEMENT_PREFERENCE, type PlacementSelection } from "./placement";
import type { PolicySet } from "./policy";
import { CORE_SLOT_NAMES, ValidatedBlueprint, type ValidatedContribution } from "./validator";
import type { TenantId } from "../identity";
import { DeploymentId, DeploymentKey } from "./id";
import type { PackagePin } from "./package-lock";
import { compareText } from "./order";
import { invalidDefinition } from "./error";

const DERIVED_COMMAND_TRUST: readonly string[] = Object.freeze(["owner", "authenticated", "self"]);

const PLACEMENT_RECORD_KIND = "facet-placement";

export interface DesiredProjectionInit {
    readonly logicalKey: string;
    readonly recordKind: string;
    readonly desired: JsonValue;
    readonly desiredDigest?: Digest;
}

export class DesiredProjection {
    public readonly logicalKey: string;
    public readonly recordKind: string;
    public readonly desired: JsonValue;
    public readonly desiredDigest: Digest;

    public constructor(init: DesiredProjectionInit) {
        const logicalKey = init.logicalKey;
        const recordKind = init.recordKind;
        const expectedDigest = init.desiredDigest;
        requireCanonicalName(logicalKey, "Desired projection logical key");
        requireCanonicalName(recordKind, "Desired projection record kind");
        const desired = canonicalData(
            canonicalMaterializationDesired(recordKind, canonicalData(init.desired))
        );
        const desiredDigest = digestData({
            desired,
            recordKind
        });
        if (expectedDigest !== undefined && !expectedDigest.equals(desiredDigest)) {
            throw new TypeError("Desired projection digest does not match its canonical contents");
        }
        this.logicalKey = logicalKey;
        this.recordKind = recordKind;
        this.desired = desired;
        this.desiredDigest = desiredDigest;
        Object.freeze(this);
    }

    public static fromData(payload: JsonValue): DesiredProjection {
        const object = requireObject(payload, "Desired projection");
        requireFields(
            object,
            ["desired", "desiredDigest", "logicalKey", "recordKind"],
            "Desired projection"
        );
        return new DesiredProjection({
            logicalKey: requireString(object["logicalKey"], "Desired projection logical key"),
            recordKind: requireString(object["recordKind"], "Desired projection record kind"),
            desired: requireValue(object["desired"], "Desired projection value"),
            desiredDigest: new Digest(
                requireString(object["desiredDigest"], "Desired projection digest")
            )
        });
    }

    public toData(): JsonValue {
        return {
            desired: this.desired,
            desiredDigest: this.desiredDigest.value,
            logicalKey: this.logicalKey,
            recordKind: this.recordKind
        };
    }
}

export function placementProjection(
    logicalKey: string,
    facet: string,
    selection: PlacementSelection
): DesiredProjection {
    requireCanonicalName(facet, "Placement facet");
    const selected = choosePlacement(
        selection.manifest,
        selection.policy,
        selection.substrate,
        selection.trust
    );
    validatePlacementSelection(selected, selection.selected);
    return new DesiredProjection({
        logicalKey,
        recordKind: PLACEMENT_RECORD_KIND,
        desired: {
            facet,
            manifest: selection.manifest,
            policy: selection.policy,
            selected,
            substrate: selection.substrate,
            trust: selection.trust
        }
    });
}

export function policyProjection(logicalKey: string, policy: PolicySet): DesiredProjection {
    return new DesiredProjection({
        logicalKey,
        recordKind: "policy-set",
        desired: policy.toData()
    });
}

function facetInstallProjection(
    logicalKey: string,
    install: {
        readonly packageId: PackagePin["id"]["value"];
        readonly facetId: FacetManifest["id"]["value"];
        readonly facetVersion: string;
    }
): DesiredProjection {
    return new DesiredProjection({
        logicalKey,
        recordKind: "facet-install",
        desired: {
            facetId: install.facetId,
            facetVersion: install.facetVersion,
            packageId: install.packageId
        }
    });
}

function slotEntryProjection(logicalKey: string, entry: ValidatedContribution): DesiredProjection {
    return new DesiredProjection({
        logicalKey,
        recordKind: "slot-entry",
        desired: {
            contributor: entry.contributor,
            index: entry.index,
            slot: entry.slot,
            value: entry.value as JsonValue
        }
    });
}

function subscriptionProjection(logicalKey: string, template: JsonValue): DesiredProjection {
    return new DesiredProjection({ logicalKey, recordKind: "subscription", desired: template });
}

function declarationProjection(
    recordKind: string,
    logicalKey: string,
    declaration: JsonValue
): DesiredProjection {
    return new DesiredProjection({ logicalKey, recordKind, desired: declaration });
}

export interface ActorPlanInit {
    readonly actor: ActorRef;
    readonly origin: ManagedOrigin;
    readonly projections: readonly DesiredProjection[];
    readonly id?: Digest;
}

class ActorPlanCodec extends RecordCodec<ActorPlan> {
    public constructor() {
        super("definition.actor-plan", { major: 1, minor: 0 });
    }

    protected encodePayload(plan: ActorPlan): JsonValue {
        return plan.toData();
    }

    protected decodePayload(payload: JsonValue): ActorPlan {
        return ActorPlan.fromData(payload);
    }
}

export class ActorPlan {
    public static readonly codec: RecordCodec<ActorPlan> = new ActorPlanCodec();

    public readonly id: Digest;
    public readonly actor: ActorRef;
    public readonly origin: ManagedOrigin;
    public readonly projections: readonly DesiredProjection[];

    public constructor(init: ActorPlanInit) {
        for (const projection of init.projections) validateProjection(projection);
        const projections = canonicalProjections(init.projections);
        const id = actorPlanId(init.actor, init.origin, projections);
        if (init.id !== undefined && !init.id.equals(id)) {
            throw new TypeError("Actor plan ID does not match its canonical contents");
        }
        this.id = id;
        this.actor = copyActorRef(init.actor);
        this.origin = init.origin;
        this.projections = Object.freeze(projections);
        Object.freeze(this);
    }

    public static encode(plan: ActorPlan): Uint8Array {
        return ActorPlan.codec.encode(plan);
    }

    public static decode(bytes: Uint8Array): ActorPlan {
        return ActorPlan.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): ActorPlan {
        const object = requireObject(payload, "Actor plan");
        requireFields(object, ["actor", "id", "origin", "projections"], "Actor plan");
        const projections = requireArray(object["projections"], "Actor plan projections").map(
            DesiredProjection.fromData
        );
        return new ActorPlan({
            id: new Digest(requireString(object["id"], "Actor plan ID")),
            actor: actorRefFromData(requireValue(object["actor"], "Actor plan actor")),
            origin: ManagedOrigin.fromData(requireValue(object["origin"], "Actor plan origin")),
            projections
        });
    }

    public toData(): JsonValue {
        return {
            actor: actorRefData(this.actor),
            id: this.id.value,
            origin: this.origin.toData(),
            projections: this.projections.map((projection) => projection.toData())
        };
    }
}

export interface MaterializationPlanInit {
    readonly origin: ManagedOrigin;
    readonly actors: readonly ActorPlan[];
    readonly id?: Digest;
}

class MaterializationPlanCodec extends RecordCodec<MaterializationPlan> {
    public constructor() {
        super("definition.materialization-plan", { major: 1, minor: 0 });
    }

    protected encodePayload(plan: MaterializationPlan): JsonValue {
        return plan.toData();
    }

    protected decodePayload(payload: JsonValue): MaterializationPlan {
        return MaterializationPlan.fromData(payload);
    }
}

export class MaterializationPlan {
    public static readonly codec: RecordCodec<MaterializationPlan> = new MaterializationPlanCodec();

    public readonly id: Digest;
    public readonly origin: ManagedOrigin;
    public readonly actors: readonly ActorPlan[];

    public constructor(init: MaterializationPlanInit) {
        for (const actor of init.actors) validateActorPlan(actor);
        const actors = canonicalActorPlans(init.actors);
        if (actors.some((actorPlan) => !actorPlan.origin.equals(init.origin))) {
            throw new TypeError("Every Actor plan must have the materialization plan origin");
        }
        const id = materializationPlanId(init.origin, actors);
        if (init.id !== undefined && !init.id.equals(id)) {
            throw new TypeError("Materialization plan ID does not match its canonical contents");
        }
        this.id = id;
        this.origin = init.origin;
        this.actors = Object.freeze(actors);
        Object.freeze(this);
    }

    public get blueprintDigest(): Digest {
        return this.origin.blueprintDigest;
    }

    public get packageLockDigest(): Digest {
        return this.origin.packageLockDigest;
    }

    public get configDigest(): Digest {
        return this.origin.configDigest;
    }

    public get generation(): number {
        return this.origin.generation;
    }

    public static encode(plan: MaterializationPlan): Uint8Array {
        return MaterializationPlan.codec.encode(plan);
    }

    public static decode(bytes: Uint8Array): MaterializationPlan {
        return MaterializationPlan.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): MaterializationPlan {
        const object = requireObject(payload, "Materialization plan");
        requireFields(object, ["actors", "id", "origin"], "Materialization plan");
        const actors = requireArray(object["actors"], "Materialization plan Actors").map(
            ActorPlan.fromData
        );
        return new MaterializationPlan({
            id: new Digest(requireString(object["id"], "Materialization plan ID")),
            origin: ManagedOrigin.fromData(
                requireValue(object["origin"], "Materialization plan origin")
            ),
            actors
        });
    }

    public toData(): JsonValue {
        return {
            actors: this.actors.map((actor) => actor.toData()),
            id: this.id.value,
            origin: this.origin.toData()
        };
    }
}

export abstract class MaterializationTopologyPort {
    /**
     * Route a projection to its single owning Actor (SPEC §8.4). Implementations must
     * follow the normative ownership map: policy-set and scope-scaffold records belong
     * to the tenant Actor; facet-install, facet-placement, slot-entry, subscription,
     * agent-profile, and surface-layout records belong to the owning workspace Actor;
     * environment records belong to their environment Actor. Grants and Bindings are
     * authority-plane records materialized outside the definition plane (role
     * assignment and composition policies), never through this port.
     */
    public abstract actorFor(
        validated: ValidatedBlueprint,
        projection: DesiredProjection
    ): ActorRef;
}

export interface PlanMaterializationInput {
    readonly validatedBlueprint: ValidatedBlueprint;
    readonly tenantId: TenantId;
    readonly deploymentKey: DeploymentKey;
    readonly generation: number;
    readonly topology: MaterializationTopologyPort;
}

export function planMaterialization(input: PlanMaterializationInput): MaterializationPlan {
    if (!(input.validatedBlueprint instanceof ValidatedBlueprint)) {
        throw invalidDefinition("Materialization planning requires a ValidatedBlueprint");
    }
    const projections = attestedProjections(input.validatedBlueprint);
    const lock = input.validatedBlueprint.lock;
    const deploymentId = DeploymentId.derive(input.tenantId, input.deploymentKey);
    const origin = new ManagedOrigin({
        tenantId: input.tenantId,
        deploymentId,
        attestationDigest: input.validatedBlueprint.attestation.id,
        blueprintDigest: Digest.sha256(Blueprint.encode(input.validatedBlueprint.blueprint)),
        packageLockDigest: lock.digest,
        configDigest: digestData(validatedConfig(input.validatedBlueprint)),
        generation: input.generation
    });
    const grouped = new Map<
        string,
        { readonly actor: ActorRef; readonly projections: DesiredProjection[] }
    >();
    for (const projection of projections) {
        const actor = input.topology.actorFor(input.validatedBlueprint, projection);
        if (!(actor instanceof ActorRef)) {
            throw invalidDefinition("Materialization topology must return an ActorRef");
        }
        const key = `${actor.kind}\0${actor.id.value}`;
        const group = grouped.get(key) ?? { actor, projections: [] };
        group.projections.push(projection);
        grouped.set(key, group);
    }
    const actors = [...grouped.values()].map(
        (group) =>
            new ActorPlan({
                actor: group.actor,
                origin,
                projections: group.projections
            })
    );
    return new MaterializationPlan({
        origin,
        actors
    });
}

function attestedProjections(validated: ValidatedBlueprint): readonly DesiredProjection[] {
    const blueprint = validated.blueprint;
    const projections: DesiredProjection[] = [
        policyProjection("policy:platform", blueprint.policies)
    ];

    for (const placement of validated.placements) {
        projections.push(
            placementProjection(
                `placement:${placement.packageId}:${placement.facetId}`,
                placement.facetId,
                placement.selection
            )
        );
        projections.push(
            facetInstallProjection(`install:${placement.packageId}:${placement.facetId}`, {
                facetId: placement.facetId,
                facetVersion: placement.facetVersion,
                packageId: placement.packageId
            })
        );
    }

    const contributeAuthority = slotContributeAuthority(validated);
    const commandSurfaceNames = new Set<string>();
    for (const declaration of validated.declarations) {
        requireSlotContributeAuthority(declaration, contributeAuthority);
        projections.push(
            slotEntryProjection(
                `contribution:${declaration.contributor}:${declaration.slot}:${declaration.index}`,
                declaration
            )
        );
        if (declaration.slot === "commands") {
            projections.push(commandSubscriptionProjection(declaration, commandSurfaceNames));
        } else if (declaration.slot === "automations") {
            projections.push(
                subscriptionProjection(
                    `subscription:automation:${declaration.contributor}:${declaration.index}`,
                    declaration.value as JsonValue
                )
            );
        }
    }

    (blueprint.subscriptions ?? []).forEach((template, index) => {
        projections.push(
            subscriptionProjection(`subscription:blueprint:${index}`, template as JsonValue)
        );
    });

    (blueprint.slots ?? []).forEach((slot, index) => {
        projections.push(
            slotEntryProjection(`contribution:blueprint:slots:${index}`, {
                contributor: "blueprint",
                index,
                slot: "slots",
                value: slot
            })
        );
    });

    if (blueprint.scopes !== undefined) {
        projections.push(
            declarationProjection("scope-scaffold", "scope:platform", blueprint.scopes as JsonValue)
        );
    }
    blueprint.agents.forEach((agent, index) => {
        projections.push(
            declarationProjection("agent-profile", `agent:${index}`, agent as JsonValue)
        );
    });
    (blueprint.environments ?? []).forEach((environment, index) => {
        projections.push(
            declarationProjection("environment", `environment:${index}`, environment as JsonValue)
        );
    });
    if (blueprint.surfaces !== undefined) {
        projections.push(
            declarationProjection(
                "surface-layout",
                "surface:platform",
                blueprint.surfaces as JsonValue
            )
        );
    }

    return Object.freeze(projections.sort(compareProjections));
}

function commandSubscriptionProjection(
    declaration: ValidatedContribution,
    surfaceNames: Set<string>
): DesiredProjection {
    const command = Command.fromData(declaration.value);
    for (const surface of command.surfaces) {
        const key = `${surface.value} ${command.name}`;
        if (surfaceNames.has(key)) {
            throw invalidDefinition(
                `Command ${command.name} is not unique in surface slot ${surface.value}`
            );
        }
        surfaceNames.add(key);
    }
    const template: JsonValue = {
        authority: "initiator",
        binding: command.binding.value,
        dedupe: "event",
        mapping: [{ from: "/input", to: "" }],
        source: {
            acceptedTrust: command.acceptedTrust ?? DERIVED_COMMAND_TRUST,
            kind: "command.invoked",
            source: `${declaration.contributor}:${command.name}`
        },
        target: command.operation.value
    };
    return subscriptionProjection(
        `subscription:command:${declaration.contributor}:${command.name}`,
        template
    );
}

function slotContributeAuthority(
    validated: ValidatedBlueprint
): ReadonlyMap<string, readonly string[]> {
    const map = new Map<string, readonly string[]>();
    const add = (data: JsonValue): void => {
        const slot = SlotDeclaration.fromData(data);
        map.set(slot.name.value, slot.authority.contribute);
    };
    for (const data of validated.blueprint.slots ?? []) add(data as JsonValue);
    for (const declaration of validated.declarations) {
        if (declaration.slot === "slots") add(declaration.value);
    }
    return map;
}

function requireSlotContributeAuthority(
    declaration: ValidatedContribution,
    authority: ReadonlyMap<string, readonly string[]>
): void {
    if (CORE_SLOT_NAMES.has(declaration.slot)) return;
    const contribute = authority.get(declaration.slot);
    if (contribute === undefined) return;
    if (!contribute.some((selector) => selectorMatches(selector, declaration.contributor))) {
        throw invalidDefinition(
            `Contributor ${declaration.contributor} may not contribute to slot ${declaration.slot}`
        );
    }
}

function selectorMatches(selector: string, value: string): boolean {
    const expression = selector
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*");
    return new RegExp(`^${expression}$`, "u").test(value);
}

function compareProjections(left: DesiredProjection, right: DesiredProjection): number {
    return (
        compareText(left.recordKind, right.recordKind) ||
        compareText(left.logicalKey, right.logicalKey)
    );
}

function validatedConfig(validated: ValidatedBlueprint): JsonValue {
    const roots = new Map(
        validated.blueprint.packages.map((install) => [
            install.request.id.value,
            install.config.toData()
        ])
    );
    return Object.fromEntries(
        validated.lock.packages.map((pin) => [pin.id.value, roots.get(pin.id.value) ?? {}])
    );
}

function canonicalProjections(input: readonly DesiredProjection[]): DesiredProjection[] {
    const projections = [...input].sort((left, right) =>
        compareText(left.logicalKey, right.logicalKey)
    );
    const unique: DesiredProjection[] = [];
    for (const projection of projections) {
        const previous = unique.at(-1);
        if (previous === undefined || previous.logicalKey !== projection.logicalKey) {
            unique.push(projection);
            continue;
        }
        if (
            !bytesEqual(
                encodeCanonicalJson(previous.toData()),
                encodeCanonicalJson(projection.toData())
            )
        ) {
            throw new TypeError(
                `Conflicting desired projections for logical key ${projection.logicalKey}`
            );
        }
    }
    return unique;
}

function validateProjection(projection: DesiredProjection): void {
    validateMaterializationKind(projection.recordKind, projection.desired);
}

function validateActorPlan(plan: ActorPlan): void {
    for (const projection of plan.projections) validateProjection(projection);
}

function canonicalActorPlans(input: readonly ActorPlan[]): ActorPlan[] {
    const actors = [...input].sort((left, right) => compareActorRefs(left.actor, right.actor));
    const unique: ActorPlan[] = [];
    for (const actor of actors) {
        const previous = unique.at(-1);
        if (previous === undefined || compareActorRefs(previous.actor, actor.actor) !== 0) {
            unique.push(actor);
            continue;
        }
        if (!bytesEqual(ActorPlan.encode(previous), ActorPlan.encode(actor))) {
            throw new TypeError(
                `Conflicting Actor plans for ${actor.actor.kind}:${actor.actor.id.value}`
            );
        }
    }
    return unique;
}

function actorPlanId(
    actor: ActorRef,
    origin: ManagedOrigin,
    projections: readonly DesiredProjection[]
): Digest {
    return digestData({
        actor: actorRefData(actor),
        origin: origin.toData(),
        projections: projections.map((projection) => projection.toData())
    });
}

function materializationPlanId(origin: ManagedOrigin, actors: readonly ActorPlan[]): Digest {
    return digestData({
        actors: actors.map((actor) => actor.toData()),
        origin: origin.toData()
    });
}

function choosePlacement(
    manifest: readonly IsolationMode[],
    policy: readonly IsolationMode[],
    substrate: readonly IsolationMode[],
    trust: readonly IsolationMode[]
): IsolationMode | undefined {
    return PLACEMENT_PREFERENCE.find(
        (mode) =>
            manifest.includes(mode) &&
            policy.includes(mode) &&
            substrate.includes(mode) &&
            trust.includes(mode)
    );
}

function validatePlacementSelection(
    selected: IsolationMode | undefined,
    expected: IsolationMode
): asserts selected is IsolationMode {
    if (selected !== expected) {
        throw new TypeError("Placement selection does not match its four-source intersection");
    }
}

function copyActorRef(actor: ActorRef): ActorRef {
    return Object.freeze(new ActorRef(actor.kind, new ActorId(actor.id.value)));
}

function actorRefData(actor: ActorRef): JsonValue {
    return { id: actor.id.value, kind: actor.kind };
}

function actorRefFromData(payload: JsonValue): ActorRef {
    const object = requireObject(payload, "Actor reference");
    requireFields(object, ["id", "kind"], "Actor reference");
    return new ActorRef(
        requireActorKind(object["kind"]),
        new ActorId(requireString(object["id"], "Actor ID"))
    );
}

function requireActorKind(value: JsonValue | undefined): ActorKind {
    if (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    ) {
        return value;
    }
    throw new TypeError("Actor kind is invalid");
}

function canonicalData(value: JsonValue): JsonValue {
    return freezeData(decodeCanonicalJson(encodeCanonicalJson(value)));
}

function freezeData(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        for (const entry of value) freezeData(entry);
        return Object.freeze(value);
    }
    if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value)) freezeData(entry);
        return Object.freeze(value);
    }
    return value;
}

function digestData(value: JsonValue): Digest {
    return Digest.sha256(encodeCanonicalJson(value));
}

function requireCanonicalName(value: string, subject: string): void {
    if (value.trim().length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
}

function requireObject(value: JsonValue, subject: string): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

function requireFields(
    value: { readonly [key: string]: JsonValue },
    fields: readonly string[],
    subject: string
): void {
    if (!hasExactJsonKeys(value, fields)) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
}

function requireString(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${subject} must be a string`);
    }
    return value;
}

function requireArray(value: JsonValue | undefined, subject: string): readonly JsonValue[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value;
}

function requireValue(value: JsonValue | undefined, subject: string): JsonValue {
    if (value === undefined) {
        throw new TypeError(`${subject} is required`);
    }
    return value;
}

function compareActorRefs(left: ActorRef, right: ActorRef): number {
    return compareText(left.kind, right.kind) || compareText(left.id.value, right.id.value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}
