import {
    isJsonObject,
    type JsonFields,
    type JsonObject,
    RecordCodec,
    SecretRef,
    SemVer,
    type JsonValue,
    TextId
} from "../core";
import { AuthoredCodeBackingId, canonicalFacetData, type FacetDataMap } from "../facets";
import { Config, type ConfigInputMap } from "./config";
import { PackageId } from "./id";
import { PackageDependency } from "./package";
import { AuthoredCodeBackingPolicy, PlacementPolicy } from "./placement";
import { PolicySet, TreeMergePolicy } from "./policy";
import { compareText } from "./order";

export interface CanonicalDeclaration {
    toData(): JsonValue;
}

export type DeclarationInput = JsonValue | CanonicalDeclaration;

export interface PackageInstallInit {
    readonly request: PackageDependency;
    readonly config?: Config | ConfigInputMap;
}

class PackageInstallCodec extends RecordCodec<PackageInstall> {
    public constructor() {
        super(
            [PackageInstall, TextId, Config, PackageDependency, SecretRef, PackageId],
            "definition.package-install",
            {
                major: 1,
                minor: 0
            }
        );
    }

    protected encodePayload(install: PackageInstall): JsonValue {
        return install.toData();
    }

    protected decodePayload(payload: JsonValue): PackageInstall {
        return PackageInstall.fromData(payload);
    }
}

export class PackageInstall {
    public static get codec(): RecordCodec<PackageInstall> {
        return packageInstallCodecInstance;
    }
    public readonly request: PackageDependency;
    public readonly config: Config;

    public constructor(init: PackageInstallInit) {
        this.request = new PackageDependency(init.request.id, init.request.range);
        this.config =
            init.config instanceof Config
                ? Config.decode(Config.encode(init.config))
                : new Config(init.config ?? {});
        Object.freeze(this);
    }

    public static encode(install: PackageInstall): Uint8Array {
        return PackageInstall.codec.encode(install);
    }

    public static decode(bytes: Uint8Array): PackageInstall {
        return PackageInstall.codec.decode(bytes);
    }

    public static fromData(value: JsonValue): PackageInstall {
        const object = requireObject(value, "Package install");
        requireFields(object, ["config", "request"], [], "Package install");
        return new PackageInstall({
            request: PackageDependency.fromData(object["request"]),
            config: Config.fromData(requireObject(object["config"], "Package config"))
        });
    }

    public toData(): JsonValue {
        return {
            config: this.config.toData(),
            request: this.request.toData()
        };
    }
}

const packageInstallCodecInstance = new PackageInstallCodec();

export interface BlueprintMetaInit {
    readonly name: string;
    readonly version: SemVer;
}

export class BlueprintMeta {
    public constructor(
        public readonly name: string,
        public readonly version: SemVer
    ) {
        requireNonblank(name, "Blueprint name");
        Object.freeze(this);
    }

    public static fromData(value: JsonValue): BlueprintMeta {
        const object = requireObject(value, "Blueprint metadata");
        requireFields(object, ["name", "version"], [], "Blueprint metadata");
        return new BlueprintMeta(
            requireString(object["name"], "Blueprint name"),
            new SemVer(requireString(object["version"], "Blueprint version"))
        );
    }

    public toData(): JsonValue {
        return { name: this.name, version: this.version.toString() };
    }
}

export interface BlueprintInit {
    readonly meta: BlueprintMeta | BlueprintMetaInit;
    readonly packages: readonly PackageInstall[];
    readonly policies: PolicySet;
    readonly scopes?: DeclarationInput;
    readonly agents: readonly DeclarationInput[];
    readonly slots?: readonly DeclarationInput[];
    readonly subscriptions?: readonly DeclarationInput[];
    readonly environments?: readonly DeclarationInput[];
    readonly surfaces?: DeclarationInput;
}

