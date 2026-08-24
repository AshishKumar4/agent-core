import { ActorId, ActorRef } from "../../src/actors";
import { TurnId } from "../../src/agents";
import { GrantId } from "../../src/authority";
import { RunId } from "../../src/execution-references";
import {
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SemVer,
    isJsonObject,
    type JsonValue
} from "../../src/core";
import {
    DeploymentId,
    ManagedOrigin,
    PackageId,
    PackageInstallationProvenancePort,
    PackagePin,
    type AuthenticatedPackageInstallation
} from "../../src/definition";
import {
    BindingName,
    ContributionAttribution,
    EventKind,
    EventPattern,
    FacetPackageId,
    FacetRef,
    FieldMove,
    OperationRef,
    PayloadMapping,
    SurfaceId,
    type DedupePolicy,
    type TrustTier
} from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    TenantId,
    WorkspaceId as IdentityWorkspaceId
} from "../../src/identity";
import {
    AuditRecordId,
    CorrelationId,
    InvocationId,
    RouteProjectionId,
    RouteReservationId
} from "../../src/interaction-references";
import { requireString } from "../../src/workspaces/codec";
import {
    CoherenceFinding,
    CoherenceVerdict,
    type CoherenceFindingIdentity,
    type CrossRunObservation,
    type ObservedIntent
} from "../../src/workspaces/coherence";
import { Event, type EventInit } from "../../src/workspaces/event";
import {
    ActionId,
    CoherenceFindingId,
    ContentRetentionId,
    EventCursor,
    InboxReferenceId,
    RetainedRecordRef
} from "../../src/workspaces/id";
import {
    EventId,
    SubscriptionId,
    WorkspacePersistence,
    WorkspaceSubscriptionMaterializer,
    type SubscriptionMaterializationInit
} from "../../src/workspaces";
import { InboxEventReference } from "../../src/workspaces/inbox";
import { ContentRetentionReference, RetainedRecordKind } from "../../src/workspaces/retention";
import {
    AuthenticatedRouteProjection,
    RouteDelivery,
    RouteDeliveryState,
    RouteProjection,
    RouteProjectionAuthenticator,
    RouteReservation,
    routeProjectionEnvelopeBytes
} from "../../src/workspaces/route";
import { Subscription, type SubscriptionInit } from "../../src/workspaces/subscription";
import { EventProvenance, EventVerification } from "../../src/workspaces/value";
import { ActionDescriptor, View, ViewDelta } from "../../src/workspaces/view";

const encoder = new TextEncoder();

export const tenant = new TenantId("tenant-test");
export const principalId = new PrincipalId("principal-test");
export const principal = new PrincipalRef(tenant, principalId);
export const sourceActor = new ActorRef("workspace", new ActorId("workspace-source"));
export const targetActor = new ActorRef("workspace", new ActorId("workspace-target"));
export const scope = ScopeRef.workspace(tenant, new IdentityWorkspaceId("workspace-scope"));

export type ContentFixture = {
    readonly ref: ContentRef;
    readonly digest: Digest;
};

export function content(label: string): ContentFixture {
    const digest = Digest.sha256(encoder.encode(label));
    return { digest, ref: ContentRef.fromDigest(digest) };
}

export function eventFixture(
    suffix = "default",
    init: {
        readonly causation?: EventId;
        readonly kind?: string;
        readonly source?: "actor" | "facet";
        readonly trust?: TrustTier;
    } = {}
): Event {
    const payload = content(`event-payload-${suffix}`);
    const trust = init.trust ?? "authenticated";
    const provenance = new EventProvenance({
        verification: trust === "self" ? EventVerification.host() : EventVerification.verified(),
        principal,
        channel: "test-channel",
        claims: { nested: { accepted: true }, roles: ["operator"] }
    });
    const base: EventInit = {
        id: new EventId(`event-${suffix}`),
        scope,
        source:
            init.source === "actor"
                ? { kind: "actor", actor: sourceActor }
                : { kind: "facet", facet: new FacetPackageId("facet.test") },
        kind: new EventKind(init.kind ?? "task.created"),
        payload: payload.ref,
        payloadDigest: payload.digest,
        idempotencyKey: `event-key-${suffix}`,
        correlation: new CorrelationId(`correlation-${suffix}`),
        provenance,
        trust,
        visibility: "workspace",
        initiator: principal
    };
    return new Event(
        init.causation === undefined ? base : { ...base, causation: init.causation }
    );
}

