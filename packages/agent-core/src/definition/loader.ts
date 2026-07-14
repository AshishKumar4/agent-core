import { Digest, type ContentRef } from "../core";
import type { ContentStore } from "../content";
import type { PackageCodeModule } from "./code-manifest";
import type { PackageRelease } from "./package";
import type { PackagePin } from "./package-lock";
import type { IsolationMode } from "../facets";
import {
    BlueprintValidator,
    type BlueprintValidatorOptions,
    type ValidatedBlueprint
} from "./validator";
import type { Blueprint } from "./blueprint";
import { compareText } from "./order";
import { invalidDefinition } from "./error";

export interface VerifiedPackageModule {
    readonly pin: PackagePin;
    readonly release: PackageRelease;
    readonly module: PackageCodeModule;
    readonly bytes: Uint8Array;
    readonly selected: IsolationMode;
}

export abstract class PackageModuleEvaluator<Loaded> {
    public abstract evaluate(module: VerifiedPackageModule): Promise<Loaded>;

    public abstract dispose(module: LoadedPackageModule<Loaded>): void | Promise<void>;
}

export abstract class PackageModuleInspector {
    public abstract imports(
        module: PackageCodeModule,
        bytes: Uint8Array
    ): Promise<readonly string[]>;
}

export abstract class PackageCorrespondencePort<Loaded> {
    public abstract validate(
        release: PackageRelease,
        modules: readonly LoadedPackageModule<Loaded>[]
    ): Promise<void>;
}

export interface LoadedPackageModule<Loaded> {
    readonly release: PackageRelease;
    readonly module: PackageCodeModule;
    readonly value: Loaded;
}

export interface LoadedBlueprint<Loaded> {
    readonly validated: ValidatedBlueprint;
    readonly modules: readonly LoadedPackageModule<Loaded>[];
    dispose(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}

export interface BlueprintLoaderOptions<Loaded> extends BlueprintValidatorOptions {
    readonly content: Pick<ContentStore, "get">;
    readonly inspector: PackageModuleInspector;
    readonly evaluator: PackageModuleEvaluator<Loaded>;
    readonly correspondence: PackageCorrespondencePort<Loaded>;
}

export class BlueprintLoader<Loaded> {
    readonly #validator: BlueprintValidator;
    readonly #content: Pick<ContentStore, "get">;
    readonly #inspector: PackageModuleInspector;
    readonly #evaluator: PackageModuleEvaluator<Loaded>;
    readonly #correspondence: PackageCorrespondencePort<Loaded>;

    public constructor(options: BlueprintLoaderOptions<Loaded>) {
        this.#validator = new BlueprintValidator(options);
        this.#content = options.content;
        this.#inspector = options.inspector;
        this.#evaluator = options.evaluator;
        this.#correspondence = options.correspondence;
    }

    public async load(blueprint: Blueprint): Promise<LoadedBlueprint<Loaded>> {
        const validated = this.#validator.validate(blueprint);
        const verified: VerifiedPackageModule[] = [];
        for (const release of validated.releases) {
            const pin = exactPin(validated, release);
            for (const module of release.codeManifest.modules) {
                const loaded = await this.#content.get(module.content);
                if (!(loaded instanceof Uint8Array)) {
                    throw invalidDefinition(
                        `Loaded module bytes do not match ${module.content.value}`
                    );
                }
                const bytes = loaded.slice();
                verifyContent(module.content, bytes);
                const imports = await this.#inspector.imports(module, bytes.slice());
                verifyImports(module, imports);
                verified.push(
                    Object.freeze({
                        pin,
                        release,
                        module,
                        bytes,
                        selected: selectedMode(validated, release, module)
                    })
                );
            }
        }
        const modules: LoadedPackageModule<Loaded>[] = [];
        try {
            for (const module of verified) {
                const value = await this.#evaluator.evaluate(
                    Object.freeze({
                        ...module,
                        bytes: module.bytes.slice()
                    })
                );
                modules.push(
                    Object.freeze({
                        release: module.release,
                        module: module.module,
                        value
                    })
                );
            }
            for (const release of validated.releases) {
                await this.#correspondence.validate(
                    release,
                    modules.filter((module) => module.release === release)
                );
            }
        } catch (error) {
            await disposeModules(this.#evaluator, modules, { error });
        }
        return new ScopedLoadedBlueprint(validated, modules, this.#evaluator);
    }
}

class ScopedLoadedBlueprint<Loaded> implements LoadedBlueprint<Loaded> {
    public readonly modules: readonly LoadedPackageModule<Loaded>[];
    #disposed = false;

