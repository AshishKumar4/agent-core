import { describe, expect, it } from "vitest";
import { ActorId } from "../../src/actors";
import {
    AuthorityMutationService,
    Grant,
    MemoryTenantControlStore,
    ScopeEpoch,
    type AuthorityMutationStore,
    type Binding,
    type GrantId
} from "../../src/authority";
import { Digest, Revision } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { CapabilitySpec } from "../../src/facets";
import {
    EDITOR_ROLE,
    GuestVerificationScheme,
    Membership,
    MembershipId,
    OWNER_ROLE,
    Principal,
    PrincipalId,
    Project,
    ProjectId,
    READER_ROLE,
    Role,
    RoleName,
    RoleRule,
    ScopeRef,
    ShareOffer,
    ShareOfferId,
    ShareOfferRedemptionDenied,
    SubjectRef,
    Team,
    TeamId,
    TenantId,
    WorkspaceId,
    type GuestVerification,
    type PrincipalSubjectRef,
    type ShareOfferRedemptionRequest,
    type Workspace as WorkspaceRecord
} from "../../src/identity";
import {
    GuestTrust,
    GuestTrustId,
    PrincipalRef,
    Workspace,
    mintGuestVerification
} from "../identity/internal-fixture";
import { createSqliteTenantControlStore } from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";

const tenantId = new TenantId("tenant-share-offer");
const guestHome = new TenantId("tenant-share-offer-home");
const ownerId = new PrincipalId("principal-owner");
const editorId = new PrincipalId("principal-editor");
const facetAdminId = new PrincipalId("principal-facet-admin");
const holderId = new PrincipalId("principal-holder");
const otherHolderId = new PrincipalId("principal-other-holder");
const teamMemberId = new PrincipalId("principal-team-member");
const guestId = new PrincipalId("principal-guest");
const otherGuestId = new PrincipalId("principal-other-guest");
const teamId = new TeamId("team-share-offer");
const projectId = new ProjectId("project-share-offer");
const workspaceId = new WorkspaceId("workspace-share-offer");
const workspaceScope = ScopeRef.workspace(tenantId, projectId, workspaceId);
const facetAdminRole = new Role(new RoleName("facet-admin"), [
    new RoleRule(
        "allow",
        new CapabilitySpec({ facetPattern: "workspace:*", impacts: ["administer", "observe"] })
    )
]);
const secret = Uint8Array.of(2, 3, 5, 7, 11, 13);
const createdAt = new Date(100);
const expiresAt = new Date(200);
const redeemedAt = new Date(150);
const anchor = {
    actorId: new ActorId("tenant-share-offer-actor"),
    tenantId,
    principalId: ownerId,
    tenantKind: "personal" as const,
    trustAnchor: Uint8Array.of(9, 8, 7)
};

/** A bootstrapped Tenant control store, its mutation service, and the way it is reopened. */
interface ShareOfferHarness {
    readonly store: AuthorityMutationStore;
    readonly service: AuthorityMutationService;
    /** Reopens the same durable state through a fresh store, which is what a restart is. */
    restart(): AuthorityMutationStore;
}

