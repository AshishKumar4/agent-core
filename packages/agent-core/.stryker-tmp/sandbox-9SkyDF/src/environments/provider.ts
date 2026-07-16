// @ts-nocheck
import { ContentRef, SecretRef, type Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { AttemptReceiptOutcome } from "../invocations";
import { requireInstance } from "./data";
import {
    ProviderId,
    type EnvironmentId,
    type EnvironmentSessionId,
    type EnvironmentSnapshotId,
    type PortExposureId
} from "./id";
import { EnvironmentSessionCapability } from "./session";

const MAX_PROVIDER_VERSION_LENGTH = 128;

export class ProviderDescriptor {
    public constructor(
        public readonly id: ProviderId,
        public readonly version: string,
        public readonly configuration: ContentRef
    ) {
        requireInstance(id, ProviderId, "Provider ID");
        requireInstance(configuration, ContentRef, "Provider configuration");
        if (
            typeof version !== "string" ||
            version.trim().length === 0 ||
            version.length > MAX_PROVIDER_VERSION_LENGTH
        ) {
            throw new TypeError(
                `Provider version must contain between 1 and ${MAX_PROVIDER_VERSION_LENGTH} characters`
            );
        }
        Object.freeze(this);
    }

    public equals(other: ProviderDescriptor): boolean {
        return (
            this.id.equals(other.id) &&
            this.version === other.version &&
            this.configuration.equals(other.configuration)
        );
    }
}

export type ProviderActionOutcomeName = AttemptReceiptOutcome;
export interface ProviderActionOutcome {
    readonly name: ProviderActionOutcomeName;
}

export const ProviderActionOutcome = Object.freeze({
    succeeded: Object.freeze({ name: "succeeded" } as const),
    failed: Object.freeze({ name: "failed" } as const),
    indeterminate: Object.freeze({ name: "indeterminate" } as const)
});

export type ProviderResourceOutcome<Value> =
    | { readonly name: "ready"; readonly value: Value }
    | { readonly name: "absent" }
    | { readonly name: "failed" }
    | { readonly name: "indeterminate" };

export const ProviderResourceOutcome = Object.freeze({
    ready<Value>(value: Value): ProviderResourceOutcome<Value> {
        return Object.freeze({ name: "ready", value });
    },
    absent: Object.freeze({ name: "absent" } as const),
    failed: Object.freeze({ name: "failed" } as const),
    indeterminate: Object.freeze({ name: "indeterminate" } as const)
});

export function requireProviderActionOutcome(value: unknown): ProviderActionOutcome {
    if (!isExactOutcome(value, ["name"])) throw malformedProviderOutcome("action");
    const name = dataProperty(value, "name");
    if (name !== "succeeded" && name !== "failed" && name !== "indeterminate") {
        throw malformedProviderOutcome("action");
    }
    return value as ProviderActionOutcome;
}

export function requireProviderResourceOutcome<Value>(
    value: unknown,
    isReadyValue: (candidate: unknown) => candidate is Value
): ProviderResourceOutcome<Value> {
    if (!isObject(value)) throw malformedProviderOutcome("resource");
    const name = dataProperty(value, "name");
    if (name === "ready") {
        const readyValue = dataProperty(value, "value");
        if (!isExactOutcome(value, ["name", "value"]) || !isReadyValue(readyValue)) {
            throw malformedProviderOutcome("resource");
        }
        return value as ProviderResourceOutcome<Value>;
    }
    if (
        (name !== "absent" && name !== "failed" && name !== "indeterminate") ||
        !isExactOutcome(value, ["name"])
    ) {
        throw malformedProviderOutcome("resource");
    }
    return value as ProviderResourceOutcome<Value>;
}

export interface EnvironmentSessionChild {
    dispose(): void | Promise<void>;
}

export interface LiveEnvironmentSession {
    readonly children: readonly EnvironmentSessionChild[];
    release(): void | Promise<void>;
}

export class EnvironmentCredentialProxyCapability {
    public constructor(
        public readonly session: EnvironmentSessionCapability,
        public readonly generation: number,
        public readonly credential: SecretRef
    ) {
        requireInstance(session, EnvironmentSessionCapability, "Environment session capability");
        requireInstance(credential, SecretRef, "Environment credential");
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError(
                "Environment credential capability generation must be a non-negative safe integer"
            );
        }
        Object.freeze(this);
    }
}

