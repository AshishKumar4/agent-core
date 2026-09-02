import SpecCnl.Unit

/-!
# TrustRoute: reviewed pairings for §6.1, §6.2, and §7.4

Five rule units about where a trust tier comes from and what a route's source Actor owns:
the host derives an Event's tier from provenance rather than accepting a source's claim, a
firing admits only that derived tier, and a RouteReservation authenticates its source
Event, its Invocation, and the tenant relation its authority form asserts before the
target's projection may exist at all.

Three weakenings are systematic across this group and are recorded unit by unit below.

* **The host's lease table and clock are parameters of `AgentCore.EventStep`, not fields of
  `AgentCore.EventStore`.** A `TR[AgentCore.EventStore,AgentCore.EventLabel]` family
  therefore binds them existentially. For the reserve and project families that costs
  nothing — no premise of either constructor reads them — but it is exactly why
  `C13-TRUST-HOST-DERIVED`'s `self` clause carries a presented lease token and not a live
  one. No model record bundles a store with a lease table, and inventing one to make the
  sentence stronger is the fabrication this corpus refuses.
* **Every requirement the model carries as a constructor field is vacuous to render.** The
  cross-tenant Binding, the reservation's source-audit id, and the projection id are
  fields, so "requires" over them would be true by construction; the sentences carry the
  premises that relate two fields instead.
* **Principal-level exact matching is unrepresented.** `AgentCore.RouteAuthority` carries
  an `AuthoritySource` and no PrincipalRef, so the §6.2 five-way exact-match clause has
  nothing to range over in any of these sentences.
-/

namespace SpecCnl.Corpus.Units.TrustRoute

