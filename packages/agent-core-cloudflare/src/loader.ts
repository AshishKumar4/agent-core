import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";

export interface DynamicWorkerSource {
    readonly compatibilityDate: string;
    readonly mainModule: string;
    readonly modules: Readonly<Record<string, string>>;
}

export interface DynamicWorkerLoadOptions extends DynamicWorkerSource {
    // A §4.7 isolate's environment is empty and the type says so. Worker Loader
    // structured-clones `env`, so a capability could not ride in it even if the shape
    // allowed one: the delegated set reaches the isolate as the argument of its single
    // entry call instead, and nothing else ever reaches it at all.
    readonly env: Readonly<Record<string, never>>;
    readonly globalOutbound: null;
}

export interface DynamicWorkerHandleLike {
    getEntrypoint(): unknown;
    [Symbol.dispose]?(): void;
}

export interface WorkerLoaderBindingLike {
    load(options: DynamicWorkerLoadOptions): DynamicWorkerHandleLike;
}

export interface DynamicWorkerScope<Entrypoint> extends Disposable {
    readonly entrypoint: Entrypoint;
}

export class DynamicWorkerLoaderAdapter {
    public constructor(
        private readonly loader: WorkerLoaderBindingLike,
        private readonly errors: CloudflareErrorPort
    ) {}

    public load<Entrypoint>(
        source: DynamicWorkerSource,
        createEntrypoint: (entrypoint: unknown) => Entrypoint
    ): DynamicWorkerScope<Entrypoint> {
        validateSource(source);
        let worker: DynamicWorkerHandleLike;
        try {
            worker = this.loader.load({
                compatibilityDate: source.compatibilityDate,
                mainModule: source.mainModule,
                modules: Object.freeze({ ...source.modules }),
                env: Object.freeze({}),
                globalOutbound: null
            });
        } catch (cause) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Dynamic Worker load failed",
                cause
            );
        }
        if (!isWorkerHandle(worker)) {
            this.failAfterLoad(
                "operation.invalid-output",
                "Dynamic Worker Loader returned an invalid handle",
                undefined,
                [worker]
            );
        }
        let rawEntrypoint: unknown;
        try {
            rawEntrypoint = worker.getEntrypoint();
        } catch (cause) {
            this.failAfterLoad(
                "protocol.invalid-state",
                "Dynamic Worker entrypoint resolution failed",
                cause,
                [worker]
            );
        }
        if (rawEntrypoint === undefined || rawEntrypoint === null) {
            this.failAfterLoad(
                "operation.invalid-output",
                "Dynamic Worker Loader returned no entrypoint",
                undefined,
                [worker]
            );
        }
        let entrypoint: Entrypoint;
        try {
            entrypoint = createEntrypoint(rawEntrypoint);
        } catch (cause) {
            this.failAfterLoad(
                "operation.invalid-output",
                "Dynamic Worker entrypoint facet construction failed",
                cause,
                [rawEntrypoint, worker]
            );
        }
        return new OwnedDynamicWorkerScope(entrypoint, rawEntrypoint, worker, this.errors);
    }

    private failAfterLoad(
        code: "operation.invalid-output" | "protocol.invalid-state",
        message: string,
        cause: unknown,
        resources: readonly unknown[]
    ): never {
        const failures = disposeResources(resources);
        const combinedCause = combineFailures(cause, failures);
        operationalFailure(this.errors, code, message, combinedCause);
    }
}

class OwnedDynamicWorkerScope<Entrypoint> implements DynamicWorkerScope<Entrypoint> {
    #open = true;

    public constructor(
        public readonly entrypoint: Entrypoint,
        private readonly rawEntrypoint: unknown,
        private readonly worker: DynamicWorkerHandleLike,
        private readonly errors: CloudflareErrorPort
    ) {}

    public [Symbol.dispose](): void {
        if (!this.#open) return;
        this.#open = false;
        const resources =
            this.entrypoint === this.rawEntrypoint
                ? [this.rawEntrypoint, this.worker]
                : [this.entrypoint, this.rawEntrypoint, this.worker];
        const failures = disposeResources(resources);
        if (failures.length !== 0) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Dynamic Worker cleanup failed",
                combineFailures(undefined, failures)
            );
        }
    }
}

function validateSource(source: DynamicWorkerSource): void {
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(source.compatibilityDate) ||
        source.mainModule.length === 0 ||
        Object.keys(source.modules).length === 0 ||
        source.modules[source.mainModule] === undefined ||
        Object.entries(source.modules).some(
            ([name, code]) => name.length === 0 || code.length === 0
        )
    ) {
        throw new TypeError("Dynamic Worker source has an invalid shape");
    }
}

function isWorkerHandle(value: unknown): value is DynamicWorkerHandleLike {
    return (typeof value === "object" && value !== null) || typeof value === "function"
        ? typeof Reflect.get(value, "getEntrypoint") === "function"
        : false;
}

function disposeResources(resources: readonly unknown[]): unknown[] {
    const failures: unknown[] = [];
    const disposed = new Set<unknown>();
    for (const resource of resources) {
        if (disposed.has(resource)) continue;
        disposed.add(resource);
        try {
            dispose(resource);
        } catch (error) {
            failures.push(error);
        }
    }
    return failures;
}

function dispose(value: unknown): void {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
    const disposer = Reflect.get(value, Symbol.dispose);
    if (typeof disposer === "function") Reflect.apply(disposer, value, []);
}

function combineFailures(cause: unknown, cleanupFailures: readonly unknown[]): unknown {
    if (cleanupFailures.length === 0) return cause;
    const failures = cause === undefined ? cleanupFailures : [cause, ...cleanupFailures];
    return failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Dynamic Worker operation and cleanup failed");
}
