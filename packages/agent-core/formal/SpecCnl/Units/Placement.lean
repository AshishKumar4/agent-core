import SpecCnl.Unit

/-!
# Placement: reviewed pairings for §9.2, §7.2, and §3.5

Six rule units about where a Facet runs and what that costs the call: the
manifest/policy/substrate/trust intersection and its one preference order, the trust
set's exclusion of `bundled`, the co-location a `direct` call requires, the enforcement
floor and the approval that raises it, the authority-admission epoch comparison every
mediated effect performs, and the custody a SecretRef resolves under.

Two systematic weaknesses run through the group.

**Placement is a function here, not a transition family.** `AgentCore.choosePlacement` is
an executable selection over four `PlacementSet`s and `AgentCore.PlacementSnapshot.Valid`
is the predicate that a recorded selection is the one it returns. So every placement
sentence quantifies over validated snapshots and reads the order *backwards* from the
selection — the selected mode is admissible, a `bundled` selection excludes every earlier
mode, a `provider` selection excludes `dynamic`. Nothing here claims a Blueprint is
rejected, because the model has no Blueprint and no rejection path: the empty-intersection
rule survives only as "no snapshot with an empty intersection is valid", which is what the
admissibility clause says contrapositively.

**A floor is a permission and the grammar states refusals.** §7.2 floors `observe` at
direct, which permits a direct call; `AgentCore.DirectReady` requires the impact to *be*
`observe`, which refuses everything else. Every floor sentence below carries the refusal
half. No sentence asserts that a transition family is inhabited, and this corpus has no
form that could.
-/

namespace SpecCnl.Corpus.Units.Placement