def units : List RuleUnit :=
  [ { key := "C13_TRUST_HOST_DERIVED"
      atoms := ["C13-TRUST-HOST-DERIVED"]
      specSection := "6.1"
      anchor := "SPEC.md:2301"
      digest := "5044a7138f2a8528fc541289786dfa34ae907ef29611bcd597419fc18001c6e8"
      sentence :=
        "every published event derives a non self tier from its provenance without a \
         lease token and every published event has lease evidence for a self tier"
      dropped :=
        [ "'and the Blueprint's trust-tier policy': AgentCore.deriveChannelTrust reads \
           provenance alone and the model has no Blueprint trust-tier policy, so the \
           sentence carries the provenance half of the two-input derivation the atom names",
          "the enumeration of raw provenance a Facet supplies — authenticated identity, \
           channel, group, transport verification result: AgentCore.Provenance carries a \
           verified flag and an owner flag only, so three of the four named inputs are \
           unrepresented and the derivation the sentence carries is over the two that are",
          "the liveness half of the self tier, 'emitted by a Turn executor under a valid \
           lease'. THE SENTENCE IS WEAKER THAN THE ATOM FOR THAT TIER. It carries only \
           that a published self-tier Event presents a lease token, because a condition \
           over an AgentCore.Event cannot name the host's lease table or the publish \
           instant — AgentCore.HostDerivedTrust reads both as parameters of the step. \
           AgentCore.accepted_self_has_live_exact_lease is the exact form",
          "'never facet-asserted' read as the no-asserted-tier half: that is the clause \
           C13-TRUST-VERIFIED-INGRESS's sentence already carries, and a rule unit is \
           rendered by one sentence, so this sentence carries the derivation half instead \
           of restating it",
          "the four tier names read as an exhaustive taxonomy: AgentCore.TrustTier has \
           exactly those four constructors, so a rendering of the enumeration would be \
           true by construction and therefore vacuous" ] },
    { key := "C13_TRUST_ASSERTION_REJECTION"
      atoms := ["C13-TRUST-ASSERTION-REJECTION"]
      specSection := "6.1"
      anchor := "SPEC.md:2318"
      digest := "cd59b06075b40ffd889e877ac9c53729640c360e4951503ba54de9954c32a392"
      sentence := "every subscription firing requires a channel derived admission for the firing"
      dropped :=
        [ "'MUST be rejected' as the refusal path. The sentence carries the positive form \
           the routing plane enforces — the tier a firing admitted is the host's \
           derivation from the Event's channel provenance. \
           AgentCore.asserted_tier_publish_rejected is the refusal form on the event-store \
           plane, and it is the contrapositive of the clause \
           C13-TRUST-VERIFIED-INGRESS's sentence already carries, so this sentence does \
           not restate it",
          "'whose tier was set by a non-host source': AgentCore.RoutedEvent carries no \
           asserted-tier field at all, so on the routing plane there is nothing a source \
           could have set and the qualifier has nothing to range over. A source assertion \
           is representable only as AgentCore.Event.assertedTier, one plane away from the \
           firing this sentence is about",
          "the acceptance-predicate form of the rule, AgentCore.acceptsSourceTier with \
           AgentCore.source_asserted_tier_rejected: a source-asserted tier is accepted \
           only where it equals the host derivation. That statement relates a Provenance \
           to a TrustTier and reads no state, and every relational category in this \
           grammar reads a state, so it cannot be the subject of a sentence here",
          "the rationale — a compromised adapter marking an attacker's message as owner \
           and defeating every policy keyed on the tier — which argues for the rule rather \
           than stating a property of the model" ] },
    { key := "C13_SUBSCRIPTION_AUTHORITY"
      atoms := ["C13-SUBSCRIPTION-AUTHORITY", "C13-ROUTE-CROSS-TENANT-BINDING"]
      specSection := "6.2"
      anchor := "SPEC.md:2453"
      digest := "8eae0e22fe229968e3fa99039ec9aeee884c77a5c672dd218eca07df9d27f308"
      sentence :=
        "every route reservation establishes an authority matched tenant relation \
         for the reservation"
      dropped :=
        [ "'initiator uses the authenticated initiating Principal recorded by the source \
           Actor in the reservation through exactly its named Binding', and 'The target \
           copies that Principal into InvocationAuthority and cannot substitute another \
           principal': AgentCore.RouteAuthority carries an AuthoritySource and no \
           PrincipalRef, and the model has no authority-copy step for a route, so neither \
           the initiator's identity nor the prohibition on substituting it is statable",
          "'The complete PrincipalRef, including tenant, MUST exact-match the source \
           Event, RouteReservation tenant relation, PreparedInvocation authority, optional \
           LeaseToken holder, and any AuthorityPermit': a five-way match over records a \
           reservation does not carry",
          "'matching PrincipalId values in different Tenants are different principals', a \
           claim about how identities compare rather than about a transition",
          "'A cross-tenant reservation requires the TenantRelation.cross.authority Binding \
           in addition to the Subscription's AuthoritySource': \
           AgentCore.RouteAuthority.crossTenant carries that BindingId as a constructor \
           field, so a rendering of the requirement would be true by construction and \
           therefore vacuous. What the sentence carries is the half that is not \
           structural — the cross-tenant form is admitted only between Actors of different \
           Tenants, and the same-tenant form only within one",
          "'absence or tenant mismatch denies delivery': the model refuses the reserve \
           step, so the refusal the sentence carries sits one step earlier than the atom \
           words it, and no delivery-time authority check exists to render",
          "'delegated uses the named Binding independently of the initiator': the model's \
           authority form distinguishes same-tenant from cross-tenant and not delegated \
           from initiator, so the distinction has no constructor to range over" ] },
    { key := "C13_ROUTE_SOURCE_OWNED"
      atoms := ["C13-ROUTE-SOURCE-OWNED", "C13-ROUTE-PROJECTION-DIGEST"]
      specSection := "6.2"
      anchor := "SPEC.md:2441"
      digest := "9a5c61d56b65f1a73facdfaa98900b6f815b48e998990b5e757d8c60fd1ed060"
      sentence :=
        "every route projection establishes an exact authenticated reservation projection \
         for the projection"
      dropped :=
        [ "'Routing is at-least-once with deduplication on the subscription's dedupe key', \
           and the four policies event, causation, payload, and none: the dedupe \
           consequence is what C13-ROUTE-DELIVERY-ONCE's sentence carries over the routing \
           ledger, and the policies themselves are unrepresented — AgentCore.RoutedEvent \
           carries one EventKey and no policy discriminator",
          "'the Event-owning source Actor MUST authenticate the Event and mapping, derive \
           trust, validate it is in acceptedTrust, map the payload': the Event half is \
           what C13-ROUTE-STABLE-INVOCATION's sentence carries, and the model has no \
           mapping record, no payload map, and no acceptedTrust check on a reservation",
          "'MUST append the authoritative RouteReservation' as an obligation that an \
           append occurs: a transition rule states what an append requires and never that \
           one happens",
          "'The reservation's projection and digest MUST be immutable' as immutability \
           along a whole trace. The sentence carries the one-step form — the stored \
           projection is exactly the projection the reservation named, carrying exactly \
           the reservation's digest and target owner — and the freshness guards of \
           AgentCore.EventStep.project are what make the table append-only",
          "'the target never remaps source data': the model has no remap step, so the \
           negative has nothing to range over and the digest equality is the positive form \
           the sentence carries instead" ] },
    { key := "C13_ROUTE_STABLE_INVOCATION"
      atoms :=
        ["C13-ROUTE-STABLE-INVOCATION", "C13-ROUTE-SOURCE-EVENT", "C13-ROUTE-AUDIT-CAUSE",
          "C13-ROUTE-TENANT-RELATION"]
      specSection := "7.4"
      anchor := "SPEC.md:3265"
      digest := "b4ae3051aac34b52e01e4e44c5f48fc14e676da76abb73e738259665b330046a"
      sentence :=
        "every route reservation establishes an authenticated source event for the \
         reservation and every route reservation establishes a stable invocation for the \
         reservation"
      dropped :=
        [ "'The reservation cites the preexisting source Event audit cause' \
           (C13-ROUTE-AUDIT-CAUSE): AgentCore.RouteReservation.sourceAudit is a field and \
           no premise of either reserve constructor ties it to an existing audit entry for \
           the cited Event, so the clause is unrepresented rather than weakened. \
           AgentCore.projection_uses_reservation_bridge_not_source_audit is what the audit \
           plane does state, and it says the bridge entry's cause is the projection's \
           target-local cause rather than that source audit",
          "'MUST authenticate ... target Actor, tenants, projection, authority' \
           (C13-ROUTE-TENANT-RELATION): the authority-and-tenant half is the clause \
           C13-SUBSCRIPTION-AUTHORITY's sentence carries and the projection half is \
           C13-ROUTE-SOURCE-OWNED's, so neither is restated here. Target-Actor \
           authentication is left unclaimed by every sentence in this group: no reserve \
           premise reads the target owner beyond its Tenant",
          "'Cross-tenant delivery also verifies the reservation's explicit cross-tenant \
           Binding': the Binding is a constructor field of \
           AgentCore.RouteAuthority.crossTenant, so the verification is structural and a \
           rendering would be vacuous. AgentCore.delivery_requires_target_local_projection \
           is all the delivery step reads, and it reads the target's plane only",
          "'stable InvocationId' as stability along a whole trace. The sentence carries \
           the one-step form — the Invocation carried no reservation before the step and \
           is indexed to exactly this reservation after it — while \
           AgentCore.route_reservation_is_unique_per_invocation is the trace form and \
           needs the reachability invariant rather than one step",
          "'MUST authenticate source Actor' read as a credential check. The reserve step \
           authenticates the source by requiring the cited Event's owner to be exactly \
           the Actor the reservation names as its source, and carries no principal, \
           token, or signature to verify beyond that identity, so the sentence carries \
           exact-owner agreement rather than authentication in the wire sense" ] } ]

end SpecCnl.Corpus.Units.TrustRoute
