import { describe, expect, test } from "vitest";
import { AgentCoreError } from "../../src/errors";
import {
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonObject
} from "../../src/core";
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
import type { ShareOfferHolder, ShareOfferRefusal, ShareOfferState } from "../../src/identity";
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
const roleDigest = Digest.sha256(Uint8Array.of(29, 31, 37));
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
        roleDigest,
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

/** One successor per immutable term, each changing exactly that term and nothing else. */
function driftedTerms(source: ShareOffer): readonly (readonly [string, ShareOffer])[] {
    const successor = (
        term: string,
        override: {
            readonly id?: ShareOfferId;
            readonly scope?: ScopeRef;
            readonly role?: RoleName;
            readonly roleDigest?: Digest;
            readonly secretDigest?: Digest;
            readonly createdAt?: Date;
            readonly expiresAt?: Date;
            readonly bound?: number;
            readonly revision?: Revision;
        }
    ): readonly [string, ShareOffer] => [
        term,
        new ShareOffer(
            override.id ?? source.id,
            override.scope ?? source.scope,
            override.role ?? source.role,
            override.roleDigest ?? source.roleDigest,
            override.secretDigest ?? source.secretDigest,
            override.createdAt ?? source.createdAt,
            override.expiresAt ?? source.expiresAt,
            override.bound ?? source.bound,
            source.redemptions,
            source.state,
            override.revision ?? source.revision.next()
        )
    ];
    return [
        successor("id", { id: new ShareOfferId("offer-drifted") }),
        successor("scope", { scope: ScopeRef.tenant(tenantId) }),
        successor("role", { role: new RoleName("reader") }),
        successor("roleDigest", { roleDigest: Digest.sha256(Uint8Array.of(41)) }),
        successor("secretDigest", { secretDigest: Digest.sha256(Uint8Array.of(1)) }),
        successor("createdAt", { createdAt: new Date(1_100_000) }),
        successor("expiresAt", { expiresAt: new Date(2_100_000) }),
        successor("bound", { bound: source.bound + 1 }),
        successor("revision", { revision: source.revision.next().next() })
    ];
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
            expect(envelope["version"]).toEqual({ major: 2, minor: 0 });
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
                "roleDigest",
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

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] admits only an append-only successor over a stored offer",
        { tags: "p0" },
        () => {
            const open = offer(2);
            const redeemed = redeem(holder, open).offer;

            expect(() => open.assertCanReplace(redeemed)).not.toThrow();
            expect(() => open.assertCanReplace(open.revoke())).not.toThrow();
            // A revoked offer is terminal, so nothing may be written over it.
            expect(() => open.revoke().assertCanReplace(redeemed.revoke())).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Revoked share offers are terminal"
                })
            );
            // Rewinding to the stored offer's own predecessor is a revision conflict.
            expect(() => redeemed.assertCanReplace(offer(2))).toThrow(
                expect.objectContaining({
                    code: "protocol.revision-conflict",
                    message: "Share offer terms are immutable and updates require the next revision"
                })
            );
            // Dropping a recorded redemption would retract the Membership it minted.
            expect(() =>
                redeemed.assertCanReplace(
                    new ShareOffer(
                        redeemed.id,
                        redeemed.scope,
                        redeemed.role,
                        redeemed.roleDigest,
                        redeemed.secretDigest,
                        redeemed.createdAt,
                        redeemed.expiresAt,
                        redeemed.bound,
                        [],
                        "revoked",
                        redeemed.revision.next()
                    )
                )
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Share offer redemptions are append-only"
                })
            );
            for (const [term, drifted] of driftedTerms(redeemed)) {
                expect(() => redeemed.assertCanReplace(drifted), term).toThrow(
                    expect.objectContaining({
                        code: "protocol.revision-conflict",
                        message:
                            "Share offer terms are immutable and updates require the next revision"
                    })
                );
            }
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] preserves prior redemption time and foreign verification evidence exactly",
        { tags: "p0" },
        () => {
            const foreignHolder = SubjectRef.foreign(
                homeTenantId,
                new PrincipalId("holder-foreign"),
                GuestVerificationScheme.token
            );
            const redeemed = redeem(
                foreignHolder,
                offer(2),
                withinWindow,
                secret,
                new MembershipId("membership-foreign")
            ).offer;
            const recorded = redeemed.redemptions[0];
            if (recorded === undefined) throw new TypeError("Expected recorded foreign redemption");

            const successors = [
                [
                    "redeemedAt",
                    new ShareOfferRedemption(
                        foreignHolder,
                        recorded.membership,
                        new Date(recorded.redeemedAt.getTime() + 1)
                    )
                ],
                [
                    "verifiedVia",
                    new ShareOfferRedemption(
                        SubjectRef.foreign(
                            homeTenantId,
                            foreignHolder.principalId,
                            GuestVerificationScheme.callback
                        ),
                        recorded.membership,
                        recorded.redeemedAt
                    )
                ]
            ] as const;

            for (const [field, replacement] of successors) {
                const successor = new ShareOffer(
                    redeemed.id,
                    redeemed.scope,
                    redeemed.role,
                    redeemed.roleDigest,
                    redeemed.secretDigest,
                    redeemed.createdAt,
                    redeemed.expiresAt,
                    redeemed.bound,
                    [replacement],
                    redeemed.state,
                    redeemed.revision.next()
                );

                expect(() => redeemed.assertCanReplace(successor), field).toThrow(
                    expect.objectContaining({
                        code: "protocol.invalid-state",
                        message: "Share offer redemptions are append-only"
                    })
                );
            }
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
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] holder identity is injective across component boundaries",
        { tags: "p0" },
        () => {
            const left = SubjectRef.principal(
                new PrincipalRef(new TenantId("a"), new PrincipalId("b\u0000c"))
            );
            const right = SubjectRef.principal(
                new PrincipalRef(new TenantId("a\u0000b"), new PrincipalId("c"))
            );

            expect(shareOfferHolderKey(left)).not.toBe(shareOfferHolderKey(right));
            expect(
                decodeCanonicalJson(new TextEncoder().encode(shareOfferHolderKey(left)))
            ).toEqual(["agent-core.share-offer-holder.v1", "principal", "a", "b\u0000c"]);
            expect(
                decodeCanonicalJson(new TextEncoder().encode(shareOfferHolderKey(right)))
            ).toEqual(["agent-core.share-offer-holder.v1", "principal", "a\u0000b", "c"]);
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
                        roleDigest,
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
                        roleDigest,
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
                        roleDigest,
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

/**
 * Values that are structurally everything the record expects while not being the class it
 * names. A bearer artifact's fields decide authority on their own, so a look-alike has to be
 * refused rather than read as the real thing.
 */
class ForgedDigest extends Digest {}
class ForgedRedemption extends ShareOfferRedemption {}

interface ShareOfferOverrides {
    readonly roleDigest?: Digest;
    readonly secretDigest?: Digest;
    readonly createdAt?: Date;
    readonly expiresAt?: Date;
    readonly bound?: number;
    readonly redemptions?: readonly ShareOfferRedemption[];
    readonly state?: ShareOfferState;
    readonly revision?: Revision;
}

function offerWith(overrides: ShareOfferOverrides): ShareOffer {
    return new ShareOffer(
        new ShareOfferId("offer-share"),
        scope,
        editor,
        overrides.roleDigest ?? roleDigest,
        overrides.secretDigest ?? secretDigest,
        overrides.createdAt ?? createdAt,
        overrides.expiresAt ?? expiresAt,
        overrides.bound ?? 1,
        overrides.redemptions ?? [],
        overrides.state ?? "open",
        overrides.revision ?? Revision.initial()
    );
}

/**
 * A holder the record's own type forbids. `recordedFor` and `ShareOfferRedemption` identify
 * holders by class, so a Team standing in the holder position is the case they must refuse
 * rather than answer with whatever an unredeemed Principal is answered with.
 */
function forgedHolder<TActual>(value: TActual): ShareOfferHolder {
    // SAFETY: a Team is not a ShareOfferHolder. The call under test must reject it by class.
    return value as TActual & ShareOfferHolder;
}

/**
 * A presented secret that is not bearer bytes. Redemption compares bytes, so each of the
 * representations a secret is confused with must be refused before any comparison runs.
 */
function forgedSecret<TActual>(value: TActual): Uint8Array {
    // SAFETY: not bearer secret bytes. Redemption must refuse it before it compares anything.
    return value as TActual & Uint8Array;
}

/** An offer's own durable payload, owned by the caller, for corrupting one field of it. */
function offerPayload(source = offer()): JsonObject {
    const envelope = decodeCanonicalJson(ShareOffer.encode(source));
    if (!isJsonObject(envelope)) throw new TypeError("Expected share offer envelope");
    const payload = envelope["payload"];
    if (!isJsonObject(payload)) throw new TypeError("Expected share offer payload");
    return { ...payload };
}

function decodeOfferPayload(payload: JsonObject): ShareOffer {
    return ShareOffer.decode(
        encodeCanonicalJson({
            kind: "identity.share-offer",
            version: { major: 2, minor: 0 },
            payload
        })
    );
}

describe("share offer record integrity", () => {
    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] refuses a bearer digest and a redemption that are not exactly the class the record names",
        { tags: "p0" },
        () => {
            expect(() => offerWith({ secretDigest: new ForgedDigest(secretDigest.value) })).toThrow(
                "Share offer requires an exact bearer secret Digest"
            );
            expect(() =>
                offerWith({
                    redemptions: [new ForgedRedemption(holder, mintedMembership, withinWindow)]
                })
            ).toThrow("Share offer requires exact ShareOfferRedemption values");

            // Both look-alikes carry exactly the values the named classes would, so the refusal
            // is about the constructor and nothing else: the same values, through those classes,
            // are admitted.
            const admitted = offerWith({
                secretDigest: new Digest(secretDigest.value),
                redemptions: [new ShareOfferRedemption(holder, mintedMembership, withinWindow)]
            });
            expect(admitted.secretDigest.value).toBe(secretDigest.value);
            expect(admitted.recordedFor(holder)?.membership.value).toBe(mintedMembership.value);
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] records a redemption only inside the half-open window the offer was presentable in",
        { tags: "p1" },
        () => {
            const at = (time: number): ShareOffer =>
                offerWith({
                    redemptions: [
                        new ShareOfferRedemption(holder, mintedMembership, new Date(time))
                    ]
                });
            const outside = "Share offer redemption falls outside its redemption window";

            expect(() => at(createdAt.getTime() - 1)).toThrow(outside);
            expect(() => at(expiresAt.getTime())).toThrow(outside);
            expect(() => at(expiresAt.getTime() + 1)).toThrow(outside);
            // Both admitted ends, so the bound is the window's own and not one unit inside it.
            expect(at(createdAt.getTime()).redemptions[0]?.redeemedAt).toEqual(createdAt);
            expect(at(expiresAt.getTime() - 1).redemptions[0]?.redeemedAt).toEqual(
                new Date(expiresAt.getTime() - 1)
            );
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] refuses every transition of an offer whose revision is exhausted",
        { tags: "p0" },
        () => {
            const exhausted = offerWith({ revision: new Revision(Number.MAX_SAFE_INTEGER) });
            for (const act of [() => exhausted.revoke(), () => redeem(holder, exhausted)]) {
                expect(act).toThrow(AgentCoreError);
                expect(act).toThrowError(
                    expect.objectContaining({
                        code: "protocol.invalid-state",
                        message: "Share offer revision is exhausted"
                    })
                );
            }
            // The offer refuses ahead of Revision's own ceiling, so the caller is told the offer
            // cannot advance rather than being handed a revision conflict to retry against.
            expect(() => new Revision(Number.MAX_SAFE_INTEGER).next()).toThrowError(
                expect.objectContaining({ code: "protocol.revision-conflict" })
            );
            // Nothing transitioned: the record is still open and still records no redemption.
            expect(exhausted.state).toBe("open");
            expect(exhausted.redemptions).toEqual([]);
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] refuses a Team wherever a record's own holder belongs",
        { tags: "p1" },
        () => {
            const team = SubjectRef.team(new TeamId("team-share"));
            const notAHolder = "A share offer redemption records a Principal holder, never a Team";

            // A caller that defeats `recordedFor`'s holder type is refused rather than answered
            // with the value an unredeemed Principal is answered with.
            expect(() => offer().recordedFor(forgedHolder(team))).toThrow(notAHolder);
            expect(offer().recordedFor(holder)).toBeUndefined();
            expect(() => new ShareOfferRedemption(team, mintedMembership, withinWindow)).toThrow(
                notAHolder
            );
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] refuses a presented secret that is not bytes before it compares anything",
        { tags: "p1" },
        () => {
            const presentable = {
                subject: holder,
                membership: mintedMembership,
                now: withinWindow
            };
            for (const presented of [secretDigest.value, [...secret], undefined, null]) {
                const act = (): ShareOfferRedemptionOutcome =>
                    offer().redeem({ ...presentable, secret: forgedSecret(presented) });
                expect(act).toThrow(TypeError);
                expect(act).toThrow("Share offer redemption requires bearer secret bytes");
                // A malformed presentation is not a refusal: it carries no ShareOfferRefusal, so
                // it can never be reported to a bearer as a secret mismatch.
                expect(act).not.toThrow(ShareOfferRedemptionDenied);
            }
            expect(redeem(holder, offer()).membership?.id.value).toBe(mintedMembership.value);
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] admits exactly the two lifecycle states, in the record and on the wire",
        { tags: "p1" },
        () => {
            for (const state of ["closed", "Open", "", "open "]) {
                // SAFETY: none of these is a ShareOfferState. The record admits exactly two, so
                // every neighbouring string must be refused rather than stored.
                expect(() => offerWith({ state: state as ShareOfferState })).toThrow(
                    "Share offer state is invalid"
                );
            }
            expect(offerWith({ state: "open" }).isOpen).toBe(true);
            expect(offerWith({ state: "revoked" }).isOpen).toBe(false);

            // A stored offer cannot be made to confer anything by rewriting its state to a value
            // the record does not know: the payload is malformed rather than read as one of two.
            expect(() => decodeOfferPayload({ ...offerPayload(), state: "closed" })).toThrowError(
                expect.objectContaining({ code: "codec.invalid" })
            );
            expect(decodeOfferPayload(offerPayload(offer().revoke())).state).toBe("revoked");
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] refuses an unrepresentable instant wherever a share offer records a time",
        { tags: "p1" },
        () => {
            const recorded = redeem(holder, offer(2)).offer.redemptions[0]!.toData();
            if (!isJsonObject(recorded)) throw new TypeError("Expected redemption data");
            expect(ShareOfferRedemption.fromData(recorded).redeemedAt).toEqual(withinWindow);
            for (const redeemedAt of [1.5, "1500000", null, Number.MAX_SAFE_INTEGER + 2]) {
                expect(() => ShareOfferRedemption.fromData({ ...recorded, redeemedAt })).toThrow(
                    "Share offer redemption time must be a safe integer"
                );
            }

            // A Date carries instants no wire integer can, so the same bound is re-derived from
            // the value rather than trusted: unrepresentable and pre-epoch are both invalid.
            expect(() => offerWith({ createdAt: new Date(Number.NaN) })).toThrow(
                "Share offer creation time is invalid"
            );
            expect(() => offerWith({ expiresAt: new Date(8.64e15 + 1) })).toThrow(
                "Share offer expiry is invalid"
            );
            expect(() => offerWith({ createdAt: new Date(-1), expiresAt: new Date(1) })).toThrow(
                "Share offer creation time is invalid"
            );
            expect(
                () => new ShareOfferRedemption(holder, mintedMembership, new Date(Number.NaN))
            ).toThrow("Share offer redemption time is invalid");
        }
    );

    test(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] names the minted Membership through the accessor a replay answers with",
        { tags: "p2" },
        () => {
            const issued = redeem(holder, offer(2));
            expect(issued.isReplay).toBe(false);
            expect(issued.membershipId.value).toBe(mintedMembership.value);
            expect(issued.membershipId.value).toBe(issued.membership?.id.value);

            // The accessor is what a caller reads without branching on isReplay, so issuance and
            // replay must answer it with the one identity — only the minted record differs.
            const replay = redeem(holder, issued.offer);
            expect(replay.membershipId.value).toBe(issued.membershipId.value);
            expect(replay.membership).toBeUndefined();
        }
    );
});
