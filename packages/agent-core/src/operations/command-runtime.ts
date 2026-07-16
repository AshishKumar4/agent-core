import { encodeCanonicalJson, type JsonSchemaDocument, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import {
    Automation,
    Command,
    EventPattern,
    FieldMove,
    PayloadMapping,
    canonicalFacetData,
    type FacetData,
    type FacetPackageId,
    type FacetRef,
    type OperationDescriptor,
    type SurfaceId
} from "../facets";
const DEFAULT_COMMAND_TRUST = ["owner", "authenticated", "self"] as const;

export interface CommandInstallationTarget {
    readonly package: FacetPackageId;
    readonly descriptor: OperationDescriptor;
}

export interface CommandInstallation {
    readonly contributor: FacetRef;
    readonly command: Command;
    readonly target: CommandInstallationTarget;
    readonly completion?: CommandInstallationTarget;
}

export interface InstalledCommand {
    readonly id: string;
    readonly scope: string;
    readonly contributor: FacetRef;
    readonly command: Command;
    readonly target: OperationDescriptor;
    readonly subscription: Automation;
}

export interface CommandInvocationOrigin {
    readonly surface: SurfaceId;
    readonly run?: Readonly<{ readonly run: string; readonly branch: string }>;
}

export interface CommandInvocationEvent {
    readonly id: string;
}

export interface CommandEventPort {
    invoked(
        installed: InstalledCommand,
        origin: CommandInvocationOrigin,
        input: FacetData
    ): Promise<CommandInvocationEvent>;
}

export class CommandRuntime {
    readonly #commands = new Map<string, InstalledCommand>();
    readonly #surfaces = new Map<string, InstalledCommand>();

    public install(installation: CommandInstallation): InstalledCommand {
        validateInstallation(installation);
        const scope = facetScope(installation.contributor);
        const id = `${installation.command.operation.facet.value}:${installation.command.name}`;
        const key = commandKey(scope, id);
        const existing = this.#commands.get(key);
        if (existing !== undefined) {
            if (sameInstallation(existing, installation)) return existing;
            throw collision(`Command ${id} conflicts with an installed command in ${scope}`);
        }
        for (const surface of installation.command.surfaces) {
            if (this.#surfaces.has(surfaceKey(scope, surface.value, installation.command.name))) {
                throw collision(
                    `Command ${installation.command.name} conflicts in surface ${surface.value}`
                );
            }
        }
        const subscription = new Automation({
            source: new EventPattern(
                "command.invoked",
                installation.command.acceptedTrust ?? DEFAULT_COMMAND_TRUST,
                id
            ),
            target: installation.command.operation,
            binding: installation.command.binding,
            mapping: new PayloadMapping([new FieldMove("", { from: "/input" })]),
            dedupe: "event",
            authority: "initiator"
        });
        const installed = Object.freeze({
            id,
            scope,
            contributor: installation.contributor,
            command: installation.command,
            target: installation.target.descriptor,
            subscription
        });
        this.#commands.set(key, installed);
        for (const surface of installation.command.surfaces) {
            this.#surfaces.set(
                surfaceKey(scope, surface.value, installation.command.name),
                installed
            );
        }
        return installed;
    }

    /**
     * A Command invocation only emits `command.invoked` with the §4.3 step-4 correlation
     * (its Surface, and the Run when invoked from a conversation). Execution happens solely
     * through the derived Subscription and the workspace routing pipeline, which evaluates the
     * subscription's accepted trust, event dedupe, and initiator authority; no direct gateway
     * dispatch is permitted, as that would be an alternate authority source (§4.3). The returned
     * Event identity lets the Surface correlate the eventual `command.completed` (step 5).
     */
    public async invoke(
        installed: InstalledCommand,
        argumentsValue: FacetData,
        origin: CommandInvocationOrigin,
        events: CommandEventPort
    ): Promise<CommandInvocationEvent> {
        this.requireInstalled(installed);
        if (!installed.command.surfaces.some((surface) => surface.value === origin.surface.value)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Command ${installed.id} is not installed for surface ${origin.surface.value}`
            );
        }
        const input = this.bind(installed.command, argumentsValue);
        if (!installed.target.input.accepts(input)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Mapped Command input does not match the installed Operation schema"
            );
        }
        return events.invoked(installed, origin, { input });
    }

    public bind(command: Command, argumentsValue: FacetData): FacetData {
        const canonical = canonicalFacetData(argumentsValue);
        if (!command.arguments.accepts(canonical)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Command arguments do not match their schema"
            );
        }
        if (command.mapping === undefined) return canonical;
        let output: FacetData = {};
        for (const move of command.mapping.moves) output = applyMove(output, canonical, move);
        return canonicalFacetData(output);
    }

    private requireInstalled(installed: InstalledCommand): void {
        if (this.#commands.get(commandKey(installed.scope, installed.id)) !== installed) {
            throw new AgentCoreError("facet.inactive", `Command ${installed.id} is not installed`);
        }
    }
}

function validateInstallation(installation: CommandInstallation): void {
    const { command, target, completion } = installation;
    command.arguments.assertValid();
    target.descriptor.input.assertValid();
    target.descriptor.output.assertValid();
    if (
        !target.package.equals(command.operation.facet) ||
        !target.descriptor.name.equals(command.operation.operation)
    ) {
        throw new AgentCoreError(
            "operation.missing",
            "Command installation target does not match its Operation reference"
        );
    }
    validateMapping(command, target.descriptor);
    if (command.completion === undefined) {
        if (completion !== undefined) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Command installation supplied an undeclared completion Operation"
            );
        }
        return;
    }
    if (
        completion === undefined ||
        !completion.package.equals(command.completion.facet) ||
        !completion.descriptor.name.equals(command.completion.operation) ||
        completion.descriptor.impact !== "observe"
    ) {
        throw new AgentCoreError(
            "operation.invalid-input",
            "Command completion must resolve to its exact observe Operation"
        );
    }
}

function validateMapping(command: Command, operation: OperationDescriptor): void {
    if (command.mapping === undefined) {
        if (!schemasCompatible(command.arguments.document, operation.input.document)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Identity Command mapping is incompatible with the Operation input schema"
            );
        }
        return;
    }
    const destinations = new Set<string>();
    for (const move of command.mapping.moves) {
        if (destinations.has(move.to)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Command mapping writes ${move.to} more than once`
            );
        }
        destinations.add(move.to);
        const target = schemaAtPointer(operation.input.document, move.to);
        if (target === undefined) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Command mapping target ${move.to} is absent from the Operation input schema`
            );
        }
        if (move.from === undefined) {
            if (!schemaAccepts(target, move.literal!)) {
                throw new AgentCoreError(
                    "operation.invalid-input",
                    `Command mapping literal does not match target ${move.to}`
                );
            }
            continue;
        }
        const source = schemaAtPointer(command.arguments.document, move.from);
        if (source === undefined) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Command mapping source ${move.from} is absent from the arguments schema`
            );
        }
        if (!schemasCompatible(source, target)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Command mapping ${move.from} to ${move.to} has incompatible schemas`
            );
        }
    }
    if (!requiredTargetsCovered(operation.input.document, destinations)) {
        throw new AgentCoreError(
            "operation.invalid-input",
            "Command mapping does not produce every required Operation input"
        );
    }
}

function schemaAtPointer(
    document: JsonSchemaDocument,
    pointer: string
): JsonSchemaDocument | undefined {
    let current: JsonSchemaDocument | undefined = document;
    for (const segment of pointerSegments(pointer)) {
        if (current === undefined || typeof current === "boolean") return undefined;
        const properties = schemaMap(current["properties"]);
        if (properties !== undefined && Object.hasOwn(properties, segment)) {
            current = schemaDocument(properties[segment]);
            continue;
        }
        if (/^(?:0|[1-9]\d*)$/u.test(segment)) {
            const index = Number(segment);
            const prefixItems = current["prefixItems"];
            if (Array.isArray(prefixItems) && index < prefixItems.length) {
                current = schemaDocument(prefixItems[index]);
                continue;
            }
            const items = schemaDocument(current["items"]);
            if (items !== undefined) {
                current = items;
                continue;
            }
        }
        const additional = schemaDocument(current["additionalProperties"]);
        if (additional !== undefined && additional !== false) {
            current = additional;
            continue;
        }
        return undefined;
    }
    return current;
}

function requiredTargetsCovered(
    document: JsonSchemaDocument,
    destinations: ReadonlySet<string>
): boolean {
    if (destinations.has("") || typeof document === "boolean") return document !== false;
    const required = document["required"];
    if (!Array.isArray(required)) return true;
    return required.every(
        (property) =>
            typeof property === "string" &&
            [...destinations].some((pointer) => {
                const requiredPointer = `/${escapePointer(property)}`;
                return pointer === requiredPointer || pointer.startsWith(`${requiredPointer}/`);
            })
    );
}

function schemasCompatible(source: JsonSchemaDocument, target: JsonSchemaDocument): boolean {
    if (target === true) return true;
    if (source === false) return true;
    if (target === false || source === true) return source === target;
    if (Object.keys(target).length === 0) return true;
    if (sameJson(source, target)) return true;
    const sourceType = source["type"];
    const targetType = target["type"];
    if (targetType !== undefined && (sourceType === undefined || !sameJson(sourceType, targetType)))
        return false;
    const sourceConst = source["const"];
    if (sourceConst !== undefined) return schemaAccepts(target, sourceConst);
    const sourceEnum = source["enum"];
    if (Array.isArray(sourceEnum)) return sourceEnum.every((value) => schemaAccepts(target, value));
    return targetType !== undefined && sourceType !== undefined;
}

function schemaAccepts(schema: JsonSchemaDocument, value: JsonValue): boolean {
    if (schema === true) return true;
    if (schema === false) return false;
    const constant = schema["const"];
    if (constant !== undefined && !sameJson(constant, value)) return false;
    const enumeration = schema["enum"];
    if (Array.isArray(enumeration) && !enumeration.some((entry) => sameJson(entry, value))) {
        return false;
    }
    const type = schema["type"];
    if (typeof type === "string" && !valueHasType(value, type)) return false;
    return true;
}

function valueHasType(value: JsonValue, type: string): boolean {
    switch (type) {
        case "array":
            return Array.isArray(value);
        case "boolean":
            return typeof value === "boolean";
        case "integer":
            return typeof value === "number" && Number.isInteger(value);
        case "null":
            return value === null;
        case "number":
            return typeof value === "number";
        case "object":
            return value !== null && typeof value === "object" && !Array.isArray(value);
        case "string":
            return typeof value === "string";
        default:
            return false;
    }
}

function schemaDocument(value: JsonValue | undefined): JsonSchemaDocument | undefined {
    return typeof value === "boolean" || isJsonObject(value) ? value : undefined;
}

function schemaMap(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
    return isJsonObject(value) ? value : undefined;
}

function isJsonObject(
    value: JsonValue | undefined
): value is { readonly [key: string]: JsonValue } {
    return (
        value !== undefined && value !== null && !Array.isArray(value) && typeof value === "object"
    );
}

function facetScope(contributor: FacetRef): string {
    return contributor.value.slice(0, contributor.value.indexOf(":"));
}

function commandKey(scope: string, id: string): string {
    return `${scope}\u0000${id}`;
}

function surfaceKey(scope: string, surface: string, name: string): string {
    return `${scope}\u0000${surface}\u0000${name}`;
}

function sameInstallation(existing: InstalledCommand, installation: CommandInstallation): boolean {
    return (
        existing.contributor.equals(installation.contributor) &&
        sameBytes(Command.encode(existing.command), Command.encode(installation.command)) &&
        sameBytes(
            encodeCanonicalJson(existing.target.toData()),
            encodeCanonicalJson(installation.target.descriptor.toData())
        )
    );
}

function collision(message: string): AgentCoreError {
    return new AgentCoreError("protocol.duplicate", message);
}

function escapePointer(value: string): string {
    return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
    return sameBytes(encodeCanonicalJson(left), encodeCanonicalJson(right));
}

function applyMove(target: FacetData, source: FacetData, move: FieldMove): FacetData {
    const value = move.from === undefined ? move.literal! : readPointer(source, move.from);
    return writePointer(target, move.to, value);
}

function readPointer(value: FacetData, pointer: string): FacetData {
    let current = value;
    for (const segment of pointerSegments(pointer)) {
        if (Array.isArray(current)) {
            const index = arrayIndex(segment, current.length);
            current = current[index]!;
        } else if (isObject(current) && Object.hasOwn(current, segment)) {
            current = current[segment]!;
        } else {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Command mapping source ${pointer} is missing`
            );
        }
    }
    return current;
}

