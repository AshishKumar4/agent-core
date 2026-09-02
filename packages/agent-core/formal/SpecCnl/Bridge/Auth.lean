import SpecCnl.Sentences.Auth

/-!
# Hand propositions and bridges for the Auth group

Each `hand_` proposition below is written directly over `AgentCore` from the rule unit,
and each bridge is the kernel-checked identification of it with what the grammar composed.
Every bridge here is `Iff.rfl`: the grammar's composition of the group's lexicon
denotations is definitionally the hand statement, so the bridge adds nothing beyond
typechecking and the load-bearing content is in `SpecCnl.Proofs`.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §3.3 `C13-AUTH-DENY-PRECEDENCE` -/

def hand_C13_AUTH_DENY_PRECEDENCE : Prop :=
  ∀ (input : AuthorityInput), evaluateExec input = AuthorityDecision.allowed →
    EffectiveAuthority input.grants input.request

theorem bridge_C13_AUTH_DENY_PRECEDENCE :
    Sentences.cnl_C13_AUTH_DENY_PRECEDENCE ↔ hand_C13_AUTH_DENY_PRECEDENCE := Iff.rfl

/-! ## §3.3 `C13-AUTH-GUEST-ELEVATION` -/

def hand_C13_AUTH_GUEST_ELEVATION : Prop :=
  (∀ (input : AuthorityInput),
      (input.guest = true ∧ input.request.intent.impact.elevating = true) →
      evaluateExec input ≠ AuthorityDecision.allowed) ∧
    ∀ (before : AuthorityLedger) (membership : Membership) (after : AuthorityLedger),
      (∃ role, MaterializationStep before membership role after) →
        membership.subject.isForeign = true →
        ∀ index grant, after.grants (GrantId.role membership.id index) = some grant →
          grant.effect = GrantEffect.allow →
          grant.permission.action.elevated = false

theorem bridge_C13_AUTH_GUEST_ELEVATION :
    Sentences.cnl_C13_AUTH_GUEST_ELEVATION ↔ hand_C13_AUTH_GUEST_ELEVATION := Iff.rfl

/-! ## §3.3 `C13-AUTH-GUEST-HANDSHAKE-BOOTSTRAP` -/

def hand_C13_AUTH_GUEST_HANDSHAKE_BOOTSTRAP : Prop :=
  ∀ (before : AuthorityLedger) (membership : Membership) (after : AuthorityLedger),
    (∃ role, MaterializationStep before membership role after) →
      ∀ home id scheme, membership.subject = Subject.foreign home id scheme →
        scheme.completed = true

theorem bridge_C13_AUTH_GUEST_HANDSHAKE_BOOTSTRAP :
    Sentences.cnl_C13_AUTH_GUEST_HANDSHAKE_BOOTSTRAP ↔
      hand_C13_AUTH_GUEST_HANDSHAKE_BOOTSTRAP := Iff.rfl

/-! ## §1.4 `C13-AUTH-PRINCIPAL-REF` -/

def hand_C13_AUTH_PRINCIPAL_REF : Prop :=
  (∀ (before : AuthorityLedger) (label : AuthorityLedger.AuthorityLabel)
      (after : AuthorityLedger),
      ((∃ resolution, label = AuthorityLedger.AuthorityLabel.resolve resolution) ∧
        AuthorityLedger.AuthorityStep before label after) →
      ∀ resolution, label = AuthorityLedger.AuthorityLabel.resolve resolution →
        resolution.principal.tenant = resolution.targetScope.tenantOf) ∧
    ∀ (ledger : AuthorityLedger) (caller left right : PrincipalRef),
      ledger.ActsUnder caller (Subject.principal left) →
      ledger.ActsUnder caller (Subject.principal right) → left = right

theorem bridge_C13_AUTH_PRINCIPAL_REF :
    Sentences.cnl_C13_AUTH_PRINCIPAL_REF ↔ hand_C13_AUTH_PRINCIPAL_REF := Iff.rfl

/-! ## §3.3 `C13-AUTH-PLANE` -/

def hand_C13_AUTH_PLANE : Prop :=
  (∀ (before : AuthorityLedger) (membership : Membership) (after : AuthorityLedger),
      (∃ role, MaterializationStep before membership role after) →
        ∀ id grant, after.grants id = some grant →
          before.grants id = some grant ∨
            ∃ index, id = GrantId.role membership.id index) ∧
    ∀ (before : AuthorityLedger) (membership : Membership) (after : AuthorityLedger),
      (∃ role, MaterializationStep before membership role after) →
        before.epoch membership.scope < after.epoch membership.scope

theorem bridge_C13_AUTH_PLANE :
    Sentences.cnl_C13_AUTH_PLANE ↔ hand_C13_AUTH_PLANE := Iff.rfl

/-! ## §3.3 `C13-AUTH-ROLE-MATERIALIZATION` -/

def hand_C13_AUTH_ROLE_MATERIALIZATION : Prop :=
  ∀ (before : AuthorityLedger) (membership : Membership) (after : AuthorityLedger),
    (∃ role, MaterializationStep before membership role after) →
      ∀ index grant, after.grants (GrantId.role membership.id index) = some grant →
        grant.subject = membership.subject ∧ grant.scope = membership.scope ∧
          ∃ role, grant.source = GrantSource.roleRule membership.id role index

