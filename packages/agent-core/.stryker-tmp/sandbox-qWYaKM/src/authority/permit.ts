// @ts-nocheck
import { ActorId, ActorRef, type ActorKind } from "../actors";
import { RunId, TurnId, type LeaseToken } from "../agents";
import { Digest, RecordCodec, Revision, type JsonValue, type RecordVersion } from "../core";
import { POLICY_IMPACTS, PackagePin } from "../definition";
import { AgentCoreError } from "../errors";
import { BindingName, FacetRef, OperationRef, type Impact, type ProtectionDomain } from "../facets";
import { PrincipalId, PrincipalRef, TenantId } from "../identity";
import { ClaimWorkerId, ItemClaimId } from "../invocation-references";
import { InvocationId } from "../interaction-references";
import {
    canonicalJsonEqual,
    requireExact,
    requireObject,
    requireSafeInteger,
    requireString,
    type JsonObject
} from "./data";
import { decodeDomain, encodeDomain } from "./binding";
import { PathEpochEvidence } from "./epoch";

const EXPECTATION_FIELDS = Object.freeze([
    "argumentsDigest",
    "authority",
    "binding",
    "claim",
    "claimOwner",
    "facet",
    "impact",
    "intentDigest",
    "invocation",
    "itemIndex",
    "itemKey",
    "lease",
    "operation",
    "package",
    "pathEpochs",
    "principal",
    "reservation",
    "source",
    "target",
    "tenant",
    "issuer",
    "attemptOrdinal"
]);

export interface AuthorityPermitTarget {
    readonly actor: ActorRef;
    readonly fence: number;
    readonly domain: ProtectionDomain;
}

export interface AuthorityPermitBinding {
    readonly name: BindingName;
    readonly generation: Revision;
}

export interface AuthorityPermitReservation {
    readonly run: RunId;
    readonly registryEpoch: number;
    readonly obligation: {
        readonly kind: "invocationItem";
        readonly invocation: InvocationId;
        readonly itemIndex: number;
        readonly itemKey: string;
    };
}

export type AuthorityPermitClaimOwner =
    | { readonly kind: "executor"; readonly token: LeaseToken; readonly worker: ClaimWorkerId }
    | { readonly kind: "system"; readonly actor: ActorRef; readonly worker: ClaimWorkerId };

export type AuthorityPermitSource =
    | {
          readonly kind: "initiator";
          readonly principal: PrincipalRef;
          readonly binding: BindingName;
      }
    | {
          readonly kind: "delegated";
          readonly principal: PrincipalRef;
          readonly binding: BindingName;
      };

export interface AuthorityPermitExpectationInit {
    readonly tenant: TenantId;
    readonly issuer: ActorRef;
    readonly source: ActorRef;
    readonly target: AuthorityPermitTarget;
    readonly principal: PrincipalRef;
    readonly binding: AuthorityPermitBinding;
    readonly facet: FacetRef;
    readonly operation: OperationRef;
    readonly package: PackagePin;
    readonly impact: Impact;
    readonly invocation: InvocationId;
    readonly reservation: AuthorityPermitReservation;
    readonly itemIndex: number;
    readonly attemptOrdinal: number;
    readonly claim: ItemClaimId;
    readonly claimOwner: AuthorityPermitClaimOwner;
    readonly itemKey: string;
    readonly argumentsDigest: Digest;
    readonly intentDigest: Digest;
    readonly pathEpochs: PathEpochEvidence;
    readonly authority: AuthorityPermitSource;
    readonly lease?: LeaseToken | undefined;
}

