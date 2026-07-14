import { OperationDescriptor, SurfaceDescriptor } from "../contribution";
import type { FacetManifest } from "../manifest";
import { OperationName, SlotName, SurfaceId, type InterceptorId } from "../id";
import {
    Facet,
    type FacetLifecycleContext,
    type Interceptor,
    type Operation,
    type Surface
} from "../runtime";
import type { ProfileRuntimeHostBinding } from "./runtime";
import { DetailedProfileError } from "./error";

export abstract class ProfileFacetRuntime extends Facet {}

export interface InternalProfileFacetRuntimeInit {
    readonly manifest: FacetManifest;
    readonly operations: readonly Operation[];
    readonly surfaces?: readonly Surface[];
    readonly interceptors?: readonly Interceptor[];
    readonly children?: readonly Facet[];
    readonly runtime: {
        readonly host: ProfileRuntimeHostBinding;
        readonly active: boolean;
        activate(): void;
        deactivate(): void;
    };
    readonly start?: (context: FacetLifecycleContext) => void | Promise<void>;
    readonly stop?: (context: FacetLifecycleContext) => void | Promise<void>;
}

export class InternalProfileFacetRuntime extends ProfileFacetRuntime {
    readonly #operations: ReadonlyMap<string, Operation>;
    readonly #surfaces: ReadonlyMap<string, Surface>;
    readonly #interceptors: ReadonlyMap<string, Interceptor>;
    readonly #children: readonly Facet[];
    #started = false;
    #starting: Promise<void> | undefined;
    #stopping: Promise<void> | undefined;

    public constructor(private readonly init: InternalProfileFacetRuntimeInit) {
        super();
        this.#operations = uniqueMap(
            init.operations,
            (operation) => operation.descriptor.name.value,
            "Operation"
        );
        this.#surfaces = uniqueMap(
            init.surfaces ?? [],
            (surface) => surface.descriptor.id.value,
            "Surface"
        );
        this.#interceptors = uniqueMap(
            init.interceptors ?? [],
            (interceptor) => interceptor.declaration.id.value,
            "Interceptor"
        );
        this.#children = Object.freeze([...(init.children ?? [])]);
        init.runtime.deactivate();
        requireExactDeclarations(
            init.manifest.contributions
                .get(new SlotName("operations"))
                ?.map(OperationDescriptor.fromData) ?? [],
            [...this.#operations.values()].map((operation) => operation.descriptor),
            "Operation"
        );
        requireExactDeclarations(
            init.manifest.contributions
                .get(new SlotName("surfaces"))
                ?.map(SurfaceDescriptor.fromData) ?? [],
            [...this.#surfaces.values()].map((surface) => surface.descriptor),
            "Surface"
        );
    }

    public get ref(): ProfileRuntimeHostBinding["facet"] {
        return this.init.runtime.host.facet;
    }
    public get manifest(): FacetManifest {
        return this.init.manifest;
    }
    public get active(): boolean {
        return this.#started && this.init.runtime.active;
    }

    public operation(name: OperationName): Operation | undefined {
        return this.#operations.get(name.value);
    }

    public surface(id: SurfaceId): Surface | undefined {
        return this.#surfaces.get(id.value);
    }

    public interceptor(id: InterceptorId): Interceptor | undefined {
        return this.#interceptors.get(id.value);
    }

    public children(): readonly Facet[] {
        return this.#children;
    }

    public async start(context: FacetLifecycleContext): Promise<void> {
        if (this.#stopping !== undefined) await this.#stopping;
        if (this.#started) return;
        if (this.#starting !== undefined) return this.#starting;
        this.#starting = this.startOnce(context);
        return this.#starting;
    }

    public async stop(context: FacetLifecycleContext): Promise<void> {
        if (this.#starting !== undefined) await this.#starting;
        if (this.#stopping !== undefined) return this.#stopping;
        if (!this.#started) return;
        this.#stopping = this.stopOnce(context);
        return this.#stopping;
    }

    private async startOnce(context: FacetLifecycleContext): Promise<void> {
        try {
            await this.init.start?.(context);
            if (context.signal.aborted) return;
            this.init.runtime.activate();
            this.#started = true;
        } finally {
            this.#starting = undefined;
        }
    }

    private async stopOnce(context: FacetLifecycleContext): Promise<void> {
        this.#started = false;
        this.init.runtime.deactivate();
        try {
            await this.init.stop?.(context);
        } finally {
            this.#stopping = undefined;
        }
    }
}

function uniqueMap<Value>(
    values: readonly Value[],
    key: (value: Value) => string,
    subject: string
): ReadonlyMap<string, Value> {
    const result = new Map(values.map((value) => [key(value), value]));
    if (result.size !== values.length) {
        throw invalidRuntime(`Internal profile ${subject} implementations must be unique`);
    }
    return result;
}

function requireExactDeclarations(
    declared: readonly { toData(): unknown }[],
    implemented: readonly { toData(): unknown }[],
    subject: string
): void {
    const data = (values: readonly { toData(): unknown }[]) =>
        values.map((value) => JSON.stringify(value.toData())).sort();
    if (JSON.stringify(data(declared)) !== JSON.stringify(data(implemented))) {
        throw invalidRuntime(`Internal profile ${subject} declarations do not match its runtime`);
    }
}

function invalidRuntime(message: string): DetailedProfileError<"runtime.declaration"> {
    return new DetailedProfileError("protocol.invalid-state", "runtime.declaration", message);
}