describe.each([
    ["memory", memoryControl],
    ["sqlite", sqliteControl]
] as const)("share offer authority in the %s Tenant control store", (_backing, open) => {
    it(
        "[C13-AUTH-SHARE-OFFER] refuses an issuer whose authority does not cover the offered Scope and Role, and admits one whose does",
        { tags: "p0" },
        () => {
            const harness = seeded(open());
            const denied = expect.objectContaining({
                code: "authority.denied",
                message:
                    "Issuing a share offer requires administer authority covering its Role at its Scope"
            });

            // An editor holds every impact except `administer`, so it cannot issue at all.
            expect(() =>
                harness.service.issueShareOffer(offer("offer-editor"), principal(editorId))
            ).toThrow(denied);
            // A facet-scoped administer holder cannot widen the facet pattern the Role names.
            expect(() =>
                harness.service.issueShareOffer(offer("offer-facet-admin"), principal(facetAdminId))
            ).toThrow(denied);
            expect(harness.store.shareOffers()).toEqual([]);

            // A Team Membership carrying administer issues for every Principal in the Team,
            // exactly as the Binding resolver's effective subjects read a Team.
            expect(
                harness.service.issueShareOffer(offer("offer-team"), principal(teamMemberId)).isOpen
            ).toBe(true);
            const issued = harness.service.issueShareOffer(
                offer("offer-owner"),
                principal(ownerId)
            );

            expect(issued.isOpen).toBe(true);
            expect(harness.store.shareOffer(issued.id)?.role.value).toBe(READER_ROLE.name.value);
            // An offer is not authority: it materializes no Grant and moves no path epoch.
            const grantsBefore = harness.store.grants().length;
            const epochBefore = harness.store.epoch(workspaceScope).epoch;
            harness.service.issueShareOffer(offer("offer-second"), principal(ownerId));
            expect(harness.store.grants()).toHaveLength(grantsBefore);
            expect(harness.store.epoch(workspaceScope).epoch).toBe(epochBefore);
        }
    );

    it(
        "[C13-AUTH-SHARE-OFFER] refuses disabled direct and Team issuers without writing an offer, Grant, or epoch",
        { tags: "p0" },
        () => {
            const harness = seeded(open());
            const teamSubject = SubjectRef.team(teamId);

            expect(() =>
                harness.service.issueShareOffer(offer("offer-team-subject"), teamSubject)
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "A share offer issuer must be a local Principal"
                })
            );

            for (const [kind, issuerId] of [
                ["direct", ownerId],
                ["Team", teamMemberId]
            ] as const) {
                const issuer = principal(issuerId);
                expect(
                    harness.service.issueShareOffer(offer(`offer-${kind}-before-disable`), issuer)
                        .isOpen
                ).toBe(true);

                expect(harness.service.disablePrincipal(issuerId).canAct, kind).toBe(false);
                const before = {
                    epochs: harness.store.epochs().map(ScopeEpoch.encode),
                    grants: harness.store.grants().map(Grant.encode),
                    offers: harness.store.shareOffers().map(ShareOffer.encode)
                };

                expect(() =>
                    harness.service.issueShareOffer(offer(`offer-${kind}-after-disable`), issuer)
                ).toThrow(
                    expect.objectContaining({
                        code: "authority.denied",
                        message: "Disabled Principal cannot issue share offers"
                    })
                );
                expect(harness.store.shareOffers().map(ShareOffer.encode), kind).toEqual(
                    before.offers
                );
                expect(harness.store.grants().map(Grant.encode), kind).toEqual(before.grants);
                expect(harness.store.epochs().map(ScopeEpoch.encode), kind).toEqual(before.epochs);
            }
        }
    );

    it(
        "[C13-AUTH-SHARE-OFFER] refuses redemption after the issued Role content widens",
        { tags: "p0" },
        () => {
            const harness = seeded(open());
            const issued = harness.service.issueShareOffer(
                offer("offer-role-pin", 2, facetAdminRole.name),
                principal(ownerId)
            );
            const widened = new Role(facetAdminRole.name, [
                new RoleRule(
                    "allow",
                    new CapabilitySpec({
                        facetPattern: "*",
                        impacts: ["administer", "externalSend", "observe"]
                    })
                )
            ]);

            expect(issued.roleDigest.equals(Digest.sha256(Role.encode(facetAdminRole)))).toBe(true);
            expect(harness.service.changeRole(widened, redeemedAt).rules).toEqual(widened.rules);
            const before = {
                epochs: harness.store.epochs().map(ScopeEpoch.encode),
                grants: harness.store.grants().map(Grant.encode),
                memberships: harness.store.memberships().map(Membership.encode),
                offers: harness.store.shareOffers().map(ShareOffer.encode)
            };

            expect(() =>
                harness.service.redeemShareOffer(
                    issued.id,
                    redemption(holderId, "membership-role-drift")
                )
            ).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "Share offer Role changed after issuance"
                })
            );
            expect(harness.store.epochs().map(ScopeEpoch.encode)).toEqual(before.epochs);
            expect(harness.store.grants().map(Grant.encode)).toEqual(before.grants);
            expect(harness.store.memberships().map(Membership.encode)).toEqual(before.memberships);
            expect(harness.store.shareOffers().map(ShareOffer.encode)).toEqual(before.offers);
        }
    );

    it(
        "[C13-AUTH-SHARE-OFFER] maps cross-Tenant local issuers and holders to authority denial without writes",
        { tags: "p0" },
        () => {
            const harness = seeded(open());
            const otherTenant = new TenantId("tenant-share-offer-other");
            const foreignLocalIssuer = SubjectRef.principal(new PrincipalRef(otherTenant, ownerId));
            const beforeIssuer = {
                epochs: harness.store.epochs().map(ScopeEpoch.encode),
                grants: harness.store.grants().map(Grant.encode),
                offers: harness.store.shareOffers().map(ShareOffer.encode)
            };

            expect(() =>
                harness.service.issueShareOffer(
                    offer("offer-cross-tenant-issuer"),
                    foreignLocalIssuer
                )
            ).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "Share offer issuer belongs to another Tenant"
                })
            );
            expect(harness.store.epochs().map(ScopeEpoch.encode)).toEqual(beforeIssuer.epochs);
            expect(harness.store.grants().map(Grant.encode)).toEqual(beforeIssuer.grants);
            expect(harness.store.shareOffers().map(ShareOffer.encode)).toEqual(beforeIssuer.offers);

            const issued = harness.service.issueShareOffer(
                offer("offer-cross-tenant-holder", 2),
                principal(ownerId)
            );
            const beforeHolder = {
                epochs: harness.store.epochs().map(ScopeEpoch.encode),
                grants: harness.store.grants().map(Grant.encode),
                memberships: harness.store.memberships().map(Membership.encode),
                offers: harness.store.shareOffers().map(ShareOffer.encode)
            };
            const foreignLocalHolder = SubjectRef.principal(
                new PrincipalRef(otherTenant, holderId)
            );

            expect(() =>
                harness.service.redeemShareOffer(issued.id, {
                    secret,
                    subject: foreignLocalHolder,
                    membership: new MembershipId("membership-cross-tenant-holder"),
                    now: redeemedAt
                })
            ).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "Share offer redemption holder belongs to another Tenant"
                })
            );
            expect(harness.store.epochs().map(ScopeEpoch.encode)).toEqual(beforeHolder.epochs);
            expect(harness.store.grants().map(Grant.encode)).toEqual(beforeHolder.grants);
            expect(harness.store.memberships().map(Membership.encode)).toEqual(
                beforeHolder.memberships
            );
            expect(harness.store.shareOffers().map(ShareOffer.encode)).toEqual(beforeHolder.offers);

            // A ForeignPrincipalRef is the valid cross-Tenant form. The guest test below
            // supplies its verified provenance; this branch must not reclassify it as a
            // malformed local Principal merely because its home Tenant differs.
            expect(
                SubjectRef.foreign(otherTenant, holderId, GuestVerificationScheme.callback).kind
            ).toBe("foreign");
        }
    );
    it(
        "[C13-AUTH-SHARE-OFFER] refuses a duplicate issuance, an unknown issuer or Role, a pre-redeemed record, and a second revocation writes nothing",
        { tags: "p0" },
        () => {
            const harness = seeded(open());
            harness.service.issueShareOffer(offer("offer-guards"), principal(ownerId));

            expect(() =>
                harness.service.issueShareOffer(offer("offer-guards"), principal(ownerId))
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Share offer already exists"
                })
            );
            expect(() =>
                harness.service.issueShareOffer(
                    offer("offer-unknown-issuer"),
                    principal(new PrincipalId("principal-absent"))
                )
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Share offer issuer Principal does not exist"
                })
            );
            expect(() =>
                harness.service.issueShareOffer(
                    offer("offer-unknown-role", 1, new RoleName("role-absent")),
                    principal(ownerId)
                )
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Role does not exist"
                })
            );
            for (const stale of [
                offer("offer-pre-revoked").revoke(),
                offer("offer-pre-redeemed", 2).redeem(redemption(holderId, "membership-pre")).offer
            ]) {
                expect(
                    () => harness.service.issueShareOffer(stale, principal(ownerId)),
                    stale.id.value
                ).toThrow(
                    expect.objectContaining({
                        code: "protocol.invalid-state",
                        message: "New share offers must be open and unredeemed at revision zero"
                    })
                );
            }
            expect(() =>
                harness.service.revokeShareOffer(new ShareOfferId("offer-absent"))
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Share offer does not exist"
                })
            );

            const epochBefore = harness.store.epoch(workspaceScope).epoch;
            const revoked = harness.service.revokeShareOffer(new ShareOfferId("offer-guards"));
            const again = harness.service.revokeShareOffer(new ShareOfferId("offer-guards"));

            expect(revoked.revision.value).toBe(1);
            expect(again.revision.value).toBe(1);
            // Revocation writes only the offer: it is not a resolver input, so no epoch moves.
            expect(harness.store.epoch(workspaceScope).epoch).toBe(epochBefore);
            // A store accepts a byte-identical rewrite of a record it already holds without
            // treating it as a transition, which is what makes an at-least-once write safe.
            harness.store.transaction((candidate) => candidate.putShareOffer(again));
            expect(
                requireOffer(harness.restart().shareOffer(new ShareOfferId("offer-guards")))
                    .revision.value
            ).toBe(1);
        }
    );

    it(
        "[C13-AUTH-SHARE-OFFER] commits a redemption's Membership, redemption record, Role Grants and epoch together, and rolls every one of them back when the last step fails",
        { tags: "p0" },
        () => {
            const harness = seeded(open());
            const faulted = new AuthorityMutationService(new EpochFaultControlStore(harness.store));
            harness.service.issueShareOffer(offer("offer-atomic"), principal(ownerId));
            const before = harness.store.epoch(workspaceScope).epoch;

            expect(() =>
                faulted.redeemShareOffer(
                    new ShareOfferId("offer-atomic"),
                    redemption(holderId, "membership-atomic")
                )
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "injected Scope epoch write fault"
                })
            );

            const afterFailure = harness.restart();
            const rolledBack = requireOffer(
                afterFailure.shareOffer(new ShareOfferId("offer-atomic"))
            );
            expect(afterFailure.membership(new MembershipId("membership-atomic"))).toBeUndefined();
            expect(rolledBack.redemptions).toEqual([]);
            expect(rolledBack.revision.value).toBe(0);
            expect(roleGrantsFor(afterFailure, "membership-atomic")).toEqual([]);
            expect(afterFailure.epoch(workspaceScope).epoch).toBe(before);

            const outcome = harness.service.redeemShareOffer(
                new ShareOfferId("offer-atomic"),
                redemption(holderId, "membership-atomic")
            );

            expect(outcome.isReplay).toBe(false);
            const committed = harness.restart();
            expect(committed.membership(new MembershipId("membership-atomic"))?.isActive).toBe(
                true
            );
            expect(
                requireOffer(committed.shareOffer(new ShareOfferId("offer-atomic"))).redemptions
            ).toHaveLength(1);
            expect(roleGrantsFor(committed, "membership-atomic")).toHaveLength(1);
            expect(committed.epoch(workspaceScope).epoch).toBe(before + 1);
        }
    );

    it(
        "[C13-AUTH-SHARE-OFFER] refuses a redemption after a revocation commits and still replays one recorded before it",
        { tags: "p0" },
        () => {
            const harness = seeded(open());
            harness.service.issueShareOffer(offer("offer-revoked", 2), principal(ownerId));
            const recorded = harness.service.redeemShareOffer(
                new ShareOfferId("offer-revoked"),
                redemption(holderId, "membership-recorded")
            );

            expect(harness.service.revokeShareOffer(new ShareOfferId("offer-revoked")).isOpen).toBe(
                false
            );

            expect(() =>
                harness.service.redeemShareOffer(
                    new ShareOfferId("offer-revoked"),
                    redemption(otherHolderId, "membership-too-late")
                )
            ).toThrow(ShareOfferRedemptionDenied);
            expect(() =>
                harness.service.redeemShareOffer(
                    new ShareOfferId("offer-revoked"),
                    redemption(otherHolderId, "membership-too-late")
                )
            ).toThrow(expect.objectContaining({ refusal: "revoked" }));
            expect(
                harness.store.membership(new MembershipId("membership-too-late"))
            ).toBeUndefined();

            const replay = harness.service.redeemShareOffer(
                new ShareOfferId("offer-revoked"),
                redemption(holderId, "membership-second-attempt")
            );

            expect(replay.isReplay).toBe(true);
            expect(replay.membership).toBeUndefined();
            expect(replay.membershipId.value).toBe(recorded.membershipId.value);
            // Revocation never retracts a Membership a recorded redemption already minted.
            expect(
                harness.store.membership(new MembershipId("membership-recorded"))?.isActive
            ).toBe(true);
            expect(
                harness.store.membership(new MembershipId("membership-second-attempt"))
            ).toBeUndefined();
        }
    );

    it(
        "[C13-AUTH-SHARE-OFFER] answers a second at-least-once delivery across a restart exactly as the first",
        { tags: "p0" },
        () => {
            const harness = seeded(open());
            harness.service.issueShareOffer(offer("offer-replay", 2), principal(ownerId));
            const first = harness.service.redeemShareOffer(
                new ShareOfferId("offer-replay"),
                redemption(holderId, "membership-replay")
            );
            harness.service.revokeShareOffer(new ShareOfferId("offer-replay"));
            const epochAfterFirst = harness.store.epoch(workspaceScope).epoch;

            const restarted = harness.restart();
            const second = new AuthorityMutationService(restarted).redeemShareOffer(
                new ShareOfferId("offer-replay"),
                redemption(holderId, "membership-replay-duplicate")
            );

            expect(second.membershipId.value).toBe(first.membershipId.value);
            expect(second.isReplay).toBe(true);
            // A replay consumes no unit of the bound, advances no revision, and moves no epoch.
            expect(second.offer.redemptions).toHaveLength(1);
            expect(second.offer.revision.value).toBe(
                requireOffer(restarted.shareOffer(new ShareOfferId("offer-replay"))).revision.value
            );
            expect(restarted.epoch(workspaceScope).epoch).toBe(epochAfterFirst);
            expect(
                restarted.membership(new MembershipId("membership-replay-duplicate"))
            ).toBeUndefined();
        }
    );

    it(
        "[C13-AUTH-SHARE-OFFER] [identity.share-offer] keeps an issued and redeemed offer byte-identical across a restart",
        { tags: "p0" },
        () => {
            const harness = seeded(open());
            const issued = harness.service.issueShareOffer(
                offer("offer-durable", 3),
                principal(ownerId)
            );
            expect(
                ShareOffer.encode(
                    requireOffer(harness.restart().shareOffer(new ShareOfferId("offer-durable")))
                )
            ).toEqual(ShareOffer.encode(issued));

            const redeemed = harness.service.redeemShareOffer(
                new ShareOfferId("offer-durable"),
                redemption(holderId, "membership-durable")
            ).offer;
            const reloaded = requireOffer(
                harness.restart().shareOffer(new ShareOfferId("offer-durable"))
            );

            expect(ShareOffer.encode(reloaded)).toEqual(ShareOffer.encode(redeemed));
            expect(reloaded.redemptions[0]?.membership.value).toBe("membership-durable");
            expect(reloaded.secretDigest.value).toBe(Digest.sha256(secret).value);
            expect(reloaded.expiresAt.getTime()).toBe(expiresAt.getTime());
            expect(reloaded.bound).toBe(3);
        }
    );

    it(
        "[C13-AUTH-SHARE-OFFER] mints a guest holder's Membership only against current host-minted verification",
        { tags: "p0" },
        () => {
            const harness = seeded(open());
            const trust = guestTrust();
            harness.service.createGuestTrust(trust);
            harness.service.issueShareOffer(offer("offer-guest", 2), principal(ownerId));
            const guest = SubjectRef.foreign(guestHome, guestId, GuestVerificationScheme.callback);

            expect(() =>
                harness.service.redeemShareOffer(new ShareOfferId("offer-guest"), {
                    secret,
                    subject: guest,
                    membership: new MembershipId("membership-unverified-guest"),
                    now: redeemedAt
                })
            ).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "Guest Memberships require verified provenance"
                })
            );

            const outcome = harness.service.redeemShareOffer(new ShareOfferId("offer-guest"), {
                secret,
                subject: guest,
                membership: new MembershipId("membership-guest"),
                now: redeemedAt,
                guestVerification: guestProof(trust, guestId)
            });

            expect(outcome.membership?.subject.kind).toBe("foreign");
            const restarted = harness.restart();
            expect(restarted.membership(new MembershipId("membership-guest"))?.isActive).toBe(true);
            expect(
                restarted.membership(new MembershipId("membership-unverified-guest"))
            ).toBeUndefined();
            // A revoked host trust stops the next guest holder: the offer is checked against
            // the store's current trust, never against a self-authenticating token.
            harness.service.revokeGuestTrust(trust.id);
            expect(() =>
                harness.service.redeemShareOffer(new ShareOfferId("offer-guest"), {
                    secret,
                    subject: SubjectRef.foreign(
                        guestHome,
                        otherGuestId,
                        GuestVerificationScheme.callback
                    ),
                    membership: new MembershipId("membership-stale-trust"),
                    now: redeemedAt,
                    guestVerification: guestProof(trust, otherGuestId)
                })
            ).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "Guest verification is not currently valid"
                })
            );
            expect(
                harness.restart().membership(new MembershipId("membership-stale-trust"))
            ).toBeUndefined();
        }
    );

    it(
        "[C13-AUTH-SHARE-OFFER] refuses the widest guest issuer, and never widens a foreign issuer through a Team",
        { tags: "p0" },
        () => {
            const harness = seeded(open());
            const trust = guestTrust();
            harness.service.createGuestTrust(trust);
            // The trap, in its sharpest form: a LOCAL Principal whose ID string is the same
            // as the guest's home Principal ID joins the admin Team, which already carries
            // OWNER_ROLE at this Scope. An issuer resolver that read `principalId` without
            // first deciding on the subject's kind would match this guest against that Team's
            // administer Grant and let it issue.
            harness.service.createPrincipal(new Principal(guestId, "user", "active"));
            harness.service.changeTeam(teamId, "Share offer admins", [teamMemberId, guestId]);
            // And the guest holds the widest Membership the guest membrane admits, at the
            // same Scope and under the same Role the local Team admin issues with.
            harness.service.assignGuestMembership(
                new Membership(
                    new MembershipId("membership-widest-guest"),
                    workspaceScope,
                    SubjectRef.foreign(guestHome, guestId, GuestVerificationScheme.callback),
                    OWNER_ROLE.name,
                    "active",
                    Revision.initial()
                ),
                guestProof(trust, guestId),
                createdAt
            );
            const guest = SubjectRef.foreign(guestHome, guestId, GuestVerificationScheme.callback);

            expect(() =>
                harness.service.issueShareOffer(offer("offer-widest-guest"), guest)
            ).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message:
                        "Issuing a share offer requires administer authority covering its Role at its Scope"
                })
            );
            // A narrower Role does not buy the guest a way in either: the refusal is about
            // who is asking, not about how much the offer asks for.
            expect(() =>
                harness.service.issueShareOffer(
                    offer("offer-widest-guest-narrow", 1, EDITOR_ROLE.name),
                    guest
                )
            ).toThrow(expect.objectContaining({ code: "authority.denied" }));
            expect(harness.store.shareOffers()).toEqual([]);
            expect(harness.restart().shareOffers()).toEqual([]);

            // Positive control on the same Team, Scope and Role: the local member issues, so
            // the guest's refusal cannot be blamed on the topology the trap set up.
            expect(
                harness.service.issueShareOffer(offer("offer-local-team"), principal(teamMemberId))
                    .isOpen
            ).toBe(true);
        }
    );
});

