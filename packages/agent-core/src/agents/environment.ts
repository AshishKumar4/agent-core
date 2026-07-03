import type { EnvironmentRuntime } from "../environments/runtime";
import type { EnvironmentSession } from "../environments/session";
import type { Run } from "./runs";
import { BindingSet } from "./binding";

export class RunEnvironmentResolution {
    public constructor(
        public readonly bindings: BindingSet,
        public readonly session: EnvironmentSession | undefined
    ) {
    }

    public async close(): Promise<void> {
        await this.session?.close();
    }
}

export class RunEnvironmentResolver {
    public constructor(private readonly environments: readonly EnvironmentRuntime[]) {
    }

    public async resolve(run: Run, bindings: BindingSet): Promise<RunEnvironmentResolution> {
        const pin = run.environmentPin;
        if (pin === undefined) {
            return new RunEnvironmentResolution(bindings, undefined);
        }

        const environment = this.environments.find(runtime => runtime.environment.id.equals(pin.environmentId));
        if (environment === undefined) {
            throw new TypeError("Run Environment pin references an unknown Environment");
        }

        const session = await environment.openSession(pin);
        return new RunEnvironmentResolution(
            bindings.merge(BindingSet.fromFacets(session.use(pin))),
            session
        );
    }
}