export function subscriptionFixture(
    suffix = "default",
    init: {
        readonly dedupe?: DedupePolicy;
        readonly mapping?: PayloadMapping;
        readonly revision?: Revision;
        readonly contribution?: ContributionAttribution;
    } = {}
): Subscription {
    const base: SubscriptionInit = {
        id: new SubscriptionId(`subscription-${suffix}`),
        revision: init.revision ?? Revision.initial(),
        source: new EventPattern("task.*", ["authenticated", "owner", "self"], "facet.*"),
        target: new OperationRef("facet.test:consume"),
        mapping: init.mapping ?? new PayloadMapping([new FieldMove("", { from: "" })]),
        dedupe: init.dedupe ?? "event",
        authority: { kind: "initiator", binding: new BindingName("binding.route") }
    };
    return new Subscription(
        init.contribution === undefined ? base : { ...base, contribution: init.contribution }
    );
}

export function subscriptionMaterializationInit(
    subscription: Subscription
): SubscriptionMaterializationInit {
    return {
        id: subscription.id,
        source: subscription.source,
        target: subscription.target,
        mapping: subscription.mapping,
        dedupe: subscription.dedupe,
        authority: subscription.authority
    };
}

export class TestPackageInstallationProvenance<State> extends PackageInstallationProvenancePort<
    State,
    object
> {
    public constructor(public installation: AuthenticatedPackageInstallation | undefined) {
        super();
    }

    protected authenticatedInstallation(): AuthenticatedPackageInstallation | undefined {
        return this.installation;
    }
}

export function authenticatedInstallationFixture(
    facet = "workspace:subscription",
    packagePin?: PackagePin,
    manifestDigest?: Digest
): AuthenticatedPackageInstallation {
    const digest = Digest.sha256(encoder.encode(`subscription-installation:${facet}`));
    return Object.freeze({
        package:
            packagePin ??
            new PackagePin(
                new PackageId("subscription-package"),
                new SemVer("1.0.0"),
                digest,
                digest
            ),
        packageFacet: new FacetPackageId("subscription.materializer"),
        manifestDigest: manifestDigest ?? digest,
        facet: new FacetRef(facet),
        materialization: new ManagedOrigin({
            tenantId: tenant,
            deploymentId: new DeploymentId(digest.value),
            attestationDigest: digest,
            blueprintDigest: digest,
            packageLockDigest: digest,
            configDigest: digest,
            generation: 1
        })
    });
}

export function contributionAttributionFixture(
    facet = "workspace:subscription"
): ContributionAttribution {
    const installation = authenticatedInstallationFixture(facet);
    return new ContributionAttribution(installation.facet, installation.package);
}

export function materializeAttributedSubscription<Transaction>(
    persistence: WorkspacePersistence<Transaction>,
    transaction: Transaction,
    contribution: ContributionAttribution,
    subscription: Subscription
): Subscription {
    const provenance = new TestPackageInstallationProvenance<Transaction>(
        authenticatedInstallationFixture(contribution.contributor.value, contribution.package)
    );
    const materializer = new WorkspaceSubscriptionMaterializer(persistence, provenance);
    const context = {};
    const prepared = materializer.prepareContribution(transaction, context);
    if (prepared === undefined) {
        throw new TypeError("Authenticated test installation did not prepare a contribution");
    }
    return materializer.materialize(
        transaction,
        context,
        prepared,
        subscriptionMaterializationInit(subscription)
    );
}

