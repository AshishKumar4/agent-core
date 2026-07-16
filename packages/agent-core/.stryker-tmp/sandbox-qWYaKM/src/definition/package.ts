// @ts-nocheck
import { Range } from "semver";
import {
    CompatRange,
    Digest,
    JsonSchema,
    RecordCodec,
    Revision,
    SemVer,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue
} from "../core";
import { FacetManifest, canonicalFacetDataMap, isFacetDataMap, type FacetDataMap } from "../facets";
import { PackageId } from "./id";
import { canonicalCompatibilityRange } from "./compatibility";
import { PackageCodeManifest } from "./code-manifest";
import { compareText } from "./order";

export type PackageProvenance = FacetDataMap;

export class PackageDependency {
    public readonly range: string;

    public constructor(
        public readonly id: PackageId,
        range: string
    ) {
        this.range = canonicalPackageRange(range);
        Object.freeze(this);
    }

    public static fromData(value: JsonValue): PackageDependency {
        const object = requireObject(value, "Package dependency");
        requireFields(object, ["id", "range"], "Package dependency");
        const range = requireString(object["range"], "Package dependency range");
        const dependency = new PackageDependency(
            new PackageId(requireString(object["id"], "Package dependency ID")),
            range
        );
        if (dependency.range !== range) {
            throw new TypeError("Package dependency range must be canonical");
        }
        return dependency;
    }

    public toData(): JsonValue {
        return { id: this.id.value, range: this.range };
    }
}

export interface PackageReleaseInit {
    readonly id: PackageId;
    readonly version: SemVer;
    readonly compatibility: CompatRange;
    readonly dependencies: readonly PackageDependency[];
    readonly manifests: readonly [FacetManifest, ...FacetManifest[]];
    readonly codeManifest: PackageCodeManifest;
    readonly manifestDigest?: Digest;
    readonly codeDigest?: Digest;
    readonly provenance: PackageProvenance;
    readonly configSchema?: JsonSchema;
}

class PackageReleaseCodec extends RecordCodec<PackageRelease> {
    public constructor() {
        super("definition.package-release", { major: 2, minor: 0 });
    }

    protected encodePayload(release: PackageRelease): JsonValue {
        return release.toData();
    }

    protected decodePayload(payload: JsonValue): PackageRelease {
        return PackageRelease.fromData(payload);
    }
}

export class PackageRelease {
    public static readonly codec: RecordCodec<PackageRelease> = new PackageReleaseCodec();

    public readonly id: PackageId;
    public readonly version: SemVer;
    public readonly compatibility: CompatRange;
    public readonly dependencies: readonly PackageDependency[];
    public readonly manifests: readonly [FacetManifest, ...FacetManifest[]];
    public readonly manifestDigest: Digest;
    public readonly codeDigest: Digest;
    public readonly codeManifest: PackageCodeManifest;
    public readonly provenance: PackageProvenance;
    public readonly configSchema: JsonSchema | undefined;

    public constructor(init: PackageReleaseInit) {
        const dependencies = [...init.dependencies]
            .map((dependency) => new PackageDependency(dependency.id, dependency.range))
            .sort((left, right) => compareText(left.id.value, right.id.value));
        requireUnique(
            dependencies.map((dependency) => dependency.id.value),
            "Package dependency IDs must be unique"
        );
        const manifests = [...init.manifests].sort(compareManifests);
        if (manifests.length === 0) {
            throw new TypeError("Package release must contain at least one manifest");
        }
        requireUnique(
            manifests.map((manifest) => `${manifest.id.value}\0${manifest.version.toString()}`),
            "Package manifests must be unique by ID and version"
        );
        const manifestDigest = Digest.sha256(
            encodeCanonicalJson(manifests.map((manifest) => manifest.toData()))
        );
        if (init.manifestDigest !== undefined && !init.manifestDigest.equals(manifestDigest)) {
            throw new TypeError("Package manifest digest does not match its canonical manifests");
        }
        if (!isFacetDataMap(init.provenance)) {
            throw new TypeError("Package provenance must be a canonical data object");
        }
        const codeManifest = PackageCodeManifest.decode(
            PackageCodeManifest.encode(init.codeManifest)
        );
        const manifestKeys = manifests.map(
            (manifest) => `${manifest.id.value}\0${manifest.version.toString()}`
        );
        const entrypointKeys = codeManifest.entrypoints.map(
            (entrypoint) => `${entrypoint.facet.value}\0${entrypoint.version.toString()}`
        );
        if (
            manifestKeys.length !== entrypointKeys.length ||
            manifestKeys.some((key, index) => key !== entrypointKeys[index])
        ) {
            throw new TypeError(
                "Package code entrypoints must exactly match Package Facet manifests"
            );
        }
        if (init.codeDigest !== undefined && !init.codeDigest.equals(codeManifest.digest)) {
            throw new TypeError("Package code digest does not match its canonical code manifest");
        }

        this.id = init.id;
        this.version = init.version;
        this.compatibility = new CompatRange(
            canonicalCompatibilityRange(init.compatibility.spec, "Package spec compatibility"),
            canonicalCompatibilityRange(init.compatibility.host, "Package host compatibility")
        );
        this.dependencies = Object.freeze(dependencies);
        this.manifests = Object.freeze(manifests) as unknown as readonly [
            FacetManifest,
            ...FacetManifest[]
        ];
        this.manifestDigest = manifestDigest;
        this.codeDigest = codeManifest.digest;
        this.codeManifest = codeManifest;
        this.provenance = canonicalFacetDataMap(init.provenance);
        this.configSchema = init.configSchema;
        Object.freeze(this);
    }

