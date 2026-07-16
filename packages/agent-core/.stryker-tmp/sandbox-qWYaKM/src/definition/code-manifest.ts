// @ts-nocheck
import {
    ContentRef,
    Digest,
    RecordCodec,
    SemVer,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue
} from "../core";
import type { MediaHint } from "../content";
import { FacetPackageId } from "../facets";
import { compareText } from "./order";

export interface PackageCodeModuleInit {
    readonly specifier: string;
    readonly content: ContentRef;
    readonly media: MediaHint;
    readonly imports?: readonly string[];
}

export class PackageCodeModule {
    public readonly specifier: string;
    public readonly content: ContentRef;
    public readonly media: MediaHint;
    public readonly imports: readonly string[];

    public constructor(init: PackageCodeModuleInit) {
        this.specifier = canonicalSpecifier(init.specifier, "Code module specifier");
        const imports = [...(init.imports ?? [])]
            .map((value) => canonicalSpecifier(value, "Code module import"))
            .sort(compareText);
        requireUnique(imports, "Code module imports must be unique");
        this.content = new ContentRef(init.content.value);
        this.media = canonicalMedia(init.media);
        this.imports = Object.freeze(imports);
        Object.freeze(this);
    }

    public static fromData(value: JsonValue): PackageCodeModule {
        const object = requireObject(value, "Code module");
        requireFields(object, ["content", "imports", "media", "specifier"], "Code module");
        return new PackageCodeModule({
            specifier: requireString(object["specifier"], "Code module specifier"),
            content: new ContentRef(requireString(object["content"], "Code module content")),
            media: { mediaType: requireString(object["media"], "Code module media") },
            imports: requireArray(object["imports"], "Code module imports").map((entry) =>
                requireString(entry, "Code module import")
            )
        });
    }

    public toData(): JsonValue {
        return {
            content: this.content.value,
            imports: this.imports,
            media: this.media.mediaType,
            specifier: this.specifier
        };
    }
}

export interface PackageCodeEntrypointInit {
    readonly facet: FacetPackageId;
    readonly version: SemVer;
    readonly module: string;
    readonly exportName?: string;
}

export class PackageCodeEntrypoint {
    public readonly facet: FacetPackageId;
    public readonly version: SemVer;
    public readonly module: string;
    public readonly exportName: string;

    public constructor(init: PackageCodeEntrypointInit) {
        this.facet = new FacetPackageId(init.facet.value);
        this.version = new SemVer(init.version.toString());
        this.module = canonicalSpecifier(init.module, "Code entrypoint module");
        this.exportName = canonicalExportName(init.exportName ?? "default");
        Object.freeze(this);
    }

    public static fromData(value: JsonValue): PackageCodeEntrypoint {
        const object = requireObject(value, "Code entrypoint");
        requireFields(object, ["exportName", "facet", "module", "version"], "Code entrypoint");
        return new PackageCodeEntrypoint({
            facet: new FacetPackageId(requireString(object["facet"], "Code entrypoint Facet")),
            version: new SemVer(requireString(object["version"], "Code entrypoint version")),
            module: requireString(object["module"], "Code entrypoint module"),
            exportName: requireString(object["exportName"], "Code entrypoint export")
        });
    }

    public toData(): JsonValue {
        return {
            exportName: this.exportName,
            facet: this.facet.value,
            module: this.module,
            version: this.version.toString()
        };
    }
}

export interface PackageCodeManifestInit {
    readonly modules: readonly [PackageCodeModule, ...PackageCodeModule[]];
    readonly entrypoints: readonly [PackageCodeEntrypoint, ...PackageCodeEntrypoint[]];
    readonly compatibilityDate: string;
    readonly digest?: Digest;
}

class PackageCodeManifestCodec extends RecordCodec<PackageCodeManifest> {
    public constructor() {
        super("definition.package-code-manifest", { major: 1, minor: 0 });
    }

    protected encodePayload(manifest: PackageCodeManifest): JsonValue {
        return manifest.toData();
    }

    protected decodePayload(payload: JsonValue): PackageCodeManifest {
        return PackageCodeManifest.fromData(payload);
    }
}

export class PackageCodeManifest {
    public static readonly codec: RecordCodec<PackageCodeManifest> = new PackageCodeManifestCodec();

    public readonly modules: readonly [PackageCodeModule, ...PackageCodeModule[]];
    public readonly entrypoints: readonly [PackageCodeEntrypoint, ...PackageCodeEntrypoint[]];
    public readonly compatibilityDate: string;
    public readonly digest: Digest;

    public constructor(init: PackageCodeManifestInit) {
        const modules = init.modules
            .map((module) => PackageCodeModule.fromData(module.toData()))
            .sort((left, right) => compareText(left.specifier, right.specifier));
        const entrypoints = init.entrypoints
            .map((entrypoint) => PackageCodeEntrypoint.fromData(entrypoint.toData()))
            .sort(compareEntrypoints);
        if (modules.length === 0 || entrypoints.length === 0) {
            throw new TypeError("Package code manifest requires modules and entrypoints");
        }
        requireUnique(
            modules.map((module) => module.specifier),
            "Code module specifiers must be unique"
        );
        requireUnique(
            entrypoints.map((entrypoint) => facetKey(entrypoint.facet, entrypoint.version)),
            "Code entrypoints must be unique by Facet and version"
        );
        const moduleNames = new Set(modules.map((module) => module.specifier));
        for (const module of modules) {
            for (const imported of module.imports) {
                if (!moduleNames.has(imported)) {
                    throw new TypeError(
                        `Code module ${module.specifier} imports missing module ${imported}`
                    );
                }
            }
        }
        for (const entrypoint of entrypoints) {
            if (!moduleNames.has(entrypoint.module)) {
                throw new TypeError(
                    `Code entrypoint references missing module ${entrypoint.module}`
                );
            }
        }
        const reachable = reachableModules(modules, entrypoints);
        if (modules.some((module) => !reachable.has(module.specifier))) {
            throw new TypeError(
                "Package code manifest contains a module outside its entrypoint closure"
            );
        }
        const compatibilityDate = canonicalCompatibilityDate(init.compatibilityDate);
        const data = codeData(modules, entrypoints, compatibilityDate);
        const digest = Digest.sha256(encodeCanonicalJson(data));
        if (init.digest !== undefined && !init.digest.equals(digest)) {
            throw new TypeError("Package code digest does not match its canonical module closure");
        }
        this.modules = Object.freeze(modules) as unknown as readonly [
            PackageCodeModule,
            ...PackageCodeModule[]
        ];
        this.entrypoints = Object.freeze(entrypoints) as unknown as readonly [
            PackageCodeEntrypoint,
            ...PackageCodeEntrypoint[]
        ];
        this.compatibilityDate = compatibilityDate;
        this.digest = digest;
        Object.freeze(this);
    }

