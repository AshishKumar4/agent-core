import { Range, satisfies } from "semver";
import { PackageId } from "./id";
import { PackageLock, PackagePin } from "./package-lock";
import { MetadataSnapshot, PackageDependency, type PackageRelease } from "./package";
import { PlatformCompatibility, compatibilityAdmits } from "./compatibility";
import { compareText } from "./order";
import { invalidDefinition } from "./error";

type Constraints = ReadonlyMap<string, readonly string[]>;
type Selection = ReadonlyMap<string, PackageRelease>;

// Nothing reads a failure's category; the message is the whole of what resolution
// reports, so the category was a second answer to a question no caller asked.
type SearchResult =
    | { readonly complete: true; readonly selected: Selection }
    | { readonly complete: false; readonly failure: string };

export class PackageResolver {
    public resolve(
        snapshot: MetadataSnapshot,
        roots: readonly PackageDependency[],
        target: PlatformCompatibility
    ): PackageLock {
        const constraints = rootConstraints(roots);
        const result = search(snapshot, new Map(), constraints, target);
        if (!result.complete) {
            throw invalidDefinition(result.failure);
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

    // A package-level dependency cycle is NOT rejected. SPEC §9.1 states the closure is
    // "finite and unique by PackagePin.id, so it is computable whether or not the declared
    // relation is acyclic", and lists exactly two rejections: an unsatisfiable range and a
    // dependency the Blueprint does not install. The cycle SPEC does reject belongs to a
    // different relation — §4.1 Facet reliance, FacetRef via BindingRequirement,
    // C13-FACET-DEPENDENCY-ORDER — and rejecting one for the other refuses a legitimate
    // Blueprint. Termination needs no cycle check: this recursion descends only on ids
    // absent from `selected`, so `selected` grows by exactly one per level and is bounded
    // by the snapshot's id set. A cycle whose accumulated ranges disagree still fails the
    // admittedByAll re-check above, as a conflict rather than as a shape.

    const unresolved = [...constraints]
        .filter(([id]) => !selected.has(id))
        .sort(([left], [right]) => compareText(left, right));
    const next = unresolved[0];
    if (next === undefined) {
        return { complete: true, selected };
    }
    // The ranges travel with the id they were looked up under, so there is no second
    // lookup here and no absent-key branch that this loop could never take.
    const [id, ranges] = next;

    const releases = snapshot.releasesFor(new PackageId(id));
    if (releases.length === 0) {
        return { complete: false, failure: `Missing package ${id}` };
    }
    const candidates = releases
        .filter((release) => admittedByAll(release, ranges) && compatibleWith(release, target))
        .sort(compareCandidates);
    if (candidates.length === 0) {
        return failedConflict(id, ranges);
    }

    let firstFailure: string | undefined;
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
                // An empty comparator carries the ANY sentinel instead of a
                // version, and a range that names no version admits no prerelease.
                (comparator) =>
                    comparator.value !== "" &&
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

function failedConflict(id: string, ranges: readonly string[]): SearchResult {
    const constraint = [...new Set(ranges)].sort(compareText).join(" && ");
    return {
        complete: false,
        failure: `No version of package ${id} satisfies ${constraint}`
    };
}
