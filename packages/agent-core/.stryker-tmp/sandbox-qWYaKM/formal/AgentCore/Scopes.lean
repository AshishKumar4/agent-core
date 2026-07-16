import AgentCore.Model

/-!
# Canonical authority and bounded resolution evidence

Bindings authorize the exact operation facet. Delegation follows scope containment,
cannot widen the permission, and cannot delegate deny. Issued direct evidence is tied
to the exact optional lease incarnation, complete path epochs, original lease expiry,
and configured maximum window. Invalidation is a per-holder Scope→epoch join.
-/

namespace AgentCore

def Scope.tenantOf : Scope → TenantId
  | .tenant t => t | .project t _ => t | .workspace t _ _ => t

def Scope.path : Scope → List Scope
  | .tenant t => [.tenant t]
  | .project t p => [.project t p, .tenant t]
  | .workspace t none w => [.workspace t none w, .tenant t]
  | .workspace t (some p) w => [.workspace t (some p) w, .project t p, .tenant t]

def Scope.Contains (parent child : Scope) : Prop := parent ∈ child.path
def Scope.orderedPath (scope : Scope) : List Scope := scope.path.reverse

namespace Scope

theorem self_mem_path (scope : Scope) : scope ∈ scope.path := by
  cases scope with
  | tenant => simp [path]
  | project => simp [path]
  | workspace _ project _ => cases project <;> simp [path]

theorem contains_refl (scope : Scope) : scope.Contains scope := self_mem_path scope

theorem path_preserves_tenant {scope ancestor : Scope} (member : ancestor ∈ scope.path) :
    ancestor.tenantOf = scope.tenantOf := by
  cases scope with
  | tenant => simp [path] at member; subst ancestor; rfl
  | project => simp [path] at member; rcases member with rfl | rfl <;> rfl
  | workspace tenant project workspace =>
      cases project with
      | none => simp [path] at member; rcases member with rfl | rfl <;> rfl
      | some project => simp [path] at member; rcases member with rfl | rfl | rfl <;> rfl

end Scope

structure Resolution where
  id : ResolutionId
  principal : PrincipalRef
  header : InvocationHeader
  targetScope : Scope
  issuedAt : Time
  deadline : Time
  originalLeaseExpiry : Option Time
  deriving DecidableEq, Repr

structure AuthorityLedger where
  grants : GrantId → Option Grant
  bindings : BindingId → Option Binding
  revoked : GrantId → Prop
  teamMembers : TeamId → PrincipalId → Prop
  foreignVerified : TenantId → PrincipalId → Prop
  epoch : Scope → Nat
  maxDirectWindow : Nat
  resolutions : ResolutionId → Option Resolution
  issuedAuthorized : ResolutionId → Prop
  holderWatermark : PrincipalRef → Scope → Nat

instance : Inhabited AuthorityLedger where
  default := {
    grants := fun _ => none
    bindings := fun _ => none
    revoked := fun _ => False
    teamMembers := fun _ _ => False
    foreignVerified := fun _ _ => False
    epoch := fun _ => 0
    maxDirectWindow := 10
    resolutions := fun _ => none
    issuedAuthorized := fun _ => False
    holderWatermark := fun _ _ => 0
  }

namespace AuthorityLedger

def ActsUnder (ledger : AuthorityLedger) (principal : PrincipalRef) : Subject → Prop
  | .principal id => id = principal.id
  | .team id => ledger.teamMembers id principal.id
  | .foreign home id => home = principal.tenant ∧ id = principal.id ∧
      ledger.foreignVerified home principal.id

inductive LiveGrant (ledger : AuthorityLedger) : GrantId → Grant → Prop
  | root {id grant} :
      ledger.grants id = some grant → grant.parent = none → ¬ ledger.revoked id →
      LiveGrant ledger id grant
  | child {id grant parent parentGrant} :
      ledger.grants id = some grant → grant.parent = some parent → ¬ ledger.revoked id →
      LiveGrant ledger parent parentGrant → LiveGrant ledger id grant

def Applies (ledger : AuthorityLedger) (principal : PrincipalRef) (target : Scope)
    (permission : Permission) (grant : Grant) : Prop :=
  principal.tenant = target.tenantOf ∧ ledger.ActsUnder principal grant.subject ∧ grant.scope.Contains target ∧
  grant.permission = permission ∧ permission.resource.tenant = target.tenantOf

def Denied (ledger : AuthorityLedger) (principal : PrincipalRef) (target : Scope)
    (permission : Permission) : Prop :=
  ∃ id grant, ledger.LiveGrant id grant ∧ grant.effect = .deny ∧
    ledger.Applies principal target permission grant

