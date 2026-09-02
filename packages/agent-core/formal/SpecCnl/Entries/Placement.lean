import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# Placement, floor, and custody vocabulary

Four paradigms, in the order the corpus exercises them.

**The placement decision.** `AgentCore.choosePlacement` is a function, not a transition
family, so the subject of a placement sentence is a `PlacementSnapshot` the model has
validated: `chosen placement` is `PlacementSnapshot.Valid`, and `bundled placement` and
`provider placement` narrow it to a selection. `admits` is the one relation the
intersection gives — this snapshot's four sets admit that mode — and it composes with the
`no` determiner and a mode common noun, so the preference order is stated as the
exclusions a selection implies rather than as an order relation the grammar has no
category for.

**The escalation floor.** `unbundled mode` and `yields the mediated tier` are about a
`Placement` alone, because `AgentCore.effectiveTier` reaches `direct` only through its
bundled branch whatever the impact, the Session fact, and the interception fact are.

**Direct admission.** `AgentCore.DirectStep` is a transition family over a `SystemState`
and an `AdmissionRequest`, so it binds to `TR` directly and the conditions on it are
ordinary `ST` entries — no lifter, because the request is the label rather than a payload
inside one. Two rule units share the family and contribute one condition each.

**Mediated admission and secret custody.** `AgentCore.MediatedReady` is a condition on a
state and a request, not a transition, so a mediated sentence quantifies over the request
and reads "in every state that admits it". The two custody entries reuse the §3.5 resolve
family and add the two lifters the existing `for the resolved secret` lifter cannot
supply: it passes the secret and the requesting Tenant, and the custody check needs the
presented Binding and the presented endpoint.

Every denotation is a term over `AgentCore` alone and names its projections explicitly, so
the emitted ledger records exactly which model constants an entry mentions.
-/

namespace SpecCnl.Entries.Placement