def units : List RuleUnit :=
  [ { key := "C13_PLACEMENT_INTERSECTION"
      atoms := ["C13-PLACEMENT-INTERSECTION", "C13-PLACEMENT-ORDER", "C13-PLACEMENT-EMPTY"]
      specSection := "9.2"
      anchor := "SPEC.md:3505"
      digest := "d9927072b3a8615e922ae3fa96beeef745e6e3c4daffc930aefd1ba5feeddf68"
      sentence :=
        "every chosen placement selects an admissible mode and every bundled placement \
         admits no unbundled mode and additionally every provider placement admits no \
         dynamic mode"
      dropped :=
        [ "'compute exactly manifest ∩ policy ∩ substrate ∩ trust, where each term is an \
           independently derived admissible-mode set': AgentCore.placementIntersection is \
           defined as that fourfold intersect, so a rendering of the equation would be \
           true by construction and therefore vacuous. What the sentence carries instead \
           is the non-vacuous consequence — a validated selection is a member of the \
           intersection, hence admissible in all four sets at once",
          "'An empty intersection MUST reject the Blueprint; no fallback is inferred': the \
           model has no Blueprint and no rejection transition, so the clause is carried \
           only in the contrapositive the first clause gives — an empty intersection \
           contains no mode, so it validates no selection at all and there is nothing for \
           a fallback to select. AgentCore.empty_intersection_rejects is the direct form",
          "'decides isolation (§1.5)' and 'One preference order applies everywhere' as a \
           claim about the scope of the rule rather than about one decision",
          "the order is carried as two exclusions rather than as a relation over modes. \
           A bundled selection excludes every unbundled mode and a provider selection \
           excludes dynamic, which is 'the first member of the intersection in that \
           order' for the two cases where anything is excluded; the third case, a dynamic \
           selection, excludes nothing and needs no clause. The grammar has no ordering \
           relation over Placement, so the order itself is not named" ] },
    { key := "C13_PLACEMENT_UNTRUSTED_BUNDLED"
      atoms := ["C13-POLICY-DIRECT-ESCALATION"]
      specSection := "9.2"
      anchor := "SPEC.md:3515"
      digest := "ab311c9c137104df0b9b6aa31df1364abeb518e23783efa6abb6b2346d0345bc"
      sentence := "every unbundled mode yields the mediated tier"
      dropped :=
        [ "'policies.placement.trusted names the Packages the trust set admits to \
           bundled, as a nonempty list of globs matched against the whole PackageId', the \
           glob semantics, and 'The trust set MUST exclude bundled for every Package no \
           glob matches'. THE SENTENCE CARRIES NOTHING OF C13-PLACEMENT-UNTRUSTED-BUNDLED, \
           WHICH IS THIS RULE UNIT'S OWN ATOM AND IS NOT CLAIMED. There is no trusted-glob \
           list in the model, and nothing relates a Package to a trust set: \
           AgentCore.PlacementSnapshot.trust is an unconstrained PlacementSet input, and \
           AgentCore.acceptedTrustSet — the one function that derives a PlacementSet from \
           a trust level — reads a channel TrustTier and is referenced by no other \
           definition in the model, so it does not feed that field either. \
           AgentCore.PackageId is a Nat wrapper with no textual id, so a glob 'matched \
           against the whole PackageId' has nothing to match, and AgentCore.globMatch — \
           which does implement exactly these glob semantics over List Char — is applied \
           to Facet patterns in capability attenuation and to nothing else",
          "'placement itself does not change': AgentCore.effectiveTier takes the placement \
           as an argument and returns a tier, so there is no step that could change it and \
           a rendering would be vacuous",
          "'a policy-selected direct call' as a policy act. The model has no policy \
           composition, so the sentence is uniform in the impact, the \
           Turn-owned-Session fact, and the interception fact instead of being about a \
           call policy selected for the direct tier" ] },
    { key := "C13_POLICY_DIRECT_COLOCATION"
      atoms := ["C13-POLICY-DIRECT-COLOCATION"]
      specSection := "7.2"
      anchor := "SPEC.md:2828"
      digest := "ad0f2e4892496e274a2371593433553e76e8f2b08da10a019f5cd99bd0645f0d"
      sentence :=
        "every direct admission requires a bundled selection and every direct admission \
         requires an exact turn lease and additionally every direct admission maintains \
         unchanged system state"
      dropped :=
        [ "'Authority, delivered watermark, PathEpochEvidence, and immutable §3.4 deadline \
           are checked in memory': of the five in-memory checks the sentence carries the \
           exact-current-Turn-lease one, because three sentence clauses is the whole \
           budget. AgentCore.direct_ready_uses_exact_holder_watermark_inequality and \
           AgentCore.direct_resolution_uses_actual_lease_expiry are where the watermark \
           and deadline halves live",
          "'an in-process call' and 'telemetry MAY be sampled': the first is not a \
           statable property of the transition and the second is a MAY",
          "'because its authority check would cross an isolate boundary', the rule's \
           justification rather than the rule",
          "the second clause carries 'in the Actor that owns the Turn lease' as the \
           conjunction of what the exact lease gate gives — the lease names a running \
           Turn, that Turn's Run is the call's protection domain, and the Turn's pinned \
           placement is this call's placement snapshot. AgentCore.AdmissionRequest has no \
           Actor field, so Actor identity is carried through the Run domain rather than \
           named",
          "the third clause is 'no durable writes occur on the call path' in the strongest \
           form the model has: the successor state equals the source state. A one-step \
           statement says nothing about a call path made of several steps" ] },
    { key := "C13_POLICY_MEDIATION_FLOOR"
      atoms := ["C13-POLICY-MEDIATION-FLOOR", "C13-POLICY-APPROVAL-FLOOR"]
      specSection := "7.2"
      anchor := "SPEC.md:2850"
      digest := "688d40a45f8e463256063bddc6e681cb6c1403caedb6b5b2bf762d75b0836e07"
      sentence :=
        "every direct admission requires an observing impact and every direct admission \
         requires an unapproved operation and additionally every direct admission \
         requires an unintercepted call"
      dropped :=
        [ "'observe → direct' and 'on a Turn-owned Session, execute and mutate whose \
           target is that Session's own filesystem → direct'. THE SENTENCE CARRIES ONLY \
           THE REFUSAL HALF OF THE FLOOR. A direct floor is a permission to stay direct, \
           and no sentence form in this corpus asserts that a transition family is \
           inhabited. AgentCore.defaultTier does floor observe, a Turn-owned execute, and \
           a Turn-owned own-filesystem mutate at direct, and \
           AgentCore.turn_owned_session_execute_floor_is_direct and \
           AgentCore.turn_owned_session_own_filesystem_mutate_floor_is_direct are those \
           facts",
          "'execute and mutate whose target is that Session's own filesystem → direct' \
           carries both halves in the model now — AgentCore.defaultTier admits the \
           conjunction and refuses either half withdrawn — so what keeps the clause out \
           of the corpus is only the first reason: no sentence form here asserts that a \
           transition family is inhabited",
          "'Policy MAY raise a direct floor to mediated, and MAY add approval': a MAY, and \
           the model has no policy-composition operator that could raise a floor. The \
           second clause carries the consequence the SPEC gives for the approval case — an \
           approval has nowhere to be recorded on the direct path — as the refusal that \
           AgentCore.requiresApproval is false of every directly admitted call",
          "'It MUST NOT lower a mediated floor or remove an approval required by a \
           profile, Operation, Package, or ancestor policy': the never-lowered half is \
           AgentCore.effectiveTier's mediated branch, which returns mediated \
           unconditionally, and this sentence is about the direct path so it does not \
           carry it. A profile, an Operation, a Package, and an ancestor policy are not \
           model constructs, so the sources of a required approval are unrepresentable",
          "the third of the three further conditions, 'the absence of a configured \
           maxDirectRevocationWindowMs': AgentCore.AuthorityLedger.maxDirectWindow is a \
           total Nat field, so there is no unconfigured state for the condition to be \
           about",
          "'An interceptor contributed over an observe operation therefore moves that read \
           onto the mediated path' as a derived remark, the SHOULD about surfacing it at \
           contribution time, and 'These tightenings are monotone'",
          "'A write inside a Turn-owned Session crosses no seam and acquires no authority, \
           so it can neither exfiltrate nor escalate', with the tree-checkpoint evidence \
           argument: the justification of the floor rather than the floor" ] },
    { key := "C13_POLICY_EPOCH_RECHECK"
      atoms := ["C13-POLICY-EPOCH-RECHECK"]
      specSection := "7.2"
      anchor := "SPEC.md:2859"
      digest := "5db97aedd6cc13d3a92d4352f2610582ce1ac78313e1345a2dd619cbdbfb3b4e"
      sentence :=
        "every mediated effect compares the current path epochs and every mediated effect \
         matches the open reservation epoch"
      dropped :=
        [ "'uses the one final authority-admission linearization point in §3.4 rule 7': \
           uniqueness of the linearization point is a claim about the pipeline's shape, \
           and the model has no ordering of admission points to compare. What the sentence \
           carries is that the comparison holds in every state that admits the effect",
          "'Cross-Actor admission performs it when the Tenant Actor issues the exact-claim \
           permit; target consumption validates local claim, fence, reservation epoch, \
           watermark, single use, and expiry but does not reopen the Grant decision': the \
           cross-Actor permit is AgentCore.DistributedPermit and is a separate ledger from \
           AgentCore.MediatedReady, so both clauses are about Actor-local admission only",
          "'including an internal mutation or execution' and 'This rule is not limited to \
           external sends' are carried by the subject rather than stated: the subject is \
           every request whose effective tier is mediated, at any impact, so an internal \
           mutation and an internal execution are in range. The restriction is also not \
           load-bearing — AgentCore.MediatedReady already pins the mediated tier, so both \
           clauses hold of every request — and it is kept because it is the rule unit's own \
           subject",
          "the second clause is confined to a Run domain, because \
           AgentCore.RunReservationGate requires no reservation of a workspace domain, so \
           there is no reservation epoch there to match" ] },
    { key := "C13_CONFIG_SECRET_CUSTODY"
      atoms := ["C13-CONFIG-SECRET-CUSTODY"]
      specSection := "3.5"
      anchor := "SPEC.md:569"
      digest := "f58b55478c62560d2210699430370471eeb03ed2860827d1968f1cbc18f16611"
      sentence :=
        "every secret resolve requires a recorded custody endpoint for the presented \
         endpoint and every secret resolve requires a recorded custody binding for the \
         presented binding"
      dropped :=
        [ "'A SecretRef resolves only inside the Tenant named by its source': the Tenant \
           half of the triple is carried by C13-AUTH-SECRET-SCOPE, whose sentence is \
           'every secret resolve requires a home tenant consumer for the resolved secret'. \
           This sentence carries the consumer and endpoint halves, which is what a \
           resolution seam checks against the custody record",
          "'repointing an integration at a new endpoint invalidates the old resolution \
           rather than presenting the old credential to the new place': not renderable. \
           The model proves it as AgentCore.repoint_invalidates_prior_resolution, but the \
           claim relates the states either side of a repoint *for the repointed secret*, \
           and the grammar's two-state form takes a relation that cannot read the label — \
           so the clause could only be written for every prior resolution of every secret, \
           which is false and rightly refused",
          "'source MUST equal the exact canonical value of that Tenant's TenantId — never \
           a free-form label': AgentCore.SecretRef.source is a TenantId field, so a \
           rendering would be true by construction and therefore vacuous",
          "'SecretRef itself stays a self-contained core value type and does not import \
           the identity types it names': a signature-level claim about the module graph, \
           not a property statable inside the theory",
          "'durably pairs it with the exact consumer identity and target endpoint the \
           Tenant authorized' as the acceptance act, and 'that (SecretRef, consumer, \
           endpoint) triple is the custody record'. AgentCore.SecretCustody is exactly \
           that record, so its shape is true by construction; what the sentence carries is \
           the seam's obligation to check the presented pair against it",
          "'MUST fail the resolution attempt, never degrade to the raw value, for a \
           mismatched or unrecorded pair': the sentence carries the precondition every \
           admitted resolution satisfies rather than the refusal. \
           AgentCore.mismatched_custody_secret_resolution_rejected is the refusal form, and \
           never-degrade-to-the-raw-value has no model construct — a resolve step returns \
           no value at all",
          "'For a mediated externalSend effect that failure is an ordinary failed \
           AttemptReceipt', 'This document does not fix where a substrate stores it', the \
           one-owner cross-reference, and 'custody denial needs no separate record kind': \
           claims about other sections and about the specification's own coverage",
          "'A delegation, a guest Membership, and a cross-tenant reservation each carry \
           the ref and never the value', which is C13-CONFIG-SECRET-REF's sentence 'every \
           secret step preserves carrier refs only' and is not re-claimed here" ] } ]

end SpecCnl.Corpus.Units.Placement
