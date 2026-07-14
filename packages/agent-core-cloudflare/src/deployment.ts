import type { DispatchNamespaceAdapter } from "./dispatch.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type {
    DynamicWorkerLoaderAdapter,
    DynamicWorkerScope,
    DynamicWorkerSource
} from "./loader.js";

export interface FetchServiceLike {
    fetch(request: Request): Response | Promise<Response>;
}

export interface ScopedFetchServiceLike extends FetchServiceLike, Disposable {}

export type CloudflareDeployment =
    | {
          readonly mode: "dynamic";
          readonly source: DynamicWorkerSource;
          readonly capabilities: Readonly<Record<string, unknown>>;
      }
    | {
          readonly mode: "dispatch";
          readonly scriptName: string;
          readonly parameters?: Readonly<Record<string, string>>;
      };

export class ExplicitCloudflareDeploymentAdapter {
    public constructor(
        private readonly dynamic: DynamicWorkerLoaderAdapter,
        private readonly dispatch: DispatchNamespaceAdapter<FetchServiceLike>,
        private readonly errors: CloudflareErrorPort
    ) {}

    public resolve(deployment: CloudflareDeployment): ScopedFetchServiceLike {
        if (deployment.mode === "dynamic") {
            return new DynamicFetchServiceScope(
                this.dynamic.load(deployment.source, deployment.capabilities, (entrypoint) =>
                    this.requireService(entrypoint)
                )
            );
        }
        return new DispatchFetchServiceScope(
            this.requireService(this.dispatch.resolve(deployment.scriptName, deployment.parameters))
        );
    }

    public async fetch(deployment: CloudflareDeployment, request: Request): Promise<Response> {
        const service = this.resolve(deployment);
        try {
            return await service.fetch(request);
        } finally {
            service[Symbol.dispose]();
        }
    }

    private requireService(service: unknown): FetchServiceLike {
        if (!isFetchService(service)) {
            operationalFailure(
                this.errors,
                "operation.invalid-output",
                "Cloudflare deployment binding returned an invalid Fetcher"
            );
        }
        return service;
    }
}

function isFetchService(value: unknown): value is FetchServiceLike {
    return (
        typeof value === "object" &&
        value !== null &&
        "fetch" in value &&
        typeof value.fetch === "function"
    );
}

class DynamicFetchServiceScope implements ScopedFetchServiceLike {
    public constructor(private readonly scope: DynamicWorkerScope<FetchServiceLike>) {}

    public fetch(request: Request): Response | Promise<Response> {
        return this.scope.entrypoint.fetch(request);
    }

    public [Symbol.dispose](): void {
        this.scope[Symbol.dispose]();
    }
}

class DispatchFetchServiceScope implements ScopedFetchServiceLike {
    public constructor(private readonly service: FetchServiceLike) {}

    public fetch(request: Request): Response | Promise<Response> {
        return this.service.fetch(request);
    }

    public [Symbol.dispose](): void {}
}