function memoryControl(): ShareOfferHarness {
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    return {
        store,
        service: new AuthorityMutationService(store),
        restart: () => MemoryTenantControlStore.restore(store.snapshot())
    };
}

function sqliteControl(): ShareOfferHarness {
    const database = new TestSqlite();
    const store = createSqliteTenantControlStore(database, anchor);
    database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
    return {
        store,
        service: new AuthorityMutationService(store),
        restart: () => createSqliteTenantControlStore(database)
    };
}

/** The Tenant topology and the three issuers whose authority the offers are judged against. */
function seeded(harness: ShareOfferHarness): ShareOfferHarness {
    const { service } = harness;
    service.createProject(new Project(projectId, tenantId, "Share offers", Revision.initial()));
    service.createWorkspace(new Workspace(workspaceId, tenantId, projectId, Revision.initial()));
    service.createRole(facetAdminRole);
    for (const [id, roleName] of [
        [editorId, EDITOR_ROLE.name],
        [facetAdminId, facetAdminRole.name]
    ] as const) {
        service.createPrincipal(new Principal(id, "user", "active"));
        service.assignMembership(
            new Membership(
                new MembershipId(`membership-${id.value}`),
                workspaceScope,
                principal(id),
                roleName,
                "active",
                Revision.initial()
            )
        );
    }
    service.createPrincipal(new Principal(teamMemberId, "user", "active"));
    service.createTeam(
        new Team(teamId, tenantId, "Share offer admins", [teamMemberId], Revision.initial())
    );
    service.assignMembership(
        new Membership(
            new MembershipId("membership-team-admin"),
            workspaceScope,
            SubjectRef.team(teamId),
            OWNER_ROLE.name,
            "active",
            Revision.initial()
        )
    );
    service.createPrincipal(new Principal(holderId, "user", "active"));
    service.createPrincipal(new Principal(otherHolderId, "user", "active"));
    return harness;
}

