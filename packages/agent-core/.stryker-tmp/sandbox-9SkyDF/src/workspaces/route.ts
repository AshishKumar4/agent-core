// @ts-nocheck
import { ActorRef } from "../actors";
import { AgentCoreError } from "../errors";
import {
    ContentRef,
    Digest,
    RecordCodec,
    encodeBase64,
    encodeCanonicalJson,
    type JsonValue,
    type RecordVersion
} from "../core";
import { BindingName, OperationRef, type TrustTier } from "../facets";
import { PrincipalRef, TenantId } from "../identity";
import {
    AuditRecordId,
    EventId,
    InvocationId,
    RouteProjectionId,
    RouteReservationId,
    SubscriptionId
} from "../interaction-references";
import {
    decodeActor,
    decodeContent,
    decodeOptionalPrincipalRef,
    encodeActor,
    encodeContent,
    encodeOptionalPrincipalRef,
    requireFields,
    requireNullableString,
    requireObject,
    requireString
} from "./codec";
import type { RouteAuthority, TenantRelation } from "./value";

export interface RouteReservationInit {
    readonly id: RouteReservationId;
    readonly invocation: InvocationId;
    readonly event: EventId;
    readonly sourceAuditCause: AuditRecordId;
    readonly sourceActor: ActorRef;
    readonly targetActor: ActorRef;
    readonly tenants: TenantRelation;
    readonly subscription: SubscriptionId;
    readonly dedupeKey: string;
    readonly operation: OperationRef;
    readonly authority: RouteAuthority;
    readonly projection: RouteProjectionId;
    readonly projectionRef: ContentRef;
    readonly projectionDigest: Digest;
    readonly trust: TrustTier;
    readonly initiator?: PrincipalRef;
}

class RouteReservationCodecV1 extends RecordCodec<RouteReservation> {
    public constructor() {
        super("workspace.route-reservation", { major: 1, minor: 0 });
    }

    protected encodePayload(route: RouteReservation): JsonValue {
        return {
            id: route.id.value,
            invocation: route.invocation.value,
            event: route.event.value,
            sourceAuditCause: route.sourceAuditCause.value,
            sourceActor: encodeActor(route.sourceActor),
            targetActor: encodeActor(route.targetActor),
            tenants: encodeTenants(route.tenants),
            subscription: route.subscription.value,
            dedupeKey: route.dedupeKey,
            operation: route.operation.value,
            authority: encodeAuthority(route.authority),
            projection: route.projection.value,
            projectionContent: encodeContent(route.projectionRef, route.projectionDigest),
            trust: route.trust,
            initiator: encodeOptionalPrincipalRef(route.initiator)
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): RouteReservation {
        const object = requireObject(payload, "Route reservation payload");
        requireFields(
            object,
            [
                "authority",
                "dedupeKey",
                "event",
                "id",
                "initiator",
                "invocation",
                "operation",
                "projection",
                "projectionContent",
                "sourceActor",
                "sourceAuditCause",
                "subscription",
                "targetActor",
                "tenants",
                "trust"
            ],
            "Route reservation payload"
        );
        const projection = decodeContent(object["projectionContent"]!, "Route projection content");
        const initiator = decodeOptionalPrincipalRef(object["initiator"], "Route initiator");
        return new RouteReservation({
            id: new RouteReservationId(requireString(object["id"], "Route reservation ID")),
            invocation: new InvocationId(
                requireString(object["invocation"], "Route invocation ID")
            ),
            event: new EventId(requireString(object["event"], "Route Event ID")),
            sourceAuditCause: new AuditRecordId(
                requireString(object["sourceAuditCause"], "Route source audit cause")
            ),
            sourceActor: decodeActor(object["sourceActor"]!, "Route source Actor"),
            targetActor: decodeActor(object["targetActor"]!, "Route target Actor"),
            tenants: decodeTenants(object["tenants"]!),
            subscription: new SubscriptionId(
                requireString(object["subscription"], "Route Subscription ID")
            ),
            dedupeKey: requireString(object["dedupeKey"], "Route dedupe key"),
            operation: new OperationRef(requireString(object["operation"], "Route operation")),
            authority: decodeAuthority(object["authority"]!),
            projection: new RouteProjectionId(
                requireString(object["projection"], "Route projection ID")
            ),
            projectionRef: projection.ref,
            projectionDigest: projection.digest,
            trust: decodeTrust(object["trust"]),
            ...(initiator === undefined ? {} : { initiator })
        });
    }
}

export class RouteReservation {
    public static readonly codec: RecordCodec<RouteReservation> = new RouteReservationCodecV1();

