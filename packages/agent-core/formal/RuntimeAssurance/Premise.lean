import AgentCore

/-!
# Runtime premises, and the two ways one stops being an assumption

SPEC §14 lists the premises a deployment relies on, and `artifacts/traceability.yaml`
carries one `ASM-*` record for each. Both state the premises. Neither states what happens
when one of them turns out to be false, so nothing in the repository can answer the only
question that matters after an incident: which guarantees are gone, and which still hold.

This module is the missing half. It names the premise vocabulary, the two channels by
which a premise leaves `conditional`, and the order between them.

Two rules here are structural rather than conventional.

* **A premise is established only by durable domain evidence.** `EvidenceRef` has one
  constructor and it names a durable domain record. A monitor report is `Report`, a
  different type, so `Assurance.domainEvidence` cannot hold one. That is typing, not
  policy: `AgentCore.Audit`'s own rule that a span is never durable evidence gets the same
  treatment one layer up.
* **A refutation dominates a discharge.** A discharge is evidence over a window that has
  closed. A refutation says the premise is false. `Standing` resolves refuted first, so a
  premise observed to fail is never reported as established by older evidence.

`PremiseKind` splits safety premises from progress premises. The doctrine's rule that no
designated safety theorem assumes delivery, fairness, or progress becomes a checkable
property of a claim's support instead of a sentence in a boundary field.

This library imports `AgentCore` and nothing in `AgentCore` imports it. No designated
theorem, witness, or semantic definition of the model can depend on anything here, which
is what keeps a platform observation from ever reaching the kernel axiom set.
-/

namespace RuntimeAssurance

/-- Whether a premise underwrites a safety property or only a progress one. -/
inductive PremiseKind where
  | safety
  | progress
  deriving DecidableEq, Repr

/--
The closed premise vocabulary. Each entry is a fact about the deployed world that the
model assumes and does not prove.

Grouped by what supplies them: the clock (`monotonicTime`, `boundedClockOffset`), the
process (`restartResumesDurableState`, `localTransactionAtomicity`), storage
(`durableRecordIntegrity`, `durableRecordRetention`, `declaredStorageBoundAccepted`), the
resource bounds (`sufficientMemoryBudget`, `sufficientCpuBudget`), the transport
(`transportAuthenticity`), the external service (`providerIdempotency`,
`providerQueryTruthful`), the language runtime (`engineSemanticsMatchModel`,
`engineSynchronousSpan`), and progress (`eventualDelivery`, `eventualScheduling`).

Absent on purpose: message loss, duplication, and reordering. `AC-COMPOSED-001` already
carries a lossy, duplicating, reordering transport inside the modeled relation, so those
are adversary powers the theorems survive rather than premises they need. Remote
acknowledgement loss is absent for the same reason: `AC-EFFECT-001` models the
indeterminate attempt and its single supersession. A premise for any of them would claim
the model is weaker than it is.
-/
inductive Premise where
  | monotonicTime
  | boundedClockOffset
  | restartResumesDurableState
  | localTransactionAtomicity
  | durableRecordIntegrity
  | durableRecordRetention
  | declaredStorageBoundAccepted
  | sufficientMemoryBudget
  | sufficientCpuBudget
  | transportAuthenticity
  | providerIdempotency
  | providerQueryTruthful
  | engineSemanticsMatchModel
  | engineSynchronousSpan
  | eventualDelivery
  | eventualScheduling
  deriving DecidableEq, Repr

/-- Every case is written out rather than defaulted through a wildcard. A premise added
without a classification then fails to elaborate instead of inheriting `safety`, which is
the direction a mistake here would go. -/
def Premise.kind : Premise → PremiseKind
  | .monotonicTime => .safety
  | .boundedClockOffset => .safety
  | .restartResumesDurableState => .safety
  | .localTransactionAtomicity => .safety
  | .durableRecordIntegrity => .safety
  | .durableRecordRetention => .safety
  | .declaredStorageBoundAccepted => .safety
  | .sufficientMemoryBudget => .safety
  | .sufficientCpuBudget => .safety
  | .transportAuthenticity => .safety
  | .providerIdempotency => .safety
  | .providerQueryTruthful => .safety
  | .engineSemanticsMatchModel => .safety
  | .engineSynchronousSpan => .safety
  | .eventualDelivery => .progress
  | .eventualScheduling => .progress

/-- The progress premises are exactly the two eventual ones. This is the discriminating
witness for the safety/progress split: reclassifying any premise breaks it. -/
theorem Premise.progress_is_exactly_eventual (premise : Premise) :
    premise.kind = .progress ↔
      (premise = .eventualDelivery ∨ premise = .eventualScheduling) := by
  cases premise <;> simp [Premise.kind]

/--
A durable domain record. One constructor, and it is the only channel into
`Assurance.domainEvidence`.

The record identity is abstract. Which Receipt, AuditRecord, WriteRecord, or Event
discharges which premise is a conformance question that `C13-*` atoms answer; this model
only needs the fact that the discharging artifact is of a different type from anything a
monitor produces.
-/
inductive EvidenceRef where
  | durableRecord (record : Nat)
  deriving DecidableEq, Repr

/-- What is known about one premise. `conditional` is the honest default: assumed and not
established. -/
inductive Standing where
  | conditional
  | discharged
  | refuted
  deriving DecidableEq, Repr

/-- A present option names its value. Proved by case analysis rather than by contradiction,
because the model uses no classical elimination. -/
theorem option_ne_none_has_value {α : Type} {value : Option α} (present : value ≠ none) :
    ∃ inner, value = some inner := by
  cases value with
  | none => exact absurd rfl present
  | some inner => exact ⟨inner, rfl⟩

/-- `Standing` has three constructors, so ruling out the other two establishes `discharged`
without double-negation elimination. -/
theorem standing_discharged_of_not_ne {standing : Standing}
    (established : ¬ standing ≠ .discharged) : standing = .discharged := by
  cases standing with
  | conditional => exact absurd (by simp) established
  | discharged => rfl
  | refuted => exact absurd (by simp) established

end RuntimeAssurance