    public static encode(release: PackageRelease): Uint8Array {
        return PackageRelease.codec.encode(release);
    }

    public static decode(bytes: Uint8Array): PackageRelease {
        return PackageRelease.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): PackageRelease {
        const object = requireObject(payload, "Package release");
        requireOptionalFields(
            object,
            [
                "codeDigest",
                "codeManifest",
                "compatibility",
                "dependencies",
                "id",
                "manifestDigest",
                "manifests",
                "provenance",
                "version"
            ],
            ["configSchema"],
            "Package release"
        );
        const compatibility = requireObject(object["compatibility"]!, "Package compatibility");
        requireFields(compatibility, ["host", "spec"], "Package compatibility");
        const provenance = object["provenance"];
        if (!isFacetDataMap(provenance)) {
            throw new TypeError("Package provenance must be a canonical data object");
        }
        const configSchema =
            object["configSchema"] === undefined
                ? undefined
                : new JsonSchema(requireSchema(object["configSchema"]!));
        const manifests = requireArray(object["manifests"], "Package manifests").map(
            FacetManifest.fromData
        );
        if (manifests.length === 0) {
            throw new TypeError("Package release must contain at least one manifest");
        }
        return new PackageRelease({
            id: new PackageId(requireString(object["id"], "Package ID")),
            version: new SemVer(requireString(object["version"], "Package version")),
            compatibility: new CompatRange(
                requireString(compatibility["spec"], "Package spec compatibility"),
                requireString(compatibility["host"], "Package host compatibility")
            ),
            dependencies: requireArray(object["dependencies"], "Package dependencies").map(
                PackageDependency.fromData
            ),
            manifests: manifests as [FacetManifest, ...FacetManifest[]],
            codeManifest: PackageCodeManifest.fromData(object["codeManifest"]!),
            manifestDigest: new Digest(requireString(object["manifestDigest"], "Manifest digest")),
            codeDigest: new Digest(requireString(object["codeDigest"], "Code digest")),
            provenance,
            ...(configSchema === undefined ? {} : { configSchema })
        });
    }

    public toData(): JsonValue {
        return {
            codeDigest: this.codeDigest.value,
            codeManifest: this.codeManifest.toData(),
            compatibility: {
                host: this.compatibility.host,
                spec: this.compatibility.spec
            },
            dependencies: this.dependencies.map((dependency) => dependency.toData()),
            id: this.id.value,
            manifestDigest: this.manifestDigest.value,
            manifests: this.manifests.map((manifest) => manifest.toData()),
            provenance: this.provenance,
            version: this.version.toString(),
            ...(this.configSchema === undefined ? {} : { configSchema: this.configSchema.document })
        };
    }
}

export interface MetadataSnapshotInit {
    readonly revision: Revision;
    readonly releases: readonly PackageRelease[];
    readonly digest?: Digest;
}

class MetadataSnapshotCodec extends RecordCodec<MetadataSnapshot> {
    public constructor() {
        super("definition.metadata-snapshot", { major: 1, minor: 0 });
    }

