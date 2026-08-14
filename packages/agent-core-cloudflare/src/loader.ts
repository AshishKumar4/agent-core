import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { PassedCapabilities } from "./passed-capability.js";
import { isPlatformMethod, isPlatformObject } from "./platform-value.js";

export interface DynamicWorkerSource {
    readonly compatibilityDate: string;
    readonly compatibilityFlags?: readonly string[];
    readonly mainModule: string;
    readonly modules: Readonly<Record<string, string>>;
}

export interface DynamicWorkerLoadOptions extends Omit<DynamicWorkerSource, "compatibilityFlags"> {
    // Mutable to match the platform's own binding type, which the host satisfies
    // structurally; the adapter is the only writer and copies before handing it over.
    readonly compatibilityFlags?: string[];
    // An isolate's whole environment is the delegated capability set: one entry per
    // passed Binding, typed so nothing that is not one can be put there. Worker Loader
    // serializes `env`, which is why a passed capability is an entrypoint stub built
    // from data rather than a live host object (see passed-capability.ts).
    readonly env: PassedCapabilities;
    readonly globalOutbound: null;
}

export interface DisposableCandidate {
    [Symbol.dispose]?(): void;
}

export interface DynamicWorkerHandleLike<
    Entrypoint extends DisposableCandidate
> extends DisposableCandidate {
    getEntrypoint(): Entrypoint;
}

export interface DynamicWorkerHandleCandidate<
    Entrypoint extends DisposableCandidate
> extends DisposableCandidate {
    getEntrypoint?(): Entrypoint;
}

export interface WorkerLoaderBindingLike<Entrypoint extends DisposableCandidate> {
    load(options: DynamicWorkerLoadOptions): DynamicWorkerHandleCandidate<Entrypoint>;
}

export interface DynamicWorkerScope<Entrypoint extends DisposableCandidate> extends Disposable {
    readonly entrypoint: Entrypoint;
}

export class DynamicWorkerLoaderAdapter<RawEntrypoint extends DisposableCandidate> {
    public constructor(
        private readonly loader: WorkerLoaderBindingLike<RawEntrypoint>,
        private readonly errors: CloudflareErrorPort
    ) {}

    public load<Entrypoint extends DisposableCandidate>(
        source: DynamicWorkerSource,
        capabilities: PassedCapabilities,
        createEntrypoint: (entrypoint: RawEntrypoint) => Entrypoint
    ): DynamicWorkerScope<Entrypoint> {
        validateSource(source);
        const required = {
            compatibilityDate: source.compatibilityDate,
            mainModule: source.mainModule,
            modules: Object.freeze({ ...source.modules }),
            env: Object.freeze({ ...capabilities }),
            globalOutbound: null
        };
        // An absent flag list is absent, not present-and-undefined: the binding reads the
        // property, and `exactOptionalPropertyTypes` keeps that distinction in the type.
        const options: DynamicWorkerLoadOptions =
            source.compatibilityFlags === undefined
                ? required
                : { ...required, compatibilityFlags: [...source.compatibilityFlags] };
        let worker: DynamicWorkerHandleCandidate<RawEntrypoint>;
        try {
            worker = this.loader.load(options);
        } catch (cause) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Dynamic Worker load failed",
                { value: cause }
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
        let rawEntrypoint: RawEntrypoint;
        try {
            rawEntrypoint = worker.getEntrypoint();
        } catch (cause) {
            this.failAfterLoad(
                "protocol.invalid-state",
                "Dynamic Worker entrypoint resolution failed",
                { value: cause },
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
                { value: cause },
                [rawEntrypoint, worker]
            );
        }
        return new OwnedDynamicWorkerScope(entrypoint, rawEntrypoint, worker, this.errors);
    }

    private failAfterLoad(
        code: "operation.invalid-output" | "protocol.invalid-state",
        message: string,
        cause: CapturedFailure | undefined,
        resources: readonly DisposableCandidate[]
    ): never {
        const failures = disposeResources(resources);
        const combinedCause = combineFailures(cause, failures);
        operationalFailure(this.errors, code, message, combinedCause);
    }
}

class OwnedDynamicWorkerScope<
    Entrypoint extends DisposableCandidate
> implements DynamicWorkerScope<Entrypoint> {
    #open = true;

    public constructor(
        public readonly entrypoint: Entrypoint,
        private readonly rawEntrypoint: DisposableCandidate,
        private readonly worker: DynamicWorkerHandleLike<DisposableCandidate>,
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

function isWorkerHandle<Entrypoint extends DisposableCandidate>(
    value: DynamicWorkerHandleCandidate<Entrypoint>
): value is DynamicWorkerHandleLike<Entrypoint> {
    return isPlatformObject(value) && isPlatformMethod(value.getEntrypoint);
}

interface CapturedFailure {
    readonly value: unknown;
}

function disposeResources(resources: readonly DisposableCandidate[]): CapturedFailure[] {
    const failures: CapturedFailure[] = [];
    const disposed = new Set<DisposableCandidate>();
    for (const resource of resources) {
        if (disposed.has(resource)) continue;
        disposed.add(resource);
        try {
            dispose(resource);
        } catch (cause) {
            failures.push(Object.freeze({ value: cause }));
        }
    }
    return failures;
}

function dispose(value: DisposableCandidate): void {
    if (isDisposable(value)) value[Symbol.dispose]();
}

function isDisposable(value: DisposableCandidate): value is Disposable {
    return isPlatformObject(value) && isPlatformMethod(value[Symbol.dispose]);
}

function combineFailures(
    cause: CapturedFailure | undefined,
    cleanupFailures: readonly CapturedFailure[]
): CapturedFailure | undefined {
    if (cleanupFailures.length === 0) return cause;
    const failures = cleanupFailures.map((failure) => failure.value);
    if (cause !== undefined) failures.unshift(cause.value);
    return Object.freeze({
        value:
            failures.length === 1
                ? failures[0]
                : new AggregateError(failures, "Dynamic Worker operation and cleanup failed")
    });
}
