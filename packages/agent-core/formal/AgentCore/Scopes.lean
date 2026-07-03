import AgentCore.Model

/-!
SPEC v2 §3 (identity & authority): the Scope chain, Memberships/Teams/Roles with
deny-overrides precedence, and bounded-window revocation epochs.

Modeling scope: this file formalizes the *authority algebra* of SPEC §3.1–§3.4 —
effective authority over the scope chain and epoch staleness. Integration of these
records into the full `Step` transition system is a declared refinement obligation
(SPEC §14), not a claim of this file.
-/

namespace AgentCore

structure ProjectId where
  value : Nat
  deriving DecidableEq, Repr

structure TeamId where
  value : Nat
  deriving DecidableEq, Repr

structure MembershipId where
  value : Nat
  deriving DecidableEq, Repr

/-- SPEC §3.2: one Scope primitive, three roles, fixed non-recursive chain. -/
inductive Scope where
  | tenant (t : TenantId)
  | project (t : TenantId) (p : ProjectId)
  | workspace (t : TenantId) (p : Option ProjectId) (w : WorkspaceId)
  deriving DecidableEq, Repr

namespace Scope

def tenantOf : Scope → TenantId
  | .tenant t => t
  | .project t _ => t
  | .workspace t _ _ => t

/-- The scope's chain: itself and every ancestor, innermost first (SPEC §3.2). -/
def path : Scope → List Scope
  | .tenant t => [Scope.tenant t]
  | .project t p => [Scope.project t p, Scope.tenant t]
  | .workspace t none w => [Scope.workspace t none w, Scope.tenant t]
  | .workspace t (some p) w =>
      [Scope.workspace t (some p) w, Scope.project t p, Scope.tenant t]

theorem self_mem_path (scope : Scope) : scope ∈ scope.path := by
  cases scope with
  | tenant t =>
      simp only [path]
      exact List.mem_cons_self ..
  | project t p =>
      simp only [path]
      exact List.mem_cons_self ..
  | workspace t p w =>
      cases p <;> (simp only [path]; exact List.mem_cons_self ..)

theorem tenant_mem_path (scope : Scope) : Scope.tenant scope.tenantOf ∈ scope.path := by
  cases scope with
  | tenant t =>
      simp only [path, tenantOf]
      exact List.mem_cons_self ..
  | project t p =>
      simp only [path, tenantOf]
      exact List.mem_cons_of_mem _ (List.mem_cons_self ..)
  | workspace t p w =>
      cases p with
      | none =>
          simp only [path, tenantOf]
          exact List.mem_cons_of_mem _ (List.mem_cons_self ..)
      | some p =>
          simp only [path, tenantOf]
          exact List.mem_cons_of_mem _ (List.mem_cons_of_mem _ (List.mem_cons_self ..))

/-- The chain never crosses tenants: every scope on a path shares the tenant
    (SPEC §3.2 — the Tenant is the isolation boundary). -/
theorem path_preserves_tenant {scope ancestor : Scope}
    (mem : ancestor ∈ scope.path) : ancestor.tenantOf = scope.tenantOf := by
  cases scope with
  | tenant t =>
      simp only [path] at mem
      cases mem with
      | head => rfl
      | tail _ h => cases h
  | project t p =>
      simp only [path] at mem
      cases mem with
      | head => rfl
      | tail _ h =>
          cases h with
          | head => rfl
          | tail _ h' => cases h'
  | workspace t p w =>
      cases p with
      | none =>
          simp only [path] at mem
          cases mem with
          | head => rfl
          | tail _ h =>
              cases h with
              | head => rfl
              | tail _ h' => cases h'
      | some p =>
          simp only [path] at mem
          cases mem with
          | head => rfl
          | tail _ h =>
              cases h with
              | head => rfl
              | tail _ h' =>
                  cases h' with
                  | head => rfl
                  | tail _ h'' => cases h''

end Scope

/-- SPEC §3.3: Membership subjects are principals or teams. -/
inductive Subject where
  | principal (id : PrincipalId)
  | team (id : TeamId)
  deriving DecidableEq, Repr

