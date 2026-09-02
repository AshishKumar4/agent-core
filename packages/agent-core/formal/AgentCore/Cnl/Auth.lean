import AgentCore.Proofs.Safety

/-!
# Consequences of the existing authority model the controlled language needs

Every theorem here reads only definitions that already stand — `AuthorityLedger` with its
`AuthorityStep`, `materializeRole` with `MaterializationStep`, and `MediatedStep` — and
none of them gains, loses, or reshapes a premise. They exist because the §3.3/§3.4 rule
units name facts the model implies without ever spelling them out: that a live Grant is a
stored Grant, that a delegation names its live allow parent, that materialization writes
only Grants keyed by the assigning Membership, and that a mediated start has already
compared canonical authority against current path epochs.
-/

namespace AgentCore

/-- A case split on an `Option` that keeps the equation stated against the original
expression, which `cases h : e` does not: it substitutes the pattern into `h` as well. -/
private theorem option_cases {α : Type _} (value : Option α) :
    value = none ∨ ∃ inner, value = some inner := by
  cases value with
  | none => exact Or.inl rfl
  | some inner => exact Or.inr ⟨inner, rfl⟩

/-! ## The abstract Grant plane (§3.4) -/

/-- **A live Grant is a stored Grant.** Both `LiveGrant` constructors carry the lookup, so
the liveness relation never names a Grant the ledger does not hold. -/
theorem live_grant_is_stored {ledger : AuthorityLedger} {id : GrantId} {grant : Grant}
    (live : ledger.LiveGrant id grant) : ledger.grants id = some grant := by
  cases live with
  | root lookup _ _ => exact lookup
  | child lookup _ _ _ => exact lookup

/-- **A delegation names a live allow parent it does not widen.** SPEC §3.4's "an allow may
be delegated only to an equal or narrower capability; a deny is not callable or delegable",
stated over the step that performs the delegation: the child is an allow, its recorded
parent pointer resolves in the ledger the step read, that parent is itself an allow whose
Scope contains the child's, and the permission is unchanged. -/
theorem delegation_names_contained_allow_parent {before after : AuthorityLedger} {id : GrantId}
    (step : AuthorityLedger.AuthorityStep before (.delegate id) after) :
    ∃ child parentId parent,
      after.grants id = some child ∧ child.effect = GrantEffect.allow ∧
      child.parent = some parentId ∧ before.grants parentId = some parent ∧
      parent.effect = GrantEffect.allow ∧ parent.scope.Contains child.scope ∧
      child.permission = parent.permission := by
  cases step with
  | delegate _ parentEdge live parentAllow childAllow _ contained permission =>
      exact ⟨_, _, _, tableSet_self .., childAllow, parentEdge, live_grant_is_stored live,
        parentAllow, contained, permission⟩

/-- **A caller acts under exactly one Principal subject.** `ActsUnder` reads a Principal
subject as the tenant-qualified reference it names and nothing else, so two Principal
subjects one caller acts under are the same reference — which is what makes an unqualified
id or a mismatched Tenant a refusal rather than a second way to name the same caller
(§1.4). -/
theorem acts_under_principal_subject_is_unique {ledger : AuthorityLedger}
    {caller left right : PrincipalRef}
    (leftActs : ledger.ActsUnder caller (.principal left))
    (rightActs : ledger.ActsUnder caller (.principal right)) : left = right := by
  have leftEq : left = caller := leftActs
  have rightEq : right = caller := rightActs
  exact leftEq.trans rightEq.symm

/-! ## Issued resolution evidence (§3.4) -/

/-- **An issued resolution names a Principal of the target Scope's own Tenant.** The
`Applies` conjunct of `Authorized` is where §1.4's "a mismatched tenant rejects" is
enforced on the authority path. -/
theorem resolution_principal_is_tenant_qualified {before after : AuthorityLedger}
    {resolution : Resolution}
    (step : AuthorityLedger.AuthorityStep before (.resolve resolution) after) :
    resolution.principal.tenant = resolution.targetScope.tenantOf := by
  obtain ⟨_, authorized, _⟩ := AuthorityLedger.resolution_issue_records_authorized_evidence step
  obtain ⟨_, _, _, _, _, _, _, _, _, applies, _⟩ := authorized
  exact applies.1

