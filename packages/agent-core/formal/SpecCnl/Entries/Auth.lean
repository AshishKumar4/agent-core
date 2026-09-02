import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# Auth: the vocabulary of Memberships, Roles, Grants, Bindings, and mediated admission

Four paradigms, one per model plane the §3.3/§3.4 rule units are about.

* **The Grant-plane decision.** `AgentCore.evaluateExec` is a decision over an
  `AgentCore.AuthorityInput`, not a transition, so its rules are rendered with the
  `every <CN> <VP>` form: the common noun restricts which decisions are spoken about and
  the verb phrase says what holds of them. Neither entry is `fun _ => True`; both are
  real predicates over the input, so the noun refuses the wrong decision.
* **Role materialization.** Reuses the corpus's existing
  `every role materialization` family over `AgentCore.MaterializationStep`. Its label
  *is* the `AgentCore.Membership`, so a condition reads the Membership's own fields
  directly and needs no lifter; there is no label constructor to match.
* **The `AuthorityLedger` step family.** Two `TR` entries over
  `AgentCore.AuthorityLedger.AuthorityLabel` — the resolution issue and the delegation —
  and one lifter each, because a condition may not match a label constructor inside its
  own denotation. The resolution lifter is shared by four units.
* **Mediated admission.** Two `TR` entries over `AgentCore.MediatedLabel`, with the
  start's lifter carrying the Invocation and the stale denial's carrying the ReceiptId.

Every denotation is a term over `AgentCore` alone.
-/

namespace SpecCnl.Entries.Auth

