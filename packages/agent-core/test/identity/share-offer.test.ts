import { describe, expect, test } from "vitest";
import { AgentCoreError } from "../../src/errors";
import { Digest, Revision, decodeCanonicalJson, isJsonObject } from "../../src/core";
import {
    GuestVerificationScheme,
    MembershipId,
    MemoryIdentityRepository,
    PrincipalId,
    ProjectId,
    RoleName,
    ScopeRef,
    ShareOffer,
    ShareOfferId,
    ShareOfferRedemption,
    ShareOfferRedemptionDenied,
    ShareOfferRedemptionOutcome,
    SubjectRef,
    TeamId,
    TenantId,
    WorkspaceId,
    shareOfferHolderKey
} from "../../src/identity";
import type { ShareOfferRefusal } from "../../src/identity";
import { PrincipalRef, mintGuestVerification } from "./internal-fixture";
import { GuestTrustId } from "../../src/identity/id";

const tenantId = new TenantId("tenant-share");
const homeTenantId = new TenantId("tenant-home");
const scope = ScopeRef.workspace(
    tenantId,
    new ProjectId("project-share"),
    new WorkspaceId("workspace-share")
);
const editor = new RoleName("editor");
const secret = Uint8Array.of(7, 11, 13, 17, 19, 23);
const secretDigest = Digest.sha256(secret);
const createdAt = new Date(1_000_000);
const expiresAt = new Date(2_000_000);
const withinWindow = new Date(1_500_000);
const holder = SubjectRef.principal(new PrincipalRef(tenantId, new PrincipalId("holder")));
const otherHolder = SubjectRef.principal(
    new PrincipalRef(tenantId, new PrincipalId("holder-other"))
);
const mintedMembership = new MembershipId("membership-from-offer");

function offer(bound = 1, redemptions: readonly ShareOfferRedemption[] = []): ShareOffer {
    return new ShareOffer(
        new ShareOfferId("offer-share"),
        scope,
        editor,
        secretDigest,
        createdAt,
        expiresAt,
        bound,
        redemptions,
        "open",
        Revision.initial()
    );
}

function redeem(
    subject: SubjectRef,
    source: ShareOffer,
    now: Date = withinWindow,
    presented: Uint8Array = secret,
    membership: MembershipId = mintedMembership
): ShareOfferRedemptionOutcome {
    return source.redeem({ secret: presented, subject, membership, now });
}

function refusalOf(act: () => void): ShareOfferRefusal {
    try {
        act();
    } catch (error) {
        if (error instanceof ShareOfferRedemptionDenied) return error.refusal;
        throw error;
    }
    throw new Error("expected a share offer redemption denial");
}