export function reservationFixture(
    suffix = "default",
    init: {
        readonly projectionContent?: ReturnType<typeof content>;
        readonly source?: ActorRef;
        readonly target?: ActorRef;
    } = {}
): RouteReservation {
    const projectionContent = init.projectionContent ?? content(`projection-${suffix}`);
    return new RouteReservation({
        id: new RouteReservationId(`reservation-${suffix}`),
        invocation: new InvocationId(`invocation-${suffix}`),
        event: new EventId(`event-${suffix}`),
        sourceAuditCause: new AuditRecordId(`audit-event-${suffix}`),
        sourceActor: init.source ?? sourceActor,
        targetActor: init.target ?? targetActor,
        tenants: { kind: "same", tenant },
        subscription: new SubscriptionId(`subscription-${suffix}`),
        dedupeKey: `event:event-${suffix}`,
        operation: new OperationRef("facet.test:consume"),
        authority: { kind: "initiator", binding: new BindingName("binding.route") },
        projection: new RouteProjectionId(`projection-${suffix}`),
        projectionRef: projectionContent.ref,
        projectionDigest: projectionContent.digest,
        trust: "authenticated",
        initiator: principal
    });
}

export function projectionFixture(reservation: RouteReservation): RouteProjection {
    return new RouteProjection({
        id: reservation.projection,
        reservation: reservation.id,
        content: reservation.projectionRef,
        digest: reservation.projectionDigest
    });
}

class FixtureProjectionAuthenticator extends RouteProjectionAuthenticator {
    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        const expected = new TextEncoder().encode(Digest.sha256(message).value);
        return (
            expected.length === evidence.length &&
            expected.every((byte, index) => byte === evidence[index])
        );
    }
}

export function authenticatedProjectionFixture(
    reservation: RouteReservation
): AuthenticatedRouteProjection {
    const projection = projectionFixture(reservation);
    const envelope = { reservation, projection };
    const evidence = new TextEncoder().encode(
        Digest.sha256(routeProjectionEnvelopeBytes(envelope)).value
    );
    return new FixtureProjectionAuthenticator().authenticate(envelope, evidence);
}

export function deliveryFixture(
    reservation: RouteReservation,
    outcome: "delivered" | "rejected" = "delivered"
): RouteDelivery {
    return new RouteDelivery({
        reservation: reservation.id,
        state:
            outcome === "delivered"
                ? RouteDeliveryState.delivered()
                : RouteDeliveryState.rejected("authority denied"),
        targetAudit: new AuditRecordId(`audit-delivery-${reservation.id.value}`)
    });
}

export function retentionFixture(init: {
    readonly actor?: ActorRef;
    readonly content: ReturnType<typeof content>;
    readonly id: string;
    readonly recordId: string;
    readonly recordKind: RetainedRecordKind["kind"];
}): ContentRetentionReference {
    return new ContentRetentionReference({
        id: new ContentRetentionId(init.id),
        tenant,
        actor: init.actor ?? sourceActor,
        recordKind: retainedKind(init.recordKind),
        record: new RetainedRecordRef(init.recordId),
        content: init.content.ref,
        digest: init.content.digest
    });
}

function retainedKind(kind: RetainedRecordKind["kind"]): RetainedRecordKind {
    if (kind === "event") return RetainedRecordKind.event();
    if (kind === "routeReservation") return RetainedRecordKind.routeReservation();
    if (kind === "routeProjection") return RetainedRecordKind.routeProjection();
    if (kind === "view") return RetainedRecordKind.view();
    return RetainedRecordKind.viewDelta();
}

export function eventRetention(
    event: Event,
    id = `retention-${event.id.value}`
): ContentRetentionReference {
    return retentionFixture({
        id,
        recordKind: "event",
        recordId: event.id.value,
        content: { ref: event.payload, digest: event.payloadDigest }
    });
}

export function reservationRetention(
    reservation: RouteReservation,
    id = `retention-${reservation.id.value}`,
    actor = sourceActor
): ContentRetentionReference {
    return retentionFixture({
        actor,
        id,
        recordKind: "routeReservation",
        recordId: reservation.id.value,
        content: { ref: reservation.projectionRef, digest: reservation.projectionDigest }
    });
}

export function projectionRetention(
    projection: RouteProjection,
    actor = targetActor,
    id = `retention-${projection.id.value}`
): ContentRetentionReference {
    return retentionFixture({
        actor,
        id,
        recordKind: "routeProjection",
        recordId: projection.id.value,
        content: { ref: projection.content, digest: projection.digest }
    });
}

export function inboxFixture(
    suffix = "default",
    sequence = 0,
    leaseEpoch = 4,
    turn = new TurnId("turn-test")
): InboxEventReference {
    return new InboxEventReference({
        id: new InboxReferenceId(`inbox-${suffix}`),
        turn,
        event: new EventId(`event-${suffix}`),
        sequence,
        leaseEpoch
    });
}

