// @ts-nocheck
import { RecordCodec, SemVer, type JsonValue } from "../core";
import { canonicalFacetData, type FacetDataMap } from "../facets";
import { Config, type ConfigData, type ConfigInputMap } from "./config";
import { PackageId } from "./id";
import { PackageDependency } from "./package";
import { PolicySet } from "./policy";
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
        super("definition.package-install", { major: 1, minor: 0 });
    }

    protected encodePayload(install: PackageInstall): JsonValue {
        return install.toData();
    }

    protected decodePayload(payload: JsonValue): PackageInstall {
        return PackageInstall.fromData(payload);
    }
}

export class PackageInstall {
    public static readonly codec: RecordCodec<PackageInstall> = new PackageInstallCodec();
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
            request: PackageDependency.fromData(object["request"]!),
            config: Config.fromData(
                requireObject(object["config"]!, "Package config") as ConfigData
            )
        });
    }

    public toData(): JsonValue {
        return {
            config: this.config.toData(),
            request: this.request.toData()
        };
    }
}

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
        super("definition.blueprint", { major: 2, minor: 0 });
    }

    protected encodePayload(blueprint: Blueprint): JsonValue {
        return blueprint.toData();
    }

    protected decodePayload(payload: JsonValue): Blueprint {
        return Blueprint.fromData(payload);
    }
}

export class Blueprint {
    public static readonly codec: RecordCodec<Blueprint> = new BlueprintCodec();
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
        return new Blueprint({
            meta: BlueprintMeta.fromData(object["meta"]!),
            packages: requireArray(object["packages"], "Blueprint packages").map(
                PackageInstall.fromData
            ),
            policies: PolicySet.fromData(object["policies"]!),
            agents: requireObjectArray(object["agents"]!, "Blueprint agents"),
            ...(object["scopes"] === undefined
                ? {}
                : { scopes: requireObject(object["scopes"], "Blueprint scope scaffold") }),
            ...(object["slots"] === undefined
                ? {}
                : { slots: requireObjectArray(object["slots"], "Blueprint slots") }),
            ...(object["subscriptions"] === undefined
                ? {}
                : {
                      subscriptions: requireObjectArray(
                          object["subscriptions"],
                          "Blueprint subscriptions"
                      )
                  }),
            ...(object["environments"] === undefined
                ? {}
                : {
                      environments: requireObjectArray(
                          object["environments"],
                          "Blueprint environments"
                      )
                  }),
            ...(object["surfaces"] === undefined
                ? {}
                : { surfaces: requireObject(object["surfaces"], "Blueprint surface layout") })
        });
    }

    public root(id: PackageId | string): PackageInstall | undefined {
        const value = typeof id === "string" ? id : id.value;
        return this.packages.find((install) => install.request.id.value === value);
    }

    public toData(): JsonValue {
        return {
            meta: this.meta.toData(),
            packages: this.packages.map((install) => install.toData()),
            policies: this.policies.toData(),
            ...(this.scopes === undefined ? {} : { scopes: this.scopes }),
            agents: this.agents,
            ...(this.slots === undefined ? {} : { slots: this.slots }),
            ...(this.subscriptions === undefined ? {} : { subscriptions: this.subscriptions }),
            ...(this.environments === undefined ? {} : { environments: this.environments }),
            ...(this.surfaces === undefined ? {} : { surfaces: this.surfaces })
        };
    }
}

function canonicalDeclarationMap(value: DeclarationInput, subject: string): FacetDataMap {
    const data = isDeclaration(value) ? value.toData() : value;
    const canonical = canonicalFacetData(data);
    if (canonical === null || Array.isArray(canonical) || typeof canonical !== "object") {
        throw new TypeError(`${subject} must be an object declaration`);
    }
    return canonical as FacetDataMap;
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
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as FacetDataMap;
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

function requireFields(
    value: FacetDataMap,
    required: readonly string[],
    optional: readonly string[],
    subject: string
): void {
    const admitted = new Set([...required, ...optional]);
    if (
        required.some((field) => !(field in value)) ||
        Object.keys(value).some((field) => !admitted.has(field))
    ) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
}

function requireString(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${subject} must be a string`);
    }
    return value;
}

function requireNonblank(value: string, subject: string): void {
    if (value.trim().length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
}
