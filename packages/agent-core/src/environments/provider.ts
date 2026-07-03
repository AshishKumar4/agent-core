import type { ContentRef } from "../record";
import type { Environment } from "./env";
import type { ProviderId } from "./id";
import type { EnvironmentSession } from "./session";

export class ProviderDescriptor {
    public constructor(
        public readonly id: ProviderId,
        public readonly version: string,
        public readonly configurationRef: ContentRef
    ) {
        if (version.length === 0 || version.length > 128) {
            throw new TypeError("Provider version must contain between 1 and 128 characters");
        }
    }

    public equals(other: ProviderDescriptor): boolean {
        return this.id.equals(other.id)
            && this.version === other.version
            && this.configurationRef.equals(other.configurationRef);
    }
}

export interface EnvironmentProvider {
    readonly descriptor: ProviderDescriptor;
    openSession(environment: Environment): Promise<EnvironmentSession>;
}

export interface EnvironmentProviderRegistry {
    resolve(descriptor: ProviderDescriptor): EnvironmentProvider | undefined;
}

export class MemoryEnvironmentProviderRegistry implements EnvironmentProviderRegistry {
    public constructor(private readonly providers: readonly EnvironmentProvider[]) {
    }

    public resolve(descriptor: ProviderDescriptor): EnvironmentProvider | undefined {
        return this.providers.find(provider => provider.descriptor.equals(descriptor));
    }
}
