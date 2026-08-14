import { ContentRef, SecretRef, isObjectRecord, type ObjectRecord, type Revision } from "../core";
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
        requireProviderVersion(version);
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

export function requireProviderActionOutcome(value: ProviderActionOutcome): ProviderActionOutcome {
    const outcome = snapshotProviderOutcome(value);
    if (outcome === undefined || !outcome.hasExactly(["name"])) {
        throw malformedProviderOutcome("action");
    }
    const name = outcome.property("name")?.value;
    switch (name) {
        case "succeeded":
            return ProviderActionOutcome.succeeded;
        case "failed":
            return ProviderActionOutcome.failed;
        case "indeterminate":
            return ProviderActionOutcome.indeterminate;
        default:
            throw malformedProviderOutcome("action");
    }
}

export function requireProviderResourceOutcome<Value>(
    value: ProviderResourceOutcome<Value>,
    parser: ProviderReadyValueParser<Value>
): ProviderResourceOutcome<Value> {
    const outcome = snapshotProviderOutcome(value);
    if (outcome === undefined) throw malformedProviderOutcome("resource");
    const name = outcome.property("name")?.value;
    if (name === "ready") {
        const ready = outcome.property("value");
        if (ready === undefined || !outcome.hasExactly(["name", "value"])) {
            throw malformedProviderOutcome("resource");
        }
        try {
            return ProviderResourceOutcome.ready(parser.parse(ready));
        } catch {
            throw malformedProviderOutcome("resource");
        }
    }
    if (!outcome.hasExactly(["name"])) throw malformedProviderOutcome("resource");
    switch (name) {
        case "absent":
            return ProviderResourceOutcome.absent;
        case "failed":
            return ProviderResourceOutcome.failed;
        case "indeterminate":
            return ProviderResourceOutcome.indeterminate;
        default:
            throw malformedProviderOutcome("resource");
    }
}

export abstract class ProviderReadyValueParser<Value> {
    public static get contentRef(): ProviderReadyValueParser<ContentRef> {
        return contentRefReadyValueParser;
    }

    public static get liveSession(): ProviderReadyValueParser<LiveEnvironmentSession> {
        return liveSessionReadyValueParser;
    }

    public static get exposureUrl(): ProviderReadyValueParser<string> {
        return stringReadyValueParser;
    }

    public abstract parse(source: UnparsedProviderReadyValueSource): Value;
}

interface ProviderReadyValueSource<Value> {
    readonly value: Value;
    readonly enumerable: boolean;
}

interface UnparsedProviderReadyValueSource {
    readonly value: unknown;
    readonly enumerable: boolean;
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
    readonly sessionEpoch: number;
    readonly snapshotId: EnvironmentSnapshotId;
}

export interface ExposePortRequest extends GenerationPinnedRequest {
    readonly sessionId: EnvironmentSessionId;
    readonly sessionEpoch: number;
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

interface ProviderOutcomeCandidate {
    readonly name: ProviderActionOutcomeName | "ready" | "absent" | "failed" | "indeterminate";
}

interface ProviderRecordValueSource extends ProviderReadyValueSource<ObjectRecord> {
    readonly value: ObjectRecord;
}

interface ProviderArrayValueSource {
    readonly value: readonly unknown[];
    readonly enumerable: boolean;
}

interface ProviderCleanupValueSource extends ProviderReadyValueSource<() => void | Promise<void>> {
    readonly value: () => void | Promise<void>;
}

interface ProviderDataDescriptor extends PropertyDescriptor {
    readonly enumerable: boolean;
    readonly value: unknown;
}

class ProviderOutcomeSnapshot {
    public constructor(
        private readonly entries: readonly (readonly [string, UnparsedProviderReadyValueSource])[]
    ) {}

    public hasExactly(expected: readonly string[]): boolean {
        return (
            this.entries.length === expected.length &&
            expected.every((key) => this.entries.some(([candidate]) => candidate === key))
        );
    }

    public property(key: string): UnparsedProviderReadyValueSource | undefined {
        return this.entries.find(([candidate]) => candidate === key)?.[1];
    }
}

function snapshotProviderOutcome(
    value: ProviderOutcomeCandidate
): ProviderOutcomeSnapshot | undefined {
    try {
        const keys = Reflect.ownKeys(value);
        if (!keys.every(isStringPropertyKey)) return undefined;
        const entries: (readonly [string, UnparsedProviderReadyValueSource])[] = [];
        for (const key of keys) {
            const property = dataProperty(value, key);
            if (property === undefined || !property.enumerable) return undefined;
            entries.push(Object.freeze([key, property]));
        }
        return new ProviderOutcomeSnapshot(Object.freeze(entries));
    } catch {
        return undefined;
    }
}

function dataProperty(
    value: ProviderOutcomeCandidate | ObjectRecord | ProviderArrayValueSource["value"],
    key: string
): UnparsedProviderReadyValueSource | undefined {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!isDataDescriptor(descriptor)) return undefined;
        const record: ProviderDataDescriptor = descriptor;
        return Object.freeze({
            value: record["value"],
            enumerable: record["enumerable"]
        });
    } catch {
        return undefined;
    }
}