    protected encodePayload(snapshot: MetadataSnapshot): JsonValue {
        return snapshot.toData();
    }

    protected decodePayload(payload: JsonValue): MetadataSnapshot {
        return MetadataSnapshot.fromData(payload);
    }
}

export class MetadataSnapshot {
    public static readonly codec: RecordCodec<MetadataSnapshot> = new MetadataSnapshotCodec();

    public readonly revision: Revision;
    public readonly digest: Digest;
    public readonly releases: readonly PackageRelease[];

    public constructor(init: MetadataSnapshotInit) {
        const releases = canonicalReleases(init.releases);
        const digest = snapshotDigest(init.revision, releases);
        if (init.digest !== undefined && !init.digest.equals(digest)) {
            throw new TypeError("Metadata snapshot digest does not match its canonical contents");
        }
        this.revision = init.revision;
        this.digest = digest;
        this.releases = Object.freeze(releases);
        Object.freeze(this);
    }

    public static encode(snapshot: MetadataSnapshot): Uint8Array {
        return MetadataSnapshot.codec.encode(snapshot);
    }

    public static decode(bytes: Uint8Array): MetadataSnapshot {
        return MetadataSnapshot.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): MetadataSnapshot {
        const object = requireObject(payload, "Metadata snapshot");
        requireFields(object, ["digest", "releases", "revision"], "Metadata snapshot");
        return new MetadataSnapshot({
            revision: new Revision(
                requireNonnegativeInteger(object["revision"], "Snapshot revision")
            ),
            digest: new Digest(requireString(object["digest"], "Snapshot digest")),
            releases: requireArray(object["releases"], "Snapshot releases").map(
                PackageRelease.fromData
            )
        });
    }

    public releasesFor(id: PackageId): readonly PackageRelease[] {
        return this.releases.filter((release) => release.id.equals(id));
    }

    public toData(): JsonValue {
        return {
            digest: this.digest.value,
            releases: this.releases.map((release) => release.toData()),
            revision: this.revision.value
        };
    }
}

export function canonicalPackageRange(value: string): string {
    if (value.trim().length === 0 || value !== value.trim()) {
        throw new TypeError("Package dependency range must be a nonblank canonical string");
    }
    try {
        return new Range(value).range || "*";
    } catch {
        throw new TypeError("Package dependency range must be a valid semantic version range");
    }
}

function canonicalReleases(input: readonly PackageRelease[]): PackageRelease[] {
    const releases = [...input].sort(compareReleases);
    const unique: PackageRelease[] = [];
    for (const release of releases) {
        const previous = unique.at(-1);
        if (previous === undefined || releaseKey(previous) !== releaseKey(release)) {
            unique.push(release);
            continue;
        }
        if (!bytesEqual(PackageRelease.encode(previous), PackageRelease.encode(release))) {
            throw new TypeError(
                `Conflicting metadata for package release ${release.id.value}@${release.version}`
            );
        }
    }
    return unique;
}

function snapshotDigest(revision: Revision, releases: readonly PackageRelease[]): Digest {
    return Digest.sha256(
        encodeCanonicalJson({
            releases: releases.map((release) => release.toData()),
            revision: revision.value
        })
    );
}

function compareReleases(left: PackageRelease, right: PackageRelease): number {
    return (
        compareText(left.id.value, right.id.value) ||
        compareText(left.version.toString(), right.version.toString())
    );
}

function releaseKey(release: PackageRelease): string {
    return `${release.id.value}\0${release.version.toString()}`;
}

function compareManifests(left: FacetManifest, right: FacetManifest): number {
    return (
        compareText(left.id.value, right.id.value) ||
        compareText(left.version.toString(), right.version.toString())
    );
}

function requireUnique(values: readonly string[], message: string): void {
    if (new Set(values).size !== values.length) {
        throw new TypeError(message);
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

function requireOptionalFields(
    value: { readonly [key: string]: JsonValue },
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

function requireArray(value: JsonValue | undefined, subject: string): readonly JsonValue[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value;
}

function requireNonnegativeInteger(value: JsonValue | undefined, subject: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
    return value;
}

function requireSchema(value: JsonValue): boolean | { readonly [key: string]: JsonValue } {
    if (typeof value === "boolean") {
        return value;
    }
    return requireObject(value, "Package config schema");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}
