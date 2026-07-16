import {
    AuthenticatedEventIntent,
    type EventAcceptanceResult,
    type EventDraft,
    EventIntentAuthenticator,
    EventProvenance,
    EventVerification,
    MemoryWorkspaceRecords,
    SourceEventProtocol,
    Subscription,
    WorkspacePersistence,
    eventIntentBytes
} from "../../src/workspaces";
import { describe, expect, test } from "vitest";
import { MemoryActorStore, type SynchronousResultGuard } from "../../src/actors";
import { Digest, JsonSchema, Revision, type JsonValue } from "../../src/core";
import {
    BindingName,
    Command,
    EventKind,
    FacetPackageId,
    FacetRef,
    OperationName,
    OperationRef,
    OperationDescriptor,
    SlotName,
    type TrustTier
} from "../../src/facets";
import {
    AuditRecordId,
    CorrelationId,
    InvocationId,
    RouteProjectionId,
    RouteReservationId
} from "../../src/interaction-references";
import type {
    EventPayloadPort,
    EventTrustPort,
    InteractionAuditPort,
    InteractionIdPort,
    PreparedRouteMaterial,
    RouteMaterialPreparation,
    SourceRouteDecision,
    SourceRoutePort
} from "../../src/workspaces";
import type { ContentRetentionPort } from "../../src/workspaces";
import { EventId } from "../../src/workspaces";
import { SubscriptionId } from "../../src/interaction-references";
import {
    content,
    principal,
    retentionFixture,
    scope,
    sourceActor,
    targetActor,
    tenant
} from "../workspaces/fixtures";
import { CommandRuntime, type InstalledCommand } from "../../src/operations/command-runtime";

const COMMAND_PACKAGE = "acme.runtime";
const COMMAND_NAME = "run";
const COMMAND_ID = `${COMMAND_PACKAGE}:${COMMAND_NAME}`;

const argumentSchema = new JsonSchema({
    type: "object",
    required: ["value"],
    properties: { value: { type: "number" } },
    additionalProperties: false
});
const outputSchema = new JsonSchema({ type: "object", additionalProperties: true });

function command(acceptedTrust?: readonly [TrustTier, ...TrustTier[]]): Command {
    return new Command({
        name: COMMAND_NAME,
        title: "Run",
        arguments: argumentSchema,
        operation: new OperationRef(COMMAND_ID),
        binding: new BindingName("runtime"),
        surfaces: [new SlotName("palette")],
        ...(acceptedTrust === undefined ? {} : { acceptedTrust })
    });
}

function descriptor(): OperationDescriptor {
    return new OperationDescriptor(
        new OperationName(COMMAND_NAME),
        "mutate",
        argumentSchema,
        outputSchema
    );
}

function install(acceptedTrust: readonly [TrustTier, ...TrustTier[]]): InstalledCommand {
    return new CommandRuntime().install({
        contributor: new FacetRef("workspace:commands"),
        command: command(acceptedTrust),
        target: { package: new FacetPackageId(COMMAND_PACKAGE), descriptor: descriptor() }
    });
}

/**
 * Materializes the workspace Subscription the Definition layer derives from an installed
 * Command's Automation — the single routing path a Command invocation may take (§4.3).
 */
function routedSubscription(installed: InstalledCommand): Subscription {
    const automation = installed.subscription;
    return new Subscription({
        id: new SubscriptionId(`command-subscription-${installed.id}`),
        revision: Revision.initial(),
        source: automation.source,
        target: automation.target,
        mapping: automation.mapping!,
        dedupe: automation.dedupe!,
        authority: { kind: "initiator", binding: automation.binding }
    });
}

describe("Command invocation routing", () => {
    test("routes an invocation only when the derived Subscription accepts the Event trust", async () => {
        const installed = install(["owner"]);
        expect(await reservationCount(installed, "owner", "cmd-owner")).toBe(1);
        expect(await reservationCount(installed, "authenticated", "cmd-authenticated")).toBe(0);
        expect(await reservationCount(installed, "external", "cmd-external")).toBe(0);
    });

    test("routes exactly one reservation per invocation and dedupes a redelivered Event", async () => {
        const installed = install(["owner", "authenticated", "self"]);
        const harness = createHarness();
        harness.transaction((state) =>
            harness.persistence.saveSubscription(state, routedSubscription(installed), undefined)
        );
        const protocol = sourceProtocol(harness, "authenticated");

        const first = await commit(harness, protocol, "cmd-1");
        expect(first.duplicate).toBe(false);
        expect(first.reservations).toHaveLength(1);
        expect(first.reservations[0]!.operation.value).toBe(COMMAND_ID);
        expect(first.reservations[0]!.trust).toBe("authenticated");
        expect(first.reservations[0]!.authority.kind).toBe("initiator");

        const redelivered = await commit(harness, protocol, "cmd-1");
        expect(redelivered.duplicate).toBe(true);
        expect(redelivered.reservations).toHaveLength(1);
        expect(redelivered.reservations[0]!.id).toEqual(first.reservations[0]!.id);
        expect(harness.snapshot().records.listRecords("routeReservation")).toHaveLength(1);
    });
});

async function reservationCount(
    installed: InstalledCommand,
    trust: TrustTier,
    eventId: string
): Promise<number> {
    const harness = createHarness();
    harness.transaction((state) =>
        harness.persistence.saveSubscription(state, routedSubscription(installed), undefined)
    );
    const protocol = sourceProtocol(harness, trust);
    return (await commit(harness, protocol, eventId)).reservations.length;
}

