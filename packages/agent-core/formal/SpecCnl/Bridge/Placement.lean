import SpecCnl.Sentences.Placement

/-!
# Hand propositions and bridge lemmas for §9.2, §7.2, and §3.5

Each `hand_X` is written directly over `AgentCore`. Every bridge here is `Iff.rfl`: no
entry in this group denotes `fun _ => True`, so there is no `True` to strip and no
existential to move, and the grammar's composition of the reviewed denotations is
definitionally the hand statement.

What that is worth is stated in `SpecCnl.Bridge`: the load-bearing declarations are the
discharges in `SpecCnl.Proofs.Placement`.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §9.2 `C13-PLACEMENT-INTERSECTION`, `C13-PLACEMENT-ORDER`, `C13-PLACEMENT-EMPTY` -/

def hand_C13_PLACEMENT_INTERSECTION : Prop :=
  ((∀ snapshot : PlacementSnapshot, snapshot.Valid →
      (placementIntersection snapshot.manifest snapshot.policy snapshot.substrate
        snapshot.trust).contains snapshot.selected = true) ∧
    ∀ snapshot : PlacementSnapshot,
      (snapshot.Valid ∧ snapshot.selected = Placement.bundled) →
        ∀ mode : Placement, mode ≠ Placement.bundled →
          ¬ (placementIntersection snapshot.manifest snapshot.policy snapshot.substrate
              snapshot.trust).contains mode = true) ∧
  ∀ snapshot : PlacementSnapshot,
    (snapshot.Valid ∧ snapshot.selected = Placement.provider) →
      ∀ mode : Placement, mode = Placement.dynamic →
        ¬ (placementIntersection snapshot.manifest snapshot.policy snapshot.substrate
            snapshot.trust).contains mode = true

theorem bridge_C13_PLACEMENT_INTERSECTION :
    Sentences.cnl_C13_PLACEMENT_INTERSECTION ↔ hand_C13_PLACEMENT_INTERSECTION := Iff.rfl

/-! ## §9.2 `C13-POLICY-DIRECT-ESCALATION` -/

def hand_C13_PLACEMENT_UNTRUSTED_BUNDLED : Prop :=
  ∀ mode : Placement, mode ≠ Placement.bundled →
    ∀ (impact : InvocationImpact) (sessionScoped intercepted : Bool),
      effectiveTier mode impact sessionScoped intercepted = EnforcementTier.mediated

theorem bridge_C13_PLACEMENT_UNTRUSTED_BUNDLED :
    Sentences.cnl_C13_PLACEMENT_UNTRUSTED_BUNDLED ↔
      hand_C13_PLACEMENT_UNTRUSTED_BUNDLED := Iff.rfl

/-! ## §7.2 `C13-POLICY-DIRECT-COLOCATION` -/

def hand_C13_POLICY_DIRECT_COLOCATION : Prop :=
  ((∀ (before : SystemState) (request : AdmissionRequest) (after : SystemState),
      DirectStep before request after →
        request.prepared.header.placement.selected = Placement.bundled) ∧
    ∀ (before : SystemState) (request : AdmissionRequest) (after : SystemState),
      DirectStep before request after →
        ∃ token turn run,
          request.prepared.header.lease = some token ∧
          before.graph.turns token.turn = some turn ∧
          before.graph.runs turn.run = some run ∧
          request.prepared.header.domain = ProtectionDomain.run run.tenant turn.run ∧
          turn.pins.placement = request.prepared.header.placement ∧
          turn.lease.Admits token request.now) ∧
  ∀ (before : SystemState) (request : AdmissionRequest) (after : SystemState),
    DirectStep before request after → after = before

theorem bridge_C13_POLICY_DIRECT_COLOCATION :
    Sentences.cnl_C13_POLICY_DIRECT_COLOCATION ↔ hand_C13_POLICY_DIRECT_COLOCATION := Iff.rfl

/-! ## §7.2 `C13-POLICY-MEDIATION-FLOOR`, `C13-POLICY-APPROVAL-FLOOR` -/

def hand_C13_POLICY_MEDIATION_FLOOR : Prop :=
  ((∀ (before : SystemState) (request : AdmissionRequest) (after : SystemState),
      DirectStep before request after →
        request.prepared.header.impact = InvocationImpact.observe) ∧
    ∀ (before : SystemState) (request : AdmissionRequest) (after : SystemState),
      DirectStep before request after → requiresApproval request.prepared = false) ∧
  ∀ (before : SystemState) (request : AdmissionRequest) (after : SystemState),
    DirectStep before request after → request.interceptors = []

theorem bridge_C13_POLICY_MEDIATION_FLOOR :
    Sentences.cnl_C13_POLICY_MEDIATION_FLOOR ↔ hand_C13_POLICY_MEDIATION_FLOOR := Iff.rfl

/-! ## §7.2 `C13-POLICY-EPOCH-RECHECK` -/

def hand_C13_POLICY_EPOCH_RECHECK : Prop :=
  (∀ request : AdmissionRequest,
      effectiveTier request.prepared.header.placement.selected
          request.prepared.header.impact request.prepared.header.lease.isSome
          request.intercepted = EnforcementTier.mediated →
        ∀ state : SystemState, MediatedReady state request →
          state.authority.PathEvidenceComplete request.prepared.header request.scope) ∧
  ∀ request : AdmissionRequest,
    effectiveTier request.prepared.header.placement.selected
        request.prepared.header.impact request.prepared.header.lease.isSome
        request.intercepted = EnforcementTier.mediated →
      ∀ (state : SystemState) (tenant : TenantId) (run : RunId),
        MediatedReady state request →
          request.prepared.header.domain = ProtectionDomain.run tenant run →
            ∃ reservation registry,
              request.reservation = some reservation ∧
              state.graph.admissionRegistry run = some registry ∧
              registry.accepting = true ∧ registry.epoch = reservation.epoch ∧
              reservation.obligation ∈ registry.reserved ∧
              reservation.obligation ∉ registry.completed

theorem bridge_C13_POLICY_EPOCH_RECHECK :
    Sentences.cnl_C13_POLICY_EPOCH_RECHECK ↔ hand_C13_POLICY_EPOCH_RECHECK := Iff.rfl

/-! ## §3.5 `C13-CONFIG-SECRET-CUSTODY` -/

def hand_C13_CONFIG_SECRET_CUSTODY : Prop :=
  (∀ (before : SecretLedger) (label : SecretLabel) (after : SecretLedger),
      ((∃ id secret requester binding endpoint,
          label = SecretLabel.resolve id secret requester binding endpoint) ∧
        SecretStep before label after) →
      ∀ id secret requester binding endpoint,
        label = SecretLabel.resolve id secret requester binding endpoint →
          ∃ custody, before.custody secret = some custody ∧
            custody.endpoint = endpoint) ∧
  ∀ (before : SecretLedger) (label : SecretLabel) (after : SecretLedger),
    ((∃ id secret requester binding endpoint,
        label = SecretLabel.resolve id secret requester binding endpoint) ∧
      SecretStep before label after) →
    ∀ id secret requester binding endpoint,
      label = SecretLabel.resolve id secret requester binding endpoint →
        ∃ custody, before.custody secret = some custody ∧ custody.binding = binding

theorem bridge_C13_CONFIG_SECRET_CUSTODY :
    Sentences.cnl_C13_CONFIG_SECRET_CUSTODY ↔ hand_C13_CONFIG_SECRET_CUSTODY := Iff.rfl

end SpecCnl.Bridge