export class AuthorityPermitExpectation {
    public readonly tenant: TenantId;
    public readonly issuer: ActorRef;
    public readonly source: ActorRef;
    public readonly target: AuthorityPermitTarget;
    public readonly principal: PrincipalRef;
    public readonly binding: AuthorityPermitBinding;
    public readonly facet: FacetRef;
    public readonly operation: OperationRef;
    public readonly package: PackagePin;
    public readonly impact: Impact;
    public readonly invocation: InvocationId;
    public readonly reservation: AuthorityPermitReservation;
    public readonly itemIndex: number;
    public readonly attemptOrdinal: number;
    public readonly claim: ItemClaimId;
    public readonly claimOwner: AuthorityPermitClaimOwner;
    public readonly itemKey: string;
    public readonly argumentsDigest: Digest;
    public readonly intentDigest: Digest;
    public readonly pathEpochs: PathEpochEvidence;
    public readonly authority: AuthorityPermitSource;
    public readonly lease: LeaseToken | undefined;

    public constructor(init: AuthorityPermitExpectationInit) {
        requireIndex(init.target.fence, "Authority permit target fence");
        requireIndex(init.binding.generation.value, "Authority permit Binding generation");
        requireIndex(init.itemIndex, "Authority permit item index");
        requireIndex(init.attemptOrdinal, "Authority permit attempt ordinal");
        requireIndex(init.reservation.registryEpoch, "Authority permit reservation epoch");
        requireNonblank(init.itemKey, "Authority permit item key");
        if (init.issuer.kind !== "tenant") {
            throw new TypeError("Authority permits must be issued by a Tenant Actor");
        }
        if (
            !init.tenant.equals(init.principal.tenantId) ||
            !init.tenant.equals(init.pathEpochs.path[0].scope.tenantId)
        ) {
            throw new TypeError("Authority permit Tenant must qualify its principal and path");
        }
        if (
            !init.authority.principal.equals(init.principal) ||
            !init.authority.binding.equals(init.binding.name)
        ) {
            throw new TypeError("Authority permit source must match its principal and Binding");
        }
        const obligation = init.reservation.obligation;
        if (
            obligation.kind !== "invocationItem" ||
            !obligation.invocation.equals(init.invocation) ||
            obligation.itemIndex !== init.itemIndex ||
            obligation.itemKey !== init.itemKey
        ) {
            throw new TypeError(
                "Authority permit reservation must match its exact invocation item"
            );
        }
        if (init.lease !== undefined && !init.lease.holder.equals(init.principal.principalId)) {
            throw new TypeError("Authority permit lease holder must match its qualified principal");
        }
        if (!POLICY_IMPACTS.includes(init.impact)) {
            throw new TypeError("Authority permit impact is invalid");
        }

        this.tenant = init.tenant;
        this.issuer = copyActor(init.issuer);
        this.source = copyActor(init.source);
        this.target = copyTarget(init.target);
        this.principal = new PrincipalRef(init.principal.tenantId, init.principal.principalId);
        this.binding = Object.freeze({
            name: init.binding.name,
            generation: new Revision(init.binding.generation.value)
        });
        this.facet = init.facet;
        this.operation = init.operation;
        this.package = PackagePin.fromData(init.package.toData());
        this.impact = init.impact;
        this.invocation = init.invocation;
        this.reservation = copyReservation(init.reservation);
        this.itemIndex = init.itemIndex;
        this.attemptOrdinal = init.attemptOrdinal;
        this.claim = init.claim;
        this.claimOwner = copyClaimOwner(init.claimOwner);
        this.itemKey = init.itemKey;
        this.argumentsDigest = init.argumentsDigest;
        this.intentDigest = init.intentDigest;
        this.pathEpochs = PathEpochEvidence.fromData(init.pathEpochs.toData());
        this.authority = copyAuthority(init.authority);
        this.lease = init.lease === undefined ? undefined : copyLease(init.lease);
        Object.freeze(this);
    }

    public equals(other: AuthorityPermitExpectation): boolean {
        return canonicalJsonEqual(this.toData(), other.toData());
    }