function offer(
    id: string,
    bound = 1,
    role: RoleName = READER_ROLE.name,
    roleDigest: Digest = digestForRole(role)
): ShareOffer {
    return new ShareOffer(
        new ShareOfferId(id),
        workspaceScope,
        role,
        roleDigest,
        Digest.sha256(secret),
        createdAt,
        expiresAt,
        bound,
        [],
        "open",
        Revision.initial()
    );
}

function digestForRole(name: RoleName): Digest {
    const role = [READER_ROLE, EDITOR_ROLE, OWNER_ROLE, facetAdminRole].find((candidate) =>
        candidate.name.equals(name)
    );
    return role === undefined
        ? Digest.sha256(new TextEncoder().encode(`unknown-role:${name.value}`))
        : Digest.sha256(Role.encode(role));
}
function redemption(holder: PrincipalId, membership: string): ShareOfferRedemptionRequest {
    return {
        secret,
        subject: principal(holder),
        membership: new MembershipId(membership),
        now: redeemedAt
    };
}

function principal(id: PrincipalId): PrincipalSubjectRef {
    return SubjectRef.principal(new PrincipalRef(tenantId, id));
}

function guestTrust(): GuestTrust {
    return new GuestTrust(
        new GuestTrustId("trust-share-offer"),
        tenantId,
        guestHome,
        { kind: "callback", endpoint: "https://share-offer.example/verify" },
        "active",
        Revision.initial()
    );
}

