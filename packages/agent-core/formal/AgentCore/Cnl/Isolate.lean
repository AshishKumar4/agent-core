import AgentCore.Slates

/-!
# Consequences of the existing Slate model the controlled language needs

`AgentCore.Slates` already proves that a committed version and a publication are
immutable, that only `deploy` contacts a provider, and that a preview is a live
Environment Session. What it never states in one place is **what moves a Slate's head**.
§9.2's rule that a Blueprint declares no Slates rests on exactly that fact — "a Slate is
produced inside a running platform and its head advances by `commit` from there" — so the
controlled language needs it as a proposition rather than as a reading of six
constructors.

Nothing here changes a definition. `slate_head_advances_only_by_commit` reads
`SlateStep`, `SlateLedger`, `SlateRecord`, and `tableSet` exactly as `AgentCore.Slates`
and `AgentCore.Model` declare them, and its proof is a case analysis over the six
existing constructors.
-/

namespace AgentCore

/-- Two lookups of one unchanged table entry name records with the same head. Stated over
the `Option SlateRecord` values rather than over the ledgers, so a caller supplies the
`tableSet` equation the step's own shape gives it. -/
private theorem head_eq_of_fixed_entry {record moved : SlateRecord}
    {left right : Option SlateRecord}
    (same : left = right) (lookup : right = some record) (found : left = some moved) :
    moved.head = record.head :=
  (congrArg SlateRecord.head (Option.some.inj (lookup.symm.trans (same.symm.trans found)))).symm

/-- **A Slate's head advances only by `commit`, and only to the version committed.** Of
the six §4.6 transitions, three leave the Slate table alone and two — `deploy` and
`rollback` — rewrite only the active-deployment pointer, so a transition across which
some Slate's head changed is a `commit` of that Slate, and the head it now names is
exactly the version that commit created.

This is what makes a Slate a platform-moved record: its version pointer advances from
inside a running platform, by an Operation, and by no other step (§9.2,
`C13-SLATE-SKELETON-ARTIFACT`). -/
theorem slate_head_advances_only_by_commit {env : EnvironmentLedger}
    {ledger after : SlateLedger} {label : SlateLabel} {slate : SlateId}
    {record moved : SlateRecord}
    (step : SlateStep env ledger label after)
    (lookup : ledger.slates slate = some record)
    (found : after.slates slate = some moved)
    (advanced : moved.head ≠ record.head) :
    ∃ version source, label = .commit slate version source ∧ moved.head = some version := by
  cases step with
  | create fresh =>
      rename_i created
      by_cases same : slate = created
      · subst same
        rw [lookup] at fresh
        exact (by cases fresh)
      · exact absurd (head_eq_of_fixed_entry (tableSet_other _ _ _ same _) lookup found) advanced
  | commit slateLookup _freshVersion =>
      rename_i committed version source current
      by_cases same : slate = committed
      · subst same
        have shape : { current with head := some version } = moved :=
          Option.some.inj ((tableSet_self ledger.slates slate _).symm.trans found)
        exact ⟨version, source, rfl, shape ▸ rfl⟩
      · exact absurd (head_eq_of_fixed_entry (tableSet_other _ _ _ same _) lookup found) advanced
  | publish _versionLookup _owned _fresh =>
      exact absurd (head_eq_of_fixed_entry rfl lookup found) advanced
  | deploy slateLookup _publicationLookup _owned _fresh =>
      rename_i deployed deployment _publication succeeded current _publicationRecord
      by_cases same : slate = deployed
      · subst same
        have owner : record = current := Option.some.inj (lookup.symm.trans slateLookup)
        have shape :
            (if succeeded then { current with active := some deployment } else current) = moved :=
          Option.some.inj ((tableSet_self ledger.slates slate _).symm.trans found)
        refine absurd ?_ advanced
        rw [← shape, owner]
        cases succeeded <;> rfl
      · exact absurd (head_eq_of_fixed_entry (tableSet_other _ _ _ same _) lookup found) advanced
  | rollback slateLookup _deploymentLookup _owned _succeeded =>
      rename_i rolled deployment current _deploymentRecord
      by_cases same : slate = rolled
      · subst same
        have owner : record = current := Option.some.inj (lookup.symm.trans slateLookup)
        have shape : { current with active := some deployment } = moved :=
          Option.some.inj ((tableSet_self ledger.slates slate _).symm.trans found)
        refine absurd ?_ advanced
        rw [← shape, owner]
      · exact absurd (head_eq_of_fixed_entry (tableSet_other _ _ _ same _) lookup found) advanced
  | openPreview _slateLookup _fresh _exposureLookup _live _sessionEq _sessionLookup _phase
      _epoch =>
      exact absurd (head_eq_of_fixed_entry rfl lookup found) advanced

end AgentCore
