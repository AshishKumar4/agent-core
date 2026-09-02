import AgentCore.Scopes

/-!
# Tier, trust, and placement policy

Placement is selected from the manifest/policy/substrate/trust intersection in the
SPEC order dynamic, provider, bundled. Source assertions never assign trust. `self`
requires lease evidence and is therefore derived later at Event acceptance.
-/

namespace AgentCore

/-- The first Bool is the §7.2 floor's session fact: the call targets a Session owned by
the current Turn. `session_use_is_turn_owned_and_live` grounds when it is true. The second
is the fact the `mutate` exception of the same §7.2 sentence turns on: the target of the
mutation is that Session's own filesystem. Everything but a Turn-owned `execute` and that
one `mutate` is mediated, which is the floor `AgentCore.Facets.enforcementFloor` states
over the same two facts and `Policy.defaultTier` now states with it. -/
def defaultTier : InvocationImpact → Bool → Bool → EnforcementTier
  | .observe, _, _ => .direct
  | .execute, turnOwnedSession, _ =>
      if turnOwnedSession then .direct else .mediated
  | .mutate, turnOwnedSession, sessionFilesystemTarget =>
      if turnOwnedSession && sessionFilesystemTarget then .direct else .mediated
  | .externalSend, _, _ | .delegate, _, _ | .administer, _, _ => .mediated

/-- The model's tier decision with the interceptor fact in place: a direct floor survives
only bundled and un-intercepted (§7.2), and the second session fact is threaded so the
own-filesystem `mutate` exception is decided where the floor decides it. -/
def effectiveTier (placement : Placement) (impact : InvocationImpact) (sessionScoped : Bool)
    (sessionFilesystemTarget : Bool) (intercepted : Bool) : EnforcementTier :=
  match defaultTier impact sessionScoped sessionFilesystemTarget with
  | .direct => if placement = .bundled ∧ intercepted = false then .direct else .mediated
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

theorem turn_owned_session_execute_floor_is_direct :
    defaultTier .execute true true = .direct := rfl

theorem unowned_execute_floor_is_mediated :
    defaultTier .execute false true = .mediated := rfl

/-- §7.2: on a Turn-owned Session, a `mutate` whose target is that Session's own
filesystem floors at `direct` — the exception the extraction and the kernel already
admit, now stated in the model too. -/
theorem turn_owned_session_own_filesystem_mutate_floor_is_direct :
    defaultTier .mutate true true = .direct := rfl

/-- §7.2: the exception is exactly the one conjunction — either half withdrawn keeps
the mediated floor. -/
theorem other_mutate_floors_are_mediated :
    defaultTier .mutate true false = .mediated ∧
      defaultTier .mutate false true = .mediated ∧
      defaultTier .mutate false false = .mediated := ⟨rfl, rfl, rfl⟩

theorem direct_execute_requires_bundled_colocation (placement : Placement) :
    effectiveTier placement .execute true true false = .direct ↔ placement = .bundled := by
  cases placement <;> simp [effectiveTier, defaultTier]

/-- §7.2: an applicable `operation.before` or `operation.after` interceptor raises a
direct floor to mediated, whatever the placement — its rewrite evidence has no direct
channel to be recorded through. -/
theorem interception_raises_direct_floor (placement : Placement)
    (impact : InvocationImpact) (sessionScoped : Bool) (sessionFilesystemTarget : Bool) :
    effectiveTier placement impact sessionScoped sessionFilesystemTarget true = .mediated := by
  unfold effectiveTier
  split
  · rw [if_neg]
    intro ⟨_, absurd⟩
    cases absurd
  · rfl

end AgentCore
