import AgentCore.View

/-! Role rules materialize into the canonical Grant plane; guest is derived from Subject.foreign. -/

namespace AgentCore

def Action.elevated : Action → Bool | .delegate | .administer => true | _ => false
def Subject.isForeign : Subject → Bool | .foreign _ _ => true | _ => false

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

inductive MaterializationStep : AuthorityLedger → Membership → Role → AuthorityLedger → Prop
  | rematerialize {ledger membership role} :
      membership.role = role.id →
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

end AgentCore