function guestProof(trust: GuestTrust, subject: PrincipalId): GuestVerification {
    return mintGuestVerification(
        new PrincipalRef(guestHome, subject),
        trust.id,
        trust.revision,
        GuestVerificationScheme.callback,
        Digest.sha256(Uint8Array.of(4)),
        createdAt,
        expiresAt
    );
}

function roleGrantsFor(store: AuthorityMutationStore, membership: string): readonly Grant[] {
    return store
        .grants()
        .filter(
            (grant) =>
                grant.origin.kind === "role" && grant.origin.membershipId.value === membership
        );
}

function requireOffer(offer: ShareOffer | undefined): ShareOffer {
    if (offer === undefined) throw new Error("expected a stored share offer");
    return offer;
}

/**
 * The store seam with one injected failure at the last write a redemption performs. Nothing
 * else changes, so what the transaction leaves behind is the only difference between a
 * redemption that commits and one that cannot finish.
 */
class EpochFaultControlStore implements AuthorityMutationStore {
    public constructor(private readonly inner: AuthorityMutationStore) {}

    public get tenantId(): TenantId {
        return this.inner.tenantId;
    }

    public transaction<Result>(operation: (store: AuthorityMutationStore) => Result): Result {
        return this.inner.transaction((candidate) =>
            operation(new EpochFaultControlStore(candidate))
        );
    }