/-- A Role names a capability set; assigning it materializes Grants (SPEC §3.3). -/
structure Role where
  allows : List Permission
  deriving Repr

structure Membership where
  subject : Subject
  scope : Scope
  role : Role
  deriving Repr

/-- The scope-authority records of SPEC §3: memberships, team membership, explicit
    denies, and per-scope revocation epochs. -/
structure ScopeAuthority where
  memberships : MembershipId → Option Membership
  teamMembers : TeamId → PrincipalId → Prop
  denies : Scope → PrincipalId → Permission → Prop
  epoch : Scope → Nat

namespace ScopeAuthority

/-- A principal acts under a subject directly or through team membership (SPEC §3.1). -/
def ActsUnder (auth : ScopeAuthority) (principal : PrincipalId) : Subject → Prop
  | .principal id => id = principal
  | .team id => auth.teamMembers id principal

/-- An allow exists at some scope on the target's chain (SPEC §3.3: authority
    attached at a scope flows to descendant scopes). -/
def Allowed (auth : ScopeAuthority) (principal : PrincipalId)
    (permission : Permission) (target : Scope) : Prop :=
  ∃ id membership,
    auth.memberships id = some membership ∧
    auth.ActsUnder principal membership.subject ∧
    membership.scope ∈ target.path ∧
    permission ∈ membership.role.allows

/-- An explicit deny exists at some scope on the target's chain. -/
def DeniedOnPath (auth : ScopeAuthority) (principal : PrincipalId)
    (permission : Permission) (target : Scope) : Prop :=
  ∃ scope, scope ∈ target.path ∧ auth.denies scope principal permission

/-- SPEC §3.3 precedence: effective authority is the union of allows minus explicit
    denies, with deny-overrides along the whole chain. -/
def Effective (auth : ScopeAuthority) (principal : PrincipalId)
    (permission : Permission) (target : Scope) : Prop :=
  auth.Allowed principal permission target ∧
    ¬ auth.DeniedOnPath principal permission target

/-- Deny-overrides: an explicit deny at any scope on the chain defeats every allow,
    wherever the allow sits (SPEC §3.3). -/
theorem deny_overrides {auth : ScopeAuthority} {principal permission target scope}
    (deny : auth.denies scope principal permission)
    (onPath : scope ∈ target.path) :
    ¬ auth.Effective principal permission target :=
  fun effective => effective.2 ⟨scope, onPath, deny⟩

/-- A descendant allow cannot re-widen an ancestor deny (SPEC §3.3): a deny at the
    tenant blocks even a workspace-level membership allow. -/
theorem descendant_allow_cannot_rewiden {auth : ScopeAuthority}
    {principal permission} {target : Scope}
    (deny : auth.denies (.tenant target.tenantOf) principal permission) :
    ¬ auth.Effective principal permission target :=
  deny_overrides deny (Scope.tenant_mem_path target)

/-- Downward flow: a tenant-level membership allow is effective at every scope of
    that tenant, absent explicit denies (SPEC §3.3). -/
theorem allow_flows_down {auth : ScopeAuthority} {principal permission}
    {id : MembershipId} {membership : Membership} {target : Scope}
    (lookup : auth.memberships id = some membership)
    (acts : auth.ActsUnder principal membership.subject)
    (atTenant : membership.scope = .tenant target.tenantOf)
    (allows : permission ∈ membership.role.allows)
    (noDeny : ¬ auth.DeniedOnPath principal permission target) :
    auth.Effective principal permission target :=
  ⟨⟨id, membership, lookup, acts, atTenant ▸ Scope.tenant_mem_path target, allows⟩, noDeny⟩

/-- Team access: a principal in a team holding a membership gets the team's
    effective authority (SPEC §3.1/§3.3 union semantics, constructive direction). -/
theorem team_confers_member_access {auth : ScopeAuthority} {principal team}
    {id : MembershipId} {membership : Membership} {permission} {target : Scope}
    (member : auth.teamMembers team principal)
    (lookup : auth.memberships id = some membership)
    (subject : membership.subject = .team team)
    (onPath : membership.scope ∈ target.path)
    (allows : permission ∈ membership.role.allows)
    (noDeny : ¬ auth.DeniedOnPath principal permission target) :
    auth.Effective principal permission target := by
  refine ⟨⟨id, membership, lookup, ?_, onPath, allows⟩, noDeny⟩
  rw [subject]
  exact member