export const observedSubjects = Object.freeze([
    new RunId("run-observed-left"),
    new RunId("run-observed-right")
] as const);

export const observationGrant = new GrantId("grant-observe");

export function observedIntentFixture(
    run: RunId,
    argumentsDigest = "a".repeat(64),
    operation = "facet.test:consume"
): ObservedIntent {
    return {
        run,
        event: new EventId(`event-${run.value}`),
        reservation: new RouteReservationId(`reservation-${run.value}`),
        operation: new OperationRef(operation),
        argumentsDigest: new Digest(argumentsDigest)
    };
}

export function coherenceFindingIdentityFixture(suffix = "default"): CoherenceFindingIdentity {
    return {
        id: new CoherenceFindingId(`coherence-${suffix}`),
        observer: principal,
        scope,
        grant: observationGrant,
        subjects: observedSubjects
    };
}

export function coherenceFindingFixture(suffix = "default"): CoherenceFinding {
    return new CoherenceFinding({
        ...coherenceFindingIdentityFixture(suffix),
        verdict: CoherenceVerdict.duplicate,
        witnesses: [
            {
                left: observedIntentFixture(observedSubjects[0]),
                right: observedIntentFixture(observedSubjects[1])
            }
        ]
    });
}

export function crossRunObservationFixture(suffix = "default"): CrossRunObservation {
    return {
        subscription: new SubscriptionId(`subscription-${suffix}`),
        observer: principal,
        subject: observedSubjects[1],
        subjectScope: scope,
        grant: observationGrant
    };
}

export function viewFixture(revision = 0, suffix = "default"): View {
    return new View({
        surface: new SurfaceId(`surface-${suffix}`),
        revision: new Revision(revision),
        body: { count: revision, nested: { enabled: true } },
        actions: [
            new ActionDescriptor({
                id: new ActionId("increment"),
                label: "Increment",
                emits: new EventKind("counter.increment"),
                arguments: new JsonSchema({ type: "object", additionalProperties: false })
            })
        ],
        cursor: new EventCursor(`cursor-${revision}`)
    });
}

export function viewDeltaFixture(view: View, count = view.revision.value + 1): ViewDelta {
    return new ViewDelta({
        surface: view.surface,
        baseRevision: view.revision,
        revision: view.revision.next(),
        patch: [{ op: "replace", path: "/body/count", value: count }],
        cursor: new EventCursor(`cursor-${view.revision.value + 1}`)
    });
}

export class DeterministicJsonPatchEngine {
    public readonly calls: {
        readonly document: JsonValue;
        readonly patch: readonly JsonValue[];
    }[] = [];

    public apply(document: JsonValue, patch: readonly JsonValue[]): JsonValue {
        this.calls.push({ document, patch });
        const result = structuredClone(document);
        for (const operation of patch) {
            if (
                !isJsonObject(operation) ||
                operation["op"] !== "replace" ||
                !("value" in operation)
            ) {
                throw new TypeError("Test JSON Patch engine only supports replace operations");
            }
            const path = requireString(operation["path"], "Test JSON Patch operation path");
            replace(result, path, structuredClone(operation["value"]));
        }
        return result;
    }
}

function replace(document: JsonValue, pointer: string, value: JsonValue): void {
    const tokens = pointer
        .slice(1)
        .split("/")
        .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
    let parent = document;
    for (const token of tokens.slice(0, -1)) {
        if (Array.isArray(parent)) parent = parent[Number(token)]!;
        else if (isJsonObject(parent)) parent = parent[token]!;
        else throw new TypeError("Patch path traverses a scalar");
    }
    const token = tokens.at(-1)!;
    if (Array.isArray(parent)) parent[Number(token)] = value;
    else if (isJsonObject(parent) && Object.hasOwn(parent, token)) {
        // SAFETY: `document` is the structuredClone this engine just took, so it owns every
        // node reached here. JsonValue models JSON as readonly, which is the contract for
        // values the caller still holds; dropping it writes only into the private clone.
        (parent as { [key: string]: JsonValue })[token] = value;
    } else {
        throw new TypeError("Patch replace path does not exist");
    }
}