async function commit(
    harness: Harness,
    protocol: SourceEventProtocol<ProtocolState>,
    eventId: string
): Promise<EventAcceptanceResult> {
    const intent = authenticate(commandInvokedDraft(eventId));
    const snapshot = harness.transaction((state) => protocol.snapshot(state, intent));
    const prepared = await protocol.prepare(snapshot);
    const result = harness.transaction((state) => protocol.commit(state, prepared));
    return result;
}

// --- harness -------------------------------------------------------------------------------

interface ProtocolState {
    readonly records: MemoryWorkspaceRecords;
    readonly audit: string[];
}

interface Harness {
    readonly persistence: WorkspacePersistence<ProtocolState>;
    transaction<Result>(
        operation: (state: ProtocolState) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    snapshot(): ProtocolState;
}

function createHarness(): Harness {
    const store = new MemoryActorStore<ProtocolState>(
        { records: new MemoryWorkspaceRecords(), audit: [] },
        (state) => ({ records: state.records.clone(), audit: [...state.audit] })
    );
    return {
        persistence: new WorkspacePersistence(
            (state) => state.records,
            new RetentionPort(),
            sourceActor,
            tenant
        ),
        transaction(operation, ...guard) {
            return store.transaction(operation, ...guard);
        },
        snapshot() {
            return store.snapshot().state;
        }
    };
}

function sourceProtocol(harness: Harness, trust: TrustTier): SourceEventProtocol<ProtocolState> {
    const trustPort: EventTrustPort<ProtocolState> = {
        derive: () =>
            trust === "external" ? { tier: "external" } : { tier: trust, initiator: principal }
    };
    const payloads: EventPayloadPort = {
        load: async (): Promise<JsonValue> => ({ input: { value: 7 } })
    };
    return new SourceEventProtocol(
        sourceActor,
        harness.persistence,
        trustPort,
        payloads,
        new SourceRoutes(),
        new RetentionPort(),
        new AuditPort(),
        new SequenceIds()
    );
}

class SourceRoutes implements SourceRoutePort<ProtocolState> {
    public async prepare(input: RouteMaterialPreparation): Promise<PreparedRouteMaterial> {
        const projected = content(`prepared-${input.reservation.value}`);
        return {
            targetActor,
            tenants: { kind: "same", tenant },
            content: projected.ref,
            digest: projected.digest,
            retention: retentionFixture({
                id: `retention-${input.reservation.value}`,
                recordKind: "routeReservation",
                recordId: input.reservation.value,
                content: projected
            }),
            evidence: "source-authority"
        };
    }

    public authorize(_transaction: ProtocolState, subscription: Subscription): SourceRouteDecision {
        return {
            kind: "accepted",
            targetActor,
            tenants: { kind: "same", tenant },
            operation: subscription.target
        };
    }
}

class RetentionPort implements ContentRetentionPort<ProtocolState> {
    public verify(): boolean {
        return true;
    }
    public release(): void {}
    public discard(): void {}
}

class AuditPort implements InteractionAuditPort<ProtocolState> {
    public appendEvent(state: ProtocolState): void {
        state.audit.push("event");
    }
    public appendReservation(state: ProtocolState): void {
        state.audit.push("reservation");
    }
    public appendProjectionRoot(state: ProtocolState): void {
        state.audit.push("projection-root");
    }
    public appendDelivery(state: ProtocolState): void {
        state.audit.push("delivery");
    }
}

class SequenceIds implements InteractionIdPort {
    #next = 0;
    public reservation(): RouteReservationId {
        return new RouteReservationId(this.id("reservation"));
    }
    public projection(): RouteProjectionId {
        return new RouteProjectionId(this.id("projection"));
    }
    public invocation(): InvocationId {
        return new InvocationId(this.id("invocation"));
    }
    public eventAudit(): AuditRecordId {
        return new AuditRecordId(this.id("audit-event"));
    }
    public reservationAudit(): AuditRecordId {
        return new AuditRecordId(this.id("audit-reservation"));
    }
    public projectionAudit(): AuditRecordId {
        return new AuditRecordId(this.id("audit-projection"));
    }
    public deliveryAudit(): AuditRecordId {
        return new AuditRecordId(this.id("audit-delivery"));
    }
    public logicalDelivery(): string {
        return this.id("logical-delivery");
    }
    private id(kind: string): string {
        this.#next += 1;
        return `${kind}-${this.#next}`;
    }
}

function commandInvokedDraft(eventId: string): EventDraft {
    const payload = content(`command-input-${eventId}`);
    const id = new EventId(eventId);
    return {
        id,
        scope,
        sourceActor,
        source: { kind: "facet", facet: new FacetPackageId(COMMAND_ID) },
        kind: new EventKind("command.invoked"),
        payload: payload.ref,
        payloadDigest: payload.digest,
        payloadRetention: retentionFixture({
            id: `retention-command-${eventId}`,
            recordKind: "event",
            recordId: id.value,
            content: payload
        }),
        idempotencyKey: `command-key-${eventId}`,
        correlation: new CorrelationId(`command-correlation-${eventId}`),
        provenance: new EventProvenance({
            verification: EventVerification.verified(),
            principal,
            claims: { source: "command" }
        }),
        visibility: "workspace"
    };
}

function authenticate(draft: EventDraft): AuthenticatedEventIntent {
    const authenticator = new SignatureIntentAuthenticator();
    return authenticator.authenticate(draft, authenticator.evidence(draft));
}

class SignatureIntentAuthenticator extends EventIntentAuthenticator {
    public evidence(intent: EventDraft): Uint8Array {
        return signature(eventIntentBytes(intent));
    }
    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        const expected = signature(message);
        return expected.length === evidence.length && expected.every((b, i) => b === evidence[i]);
    }
}

function signature(message: Uint8Array): Uint8Array {
    return new TextEncoder().encode(Digest.sha256(message).value);
}
