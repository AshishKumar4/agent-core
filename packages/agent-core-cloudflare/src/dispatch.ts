import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";

export interface DispatchNamespaceLike<Service> {
    get(scriptName: string, parameters?: Readonly<Record<string, string>>): Service;
}

export class DispatchNamespaceAdapter<Service> {
    public constructor(
        private readonly namespace: DispatchNamespaceLike<Service>,
        private readonly errors: CloudflareErrorPort
    ) {}

    public resolve(scriptName: string, parameters?: Readonly<Record<string, string>>): Service {
        if (scriptName.length === 0) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Dispatch script name must be non-empty"
            );
        }
        if (
            parameters !== undefined &&
            Object.entries(parameters).some(
                ([name, value]) => name.length === 0 || value.length === 0
            )
        ) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Dispatch parameters must have non-empty names and values"
            );
        }
        let service: Service;
        try {
            service = this.namespace.get(scriptName, parameters);
        } catch (cause) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                `Dispatch namespace resolution failed for ${scriptName}`,
                cause
            );
        }
        if (service === undefined || service === null) {
            operationalFailure(
                this.errors,
                "operation.invalid-output",
                `Dispatch namespace returned no service for ${scriptName}`
            );
        }
        return service;
    }
}