end ScopeAuthority

/-! ### Bounded-window revocation (SPEC §3.4 rule 5) -/

/-- The epoch a capability was resolved under (SPEC §3.4: every ResolvedFacet is
    stamped at resolution). -/
structure ResolutionStamp where
  scope : Scope
  epoch : Nat
  deriving DecidableEq, Repr

namespace ScopeAuthority

/-- Freshness: the stamp matches the scope's current revocation epoch. Mediated
    invocations revalidate this on their durable path (SPEC §7.2). -/
def Fresh (auth : ScopeAuthority) (stamp : ResolutionStamp) : Prop :=
  stamp.epoch = auth.epoch stamp.scope

/-- Revocation bumps the scope's epoch (SPEC §3.4 rule 5). -/
def bumpEpoch (auth : ScopeAuthority) (scope : Scope) : ScopeAuthority :=
  { auth with
    epoch := fun candidate =>
      if candidate = scope then auth.epoch candidate + 1 else auth.epoch candidate }

theorem bumpEpoch_epoch (auth : ScopeAuthority) (bumped scope : Scope) :
    (auth.bumpEpoch bumped).epoch scope =
      if scope = bumped then auth.epoch scope + 1 else auth.epoch scope := rfl

theorem bumpEpoch_monotone (auth : ScopeAuthority) (bumped scope : Scope) :
    auth.epoch scope ≤ (auth.bumpEpoch bumped).epoch scope := by
  rw [bumpEpoch_epoch]
  split <;> omega

/-- Epochs strictly advance at the revoked scope. -/
theorem bumpEpoch_advances (auth : ScopeAuthority) (scope : Scope) :
    auth.epoch scope < (auth.bumpEpoch scope).epoch scope := by
  rw [bumpEpoch_epoch]
  simp

/-- The revocation theorem: any stamp that was fresh before a revocation of its
    scope is stale after it — so every subsequent mediated invocation under that
    stamp is denied (SPEC §3.4 rule 5 deadline (b)). -/
theorem bump_stales_stamp {auth : ScopeAuthority} {stamp : ResolutionStamp}
    (fresh : auth.Fresh stamp) :
    ¬ (auth.bumpEpoch stamp.scope).Fresh stamp := by
  unfold Fresh at *
  rw [bumpEpoch_epoch, if_pos rfl]
  omega

/-- Staleness is permanent: no number of further revocations restores freshness. -/
theorem stale_stays_stale {auth : ScopeAuthority} {stamp : ResolutionStamp}
    (stale : stamp.epoch < auth.epoch stamp.scope) (scope : Scope) :
    stamp.epoch < (auth.bumpEpoch scope).epoch stamp.scope :=
  Nat.lt_of_lt_of_le stale (auth.bumpEpoch_monotone scope stamp.scope)

end ScopeAuthority

/-! ### One authority plane (SPEC §3.3)

Enforcement reads only Grants and Bindings: `AuthorizedBy` (Model.lean) is defined
over the grant/binding tables alone, so callable authorization is invariant under
*any* change to memberships, teams, denies, or epochs. The theorem below is true
**by construction** (`Iff.rfl`) — it is recorded as a structural witness that the
model admits no second enforcement path, not as a deep proof. -/

structure ScopedState where
  core : State
  authority : ScopeAuthority

def ScopedState.AuthorizedBy (state : ScopedState) (domain : Domain)
    (binding : BindingId) (permission : Permission) : Prop :=
  AgentCore.AuthorizedBy state.core domain binding permission

theorem enforcement_independent_of_memberships
    (core : State) (a b : ScopeAuthority)
    (domain : Domain) (binding : BindingId) (permission : Permission) :
    ScopedState.AuthorizedBy ⟨core, a⟩ domain binding permission ↔
      ScopedState.AuthorizedBy ⟨core, b⟩ domain binding permission :=
  Iff.rfl

end AgentCore