function isDataDescriptor(value: PropertyDescriptor | undefined): value is ProviderDataDescriptor {
    return (
        value !== undefined &&
        (value.enumerable === true || value.enumerable === false) &&
        Object.hasOwn(value, "value") &&
        value.get === undefined &&
        value.set === undefined
    );
}

function isStringPropertyKey(value: PropertyKey): value is string {
    return typeof value === "string";
}

function isObjectValueSource(
    source: UnparsedProviderReadyValueSource
): source is ProviderRecordValueSource {
    return isObjectRecord(source.value);
}

function isArrayValueSource(
    source: UnparsedProviderReadyValueSource
): source is ProviderArrayValueSource {
    return Array.isArray(source.value);
}

function isCleanupValueSource(
    source: UnparsedProviderReadyValueSource
): source is ProviderCleanupValueSource {
    return typeof source.value === "function";
}

function isStringValueSource(
    source: UnparsedProviderReadyValueSource
): source is ProviderReadyValueSource<string> {
    return typeof source.value === "string";
}

function isArrayLengthSource(
    source: UnparsedProviderReadyValueSource
): source is ProviderReadyValueSource<number> {
    return (
        typeof source.value === "number" && Number.isSafeInteger(source.value) && source.value >= 0
    );
}

class ContentRefReadyValueParser extends ProviderReadyValueParser<ContentRef> {
    public parse(source: UnparsedProviderReadyValueSource): ContentRef {
        if (!(source.value instanceof ContentRef))
            throw new TypeError("Content reference is invalid");
        return new ContentRef(source.value.value);
    }
}
const contentRefReadyValueParser = new ContentRefReadyValueParser();

class StringReadyValueParser extends ProviderReadyValueParser<string> {
    public parse(source: UnparsedProviderReadyValueSource): string {
        if (!isStringValueSource(source)) throw new TypeError("Provider value must be a string");
        return source.value;
    }
}
const stringReadyValueParser = new StringReadyValueParser();

const liveSessionAdapters = new WeakMap<object, LiveEnvironmentSession>();

class LiveSessionReadyValueParser extends ProviderReadyValueParser<LiveEnvironmentSession> {
    public parse(source: UnparsedProviderReadyValueSource): LiveEnvironmentSession {
        if (!isObjectValueSource(source)) throw new TypeError("Provider session must be an object");
        const existing = liveSessionAdapters.get(source.value);
        if (existing !== undefined) return existing;
        const childrenSource = dataProperty(source.value, "children");
        const releaseSource = dataProperty(source.value, "release");
        if (
            childrenSource === undefined ||
            releaseSource === undefined ||
            !isCleanupValueSource(releaseSource)
        ) {
            throw new TypeError("Provider session is malformed");
        }
        const children = snapshotSessionChildren(childrenSource);
        if (children === undefined) throw new TypeError("Provider session children are malformed");
        const receiver = source;
        const release = releaseSource.value;
        const session = Object.freeze({
            children,
            release: () => invokeProviderCleanup(release, receiver)
        });
        liveSessionAdapters.set(receiver.value, session);
        return session;
    }
}
const liveSessionReadyValueParser = new LiveSessionReadyValueParser();

function snapshotSessionChildren(
    source: UnparsedProviderReadyValueSource
): readonly EnvironmentSessionChild[] | undefined {
    if (!isArrayValueSource(source)) return undefined;
    const arraySource: ProviderArrayValueSource = source;
    try {
        const lengthSource = dataProperty(arraySource.value, "length");
        if (lengthSource === undefined || !isArrayLengthSource(lengthSource)) return undefined;
        const length = lengthSource.value;
        const keys = Reflect.ownKeys(source.value);
        if (
            keys.length !== length + 1 ||
            !keys.includes("length") ||
            !Array.from({ length }, (_, index) => String(index)).every((key) => keys.includes(key))
        ) {
            return undefined;
        }
        const children: EnvironmentSessionChild[] = [];
        for (let index = 0; index < length; index += 1) {
            const childSource = dataProperty(arraySource.value, String(index));
            if (childSource === undefined || !isObjectValueSource(childSource)) return undefined;
            const disposeSource = dataProperty(childSource.value, "dispose");
            if (disposeSource === undefined || !isCleanupValueSource(disposeSource))
                return undefined;
            const receiver = childSource;
            const dispose = disposeSource.value;
            children.push(
                Object.freeze({ dispose: () => invokeProviderCleanup(dispose, receiver) })
            );
        }
        return Object.freeze(children);
    } catch {
        return undefined;
    }
}

function invokeProviderCleanup(
    operation: () => void | Promise<void>,
    receiver: ProviderRecordValueSource
): Promise<void> {
    return Promise.resolve(Function.prototype.call.call(operation, receiver.value)).then(
        () => undefined
    );
}

function requireProviderVersion(value: string): void {
    try {
        if (value.trim().length > 0 && value.length <= MAX_PROVIDER_VERSION_LENGTH) return;
    } catch {
        // Fall through to the stable constructor-shape error.
    }
    throw new TypeError(
        `Provider version must contain between 1 and ${MAX_PROVIDER_VERSION_LENGTH} characters`
    );
}

function malformedProviderOutcome(kind: "action" | "resource"): AgentCoreError {
    return new AgentCoreError(
        "operation.invalid-output",
        `Environment provider ${kind} outcome is malformed`
    );
}
