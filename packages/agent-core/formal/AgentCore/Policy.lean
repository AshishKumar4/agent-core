import AgentCore.Scopes

/-!
# Tier, trust, and placement policy

Placement is selected from the manifest/policy/substrate/trust intersection in the
SPEC order dynamic, provider, bundled. Source assertions never assign trust. `self`
requires lease evidence and is therefore derived later at Event acceptance.
-/

namespace AgentCore

/- Environment Session ownership is not modeled, so execute is conservatively mediated. -/
def defaultTier : InvocationImpact → Bool → EnforcementTier
  | .observe, _ => .direct
  | .execute, _ => .mediated
  | .mutate, _ | .externalSend, _ | .delegate, _ | .administer, _ => .mediated

def effectiveTier (placement : Placement) (impact : InvocationImpact) (sessionScoped : Bool) :
    EnforcementTier :=
  match defaultTier impact sessionScoped with
  | .direct => if placement = .bundled then .direct else .mediated
  | .mediated => .mediated

def PlacementSet.contains (set : PlacementSet) : Placement → Bool
  | .bundled => set.bundled | .provider => set.provider | .dynamic => set.dynamic

def PlacementSet.intersect (left right : PlacementSet) : PlacementSet :=
  ⟨left.bundled && right.bundled, left.provider && right.provider,
   left.dynamic && right.dynamic⟩

def placementIntersection (manifest policy substrate trust : PlacementSet) : PlacementSet :=
  ((manifest.intersect policy).intersect substrate).intersect trust

def choosePlacement (manifest policy substrate trust : PlacementSet) : Option Placement :=
  let available := placementIntersection manifest policy substrate trust
  if available.dynamic then some .dynamic
  else if available.provider then some .provider
  else if available.bundled then some .bundled
  else none

def PlacementSnapshot.Valid (snapshot : PlacementSnapshot) : Prop :=
  choosePlacement snapshot.manifest snapshot.policy snapshot.substrate snapshot.trust =
    some snapshot.selected

theorem placement_prefers_dynamic {manifest policy substrate trust}
    (available : (placementIntersection manifest policy substrate trust).dynamic = true) :
    choosePlacement manifest policy substrate trust = some .dynamic := by
  simp [choosePlacement, available]

theorem placement_uses_provider_without_dynamic {manifest policy substrate trust}
    (noDynamic : (placementIntersection manifest policy substrate trust).dynamic = false)
    (provider : (placementIntersection manifest policy substrate trust).provider = true) :
    choosePlacement manifest policy substrate trust = some .provider := by
  simp [choosePlacement, noDynamic, provider]

theorem placement_uses_bundled_last {manifest policy substrate trust}
    (noDynamic : (placementIntersection manifest policy substrate trust).dynamic = false)
    (noProvider : (placementIntersection manifest policy substrate trust).provider = false)
    (bundled : (placementIntersection manifest policy substrate trust).bundled = true) :
    choosePlacement manifest policy substrate trust = some .bundled := by
  simp [choosePlacement, noDynamic, noProvider, bundled]

theorem empty_intersection_rejects {manifest policy substrate trust}
    (empty : placementIntersection manifest policy substrate trust = ⟨false, false, false⟩) :
    choosePlacement manifest policy substrate trust = none := by simp [choosePlacement, empty]

inductive TrustTier where | owner | authenticated | external | self deriving DecidableEq, Repr

structure Provenance where
  verified : Bool
  owner : Bool
  deriving DecidableEq, Repr

def deriveChannelTrust (provenance : Provenance) : TrustTier :=
  if provenance.verified then if provenance.owner then .owner else .authenticated else .external

def acceptedTrustSet : TrustTier → PlacementSet
  | .owner | .self => ⟨true, true, true⟩
  | .authenticated => ⟨false, true, true⟩
  | .external => ⟨false, true, false⟩

def acceptsSourceTier (provenance : Provenance) (asserted : TrustTier) : Prop :=
  asserted = deriveChannelTrust provenance

theorem source_asserted_tier_rejected {provenance asserted}
    (mismatch : asserted ≠ deriveChannelTrust provenance) :
    ¬ acceptsSourceTier provenance asserted := mismatch

theorem execute_is_formally_mediated (sessionScoped : Bool) :
    defaultTier .execute sessionScoped = .mediated := rfl

end AgentCore