    public constructor(
        public readonly validated: ValidatedBlueprint,
        modules: readonly LoadedPackageModule<Loaded>[],
        private readonly evaluator: PackageModuleEvaluator<Loaded>
    ) {
        this.modules = Object.freeze([...modules]);
        Object.freeze(this);
    }

    public async dispose(): Promise<void> {
        if (this.#disposed) return;
        this.#disposed = true;
        await disposeModules(this.evaluator, this.modules);
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }
}

function selectedMode(
    validated: ValidatedBlueprint,
    release: PackageRelease,
    module: PackageCodeModule
): IsolationMode {
    const reachableFacets = new Set(
        release.codeManifest.entrypoints
            .filter((entrypoint) =>
                entrypointReachesModule(release, entrypoint.module, module.specifier)
            )
            .map((entrypoint) => entrypoint.facet.value)
    );
    const candidates = validated.placements
        .filter(
            (placement) =>
                placement.packageId === release.id.value && reachableFacets.has(placement.facetId)
        )
        .map((placement) => placement.selection.selected);
    const modes = [...new Set(candidates)];
    if (modes.length !== 1) {
        throw invalidDefinition(
            `Package module ${module.specifier} spans incompatible placement modes`
        );
    }
    return modes[0]!;
}

function entrypointReachesModule(
    release: PackageRelease,
    entrypoint: string,
    target: string
): boolean {
    const pending = [entrypoint];
    const visited = new Set<string>();
    while (pending.length > 0) {
        const specifier = pending.pop()!;
        if (specifier === target) return true;
        if (visited.has(specifier)) continue;
        visited.add(specifier);
        pending.push(...release.codeManifest.module(specifier)!.imports);
    }
    return false;
}

function verifyImports(module: PackageCodeModule, imports: readonly string[]): void {
    const canonical = [...imports].sort(compareText);
    if (
        new Set(canonical).size !== canonical.length ||
        canonical.length !== module.imports.length ||
        canonical.some((value, index) => value !== module.imports[index])
    ) {
        throw invalidDefinition(
            `Inspected imports do not match code manifest for ${module.specifier}`
        );
    }
}

function verifyContent(reference: ContentRef, bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array) || !Digest.sha256(bytes).equals(reference.digest)) {
        throw invalidDefinition(`Loaded module bytes do not match ${reference.value}`);
    }
}

function exactPin(validated: ValidatedBlueprint, release: PackageRelease): PackagePin {
    const pin = validated.lock.packages.find((candidate) => candidate.id.equals(release.id));
    if (
        pin === undefined ||
        !pin.version.equals(release.version) ||
        !pin.manifestDigest.equals(release.manifestDigest) ||
        !pin.codeDigest.equals(release.codeDigest)
    ) {
        throw invalidDefinition(`Package release ${release.id.value} does not match its exact pin`);
    }
    return pin;
}

async function disposeModules<Loaded>(
    evaluator: PackageModuleEvaluator<Loaded>,
    modules: readonly LoadedPackageModule<Loaded>[],
    preserved?: { readonly error: unknown }
): Promise<never | void> {
    let failure = preserved?.error;
    let failed = preserved !== undefined;
    for (const module of [...modules].reverse()) {
        try {
            await evaluator.dispose(module);
        } catch (error) {
            if (!failed) failure = error;
            failed = true;
        }
    }
    if (failed) throw failure;
}