    public putEpoch(_epoch: ScopeEpoch): void {
        throw new AgentCoreError("protocol.invalid-state", "injected Scope epoch write fault");
    }

    public principal(id: PrincipalId): Principal | undefined {
        return this.inner.principal(id);
    }

    public putPrincipal(record: Principal): void {
        this.inner.putPrincipal(record);
    }

    public team(id: TeamId): Team | undefined {
        return this.inner.team(id);
    }

    public teams(): readonly Team[] {
        return this.inner.teams();
    }

    public putTeam(record: Team): void {
        this.inner.putTeam(record);
    }

    public project(id: ProjectId): Project | undefined {
        return this.inner.project(id);
    }

    public projects(): readonly Project[] {
        return this.inner.projects();
    }

    public putProject(record: Project): void {
        this.inner.putProject(record);
    }

    public workspace(id: WorkspaceId): WorkspaceRecord | undefined {
        return this.inner.workspace(id);
    }

    public workspaces(): readonly WorkspaceRecord[] {
        return this.inner.workspaces();
    }

    public putWorkspace(record: WorkspaceRecord): void {
        this.inner.putWorkspace(record);
    }

    public guestTrust(id: GuestTrustId): GuestTrust | undefined {
        return this.inner.guestTrust(id);
    }

    public guestTrusts(): readonly GuestTrust[] {
        return this.inner.guestTrusts();
    }