def entries : List LexEntry :=
  [ { id := "admitted.authority.decision"
      surface := "admitted authority decision"
      category := "CN[AgentCore.AuthorityInput]"
      denotation :=
        "fun input => AgentCore.evaluateExec input = AgentCore.AuthorityDecision.allowed" },
    { id := "has.effective.authority"
      surface := "has effective authority"
      category := "NP[AgentCore.AuthorityInput]\\S"
      denotation :=
        "fun input => AgentCore.EffectiveAuthority " ++
        "(AgentCore.AuthorityInput.grants input) (AgentCore.AuthorityInput.request input)" },
    { id := "elevating.guest.request"
      surface := "elevating guest request"
      category := "CN[AgentCore.AuthorityInput]"
      denotation :=
        "fun input => AgentCore.AuthorityInput.guest input = true ∧ " ++
        "AgentCore.InvocationImpact.elevating (AgentCore.CapabilityIntent.impact " ++
        "(AgentCore.AuthorityRequest.intent (AgentCore.AuthorityInput.request input))) = true" },
    { id := "is.refused"
      surface := "is refused"
      category := "NP[AgentCore.AuthorityInput]\\S"
      denotation :=
        "fun input => AgentCore.evaluateExec input ≠ AgentCore.AuthorityDecision.allowed" },
    { id := "a.completed.verification.scheme"
      surface := "a completed verification scheme"
      category := "ST[AgentCore.AuthorityLedger,AgentCore.Membership]"
      denotation :=
        "fun _ membership => ∀ home id scheme, " ++
        "AgentCore.Membership.subject membership = " ++
        "AgentCore.Subject.foreign home id scheme → " ++
        "AgentCore.GuestScheme.completed scheme = true" },
    { id := "attenuated.guest.grants"
      surface := "attenuated guest grants"
      category := "PO[AgentCore.AuthorityLedger,AgentCore.Membership]"
      denotation :=
        "fun _ membership after => " ++
        "AgentCore.Subject.isForeign (AgentCore.Membership.subject membership) = true → " ++
        "∀ index grant, AgentCore.AuthorityLedger.grants after " ++
        "(AgentCore.GrantId.role (AgentCore.Membership.id membership) index) = some grant → " ++
        "AgentCore.Grant.effect grant = AgentCore.GrantEffect.allow → " ++
        "AgentCore.Action.elevated " ++
        "(AgentCore.Permission.action (AgentCore.Grant.permission grant)) = false" },
    { id := "an.advanced.scope.epoch"
      surface := "an advanced scope epoch"
      category := "PO[AgentCore.AuthorityLedger,AgentCore.Membership]"
      denotation :=
        "fun before membership after => " ++
        "AgentCore.AuthorityLedger.epoch before (AgentCore.Membership.scope membership) < " ++
        "AgentCore.AuthorityLedger.epoch after (AgentCore.Membership.scope membership)" },
    { id := "membership.assigned.grants.only"
      surface := "membership assigned grants only"
      category := "PO[AgentCore.AuthorityLedger,AgentCore.Membership]"
      denotation :=
        "fun before membership after => ∀ id grant, " ++
        "AgentCore.AuthorityLedger.grants after id = some grant → " ++
        "AgentCore.AuthorityLedger.grants before id = some grant ∨ " ++
        "∃ index, id = AgentCore.GrantId.role (AgentCore.Membership.id membership) index" },
    { id := "rule.ordinal.keyed.grants"
      surface := "rule ordinal keyed grants"
      category := "PO[AgentCore.AuthorityLedger,AgentCore.Membership]"
      denotation :=
        "fun _ membership after => ∀ index grant, " ++
        "AgentCore.AuthorityLedger.grants after " ++
        "(AgentCore.GrantId.role (AgentCore.Membership.id membership) index) = some grant → " ++
        "AgentCore.Grant.subject grant = AgentCore.Membership.subject membership ∧ " ++
        "AgentCore.Grant.scope grant = AgentCore.Membership.scope membership ∧ " ++
        "∃ role, AgentCore.Grant.source grant = " ++
        "AgentCore.GrantSource.roleRule (AgentCore.Membership.id membership) role index" },
    { id := "every.authority.resolution"
      surface := "every authority resolution"
      category := "TR[AgentCore.AuthorityLedger,AgentCore.AuthorityLedger.AuthorityLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ resolution, " ++
        "label = AgentCore.AuthorityLedger.AuthorityLabel.resolve resolution) ∧ " ++
        "AgentCore.AuthorityLedger.AuthorityStep before label after" },
    { id := "for.the.resolution"
      surface := "for the resolution"
      category :=
        "ST[AgentCore.AuthorityLedger,AgentCore.Resolution]" ++
        "\\ST[AgentCore.AuthorityLedger,AgentCore.AuthorityLedger.AuthorityLabel]"
      denotation :=
        "fun cond before label => ∀ resolution, " ++
        "label = AgentCore.AuthorityLedger.AuthorityLabel.resolve resolution → " ++
        "cond before resolution" },
    { id := "a.tenant.qualified.principal"
      surface := "a tenant qualified principal"
      category := "ST[AgentCore.AuthorityLedger,AgentCore.Resolution]"
      denotation :=
        "fun _ resolution => " ++
        "AgentCore.PrincipalRef.tenant (AgentCore.Resolution.principal resolution) = " ++
        "AgentCore.Scope.tenantOf (AgentCore.Resolution.targetScope resolution)" },
    { id := "an.exact.facet.binding"
      surface := "an exact facet binding"
      category := "ST[AgentCore.AuthorityLedger,AgentCore.Resolution]"
      denotation :=
        "fun ledger resolution => ∃ binding, " ++
        "AgentCore.AuthorityLedger.bindings ledger " ++
        "(AgentCore.InvocationHeader.binding (AgentCore.Resolution.header resolution)) = " ++
        "some binding ∧ " ++
        "AgentCore.Binding.facet binding = AgentCore.OperationId.facet " ++
        "(AgentCore.InvocationHeader.operation (AgentCore.Resolution.header resolution))" },
    { id := "an.exact.lease.expiry"
      surface := "an exact lease expiry"
      category := "ST[AgentCore.AuthorityLedger,AgentCore.Resolution]"
      denotation :=
        "fun _ resolution => ∀ token, " ++
        "AgentCore.InvocationHeader.lease (AgentCore.Resolution.header resolution) = " ++
        "some token → " ++
        "∃ expiry, AgentCore.Resolution.originalLeaseExpiry resolution = some expiry ∧ " ++
        "AgentCore.Time.tick (AgentCore.Resolution.deadline resolution) ≤ " ++
        "AgentCore.Time.tick expiry" },
    { id := "the.stated.deadline"
      surface := "the stated deadline"
      category := "NU[AgentCore.AuthorityLedger,AgentCore.Resolution]"
      denotation :=
        "fun _ resolution => AgentCore.Time.tick (AgentCore.Resolution.deadline resolution)" },
    { id := "the.bounded.window"
      surface := "the bounded window"
      category := "NU[AgentCore.AuthorityLedger,AgentCore.Resolution]"
      denotation :=
        "fun ledger resolution => " ++
        "AgentCore.Time.tick (AgentCore.Resolution.issuedAt resolution) + " ++
        "AgentCore.AuthorityLedger.maxDirectWindow ledger" },
    { id := "the.acting.principal.subject"
      surface := "the acting principal subject"
      category :=
        "RE[AgentCore.AuthorityLedger,AgentCore.PrincipalRef,AgentCore.PrincipalRef]"
      denotation :=
        "fun ledger caller subject => " ++
        "AgentCore.AuthorityLedger.ActsUnder ledger caller " ++
        "(AgentCore.Subject.principal subject)" },
    { id := "every.grant.delegation"
      surface := "every grant delegation"
      category := "TR[AgentCore.AuthorityLedger,AgentCore.AuthorityLedger.AuthorityLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ id, label = AgentCore.AuthorityLedger.AuthorityLabel.delegate id) ∧ " ++
        "AgentCore.AuthorityLedger.AuthorityStep before label after" },
    { id := "for.the.delegation"
      surface := "for the delegation"
      category :=
        "PX[AgentCore.AuthorityLedger,AgentCore.GrantId]" ++
        "\\PO[AgentCore.AuthorityLedger,AgentCore.AuthorityLedger.AuthorityLabel]"
      denotation :=
        "fun cond before label after => ∀ id, " ++
        "label = AgentCore.AuthorityLedger.AuthorityLabel.delegate id → " ++
        "cond before id after" },
    { id := "a.contained.allow"
      surface := "a contained allow"
      category := "PX[AgentCore.AuthorityLedger,AgentCore.GrantId]"
      denotation :=
        "fun before id after => ∃ child parentId parent, " ++
        "AgentCore.AuthorityLedger.grants after id = some child ∧ " ++
        "AgentCore.Grant.effect child = AgentCore.GrantEffect.allow ∧ " ++
        "AgentCore.Grant.parent child = some parentId ∧ " ++
        "AgentCore.AuthorityLedger.grants before parentId = some parent ∧ " ++
        "AgentCore.Grant.effect parent = AgentCore.GrantEffect.allow ∧ " ++
        "AgentCore.Scope.Contains " ++
        "(AgentCore.Grant.scope parent) (AgentCore.Grant.scope child) ∧ " ++
        "AgentCore.Grant.permission child = AgentCore.Grant.permission parent" },
    { id := "every.mediated.start"
      surface := "every mediated start"
      category := "TR[AgentCore.SystemState,AgentCore.MediatedLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ invocation attempt audit, " ++
        "label = AgentCore.MediatedLabel.start invocation attempt audit) ∧ " ++
        "AgentCore.MediatedStep before label after" },
    { id := "for.the.started.intent"
      surface := "for the started intent"
      category :=
        "ST[AgentCore.SystemState,AgentCore.InvocationId]" ++
        "\\ST[AgentCore.SystemState,AgentCore.MediatedLabel]"
      denotation :=
        "fun cond before label => ∀ invocation attempt audit, " ++
        "label = AgentCore.MediatedLabel.start invocation attempt audit → " ++
        "cond before invocation" },
    { id := "a.current.authority.path"
      surface := "a current authority path"
      category := "ST[AgentCore.SystemState,AgentCore.InvocationId]"
      denotation :=
        "fun state invocation => ∃ prepared resolution scope, " ++
        "AgentCore.EffectLedger.invocations (AgentCore.SystemState.effects state) invocation = " ++
        "some prepared ∧ " ++
        "AgentCore.AuthorityLedger.MediatedResolutionUsable " ++
        "(AgentCore.SystemState.authority state) resolution " ++
        "(AgentCore.AuthoritySource.principal (AgentCore.InvocationHeader.authority " ++
        "(AgentCore.PreparedInvocation.header prepared))) " ++
        "(AgentCore.PreparedInvocation.header prepared) scope" },
    { id := "every.stale.mediated.denial"
      surface := "every stale mediated denial"
      category := "TR[AgentCore.SystemState,AgentCore.MediatedLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ invocation receipt audit, " ++
        "label = AgentCore.MediatedLabel.staleDenied invocation receipt audit) ∧ " ++
        "AgentCore.MediatedStep before label after" },
    { id := "for.the.denied.receipt"
      surface := "for the denied receipt"
      category :=
        "PX[AgentCore.SystemState,AgentCore.ReceiptId]" ++
        "\\PO[AgentCore.SystemState,AgentCore.MediatedLabel]"
      denotation :=
        "fun cond before label after => ∀ invocation receipt audit, " ++
        "label = AgentCore.MediatedLabel.staleDenied invocation receipt audit → " ++
        "cond before receipt after" },
    { id := "a.matched.denial"
      surface := "a matched denial"
      category := "PX[AgentCore.SystemState,AgentCore.ReceiptId]"
      denotation :=
        "fun before receipt after => ∃ record prepared item, " ++
        "AgentCore.EffectLedger.preReceipts (AgentCore.SystemState.effects after) receipt = " ++
        "some record ∧ " ++
        "AgentCore.PreEffectReceipt.outcome record = AgentCore.PreEffectOutcome.denied ∧ " ++
        "AgentCore.EffectLedger.invocations (AgentCore.SystemState.effects before) " ++
        "(AgentCore.PreEffectReceipt.invocation record) = some prepared ∧ " ++
        "(AgentCore.PreparedInvocation.items prepared)" ++
        "[AgentCore.PreEffectReceipt.itemIndex record]? = some item" } ]

end SpecCnl.Entries.Auth
