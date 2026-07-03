import { AgentCoreError } from "../errors";
import type { Environment } from "./env";
import type { EnvironmentId } from "./id";
import type { EnvironmentProviderRegistry } from "./provider";
import type { EnvironmentPinRef, EnvironmentSession } from "./session";

export class EnvironmentRuntime {
    #environment: Environment;

    public constructor(
        environment: Environment,
        private readonly providers: EnvironmentProviderRegistry
    ) {
        this.#environment = environment;
    }

    public get environment(): Environment {
        return this.#environment;
    }

    public pin(): EnvironmentPinRef {
        return {
            environmentId: this.#environment.id
        };
    }

    public rotate(): Environment {
        this.#environment = this.#environment.rotate();
        return this.#environment;
    }

    public async openSession(pin: EnvironmentPinRef = this.pin()): Promise<EnvironmentSession> {
        if (!this.#environment.canOpenSession) {
            throw new AgentCoreError("environment.invalid-session", "Environment cannot open sessions in its current status");
        }

        this.assertEnvironmentMatches(pin.environmentId);
        const provider = this.providers.resolve(this.#environment.provider);
        if (provider === undefined) {
            throw new AgentCoreError("environment.invalid-session", "No provider is registered for the Environment");
        }

        const session = await provider.openSession(this.#environment);
        session.use(pin);
        return session;
    }

    private assertEnvironmentMatches(environmentId: EnvironmentId): void {
        if (!environmentId.equals(this.#environment.id)) {
            throw new AgentCoreError("environment.stale-session", "Environment pin references another Environment");
        }
    }
}