def Authorized (ledger : AuthorityLedger) (principal : PrincipalRef)
    (header : InvocationHeader) (target : Scope) : Prop :=
  ∃ binding allow,
    ledger.bindings header.binding = some binding ∧ binding.domain = header.domain ∧
    binding.scope = target ∧ binding.facet = header.operation.facet ∧
    target.tenantOf = header.domain.tenant ∧
    ledger.LiveGrant binding.grant allow ∧ allow.effect = .allow ∧
    ledger.Applies principal target header.permission allow ∧
    ¬ ledger.Denied principal target header.permission

theorem deny_overrides {ledger : AuthorityLedger} {principal header target}
    (denied : ledger.Denied principal target header.permission) :
    ¬ ledger.Authorized principal header target := by
  intro authorized
  obtain ⟨_, _, _, _, _, _, _, _, _, _, noDeny⟩ := authorized
  exact noDeny denied

theorem authorized_binding_matches_operation_facet {ledger : AuthorityLedger}
    {principal header target} (authorized : ledger.Authorized principal header target) :
    ∃ binding, ledger.bindings header.binding = some binding ∧
      binding.facet = header.operation.facet := by
  obtain ⟨binding, _, lookup, _, _, facet, _⟩ := authorized
  exact ⟨binding, lookup, facet⟩

def PathEvidenceComplete (ledger : AuthorityLedger) (header : InvocationHeader)
    (target : Scope) : Prop :=
  header.pathEvidence.map PathEpoch.scope = target.orderedPath ∧
  ∀ evidence, evidence ∈ header.pathEvidence → evidence.epoch = ledger.epoch evidence.scope

def HolderCurrentFor (ledger : AuthorityLedger) (header : InvocationHeader) : Prop :=
  match header.lease with
  | none => True
  | some token => ∀ evidence, evidence ∈ header.pathEvidence →
      ledger.holderWatermark token.holder evidence.scope ≤ evidence.epoch

def deadlineBounded (ledger : AuthorityLedger) (resolution : Resolution) : Prop :=
  resolution.deadline.tick ≤ resolution.issuedAt.tick + ledger.maxDirectWindow ∧
  match resolution.header.lease, resolution.originalLeaseExpiry with
  | some _, some expiry => resolution.deadline.tick ≤ expiry.tick
  | none, none => True
  | _, _ => False

def issueResolution (ledger : AuthorityLedger) (resolution : Resolution) : AuthorityLedger :=
  { ledger with
    resolutions := tableSet ledger.resolutions resolution.id resolution
    issuedAuthorized := mark ledger.issuedAuthorized resolution.id }

def bumpScope (ledger : AuthorityLedger) (scope : Scope) : AuthorityLedger :=
  { ledger with epoch := fun candidate =>
      if candidate = scope then ledger.epoch candidate + 1 else ledger.epoch candidate }

def observeForHolder (ledger : AuthorityLedger) (holder : PrincipalRef) (target : Scope) :
    AuthorityLedger :=
  { ledger with holderWatermark := fun principal scope =>
      if principal = holder then
        if scope ∈ target.path then max (ledger.holderWatermark principal scope) (ledger.epoch scope)
        else ledger.holderWatermark principal scope
      else ledger.holderWatermark principal scope }

inductive AuthorityLabel where
  | issueGrant (id : GrantId)
  | delegate (id : GrantId)
  | bind (id : BindingId)
  | revoke (id : GrantId)
  | setTeamMember (team : TeamId) (principal : PrincipalId) (scope : Scope)
  | setForeignVerification (home : TenantId) (principal : PrincipalId) (scope : Scope)
  | resolve (resolution : Resolution)
  | observe (holder : PrincipalRef) (target : Scope)

inductive AuthorityStep : AuthorityLedger → AuthorityLabel → AuthorityLedger → Prop
  | issueGrant {ledger id grant} :
      ledger.grants id = none → grant.parent = none →
      grant.permission.resource.tenant = grant.scope.tenantOf →
      AuthorityStep ledger (.issueGrant id)
        { ledger.bumpScope grant.scope with grants := tableSet ledger.grants id grant }
  | delegate {ledger id grant parent parentGrant} :
      ledger.grants id = none → grant.parent = some parent →
      ledger.LiveGrant parent parentGrant → parentGrant.effect = .allow → grant.effect = .allow →
      grant.subject = parentGrant.subject → parentGrant.scope.Contains grant.scope →
      grant.permission = parentGrant.permission →
      AuthorityStep ledger (.delegate id)
        { ledger.bumpScope grant.scope with grants := tableSet ledger.grants id grant }
  | bind {ledger id binding grant} :
      ledger.LiveGrant binding.grant grant → grant.effect = .allow →
      binding.scope.tenantOf = binding.domain.tenant →
      AuthorityStep ledger (.bind id)
        { ledger.bumpScope binding.scope with bindings := tableSet ledger.bindings id binding }
  | revoke {ledger id grant} :
      ledger.grants id = some grant →
      AuthorityStep ledger (.revoke id) {
        ledger.bumpScope grant.scope with revoked := mark ledger.revoked id }
  | setTeamMember {ledger team principal scope} :
      AuthorityStep ledger (.setTeamMember team principal scope) {
        ledger.bumpScope scope with teamMembers := fun candidate member =>
          (candidate = team ∧ member = principal) ∨ ledger.teamMembers candidate member }
  | setForeignVerification {ledger home principal scope} :
      AuthorityStep ledger (.setForeignVerification home principal scope) {
        ledger.bumpScope scope with foreignVerified := fun candidate member =>
          (candidate = home ∧ member = principal) ∨ ledger.foreignVerified candidate member }
  | resolve {ledger resolution} :
      ledger.resolutions resolution.id = none →
      ledger.Authorized resolution.principal resolution.header resolution.targetScope →
      ledger.PathEvidenceComplete resolution.header resolution.targetScope →
      ledger.HolderCurrentFor resolution.header → ledger.deadlineBounded resolution →
      AuthorityStep ledger (.resolve resolution) (ledger.issueResolution resolution)
  | observe {ledger holder target} :
      AuthorityStep ledger (.observe holder target) (ledger.observeForHolder holder target)

