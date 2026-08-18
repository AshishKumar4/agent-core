import {
    FacetManifest,
    InterceptorDeclaration,
    OperationDescriptor,
    OperationName,
    SlotName,
    SurfaceDescriptor,
    SurfaceId,
    type FacetData
} from "../facets";
import { AgentCoreError } from "../errors";
import { Operation } from "./runtime";
import type {
    Facet,
    FacetLifecycleContext,
    Interceptor,
    OperationContext,
    Surface
} from "./runtime";

export class ValidatedFacet {
    public readonly ref: Facet["ref"];
    public readonly manifest: FacetManifest;

    public constructor(
        private readonly source: Facet,
        ref: Facet["ref"],
        manifest: FacetManifest,
        private readonly operationMap: ReadonlyMap<string, Operation>,
        private readonly surfaceMap: ReadonlyMap<string, Surface>,
        private readonly interceptorMap: ReadonlyMap<string, Interceptor>
    ) {
        this.ref = ref;
        this.manifest = manifest;
        Object.freeze(this);
    }

    public operation(name: OperationName): Operation | undefined {
        return this.operationMap.get(name.value);
    }

    public surface(id: SurfaceId): Surface | undefined {
        return this.surfaceMap.get(id.value);
    }

    public interceptor(id: InterceptorDeclaration["id"]): Interceptor | undefined {
        return this.interceptorMap.get(id.value);
    }

    public start(context: FacetLifecycleContext): Promise<void> {
        return this.source.start(context);
    }

    public stop(context: FacetLifecycleContext): Promise<void> {
        return this.source.stop(context);
    }
}

class ValidatedOperation extends Operation {
    public constructor(
        private readonly source: Operation,
        public readonly descriptor: OperationDescriptor
    ) {
        super();
        Object.freeze(this);
    }

    public execute(context: OperationContext, input: FacetData): Promise<FacetData> {
        return this.source.execute(context, input);
    }
}

export interface ValidatedFacetRuntime {
    readonly facets: readonly ValidatedFacet[];
}

export class FacetCorrespondenceValidator {
    public validate(
        expectedManifests: readonly FacetManifest[],
        roots: readonly Facet[]
    ): ValidatedFacetRuntime {
        const expected = expectedManifestMap(expectedManifests);
        const candidates = flattenFacets(roots);
        const seen = new Set<string>();
        const facets: ValidatedFacet[] = [];

        for (const candidate of candidates) {
            const key = manifestKey(candidate.manifest);
            if (seen.has(key)) {
                throw runtimeMismatch(`Runtime contains duplicate Facet manifest ${key}`);
            }
            seen.add(key);
            const manifest = expected.get(key);
            if (
                manifest === undefined ||
                !equalBytes(
                    FacetManifest.encode(manifest),
                    FacetManifest.encode(candidate.manifest)
                )
            ) {
                throw runtimeMismatch(`Runtime Facet ${key} does not match a pinned manifest`);
            }
            const implementations = validateImplementations(candidate.source, manifest);
            facets.push(
                new ValidatedFacet(
                    candidate.source,
                    candidate.ref,
                    FacetManifest.decode(FacetManifest.encode(manifest)),
                    implementations.operations,
                    implementations.surfaces,
                    implementations.interceptors
                )
            );
        }

        for (const key of expected.keys()) {
            if (!seen.has(key)) {
                throw runtimeMismatch(`Runtime omits pinned Facet manifest ${key}`);
            }
        }
        return Object.freeze({ facets: Object.freeze(facets) });
    }
}

interface Implementations {
    readonly operations: ReadonlyMap<string, Operation>;
    readonly surfaces: ReadonlyMap<string, Surface>;
    readonly interceptors: ReadonlyMap<string, Interceptor>;
}

