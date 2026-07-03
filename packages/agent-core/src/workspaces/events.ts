import { FacetDataSchemas, type FacetData, type FacetDataMap } from "../facets/data";
import type { OperationAddress } from "../facets/operation";
import type { TenantId } from "../identity";
import type { Invocation, InvocationReceipt } from "../invocations";
import { TextId } from "../core";
import type { OperationId } from "../operations";
import type { OperationContext } from "../operations";
import type { ContentRef, Digest, Revision } from "../record";
import type { EventId, SubscriptionId, WorkspaceId } from "./id";

const MAX_PATTERN_LENGTH = 256;
const MAX_PAYLOAD_PATH_LENGTH = 512;
const KIND_WILDCARD = "*";

export type EventPayloadValue = FacetData;

export type EventPayload = FacetDataMap;

export type EventVisibility = "workspace" | "private";
export type EventCategory = "surface" | "message" | "schedule" | "webhook" | "platform" | "provider" | "sandbox" | "operation" | "state";

export type SubscriptionStatus = "enabled" | "disabled" | "removed";

export type DedupePolicyValue = "none" | "event" | "causation" | "payload";

export class EventKind extends TextId {
    public constructor(value: string) {
        super(value, "Event kind");
        validateDottedValue(value, "Event kind", false);
    }
}

export class EventSource extends TextId {
    public constructor(value: string) {
        super(value, "Event source");
    }
}

export class EventCausation {
    public constructor(
        public readonly eventId: EventId | undefined,
        public readonly operationId: OperationId | undefined
    ) {
        if (eventId === undefined && operationId === undefined) {
            throw new TypeError("Event causation must include an event or operation");
        }
    }
}

export class EventMetadata {
    public constructor(
        public readonly category: EventCategory,
        public readonly tenantId: TenantId | undefined,
        public readonly payloadDigest: Digest | undefined,
        public readonly payloadRef: ContentRef | undefined,
        public readonly idempotencyKey: string | undefined,
        public readonly correlationId: string | undefined
    ) {
        if (idempotencyKey !== undefined && idempotencyKey.length === 0) {
            throw new TypeError("Event idempotency key must not be empty");
        }

        if (correlationId !== undefined && correlationId.length === 0) {
            throw new TypeError("Event correlation ID must not be empty");
        }
    }

    public static state(): EventMetadata {
        return stateEventMetadata;
    }
}

export class EventRecord {
    public constructor(
        public readonly id: EventId,
        public readonly workspaceId: WorkspaceId,
        public readonly kind: EventKind,
        public readonly source: EventSource,
        public readonly visibility: EventVisibility,
        public readonly payload: EventPayload,
        public readonly causation: EventCausation | undefined,
        public readonly occurredAt: Date,
        public readonly revision: Revision,
        public readonly metadata: EventMetadata = EventMetadata.state()
    ) {
        validateEventVisibility(visibility);
        if (!FacetDataSchemas.object().accepts(payload)) {
            throw new TypeError("Event payload must be Facet data");
        }

        if (Number.isNaN(occurredAt.getTime())) {
            throw new TypeError("Event timestamp must be a valid Date");
        }
    }
}

const stateEventMetadata = new EventMetadata("state", undefined, undefined, undefined, undefined, undefined);

export class EventPattern {
    public constructor(
        public readonly kindPattern: string,
        public readonly source: EventSource | undefined,
        public readonly visibility: EventVisibility | undefined
    ) {
        validateDottedValue(kindPattern, "Event pattern", true);

        if (visibility !== undefined) {
            validateEventVisibility(visibility);
        }
    }

    public static all(): EventPattern {
        return new EventPattern(KIND_WILDCARD, undefined, undefined);
    }

    public static forKind(kind: EventKind): EventPattern {
        return new EventPattern(kind.value, undefined, undefined);
    }