    public toData(): JsonObject {
        return {
            argumentsDigest: this.argumentsDigest.value,
            attemptOrdinal: this.attemptOrdinal,
            authority: encodeAuthority(this.authority),
            binding: {
                generation: this.binding.generation.value,
                name: this.binding.name.value
            },
            claim: this.claim.value,
            claimOwner: encodeClaimOwner(this.claimOwner),
            facet: this.facet.value,
            impact: this.impact,
            intentDigest: this.intentDigest.value,
            invocation: this.invocation.value,
            itemIndex: this.itemIndex,
            itemKey: this.itemKey,
            issuer: encodeActor(this.issuer),
            lease: this.lease === undefined ? null : encodeLease(this.lease),
            operation: this.operation.value,
            package: this.package.toData(),
            pathEpochs: this.pathEpochs.toData(),
            principal: encodePrincipal(this.principal),
            reservation: encodeReservation(this.reservation),
            source: encodeActor(this.source),
            target: {
                actor: encodeActor(this.target.actor),
                domain: encodeDomain(this.target.domain),
                fence: this.target.fence
            },
            tenant: this.tenant.value
        };
    }

    public static fromData(value: JsonValue | undefined): AuthorityPermitExpectation {
        const object = requireObject(value, "Authority permit expectation");
        requireExact(object, EXPECTATION_FIELDS, "Authority permit expectation");
        const binding = requireObject(object["binding"], "Authority permit Binding");
        const target = requireObject(object["target"], "Authority permit target");
        requireExact(binding, ["generation", "name"], "Authority permit Binding");
        requireExact(target, ["actor", "domain", "fence"], "Authority permit target");
        const lease = object["lease"];
        return new AuthorityPermitExpectation({
            tenant: new TenantId(requireString(object, "tenant")),
            issuer: decodeActor(object["issuer"]),
            source: decodeActor(object["source"]),
            target: {
                actor: decodeActor(target["actor"]),
                fence: requireSafeInteger(target, "fence"),
                domain: decodeDomain(target["domain"])
            },
            principal: decodePrincipal(object["principal"]),
            binding: {
                name: new BindingName(requireString(binding, "name")),
                generation: new Revision(requireSafeInteger(binding, "generation"))
            },
            facet: new FacetRef(requireString(object, "facet")),
            operation: new OperationRef(requireString(object, "operation")),
            package: PackagePin.fromData(object["package"]!),
            impact: requireImpact(object["impact"]),
            invocation: new InvocationId(requireString(object, "invocation")),
            reservation: decodeReservation(object["reservation"]),
            itemIndex: requireSafeInteger(object, "itemIndex"),
            attemptOrdinal: requireSafeInteger(object, "attemptOrdinal"),
            claim: new ItemClaimId(requireString(object, "claim")),
            claimOwner: decodeClaimOwner(object["claimOwner"]),
            itemKey: requireString(object, "itemKey"),
            argumentsDigest: new Digest(requireString(object, "argumentsDigest")),
            intentDigest: new Digest(requireString(object, "intentDigest")),
            pathEpochs: PathEpochEvidence.fromData(object["pathEpochs"]),
            authority: decodeAuthority(object["authority"]),
            ...(lease === null ? {} : { lease: decodeLease(lease) })
        });
    }
}

export interface AuthorityPermitInit extends AuthorityPermitExpectationInit {
    readonly nonce: string;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
}

class AuthorityPermitCodecV1 extends RecordCodec<AuthorityPermit> {
    public constructor() {
        super("authority.permit", { major: 1, minor: 0 });
    }

    protected encodePayload(permit: AuthorityPermit): JsonValue {
        return permit.toData();
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): AuthorityPermit {
        return AuthorityPermit.fromData(payload);
    }
}

export class AuthorityPermit {
    public static readonly codec: RecordCodec<AuthorityPermit> = new AuthorityPermitCodecV1();
    readonly #issuedAt: number;
    readonly #expiresAt: number;
    public readonly expectation: AuthorityPermitExpectation;
    public readonly nonce: string;