    public static encode(reservation: RouteReservation): Uint8Array {
        return RouteReservation.codec.encode(reservation);
    }

    public static decode(bytes: Uint8Array): RouteReservation {
        return RouteReservation.codec.decode(bytes);
    }

    public readonly init: RouteReservationInit;

    public constructor(init: RouteReservationInit) {
        if (!init.projectionRef.digest.equals(init.projectionDigest)) {
            throw new TypeError("Route projection reference and digest must match");
        }
        if (init.dedupeKey.length === 0 || init.dedupeKey.trim() !== init.dedupeKey) {
            throw new TypeError("Route dedupe key must be a nonblank canonical string");
        }
        if (init.authority.kind === "initiator" && init.initiator === undefined) {
            throw new TypeError("Initiator routes require an authenticated Principal");
        }
        if (
            init.initiator !== undefined &&
            !init.initiator.tenantId.equals(sourceTenant(init.tenants))
        ) {
            throw new TypeError("Route initiator Tenant must match the source Tenant");
        }
        this.init = copyReservationInit(init);
        Object.freeze(this);
    }

    public get id(): RouteReservationId {
        return this.init.id;
    }
    public get invocation(): InvocationId {
        return this.init.invocation;
    }
    public get event(): EventId {
        return this.init.event;
    }
    public get sourceAuditCause(): AuditRecordId {
        return this.init.sourceAuditCause;
    }
    public get sourceActor(): ActorRef {
        return this.init.sourceActor;
    }
    public get targetActor(): ActorRef {
        return this.init.targetActor;
    }
    public get tenants(): TenantRelation {
        return this.init.tenants;
    }
    public get subscription(): SubscriptionId {
        return this.init.subscription;
    }
    public get dedupeKey(): string {
        return this.init.dedupeKey;
    }
    public get operation(): OperationRef {
        return this.init.operation;
    }
    public get authority(): RouteAuthority {
        return this.init.authority;
    }
    public get projection(): RouteProjectionId {
        return this.init.projection;
    }
    public get projectionRef(): ContentRef {
        return this.init.projectionRef;
    }
    public get projectionDigest(): Digest {
        return this.init.projectionDigest;
    }
    public get trust(): TrustTier {
        return this.init.trust;
    }
    public get initiator(): PrincipalRef | undefined {
        return this.init.initiator;
    }
}

export interface RouteProjectionInit {
    readonly id: RouteProjectionId;
    readonly reservation: RouteReservationId;
    readonly content: ContentRef;
    readonly digest: Digest;
    readonly authenticationDigest?: Digest;
}

class RouteProjectionCodecV1 extends RecordCodec<RouteProjection> {
    public constructor() {
        super("workspace.route-projection", { major: 1, minor: 0 });
    }