    public matches(event: EventRecord): boolean {
        if (!matchesKindPattern(this.kindPattern, event.kind)) {
            return false;
        }

        if (this.source !== undefined && !this.source.equals(event.source)) {
            return false;
        }

        return this.visibility === undefined || this.visibility === event.visibility;
    }
}

export class PayloadMapping {
    public constructor(
        public readonly eventPath: string,
        public readonly operationPath: string
    ) {
        validatePayloadPath(eventPath, "Event payload path");
        validatePayloadPath(operationPath, "Operation payload path");
    }
}

export class DedupePolicy {
    public constructor(
        public readonly value: DedupePolicyValue,
        public readonly payloadPath: string | undefined
    ) {
        validateDedupePolicyValue(value);

        if (value === "payload") {
            if (payloadPath === undefined) {
                throw new TypeError("Payload dedupe policy must include a payload path");
            }

            validatePayloadPath(payloadPath, "Dedupe payload path");
            return;
        }

        if (payloadPath !== undefined) {
            throw new TypeError("Only payload dedupe policy can include a payload path");
        }
    }

    public static none(): DedupePolicy {
        return new DedupePolicy("none", undefined);
    }

    public static event(): DedupePolicy {
        return new DedupePolicy("event", undefined);
    }

    public static causation(): DedupePolicy {
        return new DedupePolicy("causation", undefined);
    }

    public static payload(path: string): DedupePolicy {
        return new DedupePolicy("payload", path);
    }

    public get enabled(): boolean {
        return this.value !== "none";
    }
}

export class Subscription {
    public readonly payloadMappings: readonly PayloadMapping[];

    public constructor(
        public readonly id: SubscriptionId,
        public readonly workspaceId: WorkspaceId,
        public readonly pattern: EventPattern,
        public readonly operation: OperationAddress,
        public readonly status: SubscriptionStatus,
        public readonly dedupePolicy: DedupePolicy,
        payloadMappings: readonly PayloadMapping[],
        public readonly revision: Revision
    ) {
        validateSubscriptionStatus(status);
        this.payloadMappings = Object.freeze([...payloadMappings]);
    }

    public get enabled(): boolean {
        return this.status === "enabled";
    }

    public matches(event: EventRecord): boolean {
        return this.enabled
            && this.workspaceId.equals(event.workspaceId)
            && this.pattern.matches(event);
    }

    public dedupeKey(event: EventRecord): string | undefined {
        return subscriptionDedupeKey(this, event);
    }

    public enable(): Subscription {
        return this.transition("enabled");
    }

    public disable(): Subscription {
        return this.transition("disabled");
    }

    public remove(): Subscription {
        return this.transition("removed");
    }

    private transition(status: SubscriptionStatus): Subscription {
        if (this.status === status) {
            return this;
        }

        if (this.status === "removed") {
            throw new TypeError("Removed subscription cannot change status");
        }

        return new Subscription(
            this.id,
            this.workspaceId,
            this.pattern,
            this.operation,
            status,
            this.dedupePolicy,
            this.payloadMappings,
            this.revision.next()
        );
    }
}

export type SubscriptionSkipReason = "dedupe" | "payload-mismatch";

export class SubscriptionInvocation {
    public constructor(
        public readonly subscription: Subscription,
        public readonly event: EventRecord,
        public readonly invocation: Invocation,
        public readonly receipt: InvocationReceipt | undefined,
        public readonly output: FacetData | undefined
    ) {
    }
}

export interface SubscriptionDedupeStore {
    reserve(subscription: Subscription, event: EventRecord): Promise<boolean>;
}

export class MemorySubscriptionDedupeStore implements SubscriptionDedupeStore {
    readonly #consumed = new Set<string>();

    public async reserve(subscription: Subscription, event: EventRecord): Promise<boolean> {
        const key = subscription.dedupeKey(event);
        if (key === undefined) {
            return true;
        }

        if (this.#consumed.has(key)) {
            return false;
        }

        this.#consumed.add(key);
        return true;
    }
}