    public constructor(init: AuthorityPermitInit) {
        this.expectation = new AuthorityPermitExpectation(init);
        this.nonce = requireNonblank(init.nonce, "Authority permit nonce");
        this.#issuedAt = validTime(init.issuedAt, "Authority permit issuance time");
        this.#expiresAt = validTime(init.expiresAt, "Authority permit expiry");
        if (this.#expiresAt <= this.#issuedAt) {
            throw new TypeError("Authority permit expiry must be after issuance");
        }
        Object.freeze(this);
    }

    public static encode(permit: AuthorityPermit): Uint8Array {
        return AuthorityPermit.codec.encode(permit);
    }

    public static decode(bytes: Uint8Array): AuthorityPermit {
        return AuthorityPermit.codec.decode(bytes);
    }

    public get tenant(): TenantId {
        return this.expectation.tenant;
    }
    public get issuer(): ActorRef {
        return this.expectation.issuer;
    }
    public get source(): ActorRef {
        return this.expectation.source;
    }
    public get target(): AuthorityPermitTarget {
        return this.expectation.target;
    }
    public get principal(): PrincipalRef {
        return this.expectation.principal;
    }
    public get binding(): AuthorityPermitBinding {
        return this.expectation.binding;
    }
    public get facet(): FacetRef {
        return this.expectation.facet;
    }
    public get operation(): OperationRef {
        return this.expectation.operation;
    }
    public get package(): PackagePin {
        return this.expectation.package;
    }
    public get impact(): Impact {
        return this.expectation.impact;
    }
    public get invocation(): InvocationId {
        return this.expectation.invocation;
    }
    public get reservation(): AuthorityPermitReservation {
        return this.expectation.reservation;
    }
    public get itemIndex(): number {
        return this.expectation.itemIndex;
    }
    public get attemptOrdinal(): number {
        return this.expectation.attemptOrdinal;
    }
    public get claim(): ItemClaimId {
        return this.expectation.claim;
    }
    public get claimOwner(): AuthorityPermitClaimOwner {
        return this.expectation.claimOwner;
    }
    public get itemKey(): string {
        return this.expectation.itemKey;
    }
    public get argumentsDigest(): Digest {
        return this.expectation.argumentsDigest;
    }
    public get intentDigest(): Digest {
        return this.expectation.intentDigest;
    }
    public get pathEpochs(): PathEpochEvidence {
        return this.expectation.pathEpochs;
    }
    public get authority(): AuthorityPermitSource {
        return this.expectation.authority;
    }
    public get lease(): LeaseToken | undefined {
        return this.expectation.lease;
    }
    public get issuedAt(): Date {
        return new Date(this.#issuedAt);
    }
    public get expiresAt(): Date {
        return new Date(this.#expiresAt);
    }

    public digest(): Digest {
        return Digest.sha256(AuthorityPermit.encode(this));
    }

    public assertConsumable(expected: AuthorityPermitExpectation, now: Date): void {
        const time = validTime(now, "Authority permit consumption time");
        if (!this.expectation.equals(expected)) {
            throw denied("Authority permit does not match the exact target admission");
        }
        if (this.#issuedAt > time || time >= this.#expiresAt) {
            throw denied("Authority permit is not valid at the target admission time");
        }
    }

    public toData(): JsonObject {
        return {
            ...this.expectation.toData(),
            expiresAt: this.#expiresAt,
            issuedAt: this.#issuedAt,
            nonce: this.nonce
        };
    }

    public static fromData(value: JsonValue | undefined): AuthorityPermit {
        const object = requireObject(value, "Authority permit");
        requireExact(
            object,
            [...EXPECTATION_FIELDS, "expiresAt", "issuedAt", "nonce"],
            "Authority permit"
        );
        const expectationData = Object.fromEntries(
            EXPECTATION_FIELDS.map((field) => [field, object[field]!])
        ) as JsonObject;
        const expectation = AuthorityPermitExpectation.fromData(expectationData);
        return new AuthorityPermit({
            ...expectation,
            nonce: requireString(object, "nonce"),
            issuedAt: new Date(requireSafeInteger(object, "issuedAt")),
            expiresAt: new Date(requireSafeInteger(object, "expiresAt"))
        });
    }
}

function copyTarget(target: AuthorityPermitTarget): AuthorityPermitTarget {
    return Object.freeze({
        actor: copyActor(target.actor),
        fence: target.fence,
        domain: decodeDomain(encodeDomain(target.domain))
    });
}

function copyReservation(reservation: AuthorityPermitReservation): AuthorityPermitReservation {
    requireNonblank(reservation.obligation.itemKey, "Authority permit reservation item key");
    requireIndex(reservation.obligation.itemIndex, "Authority permit reservation item index");
    return Object.freeze({
        run: reservation.run,
        registryEpoch: reservation.registryEpoch,
        obligation: Object.freeze({
            kind: "invocationItem" as const,
            invocation: reservation.obligation.invocation,
            itemIndex: reservation.obligation.itemIndex,
            itemKey: reservation.obligation.itemKey
        })
    });
}

function encodeReservation(reservation: AuthorityPermitReservation): JsonObject {
    return {
        obligation: {
            invocation: reservation.obligation.invocation.value,
            itemIndex: reservation.obligation.itemIndex,
            itemKey: reservation.obligation.itemKey,
            kind: reservation.obligation.kind
        },
        registryEpoch: reservation.registryEpoch,
        run: reservation.run.value
    };
}

function decodeReservation(value: JsonValue | undefined): AuthorityPermitReservation {
    const object = requireObject(value, "Authority permit reservation");
    const obligation = requireObject(object["obligation"], "Authority permit obligation");
    requireExact(object, ["obligation", "registryEpoch", "run"], "Authority permit reservation");
    requireExact(
        obligation,
        ["invocation", "itemIndex", "itemKey", "kind"],
        "Authority permit obligation"
    );
    if (obligation["kind"] !== "invocationItem") {
        throw new TypeError("Authority permit requires an invocation-item reservation");
    }
    return Object.freeze({
        run: new RunId(requireString(object, "run")),
        registryEpoch: requireSafeInteger(object, "registryEpoch"),
        obligation: Object.freeze({
            kind: "invocationItem" as const,
            invocation: new InvocationId(requireString(obligation, "invocation")),
            itemIndex: requireSafeInteger(obligation, "itemIndex"),
            itemKey: requireString(obligation, "itemKey")
        })
    });
}

function copyClaimOwner(owner: AuthorityPermitClaimOwner): AuthorityPermitClaimOwner {
    return owner.kind === "executor"
        ? Object.freeze({ kind: owner.kind, token: copyLease(owner.token), worker: owner.worker })
        : Object.freeze({ kind: owner.kind, actor: copyActor(owner.actor), worker: owner.worker });
}

function encodeClaimOwner(owner: AuthorityPermitClaimOwner): JsonObject {
    return owner.kind === "executor"
        ? { kind: owner.kind, token: encodeLease(owner.token), worker: owner.worker.value }
        : { actor: encodeActor(owner.actor), kind: owner.kind, worker: owner.worker.value };
}

function decodeClaimOwner(value: JsonValue | undefined): AuthorityPermitClaimOwner {
    const object = requireObject(value, "Authority permit claim owner");
    const kind = requireString(object, "kind");
    if (kind === "executor") {
        requireExact(object, ["kind", "token", "worker"], "Authority permit claim owner");
        return Object.freeze({
            kind,
            token: decodeLease(object["token"]),
            worker: new ClaimWorkerId(requireString(object, "worker"))
        });
    }
    if (kind === "system") {
        requireExact(object, ["actor", "kind", "worker"], "Authority permit claim owner");
        return Object.freeze({
            kind,
            actor: decodeActor(object["actor"]),
            worker: new ClaimWorkerId(requireString(object, "worker"))
        });
    }
    throw new TypeError("Authority permit claim owner kind is invalid");
}

function copyAuthority(authority: AuthorityPermitSource): AuthorityPermitSource {
    return Object.freeze({
        kind: authority.kind,
        principal: new PrincipalRef(authority.principal.tenantId, authority.principal.principalId),
        binding: authority.binding
    });
}

function encodeAuthority(authority: AuthorityPermitSource): JsonObject {
    return {
        binding: authority.binding.value,
        kind: authority.kind,
        principal: encodePrincipal(authority.principal)
    };
}

function decodeAuthority(value: JsonValue | undefined): AuthorityPermitSource {
    const object = requireObject(value, "Authority permit source");
    requireExact(object, ["binding", "kind", "principal"], "Authority permit source");
    const kind = object["kind"];
    if (kind !== "initiator" && kind !== "delegated") {
        throw new TypeError("Authority permit source kind is invalid");
    }
    return Object.freeze({
        kind,
        principal: decodePrincipal(object["principal"]),
        binding: new BindingName(requireString(object, "binding"))
    });
}

function encodePrincipal(principal: PrincipalRef): JsonObject {
    return { principal: principal.principalId.value, tenant: principal.tenantId.value };
}

function decodePrincipal(value: JsonValue | undefined): PrincipalRef {
    const object = requireObject(value, "Authority permit principal");
    requireExact(object, ["principal", "tenant"], "Authority permit principal");
    return new PrincipalRef(
        new TenantId(requireString(object, "tenant")),
        new PrincipalId(requireString(object, "principal"))
    );
}

function copyLease(lease: LeaseToken): LeaseToken {
    requireIndex(lease.epoch, "Authority permit lease epoch");
    return Object.freeze({ turn: lease.turn, holder: lease.holder, epoch: lease.epoch });
}

function encodeLease(lease: LeaseToken): JsonObject {
    return { epoch: lease.epoch, holder: lease.holder.value, turn: lease.turn.value };
}

function decodeLease(value: JsonValue | undefined): LeaseToken {
    const object = requireObject(value, "Authority permit lease");
    requireExact(object, ["epoch", "holder", "turn"], "Authority permit lease");
    return Object.freeze({
        turn: new TurnId(requireString(object, "turn")),
        holder: new PrincipalId(requireString(object, "holder")),
        epoch: requireSafeInteger(object, "epoch")
    });
}

function encodeActor(actor: ActorRef): JsonObject {
    return { id: actor.id.value, kind: actor.kind };
}

function copyActor(actor: ActorRef): ActorRef {
    return new ActorRef(actor.kind, new ActorId(actor.id.value));
}

function decodeActor(value: JsonValue | undefined): ActorRef {
    const object = requireObject(value, "Authority permit Actor");
    requireExact(object, ["id", "kind"], "Authority permit Actor");
    return new ActorRef(requireActorKind(object["kind"]), new ActorId(requireString(object, "id")));
}

function requireActorKind(value: JsonValue | undefined): ActorKind {
    if (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    )
        return value;
    throw new TypeError("Authority permit Actor kind is invalid");
}

function requireImpact(value: JsonValue | undefined): Impact {
    if (typeof value === "string" && POLICY_IMPACTS.includes(value as Impact)) {
        return value as Impact;
    }
    throw new TypeError("Authority permit impact is invalid");
}

function requireIndex(value: number, subject: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
}

function requireNonblank(value: string, subject: string): string {
    if (value.trim().length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
    return value;
}

function validTime(value: Date, subject: string): number {
    const time = value.getTime();
    if (!Number.isSafeInteger(time) || time < 0) {
        throw new TypeError(`${subject} must be a valid non-negative Date`);
    }
    return time;
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}