class BlueprintCodec extends RecordCodec<Blueprint> {
    public constructor() {
        super(
            [
                Blueprint,
                BlueprintMeta,
                SemVer,
                PolicySet,
                TreeMergePolicy,
                PackageInstall,
                AuthoredCodeBackingPolicy,
                PlacementPolicy,
                PackageId,
                AuthoredCodeBackingId,
                Config,
                TextId,
                SecretRef,
                PackageDependency
            ],
            "definition.blueprint",
            { major: 3, minor: 0 }
        );
    }

    protected encodePayload(blueprint: Blueprint): JsonValue {
        return blueprint.toData();
    }

    protected decodePayload(payload: JsonValue): Blueprint {
        return Blueprint.fromData(payload);
    }
}

export class Blueprint {
    public static get codec(): RecordCodec<Blueprint> {
        return blueprintCodecInstance;
    }
    public readonly meta: BlueprintMeta;
    public readonly packages: readonly PackageInstall[];
    public readonly policies: PolicySet;
    public readonly scopes: FacetDataMap | undefined;
    public readonly agents: readonly FacetDataMap[];
    public readonly slots: readonly FacetDataMap[] | undefined;
    public readonly subscriptions: readonly FacetDataMap[] | undefined;
    public readonly environments: readonly FacetDataMap[] | undefined;
    public readonly surfaces: FacetDataMap | undefined;

    public constructor(init: BlueprintInit) {
        const packages = [...init.packages]
            .map((install) => PackageInstall.decode(PackageInstall.encode(install)))
            .sort((left, right) => compareText(left.request.id.value, right.request.id.value));
        if (new Set(packages.map((install) => install.request.id.value)).size !== packages.length) {
            throw new TypeError("Blueprint root package IDs must be unique");
        }

        this.meta = new BlueprintMeta(init.meta.name, init.meta.version);
        this.packages = Object.freeze(packages);
        if (!(init.policies instanceof PolicySet)) {
            throw new TypeError("Blueprint policies must be a PolicySet");
        }
        this.policies = PolicySet.decode(PolicySet.encode(init.policies));
        this.scopes = optionalCanonicalDeclarationMap(init.scopes, "Blueprint scope scaffold");
        this.agents = Object.freeze(
            init.agents.map((value) => canonicalDeclarationMap(value, "Blueprint agent"))
        );
        this.slots = optionalCanonicalDeclarationArray(init.slots, "Blueprint slot");
        this.subscriptions = optionalCanonicalDeclarationArray(
            init.subscriptions,
            "Blueprint subscription"
        );
        this.environments = optionalCanonicalDeclarationArray(
            init.environments,
            "Blueprint environment"
        );
        this.surfaces = optionalCanonicalDeclarationMap(init.surfaces, "Blueprint surface layout");
        Object.freeze(this);
    }

    public static encode(blueprint: Blueprint): Uint8Array {
        return Blueprint.codec.encode(blueprint);
    }

    public static decode(bytes: Uint8Array): Blueprint {
        return Blueprint.codec.decode(bytes);
    }

    public static fromData(value: JsonValue): Blueprint {
        const object = requireObject(value, "Blueprint");
        requireFields(
            object,
            ["agents", "meta", "packages", "policies"],
            ["environments", "scopes", "slots", "subscriptions", "surfaces"],
            "Blueprint"
        );
        let blueprint: BlueprintInit = {
            meta: BlueprintMeta.fromData(object["meta"]),
            packages: requireArray(object["packages"], "Blueprint packages").map(
                PackageInstall.fromData
            ),
            policies: PolicySet.fromData(object["policies"]),
            agents: requireObjectArray(object["agents"], "Blueprint agents")
        };
        if (object["scopes"] !== undefined) {
            blueprint = {
                ...blueprint,
                scopes: requireObject(object["scopes"], "Blueprint scope scaffold")
            };
        }
        if (object["slots"] !== undefined) {
            blueprint = {
                ...blueprint,
                slots: requireObjectArray(object["slots"], "Blueprint slots")
            };
        }
        if (object["subscriptions"] !== undefined) {
            blueprint = {
                ...blueprint,
                subscriptions: requireObjectArray(
                    object["subscriptions"],
                    "Blueprint subscriptions"
                )
            };
        }
        if (object["environments"] !== undefined) {
            blueprint = {
                ...blueprint,
                environments: requireObjectArray(object["environments"], "Blueprint environments")
            };
        }
        if (object["surfaces"] !== undefined) {
            blueprint = {
                ...blueprint,
                surfaces: requireObject(object["surfaces"], "Blueprint surface layout")
            };
        }
        return new Blueprint(blueprint);
    }

