import { AgentCoreError } from "../errors";
import { FacetSet } from "../facets";
import type { EnvironmentId, EnvironmentSessionId } from "./id";

export interface EnvironmentPinRef {
    readonly environmentId: EnvironmentId;
}

export abstract class EnvironmentSession {
    #closed = false;
    #facets: FacetSet | undefined;

    protected constructor(
        public readonly id: EnvironmentSessionId,
        public readonly environmentId: EnvironmentId
    ) {
    }

    public get closed(): boolean {
        return this.#closed;
    }

    public use(pin: EnvironmentPinRef): FacetSet {
        this.assertUsable(pin);
        if (this.#facets === undefined) {
            this.#facets = this.createFacets();
        }

        return this.#facets;
    }

    protected abstract createFacets(): FacetSet;

    public async close(): Promise<void> {
        if (this.#closed) {
            return;
        }

        await this.onClose();
        this.#closed = true;
    }

    protected onClose(): Promise<void> {
        return Promise.resolve();
    }

    private assertUsable(pin: EnvironmentPinRef): void {
        if (this.#closed) {
            throw new AgentCoreError("environment.closed-session", "Environment session is closed");
        }

        if (!this.environmentId.equals(pin.environmentId)) {
            throw new AgentCoreError("environment.stale-session", "Environment session does not match the requested Environment");
        }
    }
}