    protected encodePayload(projection: RouteProjection): JsonValue {
        return {
            id: projection.id.value,
            reservation: projection.reservation.value,
            content: encodeContent(projection.content, projection.digest),
            authenticated: projection.authenticated,
            authenticationDigest: projection.authenticationDigest?.value ?? null
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): RouteProjection {
        const object = requireObject(payload, "Route projection payload");
        requireFields(
            object,
            ["authenticated", "authenticationDigest", "content", "id", "reservation"],
            "Route projection payload"
        );
        const content = decodeContent(object["content"]!, "Route projection content");
        const authenticated = object["authenticated"];
        if (typeof authenticated !== "boolean") {
            throw new TypeError("Route projection authentication marker is invalid");
        }
        const authenticationDigest = requireNullableString(
            object["authenticationDigest"],
            "Route projection authentication digest"
        );
        if (authenticated !== (authenticationDigest !== undefined)) {
            throw new TypeError("Route projection authentication evidence is inconsistent");
        }
        return new RouteProjection({
            id: new RouteProjectionId(requireString(object["id"], "Route projection ID")),
            reservation: new RouteReservationId(
                requireString(object["reservation"], "Projection reservation ID")
            ),
            content: content.ref,
            digest: content.digest,
            ...(authenticationDigest === undefined
                ? {}
                : { authenticationDigest: new Digest(authenticationDigest) })
        });
    }
}

export class RouteProjection {
    public static readonly codec: RecordCodec<RouteProjection> = new RouteProjectionCodecV1();

    public static encode(projection: RouteProjection): Uint8Array {
        return RouteProjection.codec.encode(projection);
    }

    public static decode(bytes: Uint8Array): RouteProjection {
        return RouteProjection.codec.decode(bytes);
    }

    public readonly init: RouteProjectionInit;

    public constructor(init: RouteProjectionInit) {
        if (!init.content.digest.equals(init.digest)) {
            throw new TypeError("Projection content reference and digest must match");
        }
        this.init = Object.freeze({ ...init });
        Object.freeze(this);
    }

    public get id(): RouteProjectionId {
        return this.init.id;
    }
    public get reservation(): RouteReservationId {
        return this.init.reservation;
    }
    public get content(): ContentRef {
        return this.init.content;
    }
    public get digest(): Digest {
        return this.init.digest;
    }
    public get authenticationDigest(): Digest | undefined {
        return this.init.authenticationDigest;
    }
    public get authenticated(): boolean {
        return this.authenticationDigest !== undefined;
    }

    public authenticate(digest: Digest): RouteProjection {
        if (this.authenticationDigest !== undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Route projection is already authenticated"
            );
        }
        return new RouteProjection({ ...this.init, authenticationDigest: digest });
    }
}

export abstract class RouteDeliveryState {
    public static delivered(): RouteDeliveryState {
        return deliveredRoute;
    }

    public static rejected(reason: string): RouteDeliveryState {
        return new RejectedRouteDelivery(reason);
    }

    public abstract readonly kind: "delivered" | "rejected";
    public abstract readonly reason: string | undefined;

    public equals(other: RouteDeliveryState): boolean {
        return this.kind === other.kind && this.reason === other.reason;
    }
}

class DeliveredRouteDelivery extends RouteDeliveryState {
    public readonly kind = "delivered" as const;
    public readonly reason = undefined;
}

class RejectedRouteDelivery extends RouteDeliveryState {
    public readonly kind = "rejected" as const;

    public constructor(public readonly reason: string) {
        super();
        if (reason.length === 0 || reason.trim() !== reason) {
            throw new TypeError("Route rejection reason must be canonical");
        }
        Object.freeze(this);
    }
}

const deliveredRoute = Object.freeze(new DeliveredRouteDelivery());

export interface RouteDeliveryInit {
    readonly reservation: RouteReservationId;
    readonly state: RouteDeliveryState;
    readonly targetAudit: AuditRecordId;
}

class RouteDeliveryCodecV1 extends RecordCodec<RouteDelivery> {
    public constructor() {
        super("workspace.route-delivery", { major: 1, minor: 0 });
    }

