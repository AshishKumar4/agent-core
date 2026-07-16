// @ts-nocheck
import { Digest, RecordCodec, Revision, SemVer, hasExactJsonKeys, type JsonValue } from "../core";
import { PackageId } from "./id";
import { PlatformCompatibility } from "./compatibility";
import { PackageDependency } from "./package";
import { compareText } from "./order";

export class PackagePin {
    public constructor(
        public readonly id: PackageId,
        public readonly version: SemVer,
        public readonly manifestDigest: Digest,
        public readonly codeDigest: Digest
    ) {
        Object.freeze(this);
    }

    public static fromData(value: JsonValue): PackagePin {
        const object = requireObject(value, "Package pin");
        requireFields(object, ["codeDigest", "id", "manifestDigest", "version"], "Package pin");
        return new PackagePin(
            new PackageId(requireString(object["id"], "Package pin ID")),
            new SemVer(requireString(object["version"], "Package pin version")),
            new Digest(requireString(object["manifestDigest"], "Package manifest digest")),
            new Digest(requireString(object["codeDigest"], "Package code digest"))
        );
    }

    public toData(): JsonValue {
        return {
            codeDigest: this.codeDigest.value,
            id: this.id.value,
            manifestDigest: this.manifestDigest.value,
            version: this.version.toString()
        };
    }
}

export interface PackageLockInit {
    readonly target: PlatformCompatibility;
    readonly roots: readonly PackageDependency[];
    readonly snapshotRevision: Revision;
    readonly snapshotDigest: Digest;
    readonly packages: readonly PackagePin[];
}

class PackageLockCodec extends RecordCodec<PackageLock> {
    public constructor() {
        super("definition.package-lock", { major: 2, minor: 0 });
    }

    protected encodePayload(lock: PackageLock): JsonValue {
        return lock.toData();
    }

    protected decodePayload(payload: JsonValue): PackageLock {
        return PackageLock.fromData(payload);
    }
}

export class PackageLock {
    public static readonly codec: RecordCodec<PackageLock> = new PackageLockCodec();

    public readonly snapshotRevision: Revision;
    public readonly snapshotDigest: Digest;
    public readonly target: PlatformCompatibility;
    public readonly roots: readonly PackageDependency[];
    public readonly packages: readonly PackagePin[];
    public readonly digest: Digest;

    public constructor(init: PackageLockInit) {
        const roots = [...init.roots]
            .map((root) => new PackageDependency(root.id, root.range))
            .sort((left, right) => compareText(left.id.value, right.id.value));
        if (new Set(roots.map((root) => root.id.value)).size !== roots.length) {
            throw new TypeError("Package lock roots must contain unique Package IDs");
        }
        const packages = [...init.packages].sort((left, right) =>
            compareText(left.id.value, right.id.value)
        );
        if (new Set(packages.map((pin) => pin.id.value)).size !== packages.length) {
            throw new TypeError("Package lock must contain at most one version per package ID");
        }
        this.snapshotRevision = init.snapshotRevision;
        this.snapshotDigest = init.snapshotDigest;
        this.target = PlatformCompatibility.fromData(init.target.toData());
        this.roots = Object.freeze(roots);
        this.packages = Object.freeze(packages);
        this.digest = Digest.sha256(PackageLock.encode(this));
        Object.freeze(this);
    }

    public static encode(lock: PackageLock): Uint8Array {
        return PackageLock.codec.encode(lock);
    }

    public static decode(bytes: Uint8Array): PackageLock {
        return PackageLock.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): PackageLock {
        const object = requireObject(payload, "Package lock");
        requireFields(
            object,
            ["packages", "roots", "snapshotDigest", "snapshotRevision", "target"],
            "Package lock"
        );
        return new PackageLock({
            target: PlatformCompatibility.fromData(object["target"]!),
            roots: requireArray(object["roots"], "Package lock roots").map(
                PackageDependency.fromData
            ),
            snapshotRevision: new Revision(
                requireNonnegativeInteger(
                    object["snapshotRevision"],
                    "Package lock snapshot revision"
                )
            ),
            snapshotDigest: new Digest(
                requireString(object["snapshotDigest"], "Package lock snapshot digest")
            ),
            packages: requireArray(object["packages"], "Package lock packages").map(
                PackagePin.fromData
            )
        });
    }

    public toData(): JsonValue {
        return {
            packages: this.packages.map((pin) => pin.toData()),
            roots: this.roots.map((root) => root.toData()),
            snapshotDigest: this.snapshotDigest.value,
            snapshotRevision: this.snapshotRevision.value,
            target: this.target.toData()
        };
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

function requireNonnegativeInteger(value: JsonValue | undefined, subject: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
    return value;
}