function writePointer(target: FacetData, pointer: string, value: FacetData): FacetData {
    if (pointer === "") return canonicalFacetData(value);
    const root = mutableCopy(target);
    const segments = pointerSegments(pointer);
    let current: FacetData = root;
    for (const [index, segment] of segments.entries()) {
        const last = index === segments.length - 1;
        if (!isObject(current)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Command mapping target ${pointer} is invalid`
            );
        }
        if (last) {
            defineDataProperty(current, segment, mutableCopy(value));
            continue;
        }
        rejectUnsafeSegment(segment);
        const child = Object.hasOwn(current, segment) ? current[segment] : undefined;
        if (child === undefined) {
            const next: { [key: string]: FacetData } = {};
            defineDataProperty(current, segment, next);
            current = next;
        } else {
            current = child;
        }
    }
    return canonicalFacetData(root);
}

function pointerSegments(pointer: string): readonly string[] {
    if (pointer === "") return [];
    return pointer
        .slice(1)
        .split("/")
        .map((segment) => {
            const decoded = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
            rejectUnsafeSegment(decoded);
            return decoded;
        });
}

function arrayIndex(value: string, length: number): number {
    if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
        throw new AgentCoreError(
            "operation.invalid-input",
            "Command mapping array index is invalid"
        );
    }
    const index = Number(value);
    if (!Number.isSafeInteger(index) || index >= length) {
        throw new AgentCoreError(
            "operation.invalid-input",
            "Command mapping array index is out of bounds"
        );
    }
    return index;
}

function mutableCopy(value: FacetData): FacetData {
    if (Array.isArray(value)) return value.map(mutableCopy);
    if (isObject(value))
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, mutableCopy(child)])
        );
    return value;
}

function isObject(value: FacetData): value is { readonly [key: string]: FacetData } {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}

function defineDataProperty(
    target: { readonly [key: string]: FacetData },
    key: string,
    value: FacetData
): void {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true
    });
}

function rejectUnsafeSegment(segment: string): void {
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
        throw new AgentCoreError(
            "operation.invalid-input",
            "Command mapping contains an unsafe path segment"
        );
    }
}