    protected encodePayload(delivery: RouteDelivery): JsonValue {
        return {
            reservation: delivery.reservation.value,
            outcome: delivery.state.kind,
            targetAudit: delivery.targetAudit.value,
            reason: delivery.state.reason ?? null
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): RouteDelivery {
        const object = requireObject(payload, "Route delivery payload");
        requireFields(
            object,
            ["outcome", "reason", "reservation", "targetAudit"],
            "Route delivery payload"
        );
        const outcome = object["outcome"];
        if (outcome !== "delivered" && outcome !== "rejected") {
            throw new TypeError("Route delivery outcome is invalid");
        }
        const reason = requireNullableString(object["reason"], "Route delivery reason");
        if ((outcome === "delivered") !== (reason === undefined)) {
            throw new TypeError("Route delivery reason does not match its terminal outcome");
        }
        return new RouteDelivery({
            reservation: new RouteReservationId(
                requireString(object["reservation"], "Delivery reservation ID")
            ),
            state:
                outcome === "delivered"
                    ? RouteDeliveryState.delivered()
                    : RouteDeliveryState.rejected(reason!),
            targetAudit: new AuditRecordId(
                requireString(object["targetAudit"], "Delivery target audit")
            )
        });
    }
}

export class RouteDelivery {
    public static readonly codec: RecordCodec<RouteDelivery> = new RouteDeliveryCodecV1();

    public static encode(delivery: RouteDelivery): Uint8Array {
        return RouteDelivery.codec.encode(delivery);
    }

    public static decode(bytes: Uint8Array): RouteDelivery {
        return RouteDelivery.codec.decode(bytes);
    }

    public readonly reservation: RouteReservationId;
    public readonly state: RouteDeliveryState;
    public readonly targetAudit: AuditRecordId;

    public constructor(init: RouteDeliveryInit) {
        this.reservation = init.reservation;
        this.state =
            init.state.kind === "delivered"
                ? RouteDeliveryState.delivered()
                : RouteDeliveryState.rejected(init.state.reason!);
        this.targetAudit = init.targetAudit;
        Object.freeze(this);
    }
}

export interface RouteProjectionEnvelope {
    readonly reservation: RouteReservation;
    readonly projection: RouteProjection;
}

export class AuthenticatedRouteProjection {
    public readonly envelope: RouteProjectionEnvelope;

    public constructor(token: typeof authenticationToken, envelope: RouteProjectionEnvelope) {
        if (token !== authenticationToken) {
            throw new TypeError("Authenticated projection construction is host-only");
        }
        this.envelope = envelope;
        this.digest = Digest.sha256(routeProjectionEnvelopeBytes(envelope));
        authenticatedProjectionInstances.add(this);
        Object.freeze(this);
    }

    public readonly digest: Digest;
}

const authenticationToken: unique symbol = Symbol("authenticated-route-projection");
const authenticatedProjectionInstances = new WeakSet<AuthenticatedRouteProjection>();

export function requireAuthenticatedRouteProjection(
    value: AuthenticatedRouteProjection
): asserts value is AuthenticatedRouteProjection {
    if (
        !(value instanceof AuthenticatedRouteProjection) ||
        !authenticatedProjectionInstances.has(value)
    ) {
        throw new AgentCoreError("authority.denied", "Route projection lacks host authentication");
    }
}

export abstract class RouteProjectionAuthenticator {
    public authenticate(
        input: RouteProjectionEnvelope,
        evidence: Uint8Array
    ): AuthenticatedRouteProjection {
        const envelope = detachProjectionEnvelope(input);
        validateProjectionEnvelope(envelope);
        if (envelope.projection.authenticated) {
            throw new AgentCoreError(
                "authority.denied",
                "Source projection cannot assert target authentication"
            );
        }
        const bytes = encodeProjectionEnvelope(envelope);
        if (!this.verify(bytes.slice(), evidence.slice())) {
            throw new AgentCoreError("authority.denied", "Route projection authentication failed");
        }
        return new AuthenticatedRouteProjection(authenticationToken, envelope);
    }