    public static encode(manifest: PackageCodeManifest): Uint8Array {
        return PackageCodeManifest.codec.encode(manifest);
    }

    public static decode(bytes: Uint8Array): PackageCodeManifest {
        return PackageCodeManifest.codec.decode(bytes);
    }

    public static fromData(value: JsonValue): PackageCodeManifest {
        const object = requireObject(value, "Package code manifest");
        requireFields(
            object,
            ["compatibilityDate", "digest", "entrypoints", "modules"],
            "Package code manifest"
        );
        const modules = requireArray(object["modules"], "Package code modules").map(
            PackageCodeModule.fromData
        );
        const entrypoints = requireArray(object["entrypoints"], "Package code entrypoints").map(
            PackageCodeEntrypoint.fromData
        );
        if (modules.length === 0 || entrypoints.length === 0) {
            throw new TypeError("Package code manifest requires modules and entrypoints");
        }
        return new PackageCodeManifest({
            modules: modules as [PackageCodeModule, ...PackageCodeModule[]],
            entrypoints: entrypoints as [PackageCodeEntrypoint, ...PackageCodeEntrypoint[]],
            compatibilityDate: requireString(
                object["compatibilityDate"],
                "Package code compatibility date"
            ),
            digest: new Digest(requireString(object["digest"], "Package code digest"))
        });
    }

    public module(specifier: string): PackageCodeModule | undefined {
        return this.modules.find((module) => module.specifier === specifier);
    }

    public toData(): JsonValue {
        return {
            compatibilityDate: this.compatibilityDate,
            digest: this.digest.value,
            entrypoints: this.entrypoints.map((entrypoint) => entrypoint.toData()),
            modules: this.modules.map((module) => module.toData())
        };
    }
}

function codeData(
    modules: readonly PackageCodeModule[],
    entrypoints: readonly PackageCodeEntrypoint[],
    compatibilityDate: string
): JsonValue {
    return {
        compatibilityDate,
        domain: "agent-core.package-code.v1",
        entrypoints: entrypoints.map((entrypoint) => entrypoint.toData()),
        modules: modules.map((module) => module.toData())
    };
}

function canonicalMedia(value: MediaHint): MediaHint {
    if (value === null || typeof value !== "object" || typeof value.mediaType !== "string") {
        throw new TypeError("Code module media must be a MediaHint");
    }
    const mediaType = value.mediaType;
    if (
        mediaType !== mediaType.trim().toLowerCase() ||
        !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)
    ) {
        throw new TypeError("Code module media must be a canonical media type without parameters");
    }
    return Object.freeze({ mediaType });
}

function canonicalCompatibilityDate(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match === null) {
        throw new TypeError("Package code compatibility date must be YYYY-MM-DD");
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        year === 0 ||
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        throw new TypeError("Package code compatibility date must be a valid calendar date");
    }
    return value;
}

function reachableModules(
    modules: readonly PackageCodeModule[],
    entrypoints: readonly PackageCodeEntrypoint[]
): ReadonlySet<string> {
    const byName = new Map(modules.map((module) => [module.specifier, module]));
    const reachable = new Set<string>();
    const pending = entrypoints.map((entrypoint) => entrypoint.module);
    while (pending.length > 0) {
        const specifier = pending.pop()!;
        if (reachable.has(specifier)) continue;
        reachable.add(specifier);
        pending.push(...byName.get(specifier)!.imports);
    }
    return reachable;
}

function compareEntrypoints(left: PackageCodeEntrypoint, right: PackageCodeEntrypoint): number {
    return (
        compareText(left.facet.value, right.facet.value) ||
        compareText(left.version.toString(), right.version.toString())
    );
}

function facetKey(facet: FacetPackageId, version: SemVer): string {
    return `${facet.value}\0${version.toString()}`;
}

function canonicalSpecifier(value: string, subject: string): string {
    if (value.trim().length === 0 || value !== value.trim() || value.includes("\\")) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
    return value;
}

function canonicalExportName(value: string): string {
    if (!/^(?:default|[A-Za-z_$][A-Za-z0-9_$]*)$/.test(value)) {
        throw new TypeError("Code entrypoint export must be a JavaScript identifier or default");
    }
    return value;
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
    if (typeof value !== "string") throw new TypeError(`${subject} must be a string`);
    return value;
}

function requireArray(value: JsonValue | undefined, subject: string): readonly JsonValue[] {
    if (!Array.isArray(value)) throw new TypeError(`${subject} must be an array`);
    return value;
}

function requireUnique(values: readonly string[], message: string): void {
    if (new Set(values).size !== values.length) throw new TypeError(message);
}
