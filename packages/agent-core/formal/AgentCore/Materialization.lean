import AgentCore.View

/-! Role rules materialize into the canonical Grant plane; guest is derived from Subject.foreign.
Materialization is itself the security event: it mints a durable, enumerable, delegable Grant,
so a foreign subject materializes only against a verification fact the ledger already holds.
That premise is independent of the `foreignVerified` gate on `AuthorityLedger.ActsUnder`, which
re-checks the fact at authorization time and so closes the later window. -/

namespace AgentCore

def Action.elevated : Action → Bool | .delegate | .administer => true | _ => false
def Subject.isForeign : Subject → Bool | .foreign _ _ _ => true | _ => false

def roleRuleEligible (membership : Membership) (rule : RoleRule) : Bool :=
  match rule.effect with
  | .deny => true
  | .allow => !membership.subject.isForeign || !rule.permission.action.elevated

def grantOfRoleRule (membership : Membership) (role : Role) (index : Nat)
    (rule : RoleRule) : Grant :=
  ⟨membership.subject, membership.scope, rule.effect, rule.permission, none,
    .roleRule membership.id role.id index⟩

def materializeRole (ledger : AuthorityLedger) (membership : Membership)
    (role : Role) : AuthorityLedger :=
  { ledger with grants := fun id =>
      match id with
      | .role membershipId index =>
          if membershipId = membership.id then
            match role.rules[index]? with
            | some rule => if roleRuleEligible membership rule then
                some (grantOfRoleRule membership role index rule) else none
            | none => none
          else ledger.grants id
      | .manual _ => ledger.grants id }

/-- `handshake` is the one-time bootstrap exchange; it downgrades all future verifications to
`token` and never materializes a Grant itself, so only `token` and `callback` are completed. -/
def GuestScheme.completed : GuestScheme → Bool
  | .token | .callback => true
  | .handshake => false

/-- The before-materialization guest gate. A local subject carries no such precondition; a
foreign subject requires a completed verification scheme and the host's recorded verification
of its home Tenant and Principal. -/
def AuthorityLedger.SubjectVerified (ledger : AuthorityLedger) : Subject → Prop
  | .principal _ | .team _ => True
  | .foreign home id scheme => scheme.completed = true ∧ ledger.foreignVerified home id

inductive MaterializationStep : AuthorityLedger → Membership → Role → AuthorityLedger → Prop
  | rematerialize {ledger membership role} :
      membership.role = role.id →
      ledger.SubjectVerified membership.subject →
      MaterializationStep ledger membership role
        (materializeRole (ledger.bumpScope membership.scope) membership role)

theorem guest_allow_is_attenuated {ledger membership role index rule}
    (foreign : membership.subject.isForeign = true)
    (lookup : role.rules[index]? = some rule) (allow : rule.effect = .allow)
    (elevated : rule.permission.action.elevated = true) :
    (materializeRole ledger membership role).grants (.role membership.id index) = none := by
  simp [materializeRole, lookup, roleRuleEligible, foreign, allow, elevated]

theorem guest_deny_is_preserved {ledger membership role index rule}
    (_foreign : membership.subject.isForeign = true)
    (lookup : role.rules[index]? = some rule) (deny : rule.effect = .deny) :
    (materializeRole ledger membership role).grants (.role membership.id index) =
      some (grantOfRoleRule membership role index rule) := by
  simp [materializeRole, lookup, roleRuleEligible, deny]

theorem rematerialization_advances_epoch {before after membership role}
    (step : MaterializationStep before membership role after) :
    before.epoch membership.scope < after.epoch membership.scope := by
  cases step
  simp [materializeRole, AuthorityLedger.bumpScope]

/-- The strengthened premise is load-bearing: no Role materialization of a foreign subject
exists without the host's verification fact standing in the ledger the step reads. -/
theorem materialization_requires_verified_guest {before after membership role home id scheme}
    (subject : membership.subject = .foreign home id scheme)
    (step : MaterializationStep before membership role after) :
    before.foreignVerified home id := by
  cases step with
  | rematerialize _ verified =>
      rw [subject] at verified
      exact verified.2

/-- A subject still stamped `handshake` at materialization is denied: the bootstrap scheme is
never a completed verification, so no Role materialization of it exists in any ledger. -/
theorem handshake_guest_never_materializes {before after membership role home id}
    (subject : membership.subject = .foreign home id .handshake) :
    ¬ MaterializationStep before membership role after := by
  intro step
  cases step with
  | rematerialize _ verified =>
      rw [subject] at verified
      simp [AuthorityLedger.SubjectVerified, GuestScheme.completed] at verified

end AgentCore