export interface SubscriptionInvoker {
    invoke(
        context: OperationContext,
        subscription: Subscription,
        event: EventRecord,
        input: EventPayload
    ): Promise<SubscriptionInvocation>;
}

export class SubscriptionSkip {
    public constructor(
        public readonly subscription: Subscription,
        public readonly event: EventRecord,
        public readonly reason: SubscriptionSkipReason
    ) {
    }
}

export class SubscriptionRouteResult {
    public readonly invocations: readonly SubscriptionInvocation[];

    public readonly skipped: readonly SubscriptionSkip[];

    public constructor(
        invocations: readonly SubscriptionInvocation[],
        skipped: readonly SubscriptionSkip[]
    ) {
        this.invocations = Object.freeze([...invocations]);
        this.skipped = Object.freeze([...skipped]);
    }
}

export class SubscriptionRouter {
    public readonly subscriptions: readonly Subscription[];

    public constructor(
        subscriptions: readonly Subscription[],
        private readonly invoker: SubscriptionInvoker,
        private readonly dedupe: SubscriptionDedupeStore
    ) {
        this.subscriptions = Object.freeze([...subscriptions]);
    }

    public async route(context: OperationContext, event: EventRecord): Promise<SubscriptionRouteResult> {
        const invocations: SubscriptionInvocation[] = [];
        const skipped: SubscriptionSkip[] = [];

        for (const subscription of this.subscriptions) {
            if (!subscription.matches(event)) {
                continue;
            }

            if (!await this.dedupe.reserve(subscription, event)) {
                skipped.push(new SubscriptionSkip(subscription, event, "dedupe"));
                continue;
            }

            const input = mapEventPayload(event.payload, subscription.payloadMappings);
            if (input === undefined) {
                skipped.push(new SubscriptionSkip(subscription, event, "payload-mismatch"));
                continue;
            }

            const invocation = await this.invoker.invoke(context, subscription, event, input);
            invocations.push(invocation);
        }

        return new SubscriptionRouteResult(invocations, skipped);
    }
}

function subscriptionDedupeKey(subscription: Subscription, event: EventRecord): string | undefined {
    switch (subscription.dedupePolicy.value) {
        case "none":
            return undefined;
        case "event":
            return `${subscription.id.value}:event:${event.id.value}`;
        case "causation": {
            const causation = event.causation?.eventId?.value ?? event.causation?.operationId?.value;
            return causation === undefined ? undefined : `${subscription.id.value}:causation:${causation}`;
        }
        case "payload": {
            const value = payloadValueAt(event.payload, subscription.dedupePolicy.payloadPath);
            return value === undefined
                ? undefined
                : `${subscription.id.value}:payload:${stablePayloadValue(value)}`;
        }
    }
}

function mapEventPayload(
    payload: EventPayload,
    mappings: readonly PayloadMapping[]
): EventPayload | undefined {
    if (mappings.length === 0) {
        return payload;
    }

    const mapped: MutableEventPayload = {};
    for (const mapping of mappings) {
        const value = payloadValueAt(payload, mapping.eventPath);
        if (value === undefined) {
            return undefined;
        }

        setPayloadValue(mapped, mapping.operationPath, value);
    }

    return mapped;
}

interface MutableEventPayload {
    [key: string]: EventPayloadValue;
}

function payloadValueAt(payload: EventPayload, path: string | undefined): EventPayloadValue | undefined {
    if (path === undefined) {
        return undefined;
    }

    let current: EventPayloadValue = payload;
    for (const segment of path.split(".")) {
        if (!isEventPayloadObject(current)) {
            return undefined;
        }

        const next: EventPayloadValue | undefined = current[segment];
        if (next === undefined) {
            return undefined;
        }

        current = next;
    }

    return current;
}

