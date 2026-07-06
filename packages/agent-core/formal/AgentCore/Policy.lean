import AgentCore.Model

/-!
SPEC v2 §7.2 (enforcement tiers) and §6.1 (host-derived trust tiers, verified
ingress) as executable policy derivations with their defining invariants.
-/

namespace AgentCore

/-! ### Enforcement tiers (SPEC §7.2) -/

inductive EnforcementTier where
  | mediated | direct
  deriving DecidableEq, Repr

/-- The normative defaults of SPEC §7.2, per impact and session scope. -/
def defaultTier : InvocationImpact → Bool → EnforcementTier
  | .observe, _ => .direct
  | .execute, true => .direct
  | .execute, false => .mediated
  | .mutate, _ => .mediated
  | .externalSend, _ => .mediated
  | .delegate, _ => .mediated
  | .administer, _ => .mediated

/-- The effective tier: the default, escalated to mediated whenever the facet is not
    bundled with the lease-owning Actor (SPEC §7.2 co-location requirement). -/
def effectiveTier (bundledWithLeaseOwner : Bool)
    (impact : InvocationImpact) (sessionScoped : Bool) : EnforcementTier :=
  match defaultTier impact sessionScoped with
  | .direct => if bundledWithLeaseOwner then .direct else .mediated
  | .mediated => .mediated

/-- The `direct` tier requires co-location with the lease owner: a provider- or
    dynamic-mode facet is never direct (SPEC §7.2). -/
theorem direct_requires_colocation {bundled impact sessionScoped}
    (direct : effectiveTier bundled impact sessionScoped = .direct) :
    bundled = true := by
  unfold effectiveTier at direct
  cases h : defaultTier impact sessionScoped with
  | mediated => rw [h] at direct; cases direct
  | direct =>
      rw [h] at direct
      cases bundled with
      | true => rfl
      | false => simp at direct

/-- `externalSend`, `delegate`, and `administer` are always mediated, regardless of
    placement or session scope (SPEC §7.2 defaults). -/
theorem externalSend_always_mediated (bundled sessionScoped) :
    effectiveTier bundled .externalSend sessionScoped = .mediated := rfl

theorem delegate_always_mediated (bundled sessionScoped) :
    effectiveTier bundled .delegate sessionScoped = .mediated := rfl

theorem administer_always_mediated (bundled sessionScoped) :
    effectiveTier bundled .administer sessionScoped = .mediated := rfl

theorem mutate_always_mediated (bundled sessionScoped) :
    effectiveTier bundled .mutate sessionScoped = .mediated := rfl

/-- Non-session `execute` is mediated even when bundled (SPEC §7.2). -/
theorem nonsession_execute_mediated (bundled) :
    effectiveTier bundled .execute false = .mediated := rfl

/-! ### Host-derived trust tiers and verified ingress (SPEC §6.1) -/

inductive TrustTier where
  | owner | authenticated | external | self
  deriving DecidableEq, Repr

/-- Raw provenance supplied by a Facet or transport; the Facet never supplies the
    tier itself (SPEC §6.1). -/
structure Provenance where
  verified : Bool
  isOwner : Bool
  byExecutorWithLease : Bool
  deriving DecidableEq, Repr

/-- The host's tier derivation (SPEC §6.1): `self` only for lease-fenced executor
    emissions; `owner`/`authenticated` require verification; everything else is
    `external`. -/
def deriveTier (provenance : Provenance) : TrustTier :=
  if provenance.byExecutorWithLease then .self
  else if provenance.verified then
    if provenance.isOwner then .owner else .authenticated
  else .external

/-- `self` is assignable only for emissions under a valid lease (SPEC §6.1). -/
theorem self_requires_lease {provenance}
    (self : deriveTier provenance = .self) :
    provenance.byExecutorWithLease = true := by
  unfold deriveTier at self
  cases h : provenance.byExecutorWithLease with
  | true => rfl
  | false =>
      rw [h] at self
      simp at self
      cases hv : provenance.verified <;> rw [hv] at self <;> simp at self
      cases ho : provenance.isOwner <;> rw [ho] at self <;> simp at self

/-- `owner` and `authenticated` require verified provenance. -/
theorem trusted_requires_verification {provenance}
    (trusted : deriveTier provenance = .owner ∨ deriveTier provenance = .authenticated) :
    provenance.verified = true := by
  unfold deriveTier at trusted
  cases hl : provenance.byExecutorWithLease with
  | true => rw [hl] at trusted; rcases trusted with h | h <;> simp at h
  | false =>
      rw [hl] at trusted
      cases hv : provenance.verified with
      | true => rfl
      | false =>
          rw [hv] at trusted
          rcases trusted with h | h <;> simp at h