    public putGuestTrust(record: GuestTrust): void {
        this.inner.putGuestTrust(record);
    }

    public role(name: RoleName): Role | undefined {
        return this.inner.role(name);
    }

    public putRole(record: Role): void {
        this.inner.putRole(record);
    }

    public membership(id: MembershipId): Membership | undefined {
        return this.inner.membership(id);
    }

    public memberships(): readonly Membership[] {
        return this.inner.memberships();
    }

    public putMembership(record: Membership): void {
        this.inner.putMembership(record);
    }

    public grant(id: GrantId): Grant | undefined {
        return this.inner.grant(id);
    }

    public grants(): readonly Grant[] {
        return this.inner.grants();
    }

    public putGrant(record: Grant): void {
        this.inner.putGrant(record);
    }

    public binding(key: string): Binding | undefined {
        return this.inner.binding(key);
    }

    public bindings(): readonly Binding[] {
        return this.inner.bindings();
    }

    public putBinding(record: Binding): void {
        this.inner.putBinding(record);
    }

    public shareOffer(id: ShareOfferId): ShareOffer | undefined {
        return this.inner.shareOffer(id);
    }

    public shareOffers(): readonly ShareOffer[] {
        return this.inner.shareOffers();
    }

    public putShareOffer(record: ShareOffer): void {
        this.inner.putShareOffer(record);
    }

    public epoch(scope: ScopeRef): ScopeEpoch {
        return this.inner.epoch(scope);
    }

    public epochs(): readonly ScopeEpoch[] {
        return this.inner.epochs();
    }
}
