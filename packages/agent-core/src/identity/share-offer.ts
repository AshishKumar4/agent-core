import { canonicalTupleKey, Digest, RecordCodec, Revision, TextId, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import {
    requireIdentityArray,
    requireIdentityFields,
    requireIdentityObject,
    requireIdentityRevision,
    requireIdentityString
} from "./codec";
import type { GuestVerification } from "./guest-verification";
import {
    MembershipId,
    PrincipalId,
    ProjectId,
    RoleName,
    ShareOfferId,
    TeamId,
    TenantId,
    WorkspaceId
} from "./id";
import { Membership } from "./member";
import { PrincipalRef } from "./principal-ref";
import { ScopeRef, decodeScopeRef, encodeScopeRef } from "./scope";
import {
    GuestVerificationScheme,
    decodeSubjectRef,
    encodeSubjectRef,
    requireSubjectTenant,
    type ForeignPrincipalRef,
    type PrincipalSubjectRef,
    type SubjectRef
} from "./subject";

/**
 * Recorded redemptions live inside the offer record, so the bound that limits them also
 * bounds the record. An unbounded offer would be the ambient bearer artifact §3.3 refuses.
 */
const MAX_SHARE_OFFER_BOUND = 1024;

export type ShareOfferState = "open" | "revoked";

/**
 * Why a redemption was refused. A bearer redemption path must not collapse these into one
 * fact: a caller has to tell "you were too late" from "this was taken away from you", and an
 * exhausted bound from a secret that never matched. The closed `AgentCoreErrorCode` union
 * stays untouched — the denial is `authority.denied` and this narrows it, exactly as
 * `InvocationError` narrows `invocation.invalid`.
 */
export type ShareOfferRefusal =
    "bound-reached" | "expired" | "not-yet-open" | "revoked" | "secret-mismatch" | "team-subject";

export class ShareOfferRedemptionDenied extends AgentCoreError {
    public constructor(
        public readonly refusal: ShareOfferRefusal,
        message: string
    ) {
        super("authority.denied", message);
        this.name = "ShareOfferRedemptionDenied";
    }
}

function shareOfferDenied(refusal: ShareOfferRefusal, message: string): ShareOfferRedemptionDenied {
    return new ShareOfferRedemptionDenied(refusal, message);
}

/** The subject a bearer artifact can be held by: a Principal, never a Team. */
export type ShareOfferHolder = PrincipalSubjectRef | ForeignPrincipalRef;

abstract class ShareOfferLifecycle {
    public abstract readonly state: ShareOfferState;
    public abstract revoke(): ShareOfferLifecycle;
    public abstract requireIssuable(): void;

    public static from(state: ShareOfferState): ShareOfferLifecycle {
        return state === "open" ? openShareOffer : revokedShareOffer;
    }
}

class OpenShareOfferLifecycle extends ShareOfferLifecycle {
    public readonly state = "open" as const;
    public revoke(): ShareOfferLifecycle {
        return revokedShareOffer;
    }
    public requireIssuable(): void {}
}

class RevokedShareOfferLifecycle extends ShareOfferLifecycle {
    public readonly state = "revoked" as const;
    public revoke(): ShareOfferLifecycle {
        return this;
    }
    public requireIssuable(): void {
        throw shareOfferDenied("revoked", "A revoked share offer issues no Membership");
    }
}

const openShareOffer = Object.freeze(new OpenShareOfferLifecycle());
const revokedShareOffer = Object.freeze(new RevokedShareOfferLifecycle());

/**
 * Identifies the holder a redemption is keyed on. Canonical tuple encoding preserves every
 * component boundary, including identifiers containing NUL. A foreign holder's
 * `verifiedVia` is deliberately excluded: re-verification changes evidence, not identity.
 */
export function shareOfferHolderKey(holder: ShareOfferHolder): string {
    return holder.kind === "principal"
        ? canonicalTupleKey("agent-core.share-offer-holder.v1", [
              "principal",
              holder.principal.tenantId.value,
              holder.principal.principalId.value
          ])
        : canonicalTupleKey("agent-core.share-offer-holder.v1", [
              "foreign",
              holder.homeTenant.value,
              holder.principalId.value
          ]);
}

/** One recorded redemption: which holder redeemed, which Membership it minted, and when. */
export class ShareOfferRedemption {
    public readonly subject: ShareOfferHolder;
    public readonly holderKey: string;
    readonly #redeemedAt: number;

    public constructor(
        subject: SubjectRef,
        public readonly membership: MembershipId,
        redeemedAt: Date
    ) {
        this.subject = requireShareOfferHolder(subject);
        this.holderKey = shareOfferHolderKey(this.subject);
        this.#redeemedAt = validShareOfferTime(redeemedAt, "Share offer redemption time");
        Object.freeze(this);
    }

    public get redeemedAt(): Date {
        return new Date(this.#redeemedAt);
    }

    public toData(): JsonValue {
        return {
            membership: this.membership.value,
            redeemedAt: this.#redeemedAt,
            subject: encodeSubjectRef(this.subject)
        };
    }

    public static fromData(value: JsonValue): ShareOfferRedemption {
        const object = requireIdentityObject(value, "Share offer redemption");
        requireIdentityFields(
            object,
            ["membership", "redeemedAt", "subject"],
            "Share offer redemption"
        );
        return new ShareOfferRedemption(
            decodeSubjectRef(object["subject"]),
            new MembershipId(requireIdentityString(object["membership"], "Redeemed Membership ID")),
            requireShareOfferDate(object["redeemedAt"], "Share offer redemption time")
        );
    }
}

export interface ShareOfferRedemptionRequest {
    /** The bearer secret the holder presents; only its digest is durable. */
    readonly secret: Uint8Array;
    readonly subject: SubjectRef;
    /** The Membership id a first redemption commits to. */
    readonly membership: MembershipId;
    readonly now: Date;
    /** Required for a foreign holder and refused for a local one, exactly as §3.3 fixes. */
    readonly guestVerification?: GuestVerification;
}

/**
 * A redemption either issues the offer's one Membership for a holder or replays the
 * redemption already recorded for that holder. A replay names the recorded Membership and
 * mints nothing: that Membership may since have been revised or revoked, and the offer is not
 * the record that answers for it.
 */
export abstract class ShareOfferRedemptionOutcome {
    public abstract readonly offer: ShareOffer;
    public abstract readonly membershipId: MembershipId;
    public abstract readonly membership: Membership | undefined;
    public abstract readonly isReplay: boolean;

    public static issued(offer: ShareOffer, membership: Membership): ShareOfferRedemptionOutcome {
        return Object.freeze(new IssuedShareOfferRedemption(offer, membership));
    }

    public static replayed(
        offer: ShareOffer,
        recorded: ShareOfferRedemption
    ): ShareOfferRedemptionOutcome {
        return Object.freeze(new ReplayedShareOfferRedemption(offer, recorded));
    }
}

class IssuedShareOfferRedemption extends ShareOfferRedemptionOutcome {
    public readonly isReplay = false as const;

    public constructor(
        public readonly offer: ShareOffer,
        public readonly membership: Membership
    ) {
        super();
    }

    public get membershipId(): MembershipId {
        return this.membership.id;
    }
}

class ReplayedShareOfferRedemption extends ShareOfferRedemptionOutcome {
    public readonly isReplay = true as const;
    public readonly membership = undefined;
    public readonly membershipId: MembershipId;

    public constructor(
        public readonly offer: ShareOffer,
        recorded: ShareOfferRedemption
    ) {
        super();
        this.membershipId = recorded.membership;
    }
}

class ShareOfferRecordCodec extends RecordCodec<ShareOffer> {
    public constructor() {
        super(
            [
                ShareOffer,
                ShareOfferRedemption,
                ShareOfferId,
                MembershipId,
                RoleName,
                Digest,
                Revision,
                ShareOfferLifecycle,
                OpenShareOfferLifecycle,
                RevokedShareOfferLifecycle,
                TextId,
                ScopeRef,
                PrincipalRef,
                GuestVerificationScheme,
                TenantId,
                WorkspaceId,
                ProjectId,
                PrincipalId,
                TeamId
            ],
            "identity.share-offer",
            { major: 2, minor: 0 }
        );
    }

    protected encodePayload(offer: ShareOffer): JsonValue {
        return {
            bound: offer.bound,
            createdAt: offer.createdAt.getTime(),
            expiresAt: offer.expiresAt.getTime(),
            id: offer.id.value,
            redemptions: offer.redemptions.map((redemption) => redemption.toData()),
            revision: offer.revision.value,
            role: offer.role.value,
            roleDigest: offer.roleDigest.value,
            scope: encodeScopeRef(offer.scope),
            secretDigest: offer.secretDigest.value,
            state: offer.state
        };
    }

    protected decodePayload(payload: JsonValue): ShareOffer {
        const object = requireIdentityObject(payload, "Share offer payload");
        requireIdentityFields(
            object,
            [
                "bound",
                "createdAt",
                "expiresAt",
                "id",
                "redemptions",
                "revision",
                "role",
                "roleDigest",
                "scope",
                "secretDigest",
                "state"
            ],
            "Share offer payload"
        );
        return new ShareOffer(
            new ShareOfferId(requireIdentityString(object["id"], "Share offer ID")),
            decodeScopeRef(object["scope"]),
            new RoleName(requireIdentityString(object["role"], "Share offer role")),
            new Digest(requireIdentityString(object["roleDigest"], "Share offer Role digest")),
            new Digest(requireIdentityString(object["secretDigest"], "Share offer secret digest")),
            requireShareOfferDate(object["createdAt"], "Share offer creation time"),
            requireShareOfferDate(object["expiresAt"], "Share offer expiry"),
            requireShareOfferBound(object["bound"]),
            requireIdentityArray(object["redemptions"], "Share offer redemptions").map(
                ShareOfferRedemption.fromData
            ),
            requireShareOfferState(object["state"]),
            requireIdentityRevision(object["revision"], "Share offer revision")
        );
    }
}

/**
 * A **ShareOffer** is a bearer artifact created before its subject is known — the record
 * behind handing someone a link. It is deferred Membership issuance and never a second
 * authority path: it carries no capability, no Grant and no lineage, and until a redemption is
 * recorded it confers nothing at all.
 */
export class ShareOffer {
    public static get codec(): RecordCodec<ShareOffer> {
        return shareOfferCodecInstance;
    }
    public readonly bound: number;
    public readonly redemptions: readonly ShareOfferRedemption[];
    readonly #lifecycle: ShareOfferLifecycle;
    readonly #createdAt: number;
    readonly #expiresAt: number;

    public constructor(
        public readonly id: ShareOfferId,
        public readonly scope: ScopeRef,
        public readonly role: RoleName,
        public readonly roleDigest: Digest,
        public readonly secretDigest: Digest,
        createdAt: Date,
        expiresAt: Date,
        bound: number,
        redemptions: readonly ShareOfferRedemption[],
        state: ShareOfferState,
        public readonly revision: Revision
    ) {
        if (roleDigest.constructor !== Digest) {
            throw new TypeError("Share offer requires an exact Role content Digest");
        }
        if (secretDigest.constructor !== Digest) {
            throw new TypeError("Share offer requires an exact bearer secret Digest");
        }
        this.#lifecycle = ShareOfferLifecycle.from(requireShareOfferState(state));
        this.#createdAt = validShareOfferTime(createdAt, "Share offer creation time");
        this.#expiresAt = validShareOfferTime(expiresAt, "Share offer expiry");
        if (this.#expiresAt <= this.#createdAt) {
            throw new TypeError("Share offer must expire after it is created");
        }
        this.bound = requireShareOfferBound(bound);
        this.redemptions = canonicalRedemptions(
            redemptions,
            scope,
            this.bound,
            this.#createdAt,
            this.#expiresAt
        );
        Object.freeze(this);
    }

    public static encode(offer: ShareOffer): Uint8Array {
        return ShareOffer.codec.encode(offer);
    }

    public static decode(bytes: Uint8Array): ShareOffer {
        return ShareOffer.codec.decode(bytes);
    }

    public get state(): ShareOfferState {
        return this.#lifecycle.state;
    }

    public get isOpen(): boolean {
        return this.#lifecycle.state === "open";
    }

    public get isExhausted(): boolean {
        return this.redemptions.length >= this.bound;
    }

    public get createdAt(): Date {
        return new Date(this.#createdAt);
    }

    public get expiresAt(): Date {
        return new Date(this.#expiresAt);
    }

    /**
     * Revocation stops every not-yet-recorded redemption. It never retracts a Membership a
     * recorded redemption already minted — that Membership is revoked as a Membership, on the
     * one enforcement plane, which is why nothing surviving a redemption is ambient (§3.4).
     */
    public revoke(): ShareOffer {
        return this.transition(this.#lifecycle.revoke(), this.redemptions);
    }

    /**
     * `undefined` answers exactly one question — this holder has not redeemed — so the
     * parameter is a `ShareOfferHolder` rather than a `SubjectRef`: a Team cannot be asked at
     * all, instead of being answered with the same value as an unredeemed holder. A caller
     * that defeats the type is refused rather than silently told "not redeemed".
     */
    public recordedFor(holder: ShareOfferHolder): ShareOfferRedemption | undefined {
        const key = shareOfferHolderKey(requireShareOfferHolder(holder));
        return this.redemptions.find((redemption) => redemption.holderKey === key);
    }

    /**
     * Fail-closed order is load-bearing. The presented secret is checked first, so a wrong
     * secret learns nothing about the offer's state. A recorded holder then replays, ahead of
     * the lifecycle, window and bound checks, because a duplicate delivery of an
     * already-committed redemption mints nothing and must not be answered by minting a second
     * Membership. Only issuance is gated on the offer being open, unexpired and unexhausted.
     */
    public redeem(request: ShareOfferRedemptionRequest): ShareOfferRedemptionOutcome {
        const secret = requireBearerSecret(request.secret);
        const now = validShareOfferTime(request.now, "Share offer redemption time");
        const subject = shareOfferHolder(request.subject);
        if (subject === undefined) {
            throw shareOfferDenied(
                "team-subject",
                "A share offer is redeemed by a Principal holder, never by a Team"
            );
        }
        if (!Digest.sha256(secret).equals(this.secretDigest)) {
            throw shareOfferDenied(
                "secret-mismatch",
                "Share offer bearer secret does not match its record"
            );
        }
        const recorded = this.recordedFor(subject);
        if (recorded !== undefined) {
            return ShareOfferRedemptionOutcome.replayed(this, recorded);
        }
        this.#lifecycle.requireIssuable();
        if (now < this.#createdAt) {
            throw shareOfferDenied(
                "not-yet-open",
                "Share offer is presented before it was created"
            );
        }
        if (now >= this.#expiresAt) {
            throw shareOfferDenied("expired", "Share offer expired before this redemption");
        }
        if (this.isExhausted) {
            throw shareOfferDenied("bound-reached", "Share offer has reached its redemption bound");
        }
        const membership = new Membership(
            request.membership,
            this.scope,
            subject,
            this.role,
            "active",
            new Revision(0),
            request.guestVerification
        );
        return ShareOfferRedemptionOutcome.issued(
            this.transition(this.#lifecycle, [
                ...this.redemptions,
                new ShareOfferRedemption(subject, membership.id, new Date(now))
            ]),
            membership
        );
    }

    /**
     * What a store may accept over a stored offer. The offer's terms — Scope, Role, exact
     * Role content digest, bearer secret digest, window and bound — are immutable, revision
     * advances exactly once, a revoked offer is terminal, and recorded redemptions are
     * append-only and immutable: changing any prior redemption field would rewrite the
     * evidence of the Membership it minted, which §3.3 forbids.
     */
    public assertCanReplace(next: ShareOffer): void {
        if (
            !this.id.equals(next.id) ||
            !this.scope.equals(next.scope) ||
            !this.role.equals(next.role) ||
            !this.roleDigest.equals(next.roleDigest) ||
            !this.secretDigest.equals(next.secretDigest) ||
            this.#createdAt !== next.#createdAt ||
            this.#expiresAt !== next.#expiresAt ||
            this.bound !== next.bound ||
            next.revision.value !== this.revision.value + 1
        ) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Share offer terms are immutable and updates require the next revision"
            );
        }
        if (!this.isOpen) {
            throw new AgentCoreError("protocol.invalid-state", "Revoked share offers are terminal");
        }
        if (
            next.redemptions.length < this.redemptions.length ||
            this.redemptions.some((recorded, index) => {
                const successor = next.redemptions[index];
                return successor === undefined || !sameRedemption(recorded, successor);
            })
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Share offer redemptions are append-only"
            );
        }
    }

    private transition(
        lifecycle: ShareOfferLifecycle,
        redemptions: readonly ShareOfferRedemption[]
    ): ShareOffer {
        if (this.revision.value === Number.MAX_SAFE_INTEGER) {
            throw new AgentCoreError("protocol.invalid-state", "Share offer revision is exhausted");
        }
        return new ShareOffer(
            this.id,
            this.scope,
            this.role,
            this.roleDigest,
            this.secretDigest,
            this.createdAt,
            this.expiresAt,
            this.bound,
            redemptions,
            lifecycle.state,
            this.revision.next()
        );
    }
}

/**
 * A holder key intentionally leaves a foreign holder's verification scheme out: it decides
 * bearer idempotency, not evidence identity. A successor record must retain the complete
 * redemption instead, including the scheme and the exact redemption instant.
 */
function sameRedemption(left: ShareOfferRedemption, right: ShareOfferRedemption): boolean {
    if (
        !left.membership.equals(right.membership) ||
        left.redeemedAt.getTime() !== right.redeemedAt.getTime()
    ) {
        return false;
    }
    const recorded = left.subject;
    const successor = right.subject;
    if (recorded.kind === "principal") {
        return successor.kind === "principal" && recorded.principal.equals(successor.principal);
    }
    return (
        successor.kind === "foreign" &&
        recorded.homeTenant.equals(successor.homeTenant) &&
        recorded.principalId.equals(successor.principalId) &&
        recorded.verifiedVia.equals(successor.verifiedVia)
    );
}

function canonicalRedemptions(
    values: readonly ShareOfferRedemption[],
    scope: ScopeRef,
    bound: number,
    createdAt: number,
    expiresAt: number
): readonly ShareOfferRedemption[] {
    if (values.length > bound) {
        throw new TypeError("Share offer records more redemptions than its bound admits");
    }
    const holders = new Set<string>();
    const canonical = values.map((value) => {
        if (value.constructor !== ShareOfferRedemption) {
            throw new TypeError("Share offer requires exact ShareOfferRedemption values");
        }
        requireSubjectTenant(value.subject, scope.tenantId, "Share offer redemption");
        const redeemedAt = value.redeemedAt.getTime();
        if (redeemedAt < createdAt || redeemedAt >= expiresAt) {
            throw new TypeError("Share offer redemption falls outside its redemption window");
        }
        if (holders.has(value.holderKey)) {
            throw new TypeError("Share offer records one holder twice");
        }
        holders.add(value.holderKey);
        return new ShareOfferRedemption(value.subject, value.membership, value.redeemedAt);
    });
    return Object.freeze(canonical);
}

/** The holder a subject denotes, or nothing when the subject is a Team and cannot hold one. */
function shareOfferHolder(subject: SubjectRef): ShareOfferHolder | undefined {
    const holder = decodeSubjectRef(encodeSubjectRef(subject));
    return holder.kind === "team" ? undefined : holder;
}

/** A record's own subject is a shape constraint, so a Team here is malformed rather than denied. */
function requireShareOfferHolder(subject: SubjectRef): ShareOfferHolder {
    const holder = shareOfferHolder(subject);
    if (holder === undefined) {
        throw new TypeError("A share offer redemption records a Principal holder, never a Team");
    }
    return holder;
}

function requireBearerSecret(value: Uint8Array): Uint8Array {
    if (!(value instanceof Uint8Array)) {
        throw new TypeError("Share offer redemption requires bearer secret bytes");
    }
    return value;
}

function requireShareOfferState(value: JsonValue | undefined): ShareOfferState {
    if (value === "open" || value === "revoked") {
        return value;
    }
    throw new TypeError("Share offer state is invalid");
}

function requireShareOfferBound(value: JsonValue | number | undefined): number {
    if (!isShareOfferInteger(value) || value < 1 || value > MAX_SHARE_OFFER_BOUND) {
        throw new TypeError(
            `Share offer bound must be an integer between 1 and ${MAX_SHARE_OFFER_BOUND}`
        );
    }
    return value;
}

function requireShareOfferDate(value: JsonValue | undefined, subject: string): Date {
    if (!isShareOfferInteger(value)) {
        throw new TypeError(`${subject} must be a safe integer`);
    }
    return new Date(value);
}

function isShareOfferInteger(value: JsonValue | number | undefined): value is number {
    return typeof value === "number" && Number.isSafeInteger(value);
}

function validShareOfferTime(value: Date, subject: string): number {
    const time = value.getTime();
    if (!Number.isSafeInteger(time) || time < 0) {
        throw new TypeError(`${subject} is invalid`);
    }
    return time;
}

const shareOfferCodecInstance = new ShareOfferRecordCodec();
