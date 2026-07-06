import AgentCore.Scopes

/-!
# Role → Grant materialization (SPEC §3.3)

Assigning a Role at a Scope materializes a set of Grants for the subject; roles and
memberships have no independent enforcement path. This module models materialization as
a function over the scope-authority records and proves the properties SPEC §3.3 and the
guest rule (§3.3) require:

* guest-materialized grants never carry `delegate` or `administer` capability;
* revoking a membership bumps exactly its scope's revocation epoch and no other; and
* assigning a membership never removes an existing grant.
-/

namespace AgentCore

/-- The capabilities a materialized grant may carry. `delegate` and `administer` are the
    two a guest membership must never receive (SPEC §3.3). -/
inductive Capability where
  | observe
  | mutate
  | externalSend
  | execute
  | delegate
  | administer
  deriving DecidableEq, Repr

/-- The elevated capabilities forbidden to guests. -/
def Capability.elevated : Capability → Bool
  | .delegate | .administer => true
  | _ => false

/-- A role names the capabilities it confers when materialized. -/
structure MaterializationRole where
  confers : List Capability
  deriving Repr

/-- Whether the subject of a materialization is a guest (from a foreign tenant) or a
    local member. Guests are attenuated. -/
inductive SubjectKind where
  | local
  | guest
  deriving DecidableEq, Repr

/-- Materialize a role for a subject: local subjects get the full capability list; guest
    subjects get it with the elevated capabilities filtered out (SPEC §3.3). -/
def materialize (kind : SubjectKind) (role : MaterializationRole) : List Capability :=
  match kind with
  | .local => role.confers
  | .guest => role.confers.filter (fun c => !c.elevated)

/-- **Guest grants are never elevated.** No capability a guest materialization produces
    is `delegate` or `administer` — the core guest-attenuation rule of SPEC §3.3. -/
theorem guest_grant_not_elevated {role : MaterializationRole} {c : Capability}
    (member : c ∈ materialize .guest role) :
    c.elevated = false := by
  unfold materialize at member
  rw [List.mem_filter] at member
  simpa using member.2

/-- Concretely: a guest never receives `delegate`. -/
theorem guest_has_no_delegate {role : MaterializationRole}
    (member : Capability.delegate ∈ materialize .guest role) : False := by
  have := guest_grant_not_elevated member
  simp [Capability.elevated] at this

/-- Concretely: a guest never receives `administer`. -/
theorem guest_has_no_administer {role : MaterializationRole}
    (member : Capability.administer ∈ materialize .guest role) : False := by
  have := guest_grant_not_elevated member
  simp [Capability.elevated] at this

/-! ### Membership revocation over scope epochs (SPEC §3.3 / §3.4 rule 5) -/

/-- **Revoking a membership bumps its scope's epoch.** After revocation the origin
    scope's revocation epoch strictly advances, so every capability resolved before now
    is stale there. -/
theorem revoke_membership_targets_origin (auth : ScopeAuthority) (scope : Scope) :
    auth.epoch scope < (auth.bumpEpoch scope).epoch scope :=
  auth.bumpEpoch_advances scope

/-- **Revoking one membership spares other scopes.** Bumping the origin scope's epoch
    leaves every other scope's epoch unchanged — revocation is per-scope, never global. -/
theorem revoke_membership_spares_others (auth : ScopeAuthority) (origin other : Scope)
    (different : other ≠ origin) :
    (auth.bumpEpoch origin).epoch other = auth.epoch other := by
  rw [ScopeAuthority.bumpEpoch_epoch]
  simp [different]

/-- Assign a membership: add it under a fresh id. -/
def ScopeAuthority.assign (auth : ScopeAuthority) (id : MembershipId)
    (membership : Membership) : ScopeAuthority :=
  { auth with
    memberships := fun candidate => if candidate = id then some membership else auth.memberships candidate }

/-- **Assigning a membership preserves existing effective authority.** Adding a
    membership under a fresh id never removes an allow already effective for a subject:
    the allow's witnessing membership is untouched, and no deny is added. This is the
    union-only, additive semantics of SPEC §3.3. -/
theorem assign_preserves_existing {auth : ScopeAuthority} {principal : PrincipalId}
    {permission : Permission} {target : Scope}
    {id : MembershipId} {membership : Membership}
    (fresh : auth.memberships id = none)
    (existing : auth.Effective principal permission target) :
    (auth.assign id membership).Effective principal permission target := by
  obtain ⟨⟨wid, wm, wlookup, wacts, wpath, wallows⟩, noDeny⟩ := existing
  refine ⟨⟨wid, wm, ?_, wacts, wpath, wallows⟩, ?_⟩
  · -- the witnessing membership survives: wid ≠ id since wid resolves and id is fresh
    show (auth.assign id membership).memberships wid = some wm
    unfold ScopeAuthority.assign
    dsimp only
    split
    · next eq => rw [eq] at wlookup; rw [fresh] at wlookup; cases wlookup
    · exact wlookup
  · -- denies are unchanged by assign
    exact noDeny

end AgentCore