/-- **An issued resolution's Binding names the Facet of the Operation it authorizes.** SPEC
§3.4's "a Binding authorizes only the Operations of the Facet it names", read off the
resolution the resolver issued. -/
theorem resolution_binding_matches_operation_facet {before after : AuthorityLedger}
    {resolution : Resolution}
    (step : AuthorityLedger.AuthorityStep before (.resolve resolution) after) :
    ∃ binding, before.bindings resolution.header.binding = some binding ∧
      binding.facet = resolution.header.operation.facet := by
  obtain ⟨_, authorized, _⟩ := AuthorityLedger.resolution_issue_records_authorized_evidence step
  exact AuthorityLedger.authorized_binding_matches_operation_facet authorized

/-- **An issued resolution's deadline sits inside the configured direct window.** -/
theorem resolution_deadline_is_window_bounded {before after : AuthorityLedger}
    {resolution : Resolution}
    (step : AuthorityLedger.AuthorityStep before (.resolve resolution) after) :
    resolution.deadline.tick ≤ resolution.issuedAt.tick + before.maxDirectWindow := by
  obtain ⟨_, _, bounded⟩ := AuthorityLedger.resolution_issue_records_authorized_evidence step
  exact bounded.1

/-- **A lease-carrying resolution records the incarnation's own expiry and never outlives
it.** SPEC §3.4 rule 8's "a held or cached resolution admits only while it still names the
exact current LeaseToken for that Turn": a resolution whose header carries a lease has a
recorded original expiry, and its deadline is at or before that expiry. -/
theorem resolution_lease_deadline_is_lease_bounded {before after : AuthorityLedger}
    {resolution : Resolution} {token : LeaseToken}
    (step : AuthorityLedger.AuthorityStep before (.resolve resolution) after)
    (lease : resolution.header.lease = some token) :
    ∃ expiry, resolution.originalLeaseExpiry = some expiry ∧
      resolution.deadline.tick ≤ expiry.tick := by
  obtain ⟨_, _, bounded⟩ := AuthorityLedger.resolution_issue_records_authorized_evidence step
  rcases option_cases resolution.originalLeaseExpiry with absent | ⟨expiry, present⟩
  · unfold AuthorityLedger.deadlineBounded at bounded
    rw [lease, absent] at bounded
    exact bounded.2.elim
  · exact ⟨expiry, present,
      AuthorityLedger.direct_deadline_cannot_exceed_original_lease bounded lease present⟩

/-! ## Role materialization (§3.3) -/

/-- The Grant a materialization holds at one ordinal of the assigned Membership comes from
the Role rule at that same ordinal, and only when the eligibility filter admitted it. -/
private theorem materialize_role_grant_is_eligible_rule {ledger : AuthorityLedger}
    {membership : Membership} {role : Role} {index : Nat} {grant : Grant}
    (stored : (materializeRole ledger membership role).grants
      (GrantId.role membership.id index) = some grant) :
    ∃ rule, role.rules[index]? = some rule ∧ roleRuleEligible membership rule = true ∧
      grant = grantOfRoleRule membership role index rule := by
  rcases option_cases role.rules[index]? with absent | ⟨rule, lookup⟩
  · have reduced : (materializeRole ledger membership role).grants
        (GrantId.role membership.id index) = none := by simp [materializeRole, absent]
    rw [reduced] at stored
    simp at stored
  · by_cases eligible : roleRuleEligible membership rule = true
    · have reduced : (materializeRole ledger membership role).grants
          (GrantId.role membership.id index) =
          some (grantOfRoleRule membership role index rule) := by
        simp [materializeRole, lookup, eligible]
      rw [reduced] at stored
      exact ⟨rule, lookup, eligible, (Option.some.inj stored).symm⟩
    · have refused : roleRuleEligible membership rule = false := by
        simpa using eligible
      have reduced : (materializeRole ledger membership role).grants
          (GrantId.role membership.id index) = none := by
        simp [materializeRole, lookup, refused]
      rw [reduced] at stored
      simp at stored