export abstract class EnvironmentCredentialIsolationProxy {
    public abstract forward(
        capability: EnvironmentCredentialProxyCapability,
        request: ContentRef
    ): Promise<ContentRef>;
}

interface GenerationPinnedRequest {
    readonly environmentId: EnvironmentId;
    readonly environmentRevision: Revision;
    readonly generation: number;
}

export interface OpenSessionRequest extends GenerationPinnedRequest {
    readonly sessionId: EnvironmentSessionId;
    readonly restore?: ContentRef;
}

export interface SnapshotEnvironmentRequest extends GenerationPinnedRequest {
    readonly sessionId: EnvironmentSessionId;
    readonly snapshotId: EnvironmentSnapshotId;
}

export interface ExposePortRequest extends GenerationPinnedRequest {
    readonly sessionId: EnvironmentSessionId;
    readonly exposureId: PortExposureId;
    readonly port: number;
}

export abstract class EnvironmentProvider {
    public abstract readonly descriptor: ProviderDescriptor;

    public abstract openSession(
        request: OpenSessionRequest
    ): Promise<ProviderResourceOutcome<LiveEnvironmentSession>>;

    public abstract inspectSession(
        request: OpenSessionRequest
    ): Promise<ProviderResourceOutcome<LiveEnvironmentSession>>;

    public abstract closeSession(request: OpenSessionRequest): Promise<ProviderActionOutcome>;

    public abstract createSnapshot(
        request: SnapshotEnvironmentRequest
    ): Promise<ProviderResourceOutcome<ContentRef>>;

    public abstract inspectSnapshot(
        request: SnapshotEnvironmentRequest
    ): Promise<ProviderResourceOutcome<ContentRef>>;

    public abstract exposePort(
        request: ExposePortRequest
    ): Promise<ProviderResourceOutcome<string>>;

    public abstract inspectExposure(
        request: ExposePortRequest
    ): Promise<ProviderResourceOutcome<string>>;

    public abstract revokeExposure(request: ExposePortRequest): Promise<ProviderActionOutcome>;
}

export abstract class EnvironmentProviderRegistry {
    public abstract resolve(descriptor: ProviderDescriptor): EnvironmentProvider | undefined;
}

export class MemoryEnvironmentProviderRegistry extends EnvironmentProviderRegistry {
    readonly #providers: readonly EnvironmentProvider[];

    public constructor(providers: readonly EnvironmentProvider[]) {
        super();
        this.#providers = Object.freeze([...providers]);
    }

    public resolve(descriptor: ProviderDescriptor): EnvironmentProvider | undefined {
        return this.#providers.find((provider) => provider.descriptor.equals(descriptor));
    }
}

function isExactOutcome(value: unknown, expectedKeys: readonly string[]): value is object {
    if (!isObject(value)) return false;
    try {
        const keys = Reflect.ownKeys(value);
        return (
            keys.length === expectedKeys.length &&
            expectedKeys.every((key) => keys.includes(key)) &&
            expectedKeys.every(
                (key) => Object.getOwnPropertyDescriptor(value, key)?.get === undefined
            )
        );
    } catch {
        return false;
    }
}

function dataProperty(value: object, key: string): unknown {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    } catch {
        return undefined;
    }
}

function isObject(value: unknown): value is object {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function malformedProviderOutcome(kind: "action" | "resource"): AgentCoreError {
    return new AgentCoreError(
        "operation.invalid-output",
        `Environment provider ${kind} outcome is malformed`
    );
}