/-- Unverified, non-owner, non-executor provenance is always `external` — a hostile
    channel cannot escalate by assertion because it never assigns the tier at all. -/
theorem unverified_is_external {provenance}
    (unverified : provenance.verified = false)
    (noLease : provenance.byExecutorWithLease = false) :
    deriveTier provenance = .external := by
  unfold deriveTier
  rw [unverified, noLease]
  simp

/-! Ingress: unverified requests never mint Events (SPEC §6.1). -/

structure IngressRequest where
  verified : Bool
  deriving DecidableEq, Repr

inductive IngressMint : IngressRequest → Provenance → Prop
  | mint {request provenance} :
      request.verified = true →
      provenance.verified = true →
      provenance.byExecutorWithLease = false →
      IngressMint request provenance

theorem unverified_never_mints {request provenance}
    (unverified : request.verified = false) :
    ¬ IngressMint request provenance := by
  intro mint
  cases mint with
  | mint verified _ _ => rw [unverified] at verified; cases verified

/-- Ingress-minted Events can never carry the `self` tier: channel input can never
    impersonate agent-caused intent (SPEC §6.1). -/
theorem ingress_never_self {request provenance}
    (mint : IngressMint request provenance) :
    deriveTier provenance ≠ .self := by
  cases mint with
  | mint _ _ noLease =>
      intro self
      have := self_requires_lease self
      rw [noLease] at this
      cases this

/-! ### The event trust boundary (SPEC §6.1)

A Facet supplies raw provenance and *asserts* a tier; the host accepts the event only
when the asserted tier equals the tier the host would derive. An assertion that does not
match provenance is rejected. -/

/-- The host accepts an asserted tier only if it matches the derived tier. -/
def acceptsTier (provenance : Provenance) (asserted : TrustTier) : Prop :=
  asserted = deriveTier provenance

/-- **An `owner` assertion on external provenance is rejected.** Unverified,
    non-executor provenance derives `external`, so asserting `owner` over it fails the
    boundary check — a compromised channel adapter cannot escalate to owner. -/
theorem asserted_owner_on_external_rejected {provenance}
    (unverified : provenance.verified = false)
    (noLease : provenance.byExecutorWithLease = false) :
    ¬ acceptsTier provenance .owner := by
  unfold acceptsTier
  rw [unverified_is_external unverified noLease]
  intro h; cases h

/-- **A `self` assertion without a lease is rejected.** `self` is derivable only for a
    lease-fenced executor emission; provenance without a lease never derives `self`, so
    asserting it fails — channel input cannot impersonate agent-caused intent. -/
theorem asserted_self_without_lease_rejected {provenance}
    (noLease : provenance.byExecutorWithLease = false) :
    ¬ acceptsTier provenance .self := by
  unfold acceptsTier
  intro h
  have := self_requires_lease h.symm
  rw [noLease] at this
  cases this

/-! ### Direct-tier admission (SPEC §7.2, §3.4)

A `direct`-tier call is admitted only when the facet is bundled with the lease owner and
the resolution stamp is fresh. Both conditions are necessary. -/

/-- A direct call is admitted iff its effective tier is `direct` and its resolution
    stamp is fresh (SPEC §3.4: `direct` runs against the turn-start stamp). -/
def admitDirect (bundled fresh : Bool) (impact : InvocationImpact) (sessionScoped : Bool) : Prop :=
  effectiveTier bundled impact sessionScoped = .direct ∧ fresh = true

/-- **A `direct` admission implies bundled and fresh.** -/
theorem direct_admitted_is_bundled_and_fresh {bundled fresh impact sessionScoped}
    (admitted : admitDirect bundled fresh impact sessionScoped) :
    bundled = true ∧ fresh = true :=
  ⟨direct_requires_colocation admitted.1, admitted.2⟩

/-- **An unbundled facet is never `direct`.** Whatever the impact and session scope, a
    facet not co-located with the lease owner resolves to `mediated`. -/
theorem unbundled_never_direct (impact : InvocationImpact) (sessionScoped : Bool) :
    effectiveTier false impact sessionScoped = .mediated := by
  unfold effectiveTier
  cases h : defaultTier impact sessionScoped <;> simp [h]

/-- **A stale stamp is never admitted `direct`.** Even a bundled facet's direct call is
    refused if its resolution stamp is not fresh (SPEC §3.4 rule 5) — the call
    escalates to mediated, which revalidates on the durable path. -/
theorem stale_never_direct (bundled impact sessionScoped) :
    ¬ admitDirect bundled false impact sessionScoped := by
  intro admitted
  cases admitted.2

end AgentCore