theorem bridge_C13_AUTH_ROLE_MATERIALIZATION :
    Sentences.cnl_C13_AUTH_ROLE_MATERIALIZATION ↔
      hand_C13_AUTH_ROLE_MATERIALIZATION := Iff.rfl

/-! ## §3.4 `C13-AUTH-BINDING-RESOLUTION` -/

def hand_C13_AUTH_BINDING_RESOLUTION : Prop :=
  (∀ (before : AuthorityLedger) (label : AuthorityLedger.AuthorityLabel)
      (after : AuthorityLedger),
      ((∃ id, label = AuthorityLedger.AuthorityLabel.delegate id) ∧
        AuthorityLedger.AuthorityStep before label after) →
      ∀ id, label = AuthorityLedger.AuthorityLabel.delegate id →
        ∃ child parentId parent,
          after.grants id = some child ∧ child.effect = GrantEffect.allow ∧
          child.parent = some parentId ∧ before.grants parentId = some parent ∧
          parent.effect = GrantEffect.allow ∧ parent.scope.Contains child.scope ∧
          child.permission = parent.permission) ∧
    ∀ (before : AuthorityLedger) (label : AuthorityLedger.AuthorityLabel)
        (after : AuthorityLedger),
      ((∃ resolution, label = AuthorityLedger.AuthorityLabel.resolve resolution) ∧
        AuthorityLedger.AuthorityStep before label after) →
      ∀ resolution, label = AuthorityLedger.AuthorityLabel.resolve resolution →
        ∃ binding, before.bindings resolution.header.binding = some binding ∧
          binding.facet = resolution.header.operation.facet

theorem bridge_C13_AUTH_BINDING_RESOLUTION :
    Sentences.cnl_C13_AUTH_BINDING_RESOLUTION ↔
      hand_C13_AUTH_BINDING_RESOLUTION := Iff.rfl

/-! ## §3.4 `C13-AUTH-MEDIATED-STALE`, `C13-AUTH-MEDIATED-ADMISSION` -/

def hand_C13_AUTH_MEDIATED_STALE : Prop :=
  (∀ (before : SystemState) (label : MediatedLabel) (after : SystemState),
      ((∃ invocation attempt audit,
          label = MediatedLabel.start invocation attempt audit) ∧
        MediatedStep before label after) →
      ∀ invocation attempt audit, label = MediatedLabel.start invocation attempt audit →
        ∃ prepared resolution scope,
          before.effects.invocations invocation = some prepared ∧
          before.authority.MediatedResolutionUsable resolution
            prepared.header.authority.principal prepared.header scope) ∧
    ∀ (before : SystemState) (label : MediatedLabel) (after : SystemState),
      ((∃ invocation receipt audit,
          label = MediatedLabel.staleDenied invocation receipt audit) ∧
        MediatedStep before label after) →
      ∀ invocation receipt audit,
        label = MediatedLabel.staleDenied invocation receipt audit →
          ∃ record prepared item,
            after.effects.preReceipts receipt = some record ∧
            record.outcome = PreEffectOutcome.denied ∧
            before.effects.invocations record.invocation = some prepared ∧
            prepared.items[record.itemIndex]? = some item

theorem bridge_C13_AUTH_MEDIATED_STALE :
    Sentences.cnl_C13_AUTH_MEDIATED_STALE ↔ hand_C13_AUTH_MEDIATED_STALE := Iff.rfl

/-! ## §3.4 `C13-AUTH-RESOLUTION-LIFETIME` -/

def hand_C13_AUTH_RESOLUTION_LIFETIME : Prop :=
  (∀ (before : AuthorityLedger) (label : AuthorityLedger.AuthorityLabel)
      (after : AuthorityLedger),
      ((∃ resolution, label = AuthorityLedger.AuthorityLabel.resolve resolution) ∧
        AuthorityLedger.AuthorityStep before label after) →
      ∀ resolution, label = AuthorityLedger.AuthorityLabel.resolve resolution →
        resolution.deadline.tick ≤ resolution.issuedAt.tick + before.maxDirectWindow) ∧
    ∀ (before : AuthorityLedger) (label : AuthorityLedger.AuthorityLabel)
        (after : AuthorityLedger),
      ((∃ resolution, label = AuthorityLedger.AuthorityLabel.resolve resolution) ∧
        AuthorityLedger.AuthorityStep before label after) →
      ∀ resolution, label = AuthorityLedger.AuthorityLabel.resolve resolution →
        ∀ token, resolution.header.lease = some token →
          ∃ expiry, resolution.originalLeaseExpiry = some expiry ∧
            resolution.deadline.tick ≤ expiry.tick

theorem bridge_C13_AUTH_RESOLUTION_LIFETIME :
    Sentences.cnl_C13_AUTH_RESOLUTION_LIFETIME ↔
      hand_C13_AUTH_RESOLUTION_LIFETIME := Iff.rfl

end SpecCnl.Bridge