def entries : List LexEntry :=
  [ { id := "chosen.placement"
      surface := "chosen placement"
      category := "CN[AgentCore.PlacementSnapshot]"
      denotation := "AgentCore.PlacementSnapshot.Valid" },
    { id := "bundled.placement"
      surface := "bundled placement"
      category := "CN[AgentCore.PlacementSnapshot]"
      denotation :=
        "fun snapshot => AgentCore.PlacementSnapshot.Valid snapshot ∧ " ++
        "AgentCore.PlacementSnapshot.selected snapshot = AgentCore.Placement.bundled" },
    { id := "provider.placement"
      surface := "provider placement"
      category := "CN[AgentCore.PlacementSnapshot]"
      denotation :=
        "fun snapshot => AgentCore.PlacementSnapshot.Valid snapshot ∧ " ++
        "AgentCore.PlacementSnapshot.selected snapshot = AgentCore.Placement.provider" },
    { id := "selects.an.admissible.mode"
      surface := "selects an admissible mode"
      category := "NP[AgentCore.PlacementSnapshot]\\S"
      denotation :=
        "fun snapshot => AgentCore.PlacementSet.contains " ++
        "(AgentCore.placementIntersection " ++
        "(AgentCore.PlacementSnapshot.manifest snapshot) " ++
        "(AgentCore.PlacementSnapshot.policy snapshot) " ++
        "(AgentCore.PlacementSnapshot.substrate snapshot) " ++
        "(AgentCore.PlacementSnapshot.trust snapshot)) " ++
        "(AgentCore.PlacementSnapshot.selected snapshot) = true" },
    { id := "admits"
      surface := "admits"
      category :=
        "(NP[AgentCore.PlacementSnapshot]\\S)/NP[AgentCore.Placement]"
      denotation :=
        "fun mode snapshot => AgentCore.PlacementSet.contains " ++
        "(AgentCore.placementIntersection " ++
        "(AgentCore.PlacementSnapshot.manifest snapshot) " ++
        "(AgentCore.PlacementSnapshot.policy snapshot) " ++
        "(AgentCore.PlacementSnapshot.substrate snapshot) " ++
        "(AgentCore.PlacementSnapshot.trust snapshot)) mode = true" },
    { id := "unbundled.mode"
      surface := "unbundled mode"
      category := "CN[AgentCore.Placement]"
      denotation := "fun mode => mode ≠ AgentCore.Placement.bundled" },
    { id := "dynamic.mode"
      surface := "dynamic mode"
      category := "CN[AgentCore.Placement]"
      denotation := "fun mode => mode = AgentCore.Placement.dynamic" },
    { id := "yields.the.mediated.tier"
      surface := "yields the mediated tier"
      category := "NP[AgentCore.Placement]\\S"
      denotation :=
        "fun mode => ∀ impact sessionScoped sessionFilesystemTarget intercepted, " ++
        "AgentCore.effectiveTier mode impact sessionScoped sessionFilesystemTarget " ++
        "intercepted = AgentCore.EnforcementTier.mediated" },
    { id := "every.direct.admission"
      surface := "every direct admission"
      category := "TR[AgentCore.SystemState,AgentCore.AdmissionRequest]"
      denotation := "AgentCore.DirectStep" },
    { id := "a.bundled.selection"
      surface := "a bundled selection"
      category := "ST[AgentCore.SystemState,AgentCore.AdmissionRequest]"
      denotation :=
        "fun _ request => AgentCore.PlacementSnapshot.selected " ++
        "(AgentCore.InvocationHeader.placement (AgentCore.PreparedInvocation.header " ++
        "(AgentCore.AdmissionRequest.prepared request))) = AgentCore.Placement.bundled" },
    { id := "an.exact.turn.lease"
      surface := "an exact turn lease"
      category := "ST[AgentCore.SystemState,AgentCore.AdmissionRequest]"
      denotation :=
        "fun state request => ∃ token turn run, " ++
        "AgentCore.InvocationHeader.lease (AgentCore.PreparedInvocation.header " ++
        "(AgentCore.AdmissionRequest.prepared request)) = some token ∧ " ++
        "AgentCore.GraphStore.turns (AgentCore.SystemState.graph state) " ++
        "(AgentCore.LeaseToken.turn token) = some turn ∧ " ++
        "AgentCore.GraphStore.runs (AgentCore.SystemState.graph state) " ++
        "(AgentCore.Turn.run turn) = some run ∧ " ++
        "AgentCore.InvocationHeader.domain (AgentCore.PreparedInvocation.header " ++
        "(AgentCore.AdmissionRequest.prepared request)) = " ++
        "AgentCore.ProtectionDomain.run (AgentCore.Run.tenant run) (AgentCore.Turn.run turn) ∧ " ++
        "AgentCore.TurnPins.placement (AgentCore.Turn.pins turn) = " ++
        "AgentCore.InvocationHeader.placement (AgentCore.PreparedInvocation.header " ++
        "(AgentCore.AdmissionRequest.prepared request)) ∧ " ++
        "AgentCore.TurnLease.Admits (AgentCore.Turn.lease turn) token " ++
        "(AgentCore.AdmissionRequest.now request)" },
    { id := "unchanged.system.state"
      surface := "unchanged system state"
      category := "PR[AgentCore.SystemState]"
      denotation := "fun (before after : AgentCore.SystemState) => after = before" },
    { id := "an.observing.impact"
      surface := "an observing impact"
      category := "ST[AgentCore.SystemState,AgentCore.AdmissionRequest]"
      denotation :=
        "fun _ request => AgentCore.InvocationHeader.impact " ++
        "(AgentCore.PreparedInvocation.header (AgentCore.AdmissionRequest.prepared request)) = " ++
        "AgentCore.InvocationImpact.observe" },
    { id := "an.unapproved.operation"
      surface := "an unapproved operation"
      category := "ST[AgentCore.SystemState,AgentCore.AdmissionRequest]"
      denotation :=
        "fun _ request => " ++
        "AgentCore.requiresApproval (AgentCore.AdmissionRequest.prepared request) = false" },
    { id := "an.unintercepted.call"
      surface := "an unintercepted call"
      category := "ST[AgentCore.SystemState,AgentCore.AdmissionRequest]"
      denotation := "fun _ request => AgentCore.AdmissionRequest.interceptors request = []" },
    { id := "mediated.effect"
      surface := "mediated effect"
      category := "CN[AgentCore.AdmissionRequest]"
      denotation :=
        "fun request => AgentCore.effectiveTier " ++
        "(AgentCore.PlacementSnapshot.selected (AgentCore.InvocationHeader.placement " ++
        "(AgentCore.PreparedInvocation.header (AgentCore.AdmissionRequest.prepared request)))) " ++
        "(AgentCore.InvocationHeader.impact (AgentCore.PreparedInvocation.header " ++
        "(AgentCore.AdmissionRequest.prepared request))) " ++
        "(Option.isSome (AgentCore.InvocationHeader.lease " ++
        "(AgentCore.PreparedInvocation.header (AgentCore.AdmissionRequest.prepared request)))) " ++
        "false " ++
        "(AgentCore.AdmissionRequest.intercepted request) = " ++
        "AgentCore.EnforcementTier.mediated" },
    { id := "compares.the.current.path.epochs"
      surface := "compares the current path epochs"
      category := "NP[AgentCore.AdmissionRequest]\\S"
      denotation :=
        "fun request => ∀ state, AgentCore.MediatedReady state request → " ++
        "AgentCore.AuthorityLedger.PathEvidenceComplete (AgentCore.SystemState.authority state) " ++
        "(AgentCore.PreparedInvocation.header (AgentCore.AdmissionRequest.prepared request)) " ++
        "(AgentCore.AdmissionRequest.scope request)" },
    { id := "matches.the.open.reservation.epoch"
      surface := "matches the open reservation epoch"
      category := "NP[AgentCore.AdmissionRequest]\\S"
      denotation :=
        "fun request => ∀ state tenant run, AgentCore.MediatedReady state request → " ++
        "AgentCore.InvocationHeader.domain (AgentCore.PreparedInvocation.header " ++
        "(AgentCore.AdmissionRequest.prepared request)) = " ++
        "AgentCore.ProtectionDomain.run tenant run → ∃ reservation registry, " ++
        "AgentCore.AdmissionRequest.reservation request = some reservation ∧ " ++
        "AgentCore.GraphStore.admissionRegistry (AgentCore.SystemState.graph state) run = " ++
        "some registry ∧ AgentCore.RunAdmissionRegistry.accepting registry = true ∧ " ++
        "AgentCore.RunAdmissionRegistry.epoch registry = " ++
        "AgentCore.AdmissionReservation.epoch reservation ∧ " ++
        "AgentCore.AdmissionReservation.obligation reservation ∈ " ++
        "AgentCore.RunAdmissionRegistry.reserved registry ∧ " ++
        "AgentCore.AdmissionReservation.obligation reservation ∉ " ++
        "AgentCore.RunAdmissionRegistry.completed registry" },
    { id := "a.recorded.custody.endpoint"
      surface := "a recorded custody endpoint"
      category :=
        "RE[AgentCore.SecretLedger,AgentCore.SecretRef,AgentCore.SecretEndpoint]"
      denotation :=
        "fun ledger secret endpoint => ∃ custody, " ++
        "AgentCore.SecretLedger.custody ledger secret = some custody ∧ " ++
        "AgentCore.SecretCustody.endpoint custody = endpoint" },
    { id := "for.the.presented.endpoint"
      surface := "for the presented endpoint"
      category :=
        "RE[AgentCore.SecretLedger,AgentCore.SecretRef,AgentCore.SecretEndpoint]" ++
        "\\ST[AgentCore.SecretLedger,AgentCore.SecretLabel]"
      denotation :=
        "fun cond before label => ∀ id secret requester binding endpoint, " ++
        "label = AgentCore.SecretLabel.resolve id secret requester binding endpoint → " ++
        "cond before secret endpoint" },
    { id := "a.recorded.custody.binding"
      surface := "a recorded custody binding"
      category := "RE[AgentCore.SecretLedger,AgentCore.SecretRef,AgentCore.BindingId]"
      denotation :=
        "fun ledger secret binding => ∃ custody, " ++
        "AgentCore.SecretLedger.custody ledger secret = some custody ∧ " ++
        "AgentCore.SecretCustody.binding custody = binding" },
    { id := "for.the.presented.binding"
      surface := "for the presented binding"
      category :=
        "RE[AgentCore.SecretLedger,AgentCore.SecretRef,AgentCore.BindingId]" ++
        "\\ST[AgentCore.SecretLedger,AgentCore.SecretLabel]"
      denotation :=
        "fun cond before label => ∀ id secret requester binding endpoint, " ++
        "label = AgentCore.SecretLabel.resolve id secret requester binding endpoint → " ++
        "cond before secret binding" } ]

end SpecCnl.Entries.Placement