    public root(id: PackageId | string): PackageInstall | undefined {
        const value = isPackageIdText(id) ? id : id.value;
        return this.packages.find((install) => install.request.id.value === value);
    }

    public toData(): JsonValue {
        let data: JsonObject = {
            meta: this.meta.toData(),
            packages: this.packages.map((install) => install.toData()),
            policies: this.policies.toData(),
            agents: this.agents
        };
        if (this.scopes !== undefined) data = { ...data, scopes: this.scopes };
        if (this.slots !== undefined) data = { ...data, slots: this.slots };
        if (this.subscriptions !== undefined) {
            data = { ...data, subscriptions: this.subscriptions };
        }
        if (this.environments !== undefined) data = { ...data, environments: this.environments };
        if (this.surfaces !== undefined) data = { ...data, surfaces: this.surfaces };
        return data;
    }
}

const blueprintCodecInstance = new BlueprintCodec();

function canonicalDeclarationMap(value: DeclarationInput, subject: string): FacetDataMap {
    const data = isDeclaration(value) ? value.toData() : value;
    const canonical = canonicalFacetData(data);
    if (!isJsonObject(canonical)) {
        throw new TypeError(`${subject} must be an object declaration`);
    }
    return canonical;
}

function optionalCanonicalDeclarationMap(
    value: DeclarationInput | undefined,
    subject: string
): FacetDataMap | undefined {
    return value === undefined ? undefined : canonicalDeclarationMap(value, subject);
}

function optionalCanonicalDeclarationArray(
    values: readonly DeclarationInput[] | undefined,
    subject: string
): readonly FacetDataMap[] | undefined {
    return values === undefined
        ? undefined
        : Object.freeze(values.map((value) => canonicalDeclarationMap(value, subject)));
}

function isDeclaration(value: DeclarationInput): value is CanonicalDeclaration {
    return (
        value !== null &&
        typeof value === "object" &&
        "toData" in value &&
        typeof value.toData === "function"
    );
}

function requireObject(value: JsonValue, subject: string): FacetDataMap {
    if (!isJsonObject(value)) {
        throw new TypeError(`${subject} must be an object`);
    }
    return value;
}

function requireObjectArray(value: JsonValue, subject: string): readonly FacetDataMap[] {
    return requireArray(value, subject).map((entry, index) =>
        requireObject(entry, `${subject} entry ${index}`)
    );
}

function requireArray(value: JsonValue | undefined, subject: string): readonly JsonValue[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value;
}

function requireFields<Field extends string>(
    value: FacetDataMap,
    required: readonly Field[],
    optional: readonly string[],
    subject: string
): asserts value is FacetDataMap & JsonFields<Field> {
    const admitted = new Set([...required, ...optional]);
    if (
        required.some((field) => !(field in value)) ||
        Object.keys(value).some((field) => !admitted.has(field))
    ) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
}

function requireString(value: JsonValue | undefined, subject: string): string {
    if (!isStringValue(value)) {
        throw new TypeError(`${subject} must be a string`);
    }
    return value;
}

function isPackageIdText(value: PackageId | string): value is string {
    return typeof value === "string";
}

function isStringValue(value: JsonValue | undefined): value is string {
    return typeof value === "string";
}

function requireNonblank(value: string, subject: string): void {
    if (value.length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
}