    protected abstract verify(message: Uint8Array, evidence: Uint8Array): boolean;
}

function copyReservationInit(init: RouteReservationInit): RouteReservationInit {
    const tenants: TenantRelation =
        init.tenants.kind === "same"
            ? Object.freeze({ kind: init.tenants.kind, tenant: init.tenants.tenant })
            : Object.freeze({
                  kind: init.tenants.kind,
                  source: init.tenants.source,
                  target: init.tenants.target,
                  authority: init.tenants.authority
              });
    const authority: RouteAuthority = Object.freeze({
        kind: init.authority.kind,
        binding: init.authority.binding
    });
    return Object.freeze({ ...init, tenants, authority });
}

export function routeProjectionEnvelopeBytes(envelope: RouteProjectionEnvelope): Uint8Array {
    return encodeProjectionEnvelope(detachProjectionEnvelope(envelope));
}

function encodeProjectionEnvelope(envelope: RouteProjectionEnvelope): Uint8Array {
    validateProjectionEnvelope(envelope);
    return encodeCanonicalJson({
        domain: "agent-core.route-projection.v1",
        reservation: encodeBase64(RouteReservation.codec.encode(envelope.reservation)),
        projection: encodeBase64(RouteProjection.codec.encode(envelope.projection))
    });
}

function detachProjectionEnvelope(input: RouteProjectionEnvelope): RouteProjectionEnvelope {
    const reservationValue = input.reservation;
    const projectionValue = input.projection;
    const reservation = RouteReservation.decode(RouteReservation.encode(reservationValue));
    const projection = RouteProjection.decode(RouteProjection.encode(projectionValue));
    return Object.freeze({ reservation, projection });
}

function validateProjectionEnvelope(envelope: RouteProjectionEnvelope): void {
    if (
        !envelope.projection.id.equals(envelope.reservation.projection) ||
        !envelope.projection.reservation.equals(envelope.reservation.id) ||
        !envelope.projection.content.equals(envelope.reservation.projectionRef) ||
        !envelope.projection.digest.equals(envelope.reservation.projectionDigest)
    ) {
        throw new TypeError("Projection does not match its source reservation");
    }
}

function encodeAuthority(authority: RouteAuthority): JsonValue {
    return { kind: authority.kind, binding: authority.binding.value };
}

function decodeAuthority(value: JsonValue): RouteAuthority {
    const object = requireObject(value, "Route authority");
    requireFields(object, ["binding", "kind"], "Route authority");
    const kind = object["kind"];
    if (kind !== "initiator" && kind !== "delegated") {
        throw new TypeError("Route authority kind is invalid");
    }
    return {
        kind,
        binding: new BindingName(requireString(object["binding"], "Route binding"))
    };
}

function encodeTenants(relation: TenantRelation): JsonValue {
    return relation.kind === "same"
        ? { kind: relation.kind, tenant: relation.tenant.value }
        : {
              kind: relation.kind,
              source: relation.source.value,
              target: relation.target.value,
              authority: relation.authority.value
          };
}

function decodeTenants(value: JsonValue): TenantRelation {
    const object = requireObject(value, "Route tenant relation");
    if (object["kind"] === "same") {
        requireFields(object, ["kind", "tenant"], "Same-tenant relation");
        return {
            kind: "same",
            tenant: new TenantId(requireString(object["tenant"], "Route tenant"))
        };
    }
    if (object["kind"] === "cross") {
        requireFields(object, ["authority", "kind", "source", "target"], "Cross-tenant relation");
        return {
            kind: "cross",
            source: new TenantId(requireString(object["source"], "Route source tenant")),
            target: new TenantId(requireString(object["target"], "Route target tenant")),
            authority: new BindingName(requireString(object["authority"], "Cross-tenant authority"))
        };
    }
    throw new TypeError("Route tenant relation kind is invalid");
}

function sourceTenant(relation: TenantRelation): TenantId {
    return relation.kind === "same" ? relation.tenant : relation.source;
}

function decodeTrust(value: JsonValue | undefined): TrustTier {
    if (
        value === "owner" ||
        value === "authenticated" ||
        value === "external" ||
        value === "self"
    ) {
        return value;
    }
    throw new TypeError("Route trust is invalid");
}
