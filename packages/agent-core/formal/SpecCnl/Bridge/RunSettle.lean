import SpecCnl.Sentences.RunSettle

/-!
# Hand propositions and bridges for the RunSettle group (§5.2)

Each `hand_` proposition is written directly over `AgentCore` from the rule unit. Four
bridges are `Iff.rfl`: the grammar's composition of the group's reviewed denotations is
definitionally the hand statement. `C13_RUN_ACCEPTANCE_SUBJECT` gets a real proof, because
its second clause quantifies over the `system state` type-as-common-noun entry whose `True`
the hand proposition does not repeat.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §5.2 `C13-RUN-ADMISSION-REGISTRY`, `C13-RUN-RESERVATION-EPOCH` -/

def hand_C13_RUN_ADMISSION_REGISTRY : Prop :=
  (∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ run epoch obligation,
          label = GraphLabel.completeObligation run epoch obligation) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ run epoch obligation, label = GraphLabel.completeObligation run epoch obligation →
        ∃ registry, before.admissionRegistry run = some registry ∧
          obligation ∈ registry.reserved) ∧
    ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ run epoch obligation,
          label = GraphLabel.reserveObligation run epoch obligation) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ run epoch obligation, label = GraphLabel.reserveObligation run epoch obligation →
        AdmissionReservation.ValidIn ⟨run, epoch, obligation⟩ after

theorem bridge_C13_RUN_ADMISSION_REGISTRY :
    Sentences.cnl_C13_RUN_ADMISSION_REGISTRY ↔ hand_C13_RUN_ADMISSION_REGISTRY := Iff.rfl

/-! ## §5.2 `C13-RUN-ACCEPTANCE-SUBJECT` -/

def hand_C13_RUN_ACCEPTANCE_SUBJECT : Prop :=
  (∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ run verdict, label = GraphLabel.recordAcceptanceVerdict run verdict) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ run verdict, label = GraphLabel.recordAcceptanceVerdict run verdict →
        before.AcceptanceRetryAdmissible verdict.acceptance verdict.subject) ∧
    ∀ (state : SystemState) (run : RunId) (accId : AcceptanceId) (subject : TreeId),
      state.graph.HeadTree run subject →
      (∀ verdict, verdict ∈ state.graph.acceptanceVerdicts accId →
        verdict.acceptance = accId → verdict.subject ≠ subject) →
      ¬ AcceptanceSatisfied state.graph state.effects run accId

theorem bridge_C13_RUN_ACCEPTANCE_SUBJECT :
    Sentences.cnl_C13_RUN_ACCEPTANCE_SUBJECT ↔ hand_C13_RUN_ACCEPTANCE_SUBJECT := by
  unfold Sentences.cnl_C13_RUN_ACCEPTANCE_SUBJECT hand_C13_RUN_ACCEPTANCE_SUBJECT sAnd qEvery
  exact ⟨fun claim => ⟨claim.1, fun state => claim.2 state trivial⟩,
    fun claim => ⟨claim.1, fun state _ => claim.2 state⟩⟩

/-! ## §5.2 `C13-RUN-FORCED-CANCELLATION` -/

def hand_C13_RUN_FORCED_CANCELLATION : Prop :=
  (∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ run terminalTurn sibling,
          label = GraphLabel.forceCancelSibling run terminalTurn sibling) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ run terminalTurn sibling,
        label = GraphLabel.forceCancelSibling run terminalTurn sibling →
        ∃ cancelled evidence,
          after.turns sibling = some cancelled ∧
          cancelled.status = TurnStatus.cancelled ∧
          cancelled.lease.holder = none ∧
          after.forcedCancellations sibling = some evidence ∧
          evidence.turn = sibling) ∧
    ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
      ((∃ run turn id expected, label = GraphLabel.terminalize run turn id expected) ∧
        ∃ effects events audit, GraphStep effects events audit before label after) →
      ∀ run turn id expected, label = GraphLabel.terminalize run turn id expected →
        SiblingTurnsTerminalAndUnheld before run turn

theorem bridge_C13_RUN_FORCED_CANCELLATION :
    Sentences.cnl_C13_RUN_FORCED_CANCELLATION ↔ hand_C13_RUN_FORCED_CANCELLATION := Iff.rfl

/-! ## §5.2 `C13-RUN-FRONTIER-COMPLETE`, `C13-RUN-FRONTIER-EMPTY` -/

def hand_C13_RUN_FRONTIER_COMPLETE : Prop :=
  ∀ (before : GraphStore) (label : GraphLabel) (after : GraphStore),
    ((∃ run turn id expected, label = GraphLabel.terminalize run turn id expected) ∧
      ∃ effects events audit, GraphStep effects events audit before label after) →
    ∀ run turn id expected, label = GraphLabel.terminalize run turn id expected →
      ∃ registry snapshot,
        before.admissionRegistry run = some registry ∧
        after.terminalSnapshots run = some snapshot ∧
        (∀ obligation, obligation ∈ snapshot.obligations ↔
          obligation ∈ registry.reserved ∧ obligation ∉ registry.completed) ∧
        snapshot.registryEpoch = registry.epoch ∧
        ∃ closed, after.admissionRegistry run = some closed ∧
          closed.accepting = false ∧ closed.epoch = registry.epoch + 1

theorem bridge_C13_RUN_FRONTIER_COMPLETE :
    Sentences.cnl_C13_RUN_FRONTIER_COMPLETE ↔ hand_C13_RUN_FRONTIER_COMPLETE := Iff.rfl

/-! ## §5.2 `C13-RUN-SETTLED-DERIVED` -/

def hand_C13_RUN_SETTLED_DERIVED : Prop :=
  (∀ (state : SystemState), (∃ run, Settled state run) →
      ∀ run, Settled state run →
        ∃ snapshot, state.graph.terminalSnapshots run = some snapshot ∧
          snapshot.run = run ∧ TerminalSnapshotCoherent state.graph snapshot) ∧
    ∀ (state : SystemState), (∃ run, Settled state run) →
      ∀ run, Settled state run →
        ∀ snapshot, state.graph.terminalSnapshots run = some snapshot →
          ∀ obligation, obligation ∈ snapshot.obligations →
            ObligationDischarged state run obligation

theorem bridge_C13_RUN_SETTLED_DERIVED :
    Sentences.cnl_C13_RUN_SETTLED_DERIVED ↔ hand_C13_RUN_SETTLED_DERIVED := Iff.rfl

end SpecCnl.Bridge