def DirectResolutionUsable (ledger : AuthorityLedger) (resolution : Resolution)
    (header : InvocationHeader) (now : Time) : Prop :=
  ledger.resolutions resolution.id = some resolution ∧ ledger.issuedAuthorized resolution.id ∧
  resolution.header = header ∧ now.tick < resolution.deadline.tick ∧
  ledger.HolderCurrentFor header

def MediatedResolutionUsable (ledger : AuthorityLedger) (resolution : Resolution)
    (principal : PrincipalRef) (header : InvocationHeader) (target : Scope) : Prop :=
  ledger.resolutions resolution.id = some resolution ∧ resolution.header = header ∧
  ledger.Authorized principal header target ∧ ledger.PathEvidenceComplete header target

theorem resolution_issue_records_authorized_evidence {before after resolution}
    (step : AuthorityStep before (.resolve resolution) after) :
    after.issuedAuthorized resolution.id ∧
    before.Authorized resolution.principal resolution.header resolution.targetScope ∧
    before.deadlineBounded resolution := by
  cases step with
  | resolve fresh authorized complete holder deadline =>
      exact ⟨Or.inr rfl, authorized, deadline⟩

theorem bump_scope_stales_path_evidence {ledger : AuthorityLedger} {header : InvocationHeader}
    {target scope : Scope} {evidence : PathEpoch}
    (complete : ledger.PathEvidenceComplete header target)
    (evidenceMember : evidence ∈ header.pathEvidence) (evidenceScope : evidence.scope = scope) :
    ¬ (ledger.bumpScope scope).PathEvidenceComplete header target := by
  intro after
  have beforeEpoch := complete.2 evidence evidenceMember
  have afterEpoch := after.2 evidence evidenceMember
  rw [evidenceScope] at beforeEpoch afterEpoch
  rw [beforeEpoch] at afterEpoch
  simp [bumpScope] at afterEpoch

theorem delegated_allow_is_contained_and_not_wider {before after id}
    (step : AuthorityStep before (.delegate id) after) :
    ∃ child parent : Grant,
      after.grants id = some child ∧ child.effect = .allow ∧ parent.effect = .allow ∧
      parent.scope.Contains child.scope ∧ child.permission = parent.permission := by
  cases step with
  | delegate fresh parentEdge live parentAllow childAllow subject contained permission =>
      exact ⟨_, _, tableSet_self .., childAllow, parentAllow, contained, permission⟩

theorem direct_deadline_cannot_exceed_original_lease {ledger : AuthorityLedger}
    {resolution : Resolution}
    (bounded : ledger.deadlineBounded resolution)
    {token : LeaseToken} {expiry : Time} (lease : resolution.header.lease = some token)
    (original : resolution.originalLeaseExpiry = some expiry) :
    resolution.deadline.tick ≤ expiry.tick := by
  unfold deadlineBounded at bounded
  rw [lease, original] at bounded
  exact bounded.2

theorem holder_observation_joins_epoch {ledger : AuthorityLedger} {holder : PrincipalRef}
    {target scope : Scope}
    (member : scope ∈ target.path) :
    (ledger.observeForHolder holder target).holderWatermark holder scope =
      max (ledger.holderWatermark holder scope) (ledger.epoch scope) := by
  simp [observeForHolder, member]

theorem direct_holder_watermark_is_not_ahead {ledger : AuthorityLedger}
    {header : InvocationHeader} {token : LeaseToken} {evidence : PathEpoch}
    (lease : header.lease = some token) (current : ledger.HolderCurrentFor header)
    (member : evidence ∈ header.pathEvidence) :
    ledger.holderWatermark token.holder evidence.scope ≤ evidence.epoch := by
  unfold HolderCurrentFor at current
  rw [lease] at current
  exact current evidence member

end AuthorityLedger

end AgentCore