/-- **A materialized Grant is keyed by the Membership and the Role rule's ordinal.** SPEC
§3.3's "one durable allow- or deny-Grant per Role rule, identified by `(membership, rule
ordinal)`": the Grant standing at ordinal `index` carries the Membership's own subject and
Scope and records that same ordinal as its source, so the stable rule order the
materializer walks is the order the Grant plane keeps. -/
theorem materialized_grant_is_ordinal_keyed {before after : AuthorityLedger}
    {membership : Membership} {role : Role} {index : Nat} {grant : Grant}
    (step : MaterializationStep before membership role after)
    (stored : after.grants (GrantId.role membership.id index) = some grant) :
    grant.subject = membership.subject ∧ grant.scope = membership.scope ∧
      grant.source = GrantSource.roleRule membership.id role.id index := by
  cases step
  obtain ⟨_, _, _, shape⟩ := materialize_role_grant_is_eligible_rule stored
  subst shape
  exact ⟨rfl, rfl, rfl⟩

/-- **Materialization introduces no Grant outside the assigning Membership's key space.**
Every Grant the ledger holds after a Role materialization it either already held, or is
keyed `(membership, ordinal)` for the Membership that was assigned — so a Role is a template
and becomes authority only where a Membership assigns it (§3.3). -/
theorem materialization_writes_only_membership_keyed_grants {before after : AuthorityLedger}
    {membership : Membership} {role : Role} {id : GrantId} {grant : Grant}
    (step : MaterializationStep before membership role after)
    (stored : after.grants id = some grant) :
    before.grants id = some grant ∨ ∃ index, id = GrantId.role membership.id index := by
  cases step
  cases id with
  | manual _ =>
      refine Or.inl ?_
      simpa [materializeRole, AuthorityLedger.bumpScope] using stored
  | role membershipId index =>
      by_cases same : membershipId = membership.id
      · exact Or.inr ⟨index, by rw [same]⟩
      · refine Or.inl ?_
        simpa [materializeRole, AuthorityLedger.bumpScope, same] using stored

/-- **A guest's materialized Grants carry no elevated allow.** The eligibility filter drops
exactly the allow rules a foreign subject may not receive, so no `delegate` or `administer`
allow-Grant of a guest Membership exists in any ledger a materialization produced (§3.3,
C13-AUTH-GUEST-ELEVATION). -/
theorem guest_materialization_has_no_elevated_allow {before after : AuthorityLedger}
    {membership : Membership} {role : Role} {index : Nat} {grant : Grant}
    (step : MaterializationStep before membership role after)
    (foreign : membership.subject.isForeign = true)
    (stored : after.grants (GrantId.role membership.id index) = some grant)
    (allow : grant.effect = GrantEffect.allow) :
    grant.permission.action.elevated = false := by
  cases step
  obtain ⟨rule, _, eligible, shape⟩ := materialize_role_grant_is_eligible_rule stored
  subst shape
  simp only [grantOfRoleRule] at allow ⊢
  have expand : (!membership.subject.isForeign || !rule.permission.action.elevated) = true := by
    simpa [roleRuleEligible, allow] using eligible
  simpa [foreign] using expand

/-- **Every Role materialization reads a completed verification scheme off a foreign
subject.** `handshake` is the bootstrap exchange and is never a completed verification, so
this is the positive form of §3.3's "a subject still stamped `handshake` at materialization
MUST be denied". -/
theorem materialization_requires_completed_scheme {before after : AuthorityLedger}
    {membership : Membership} {role : Role} {home : TenantId} {id : PrincipalId}
    {scheme : GuestScheme}
    (subject : membership.subject = .foreign home id scheme)
    (step : MaterializationStep before membership role after) :
    scheme.completed = true := by
  cases step with
  | rematerialize _ verified =>
      rw [subject] at verified
      exact verified.1

/-! ## Mediated admission (§3.4 rule 7) -/

/-- **A mediated first attempt has already rechecked canonical authority and current path
epochs against the exact persisted intent.** The label's Invocation is the persisted
`PreparedInvocation`'s own, and the resolution the admission used is recorded, carries that
exact header, is authorized for it, and holds complete path evidence — SPEC §3.4 rule 7's
final admission comparison, stated over the step that admits the EffectAttempt. -/
theorem mediated_start_rechecks_authority_path {before after : SystemState}
    {invocation : InvocationId} {attempt : AttemptId} {audit : AuditId}
    (step : MediatedStep before (.start invocation attempt audit) after) :
    ∃ prepared resolution scope,
      before.effects.invocations invocation = some prepared ∧
      before.authority.MediatedResolutionUsable resolution
        prepared.header.authority.principal prepared.header scope := by
  cases step with
  | start ready _ _ persisted _ _ _ _ =>
      obtain ⟨resolution, usable⟩ := mediated_rechecks_current_authority_path ready
      exact ⟨_, resolution, _, persisted, usable⟩

end AgentCore