describe("share offers", () => {
    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] grants nothing before redemption and mints one Membership on it",
        { tags: "p0" },
        () => {
            const open = offer();

            expect(open.isOpen).toBe(true);
            expect(open.isExhausted).toBe(false);
            expect(open.redemptions).toEqual([]);
            expect(open.recordedFor(holder)).toBeUndefined();
            // The offer carries a Role name only: a Role is a template, never authority (§3.3).
            // The exact own-property set is the witness -- absence of one guessed name would
            // hold just as well for a record that carried a Grant under another name.
            expect(Object.getOwnPropertyNames(open).sort()).toEqual([
                "bound",
                "id",
                "redemptions",
                "revision",
                "role",
                "scope",
                "secretDigest"
            ]);
            expect(Object.isFrozen(open)).toBe(true);
            expect(Object.isFrozen(open.redemptions)).toBe(true);

            const outcome = redeem(holder, open);

            expect(outcome.isReplay).toBe(false);
            expect(outcome.membership?.id.value).toBe(mintedMembership.value);
            expect(outcome.membership?.role.value).toBe(editor.value);
            expect(outcome.membership?.state).toBe("active");
            expect(outcome.membership?.revision.value).toBe(0);
            expect(outcome.offer.redemptions).toHaveLength(1);
            expect(outcome.offer.revision.value).toBe(1);
            expect(outcome.offer.isExhausted).toBe(true);
            // The source record is immutable: the offer that granted nothing still grants nothing.
            expect(open.redemptions).toEqual([]);
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] round-trips every redemption through its codec",
        { tags: "p0" },
        () => {
            const redeemed = redeem(holder, offer(2)).offer;
            const bytes = ShareOffer.encode(redeemed);
            const restored = ShareOffer.decode(bytes);

            expect(ShareOffer.encode(restored)).toEqual(bytes);
            expect(restored.id.value).toBe(redeemed.id.value);
            expect(restored.secretDigest.value).toBe(secretDigest.value);
            expect(restored.bound).toBe(2);
            expect(restored.expiresAt.getTime()).toBe(expiresAt.getTime());
            expect(restored.redemptions).toHaveLength(1);
            expect(restored.redemptions[0]?.membership.value).toBe(mintedMembership.value);
            expect(restored.redemptions[0]?.holderKey).toBe(shareOfferHolderKey(holder));

            const envelope = decodeCanonicalJson(bytes);
            if (!isJsonObject(envelope)) throw new TypeError("Expected share offer envelope");
            expect(envelope["kind"]).toBe("identity.share-offer");
            expect(envelope["version"]).toEqual({ major: 1, minor: 0 });
            // Only the digest of the bearer secret is durable, never the secret itself. The
            // exact payload key set is the witness: scanning the bytes for one chosen encoding
            // of the secret would pass for any encoding that is not the one guessed.
            const payload = envelope["payload"];
            if (!isJsonObject(payload)) throw new TypeError("Expected share offer payload");
            expect(Object.keys(payload).sort()).toEqual([
                "bound",
                "createdAt",
                "expiresAt",
                "id",
                "redemptions",
                "revision",
                "role",
                "scope",
                "secretDigest",
                "state"
            ]);
            expect(payload["secretDigest"]).toBe(secretDigest.value);
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] is durable in the identity store it is revoked through",
        { tags: "p0" },
        () => {
            const stored = new MemoryIdentityRepository({
                version: 1,
                records: [
                    {
                        kind: "shareOffer",
                        id: "offer-share",
                        bytes: ShareOffer.encode(offer())
                    }
                ]
            });

            const loaded = stored.loadShareOffer(new ShareOfferId("offer-share"));
            expect(loaded?.isOpen).toBe(true);

            const revoked = new MemoryIdentityRepository({
                version: 1,
                records: [
                    {
                        kind: "shareOffer",
                        id: "offer-share",
                        bytes: ShareOffer.encode(offer().revoke())
                    }
                ]
            }).loadShareOffer(new ShareOfferId("offer-share"))?.isOpen;
            expect(revoked).toBe(false);
            expect(stored.loadShareOffer(new ShareOfferId("absent"))).toBeUndefined();
            expect(
                () =>
                    new MemoryIdentityRepository({
                        version: 1,
                        records: [
                            {
                                kind: "shareOffer",
                                id: "another-offer",
                                bytes: ShareOffer.encode(offer())
                            }
                        ]
                    })
            ).toThrow(AgentCoreError);
        }
    );
});