function validateImplementations(facet: Facet, manifest: FacetManifest): Implementations {
    const operations = new Map<string, Operation>();
    for (const value of manifest.contributions.get(operationSlot) ?? []) {
        const descriptor = OperationDescriptor.fromData(value);
        requireUnique(operations, descriptor.name.value, "Operation");
        const operation = facet.operation(descriptor.name);
        requireImplementation(operation, "Operation", descriptor.name.value);
        requireEqualDeclaration(
            OperationDescriptor.encode(operation.descriptor),
            OperationDescriptor.encode(descriptor),
            `Operation ${descriptor.name.value}`
        );
        operations.set(
            descriptor.name.value,
            new ValidatedOperation(
                operation,
                OperationDescriptor.decode(OperationDescriptor.encode(descriptor))
            )
        );
    }
    const surfaces = new Map<string, Surface>();
    for (const value of manifest.contributions.get(surfaceSlot) ?? []) {
        const descriptor = SurfaceDescriptor.fromData(value);
        requireUnique(surfaces, descriptor.id.value, "Surface");
        const surface = facet.surface(descriptor.id);
        requireImplementation(surface, "Surface", descriptor.id.value);
        requireEqualDeclaration(
            SurfaceDescriptor.encode(surface.descriptor),
            SurfaceDescriptor.encode(descriptor),
            `Surface ${descriptor.id.value}`
        );
        surfaces.set(descriptor.id.value, surface);
    }
    const interceptors = new Map<string, Interceptor>();
    for (const value of manifest.contributions.get(interceptorSlot) ?? []) {
        const declaration = InterceptorDeclaration.fromData(value);
        requireUnique(interceptors, declaration.id.value, "Interceptor");
        const interceptor = facet.interceptor(declaration.id);
        requireImplementation(interceptor, "Interceptor", declaration.id.value);
        requireEqualDeclaration(
            InterceptorDeclaration.encode(interceptor.declaration),
            InterceptorDeclaration.encode(declaration),
            `Interceptor ${declaration.id.value}`
        );
        interceptors.set(declaration.id.value, interceptor);
    }
    return Object.freeze({ operations, surfaces, interceptors });
}

interface FacetCandidate {
    readonly source: Facet;
    readonly ref: Facet["ref"];
    readonly manifest: FacetManifest;
}

function flattenFacets(roots: readonly Facet[]): FacetCandidate[] {
    const facets: FacetCandidate[] = [];
    const active = new Set<Facet>();
    const visited = new Set<Facet>();
    const refs = new Set<string>();
    const visit = (facet: Facet): void => {
        if (active.has(facet)) throw runtimeMismatch("Runtime child Facets contain a cycle");
        if (visited.has(facet)) throw runtimeMismatch("Runtime child Facet appears more than once");
        const ref = facet.ref;
        const manifest = facet.manifest;
        const children = [...facet.children()];
        if (refs.has(ref.value)) throw runtimeMismatch(`Duplicate Facet reference ${ref.value}`);
        active.add(facet);
        visited.add(facet);
        refs.add(ref.value);
        facets.push({ source: facet, ref, manifest });
        for (const child of children) visit(child);
        active.delete(facet);
    };
    for (const root of roots) visit(root);
    return facets;
}

function expectedManifestMap(
    manifests: readonly FacetManifest[]
): ReadonlyMap<string, FacetManifest> {
    const result = new Map<string, FacetManifest>();
    const packageIds = new Set<string>();
    for (const manifest of manifests) {
        const key = manifestKey(manifest);
        const previous = result.get(key);
        if (previous !== undefined)
            throw runtimeMismatch(`Pinned manifests contain duplicate ${key}`);
        if (packageIds.has(manifest.id.value)) {
            throw runtimeMismatch(
                `Pinned manifests contain multiple versions of ${manifest.id.value}`
            );
        }
        packageIds.add(manifest.id.value);
        result.set(key, manifest);
    }
    return result;
}

function manifestKey(manifest: FacetManifest): string {
    return `${manifest.id.value}@${manifest.version.toString()}`;
}

function requireImplementation<T extends Operation | Surface | Interceptor>(
    value: T | undefined,
    kind: string,
    id: string
): asserts value is T {
    if (value === undefined) throw runtimeMismatch(`${kind} ${id} has no runtime implementation`);
}

function requireUnique(values: ReadonlyMap<string, unknown>, id: string, subject: string): void {
    if (values.has(id)) throw runtimeMismatch(`${subject} ${id} is declared more than once`);
}

function requireEqualDeclaration(actual: Uint8Array, expected: Uint8Array, subject: string): void {
    if (!equalBytes(actual, expected))
        throw runtimeMismatch(`${subject} does not match its declaration`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function runtimeMismatch(message: string): AgentCoreError {
    return new AgentCoreError("facet.inactive", message);
}

const operationSlot = new SlotName("operations");
const surfaceSlot = new SlotName("surfaces");
const interceptorSlot = new SlotName("interceptors");
