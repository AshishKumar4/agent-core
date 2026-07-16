// @ts-nocheck
import { Range, satisfies } from "semver";
import { PackageId } from "./id";
import { PackageLock, PackagePin } from "./package-lock";
import { MetadataSnapshot, PackageDependency, type PackageRelease } from "./package";
import { PlatformCompatibility, compatibilityAdmits } from "./compatibility";
import { compareText } from "./order";
import { invalidDefinition } from "./error";

type Constraints = ReadonlyMap<string, readonly string[]>;
type Selection = ReadonlyMap<string, PackageRelease>;

interface ResolutionFailure {
    readonly kind: "conflict" | "cycle" | "missing";
    readonly message: string;
}

type SearchResult =
    | { readonly complete: true; readonly selected: Selection }
    | { readonly complete: false; readonly failure: ResolutionFailure };

export class PackageResolver {
    public resolve(
        snapshot: MetadataSnapshot,
        roots: readonly PackageDependency[],
        target: PlatformCompatibility
    ): PackageLock {
        const constraints = rootConstraints(roots);
        const result = search(snapshot, new Map(), constraints, target);
        if (!result.complete) {
            throw invalidDefinition(result.failure.message);
        }
        return new PackageLock({
            target,
            roots,
            snapshotRevision: snapshot.revision,
            snapshotDigest: snapshot.digest,
            packages: [...result.selected.values()].map(
                (release) =>
                    new PackagePin(
                        release.id,
                        release.version,
                        release.manifestDigest,
                        release.codeDigest
                    )
            )
        });
    }
}

export function resolvePackageLock(
    snapshot: MetadataSnapshot,
    roots: readonly PackageDependency[],
    target: PlatformCompatibility
): PackageLock {
    return new PackageResolver().resolve(snapshot, roots, target);
}

function search(
    snapshot: MetadataSnapshot,
    selected: Selection,
    constraints: Constraints,
    target: PlatformCompatibility
): SearchResult {
    for (const [id, release] of selected) {
        const ranges = constraints.get(id) ?? [];
        if (!admittedByAll(release, ranges)) {
            return failedConflict(id, ranges);
        }
    }

    const cycle = dependencyCycle(selected);
    if (cycle !== undefined) {
        return {
            complete: false,
            failure: {
                kind: "cycle",
                message: `Package dependency cycle: ${cycle.join(" -> ")}`
            }
        };
    }

    const unresolved = [...constraints.keys()].filter((id) => !selected.has(id)).sort(compareText);
    const id = unresolved[0];
    if (id === undefined) {
        return { complete: true, selected };
    }

    const releases = snapshot.releasesFor(new PackageId(id));
    if (releases.length === 0) {
        return {
            complete: false,
            failure: { kind: "missing", message: `Missing package ${id}` }
        };
    }
    const ranges = constraints.get(id) ?? [];
    const candidates = releases
        .filter((release) => admittedByAll(release, ranges) && compatibleWith(release, target))
        .sort(compareCandidates);
    if (candidates.length === 0) {
        return failedConflict(id, ranges);
    }

    let firstFailure: ResolutionFailure | undefined;
    for (const candidate of candidates) {
        const nextSelected = new Map(selected);
        nextSelected.set(id, candidate);
        const nextConstraints = addDependencies(constraints, candidate.dependencies);
        const result = search(snapshot, nextSelected, nextConstraints, target);
        if (result.complete) {
            return result;
        }
        firstFailure ??= result.failure;
    }
    return { complete: false, failure: firstFailure! };
}

function compatibleWith(release: PackageRelease, target: PlatformCompatibility): boolean {
    return (
        compatibilityAdmits(release.compatibility, target) &&
        release.manifests.every((manifest) => compatibilityAdmits(manifest.compat, target))
    );
}

function rootConstraints(roots: readonly PackageDependency[]): Constraints {
    const constraints = new Map<string, readonly string[]>();
    for (const root of roots) {
        const dependency = new PackageDependency(root.id, root.range);
        if (constraints.has(dependency.id.value)) {
            throw invalidDefinition(`Duplicate root package ID ${dependency.id.value}`);
        }
        constraints.set(dependency.id.value, [dependency.range]);
    }
    return constraints;
}

function addDependencies(
    constraints: Constraints,
    dependencies: readonly PackageDependency[]
): Constraints {
    const next = new Map(constraints);
    for (const dependency of dependencies) {
        next.set(dependency.id.value, [...(next.get(dependency.id.value) ?? []), dependency.range]);
    }
    return next;
}

function admittedByAll(release: PackageRelease, ranges: readonly string[]): boolean {
    const value = release.version.toString();
    return ranges.every(
        (range) =>
            satisfies(value, range, { includePrerelease: true }) &&
            (release.version.prerelease.length === 0 || explicitlyAdmitsPrerelease(value, range))
    );
}

function explicitlyAdmitsPrerelease(value: string, rangeValue: string): boolean {
    const candidate = new Range(`=${value}`).set[0]![0]!.semver;
    return new Range(rangeValue).set.some(
        (comparators) =>
            comparators.every((comparator) => comparator.test(candidate)) &&
            comparators.some(
                (comparator) =>
                    comparator.semver.prerelease.length > 0 &&
                    comparator.semver.major === candidate.major &&
                    comparator.semver.minor === candidate.minor &&
                    comparator.semver.patch === candidate.patch
            )
    );
}

function compareCandidates(left: PackageRelease, right: PackageRelease): number {
    return (
        right.version.compare(left.version) ||
        compareText(left.version.toString(), right.version.toString())
    );
}

function dependencyCycle(selected: Selection): readonly string[] | undefined {
    const visited = new Set<string>();
    const active = new Map<string, number>();
    const path: string[] = [];

    const visit = (id: string): readonly string[] | undefined => {
        const activeIndex = active.get(id);
        if (activeIndex !== undefined) {
            return canonicalCycle([...path.slice(activeIndex), id]);
        }
        if (visited.has(id)) return undefined;
        active.set(id, path.length);
        path.push(id);
        const release = selected.get(id)!;
        for (const dependency of release.dependencies) {
            if (!selected.has(dependency.id.value)) continue;
            const cycle = visit(dependency.id.value);
            if (cycle !== undefined) return cycle;
        }
        path.pop();
        active.delete(id);
        visited.add(id);
        return undefined;
    };

    for (const id of [...selected.keys()].sort(compareText)) {
        const cycle = visit(id);
        if (cycle !== undefined) return cycle;
    }
    return undefined;
}

function canonicalCycle(cycle: readonly string[]): readonly string[] {
    const members = cycle.slice(0, -1);
    const rotations = members.map((_, index) => [
        ...members.slice(index),
        ...members.slice(0, index)
    ]);
    rotations.sort((left, right) => compareText(left.join("\0"), right.join("\0")));
    const canonical = rotations[0]!;
    return [...canonical, canonical[0]!];
}

function failedConflict(id: string, ranges: readonly string[]): SearchResult {
    const constraint = [...new Set(ranges)].sort(compareText).join(" && ");
    return {
        complete: false,
        failure: {
            kind: "conflict",
            message: `No version of package ${id} satisfies ${constraint}`
        }
    };
}