describe("share offer adversarial redemption", () => {
    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] refuses a wrong bearer secret before revealing any offer state",
        { tags: "p0" },
        () => {
            const recorded = redeem(holder, offer(2)).offer;
            const wrong = Uint8Array.of(7, 11, 13, 17, 19, 24);

            expect(refusalOf(() => redeem(holder, recorded, withinWindow, wrong))).toBe(
                "secret-mismatch"
            );
            // A wrong secret is refused even where the right one would have replayed, so the
            // refusal cannot distinguish a recorded holder from an unrecorded one.
            expect(refusalOf(() => redeem(otherHolder, recorded, withinWindow, wrong))).toBe(
                "secret-mismatch"
            );
            expect(redeem(holder, recorded).isReplay).toBe(true);
            expect(
                refusalOf(() =>
                    recorded.redeem({
                        secret: Uint8Array.of(),
                        subject: holder,
                        membership: mintedMembership,
                        now: withinWindow
                    })
                )
            ).toBe("secret-mismatch");
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] refuses an expired offer at its exact expiry",
        { tags: "p0" },
        () => {
            const open = offer();

            expect(refusalOf(() => redeem(holder, open, expiresAt))).toBe("expired");
            expect(refusalOf(() => redeem(holder, open, new Date(expiresAt.getTime() + 1)))).toBe(
                "expired"
            );
            expect(refusalOf(() => redeem(holder, open, new Date(createdAt.getTime() - 1)))).toBe(
                "not-yet-open"
            );
            expect(
                redeem(holder, open, new Date(expiresAt.getTime() - 1)).membership?.id.value
            ).toBe(mintedMembership.value);
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] revocation stops redemption and never retracts a minted Membership",
        { tags: "p0" },
        () => {
            const revokedBefore = offer().revoke();
            expect(revokedBefore.isOpen).toBe(false);
            expect(refusalOf(() => redeem(holder, revokedBefore))).toBe("revoked");
            expect(revokedBefore.revoke().state).toBe("revoked");

            const issued = redeem(holder, offer(2));
            const revokedAfter = issued.offer.revoke();
            // Revoking after a redemption stops new holders and leaves the minted Membership
            // to be revoked as a Membership, on the one enforcement plane.
            expect(refusalOf(() => redeem(otherHolder, revokedAfter))).toBe("revoked");
            expect(issued.membership?.state).toBe("active");
            expect(revokedAfter.recordedFor(holder)?.membership.value).toBe(mintedMembership.value);
            expect(redeem(holder, revokedAfter).membershipId.value).toBe(mintedMembership.value);
            expect(redeem(holder, revokedAfter).membership).toBeUndefined();
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] redeems idempotently per holder under at-least-once delivery",
        { tags: "p0" },
        () => {
            const first = redeem(holder, offer(2));
            const duplicate = redeem(holder, first.offer, new Date(1_600_000));

            expect(duplicate.isReplay).toBe(true);
            expect(duplicate.membership).toBeUndefined();
            expect(duplicate.membershipId.value).toBe(mintedMembership.value);
            // A replay consumes no unit of the bound and advances no revision.
            expect(duplicate.offer.redemptions).toHaveLength(1);
            expect(duplicate.offer.revision.value).toBe(first.offer.revision.value);
            // A replay of a different supplied Membership id still names the recorded one.
            expect(
                redeem(
                    holder,
                    first.offer,
                    withinWindow,
                    secret,
                    new MembershipId("second-membership")
                ).membershipId.value
            ).toBe(mintedMembership.value);
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] keys redemption on the holder, not on a guest's verification scheme",
        { tags: "p0" },
        () => {
            const trustId = new GuestTrustId("trust-share");
            const guestPrincipal = new PrincipalRef(homeTenantId, new PrincipalId("guest"));
            const viaToken = SubjectRef.foreign(
                homeTenantId,
                guestPrincipal.principalId,
                GuestVerificationScheme.token
            );
            const viaCallback = SubjectRef.foreign(
                homeTenantId,
                guestPrincipal.principalId,
                GuestVerificationScheme.callback
            );
            const verification = (scheme: GuestVerificationScheme) =>
                mintGuestVerification(
                    guestPrincipal,
                    trustId,
                    Revision.initial(),
                    scheme,
                    Digest.sha256(Uint8Array.of(3)),
                    createdAt,
                    expiresAt
                );

            const issued = offer(1).redeem({
                secret,
                subject: viaToken,
                membership: mintedMembership,
                now: withinWindow,
                guestVerification: verification(GuestVerificationScheme.token)
            });
            expect(issued.membership?.subject.kind).toBe("foreign");
            expect(issued.offer.isExhausted).toBe(true);

            // Re-verifying under another scheme is the same holder, so it replays rather than
            // consuming a second unit of the bound — a deny is not escapable this way either.
            const rescheme = issued.offer.redeem({
                secret,
                subject: viaCallback,
                membership: new MembershipId("second-guest-membership"),
                now: withinWindow,
                guestVerification: verification(GuestVerificationScheme.callback)
            });
            expect(rescheme.isReplay).toBe(true);
            expect(rescheme.membershipId.value).toBe(mintedMembership.value);
            expect(shareOfferHolderKey(viaToken)).toBe(shareOfferHolderKey(viaCallback));
            expect(shareOfferHolderKey(viaToken)).not.toBe(shareOfferHolderKey(holder));
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] refuses an exhausted bound, a Team holder, and an unbounded offer",
        { tags: "p0" },
        () => {
            const exhausted = redeem(holder, offer(1)).offer;
            expect(refusalOf(() => redeem(otherHolder, exhausted))).toBe("bound-reached");

            const team = SubjectRef.team(new TeamId("team-share"));
            expect(
                refusalOf(() =>
                    offer().redeem({
                        secret,
                        subject: team,
                        membership: mintedMembership,
                        now: withinWindow
                    })
                )
            ).toBe("team-subject");

            for (const bound of [0, -1, 1.5, 1025]) {
                expect(() => offer(bound)).toThrow(TypeError);
            }
            expect(
                () =>
                    new ShareOffer(
                        new ShareOfferId("offer-share"),
                        scope,
                        editor,
                        secretDigest,
                        createdAt,
                        createdAt,
                        1,
                        [],
                        "open",
                        Revision.initial()
                    )
            ).toThrow(TypeError);
            expect(
                () =>
                    new ShareOffer(
                        new ShareOfferId("offer-share"),
                        scope,
                        editor,
                        secretDigest,
                        createdAt,
                        expiresAt,
                        1,
                        [
                            new ShareOfferRedemption(holder, mintedMembership, withinWindow),
                            new ShareOfferRedemption(otherHolder, mintedMembership, withinWindow)
                        ],
                        "open",
                        Revision.initial()
                    )
            ).toThrow(TypeError);
            expect(
                () =>
                    new ShareOffer(
                        new ShareOfferId("offer-share"),
                        scope,
                        editor,
                        secretDigest,
                        createdAt,
                        expiresAt,
                        2,
                        [
                            new ShareOfferRedemption(holder, mintedMembership, withinWindow),
                            new ShareOfferRedemption(holder, mintedMembership, withinWindow)
                        ],
                        "open",
                        Revision.initial()
                    )
            ).toThrow(TypeError);
        }
    );
});