function setPayloadValue(payload: MutableEventPayload, path: string, value: EventPayloadValue): void {
    const segments = path.split(".");
    let current = payload;

    for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        if (segment === undefined) {
            throw new TypeError("Payload path segment disappeared during mapping");
        }

        const next = current[segment];
        if (!isMutableEventPayload(next)) {
            const child: MutableEventPayload = {};
            current[segment] = child;
            current = child;
            continue;
        }

        current = next;
    }

    const leaf = segments.at(-1);
    if (leaf === undefined) {
        throw new TypeError("Payload path must contain at least one segment");
    }

    current[leaf] = value;
}

function stablePayloadValue(value: EventPayloadValue): string {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return JSON.stringify(value);
    }

    if (isEventPayloadArray(value)) {
        return `[${value.map(stablePayloadValue).join(",")}]`;
    }

    if (!isEventPayloadObject(value)) {
        throw new TypeError("Unsupported Event payload value");
    }

    const keys = Object.keys(value).sort();
    const entries = keys.map(key => {
        const child: EventPayloadValue | undefined = value[key];
        if (child === undefined) {
            throw new TypeError("Payload object key disappeared during dedupe encoding");
        }

        return `${JSON.stringify(key)}:${stablePayloadValue(child)}`;
    });

    return `{${entries.join(",")}}`;
}

function isEventPayloadObject(value: EventPayloadValue): value is EventPayload {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventPayloadArray(value: EventPayloadValue): value is readonly EventPayloadValue[] {
    return Array.isArray(value);
}

function isMutableEventPayload(value: EventPayloadValue | undefined): value is MutableEventPayload {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDottedValue(value: string, name: string, allowWildcard: boolean): void {
    if (value.length === 0 || value.length > MAX_PATTERN_LENGTH) {
        throw new TypeError(`${name} must contain between 1 and ${MAX_PATTERN_LENGTH} characters`);
    }

    for (const segment of value.split(".")) {
        if (segment.length === 0) {
            throw new TypeError(`${name} cannot contain empty segments`);
        }

        if (!allowWildcard && segment === KIND_WILDCARD) {
            throw new TypeError(`${name} cannot contain wildcards`);
        }

        if (allowWildcard && segment.includes(KIND_WILDCARD) && segment !== KIND_WILDCARD) {
            throw new TypeError(`${name} wildcard must occupy a complete segment`);
        }
    }
}

function validateEventVisibility(visibility: EventVisibility): void {
    if (visibility !== "workspace" && visibility !== "private") {
        throw new TypeError("Event visibility must be workspace or private");
    }
}

function validatePayloadPath(path: string, name: string): void {
    if (path.length === 0 || path.length > MAX_PAYLOAD_PATH_LENGTH) {
        throw new TypeError(`${name} must contain between 1 and ${MAX_PAYLOAD_PATH_LENGTH} characters`);
    }
}

function validateDedupePolicyValue(value: DedupePolicyValue): void {
    if (value !== "none" && value !== "event" && value !== "causation" && value !== "payload") {
        throw new TypeError("Dedupe policy must be none, event, causation, or payload");
    }
}

function validateSubscriptionStatus(status: SubscriptionStatus): void {
    if (status !== "enabled" && status !== "disabled" && status !== "removed") {
        throw new TypeError("Subscription status must be enabled, disabled, or removed");
    }
}

function matchesKindPattern(pattern: string, kind: EventKind): boolean {
    if (pattern === KIND_WILDCARD) {
        return true;
    }

    const patternSegments = pattern.split(".");
    const kindSegments = kind.value.split(".");

    if (patternSegments.length !== kindSegments.length) {
        return false;
    }

    for (let index = 0; index < patternSegments.length; index += 1) {
        const expected = patternSegments[index];
        const actual = kindSegments[index];

        if (expected === undefined || actual === undefined) {
            return false;
        }

        if (expected !== KIND_WILDCARD && expected !== actual) {
            return false;
        }
    }

    return true;
}
