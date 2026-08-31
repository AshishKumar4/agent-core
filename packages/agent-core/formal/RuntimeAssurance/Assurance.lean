import RuntimeAssurance.Monitor

/-!
# The premise ledger, and what a monitor may write to it

`Assurance` holds four things: the deployment's identity, the durable evidence behind each
discharged premise, the refutations on record, and the monitor reports admitted so far.
`Assurance.standing` reads the second and the third. It does not read the fourth, and
`watching_is_not_standing` is the proof — two ledgers that differ only in admitted reports
give every premise the same standing.

That single fact is what "a monitor never substitutes for durable domain evidence" means
here, and the step relation makes it hold for every reachable ledger rather than for one
snapshot:

* `recordDomainEvidence` is the only transition that writes `domainEvidence`, and it refuses
  to overwrite. A discharge therefore always names the record it came from, and no later
  transition replaces that record silently.
* `admitReport` writes refutations and coverage, never evidence
  (`admitting_a_report_preserves_evidence`), so a premise nothing durable established stays
  unestablished no matter how many clean reports arrive
  (`admitting_a_report_never_discharges`). A report that saw nothing changes no standing at
  all (`silent_report_changes_no_standing`).
* Refutation runs the other way and is monotone. Both channels can refute — a monitor
  observation and a durable record — and once a premise is refuted, recording evidence for
  it cannot clear it (`evidence_cannot_clear_a_refutation`).
* `compactCoverage` bounds retention. It drops reports that closed with nothing to say, which
  changes no standing (`compaction_preserves_standing`) and no coverage from the compaction
  instant onward (`compaction_preserves_watching`). A report carrying a verdict is never
  dropped, because a refutation is a fact about a past instant.

The asymmetry is the point. Monitors are allowed to take guarantees away and are not allowed
to grant them.
-/

namespace RuntimeAssurance

open AgentCore (Time tableSet)

/-- Where a refutation came from. A durable record and a monitor observation are both
admissible and they are not interchangeable: the source stays on the refutation so an
incident review can tell which one it is looking at. -/
inductive RefutationSource where
  | observed (report : ReportId)
  | recorded (record : EvidenceRef)
  deriving DecidableEq, Repr

structure Refutation where
  fault : Fault
  source : RefutationSource
  deriving DecidableEq, Repr

/-- The refutations in a list that blame one premise. Recursive rather than a `filter` so the
two rewrite lemmas below are the whole interface, and nothing downstream depends on which
list combinator this happens to use. -/
def refutationsOf (premise : Premise) : List Refutation → List Refutation
  | [] => []
  | entry :: rest =>
      if entry.fault.consequence = .refutes premise then entry :: refutationsOf premise rest
      else refutationsOf premise rest

theorem refutationsOf_cons_blaming {premise : Premise} {entry : Refutation}
    {rest : List Refutation} (blames : entry.fault.consequence = .refutes premise) :
    refutationsOf premise (entry :: rest) = entry :: refutationsOf premise rest := by
  simp [refutationsOf, blames]

theorem refutationsOf_cons_silent {premise : Premise} {entry : Refutation}
    {rest : List Refutation} (silent : entry.fault.consequence ≠ .refutes premise) :
    refutationsOf premise (entry :: rest) = refutationsOf premise rest := by
  simp [refutationsOf, silent]

theorem mem_refutationsOf {premise : Premise} {entry : Refutation} {list : List Refutation} :
    entry ∈ refutationsOf premise list ↔
      entry ∈ list ∧ entry.fault.consequence = .refutes premise := by
  induction list with
  | nil => simp [refutationsOf]
  | cons head rest ih =>
      by_cases blames : head.fault.consequence = .refutes premise
      · simp only [refutationsOf_cons_blaming blames, List.mem_cons, ih]
        constructor
        · rintro (rfl | ⟨member, blamed⟩)
          · exact ⟨Or.inl rfl, blames⟩
          · exact ⟨Or.inr member, blamed⟩
        · rintro ⟨same | member, blamed⟩
          · exact Or.inl same
          · exact Or.inr ⟨member, blamed⟩
      · simp only [refutationsOf_cons_silent blames, ih, List.mem_cons]
        constructor
        · rintro ⟨member, blamed⟩
          exact ⟨Or.inr member, blamed⟩
        · rintro ⟨rfl | member, blamed⟩
          · exact absurd blamed blames
          · exact ⟨member, blamed⟩

/-- Refutations first, then durable evidence, then nothing. The order is the resolution rule:
an observed failure outranks older evidence, and an absent discharge is `conditional` rather
than anything better. -/
def standingOf : List Refutation → Option EvidenceRef → Standing
  | _ :: _, _ => .refuted
  | [], some _ => .discharged
  | [], none => .conditional

theorem standingOf_refuted_iff {list : List Refutation} {record : Option EvidenceRef} :
    standingOf list record = .refuted ↔ list ≠ [] := by
  cases list with
  | cons head rest => simp [standingOf]
  | nil =>
      cases record with
      | none => simp [standingOf]
      | some value => simp [standingOf]

theorem standingOf_discharged_iff {list : List Refutation} {record : Option EvidenceRef} :
    standingOf list record = .discharged ↔ (list = [] ∧ record ≠ none) := by
  cases list with
  | cons head rest => simp [standingOf]
  | nil =>
      cases record with
      | none => simp [standingOf]
      | some value => simp [standingOf]

theorem standingOf_conditional_iff {list : List Refutation} {record : Option EvidenceRef} :
    standingOf list record = .conditional ↔ (list = [] ∧ record = none) := by
  cases list with
  | cons head rest => simp [standingOf]
  | nil =>
      cases record with
      | none => simp [standingOf]
      | some value => simp [standingOf]

/--
What is known about the deployment's premises.

`coverage` is admitted monitor reports. It is a field of this record and not an input to
`standing`, which is the whole separation this module exists to keep.
-/
structure Assurance where
  deployment : Deployment
  domainEvidence : Premise → Option EvidenceRef
  refutations : List Refutation
  coverage : List Report

def Assurance.refutationsFor (self : Assurance) (premise : Premise) : List Refutation :=
  refutationsOf premise self.refutations

theorem Assurance.refutationsFor_eq (self : Assurance) (premise : Premise) :
    self.refutationsFor premise = refutationsOf premise self.refutations := rfl

theorem Assurance.mem_refutationsFor {self : Assurance} {premise : Premise}
    {entry : Refutation} :
    entry ∈ self.refutationsFor premise ↔
      entry ∈ self.refutations ∧ entry.fault.consequence = .refutes premise := by
  rw [Assurance.refutationsFor_eq]
  exact mem_refutationsOf

def Assurance.Refuted (self : Assurance) (premise : Premise) : Prop :=
  ∃ entry ∈ self.refutations, entry.fault.consequence = .refutes premise

def Assurance.standing (self : Assurance) (premise : Premise) : Standing :=
  standingOf (self.refutationsFor premise) (self.domainEvidence premise)

theorem Assurance.standing_eq (self : Assurance) (premise : Premise) :
    self.standing premise =
      standingOf (self.refutationsFor premise) (self.domainEvidence premise) := rfl

/-- Which monitor reports currently watch a premise. A report with a closed window or an
outside-model event watches nothing, so this shrinks by itself as time passes. -/
def Assurance.Watching (self : Assurance) (premise : Premise) (now : Time) : Prop :=
  ∃ report ∈ self.coverage, report.Watches premise now

theorem Assurance.refuted_iff_refutations_nonempty {self : Assurance} {premise : Premise} :
    self.Refuted premise ↔ self.refutationsFor premise ≠ [] := by
  constructor
  · rintro ⟨entry, member, blames⟩
    intro empty
    have listed : entry ∈ self.refutationsFor premise :=
      Assurance.mem_refutationsFor.mpr ⟨member, blames⟩
    rw [empty] at listed
    exact absurd listed List.not_mem_nil
  · intro nonempty
    cases listed : self.refutationsFor premise with
    | nil => exact absurd listed nonempty
    | cons head rest =>
        have member : head ∈ self.refutationsFor premise := by
          rw [listed]
          exact List.mem_cons_self
        obtain ⟨inList, blames⟩ := Assurance.mem_refutationsFor.mp member
        exact ⟨head, inList, blames⟩

/-- An unrefuted premise has an empty refutation list. Case analysis on the list rather than a
contradiction, so the proof stays constructive. -/
theorem Assurance.refutationsFor_eq_nil {self : Assurance} {premise : Premise}
    (unrefuted : ¬ self.Refuted premise) : self.refutationsFor premise = [] := by
  cases listed : self.refutationsFor premise with
  | nil => rfl
  | cons head rest =>
      refine absurd (Assurance.refuted_iff_refutations_nonempty.mpr ?_) unrefuted
      rw [listed]
      simp

theorem Assurance.standing_refuted_iff {self : Assurance} {premise : Premise} :
    self.standing premise = .refuted ↔ self.Refuted premise := by
  rw [Assurance.standing_eq, standingOf_refuted_iff,
    Assurance.refuted_iff_refutations_nonempty]

/-- A discharge always names the durable record behind it. -/
theorem discharged_names_a_durable_record {self : Assurance} {premise : Premise}
    (established : self.standing premise = .discharged) :
    ∃ record, self.domainEvidence premise = some record := by
  rw [Assurance.standing_eq, standingOf_discharged_iff] at established
  exact option_ne_none_has_value established.2

/-- Absence of evidence is `conditional`, never `discharged`. This is the fail-closed default
the doctrine's D-5 asks for, at the premise plane. -/
theorem unevidenced_premise_is_never_discharged {self : Assurance} {premise : Premise}
    (unevidenced : self.domainEvidence premise = none) :
    self.standing premise ≠ .discharged := by
  intro established
  rw [Assurance.standing_eq, standingOf_discharged_iff] at established
  exact absurd unevidenced established.2

/-- **Coverage is not standing.** Two ledgers that differ only in the monitor reports they
have admitted assign every premise the same standing, because `standing` reads durable
evidence and refutations and nothing else. -/
theorem watching_is_not_standing {left right : Assurance} {premise : Premise}
    (sameEvidence : left.domainEvidence = right.domainEvidence)
    (sameRefutations : left.refutations = right.refutations) :
    left.standing premise = right.standing premise := by
  simp only [Assurance.standing_eq, Assurance.refutationsFor_eq, sameEvidence, sameRefutations]

theorem no_coverage_watches_nothing {self : Assurance} {premise : Premise} {now : Time}
    (bare : self.coverage = []) : ¬ self.Watching premise now := by
  rintro ⟨report, member, _⟩
  rw [bare] at member
  exact absurd member List.not_mem_nil

/-! ## Transitions -/

/-- The refutations a report contributes, each stamped with the report it came from. -/
def observedRefutations (report : Report) : List Refutation :=
  report.violations.map (fun fault => ⟨fault, .observed report.id⟩)

theorem observedRefutations_eq (report : Report) :
    observedRefutations report =
      report.violations.map (fun fault => ⟨fault, .observed report.id⟩) := rfl

inductive AssuranceLabel where
  | recordDomainEvidence (premise : Premise) (record : EvidenceRef)
  | recordDurableRefutation (fault : Fault) (record : EvidenceRef)
  | admitReport (report : Report) (now : Time)
  | compactCoverage (now : Time)
  deriving DecidableEq, Repr

/--
The four ways a ledger changes.

`recordDomainEvidence` is the only writer of `domainEvidence` and it requires the premise to
be unevidenced, so a discharge is recorded once against one named record.
`recordDurableRefutation` requires the fault to refute something, so a durable record of a
`withinModel` fault enters nothing. `admitReport` requires the report to be bound to this
deployment, and it writes refutations and coverage only. `compactCoverage` drops dead reports
and writes nothing: it touches neither evidence nor refutations, which is why
`compaction_preserves_standing` holds by computation rather than by argument.
-/
inductive AssuranceStep : Assurance → AssuranceLabel → Assurance → Prop
  | recordDomainEvidence {self premise record} :
      self.domainEvidence premise = none →
      AssuranceStep self (.recordDomainEvidence premise record)
        { self with domainEvidence := tableSet self.domainEvidence premise record }
  | recordDurableRefutation {self fault record premise} :
      fault.consequence = .refutes premise →
      AssuranceStep self (.recordDurableRefutation fault record)
        { self with refutations := ⟨fault, .recorded record⟩ :: self.refutations }
  | admitReport {self report now} :
      report.BoundTo self.deployment →
      AssuranceStep self (.admitReport report now)
        { self with
          refutations := observedRefutations report ++ self.refutations
          coverage := report :: self.coverage }
  | compactCoverage {self now} :
      AssuranceStep self (.compactCoverage now)
        { self with coverage := self.coverage.filter (fun report => !report.dead now) }

inductive Reachable : Assurance → Prop
  | initial {self} : self.refutations = [] → self.coverage = [] → Reachable self
  | step {before label after} :
      Reachable before → AssuranceStep before label after → Reachable after

/-- **Admitting a report writes no evidence.** -/
theorem admitting_a_report_preserves_evidence {before after : Assurance} {report : Report}
    {now : Time} (step : AssuranceStep before (.admitReport report now) after) :
    after.domainEvidence = before.domainEvidence := by
  cases step
  rfl

/-- Refutation is monotone across report admission. -/
theorem admitting_a_report_keeps_refutations {before after : Assurance} {report : Report}
    {now : Time} {premise : Premise}
    (step : AssuranceStep before (.admitReport report now) after)
    (refuted : before.Refuted premise) : after.Refuted premise := by
  cases step
  obtain ⟨entry, member, blames⟩ := refuted
  refine ⟨entry, ?_, blames⟩
  exact List.mem_append.mpr (Or.inr member)

/-- **A monitor cannot promote a premise.** Whatever a bound report says, a premise that no
durable record established before the report is still not established after it. -/
theorem admitting_a_report_never_discharges {before after : Assurance} {report : Report}
    {now : Time} {premise : Premise}
    (step : AssuranceStep before (.admitReport report now) after)
    (unestablished : before.standing premise ≠ .discharged) :
    after.standing premise ≠ .discharged := by
  intro established
  rw [Assurance.standing_eq, standingOf_discharged_iff] at established
  have notRefuted : ¬ before.Refuted premise := by
    intro refuted
    have carried := admitting_a_report_keeps_refutations step refuted
    exact absurd established.1
      (Assurance.refuted_iff_refutations_nonempty.mp carried)
  have empty : before.refutationsFor premise = [] :=
    Assurance.refutationsFor_eq_nil notRefuted
  have stored : before.domainEvidence premise ≠ none := by
    rw [← admitting_a_report_preserves_evidence step]
    exact established.2
  apply unestablished
  rw [Assurance.standing_eq, standingOf_discharged_iff]
  exact ⟨empty, stored⟩

/-- **A report that saw nothing changes nothing.** -/
theorem silent_report_changes_no_standing {before after : Assurance} {report : Report}
    {now : Time} (step : AssuranceStep before (.admitReport report now) after)
    (silent : report.violations = []) (premise : Premise) :
    after.standing premise = before.standing premise := by
  cases step
  refine watching_is_not_standing rfl ?_
  simp [observedRefutations_eq, silent]

/-- **A bound verdict does refute.** The other half of the asymmetry: monitors take
guarantees away even though they cannot grant them. -/
theorem admitted_verdict_refutes {before after : Assurance} {report : Report} {now : Time}
    {fault : Fault} {premise : Premise}
    (step : AssuranceStep before (.admitReport report now) after)
    (observed : fault ∈ report.violations) (blames : fault.consequence = .refutes premise) :
    after.Refuted premise := by
  cases step
  refine ⟨⟨fault, .observed report.id⟩, ?_, blames⟩
  refine List.mem_append.mpr (Or.inl ?_)
  rw [observedRefutations_eq]
  exact List.mem_map_of_mem observed

/-- **An outside-model event drops the coverage and keeps the verdict.** A report that saw
something it cannot describe watches nothing, so silence over its window stops reassuring
anyone; its modeled verdicts still stand, so injecting an unmodeled event cannot suppress a
genuine refutation. -/
theorem unmodeled_event_drops_coverage_and_keeps_verdicts {before after : Assurance}
    {report : Report} {now : Time} {fault : Fault} {premise : Premise} {tag : Nat}
    (step : AssuranceStep before (.admitReport report now) after)
    (seen : tag ∈ report.unmodeled) (observed : fault ∈ report.violations)
    (blames : fault.consequence = .refutes premise) (subject : Premise) :
    after.Refuted premise ∧ ¬ report.Watches subject now :=
  ⟨admitted_verdict_refutes step observed blames, unmodeled_event_watches_nothing seen⟩

/-- A durable record refutes through its own channel, with its own source. -/
theorem durable_record_refutes {before after : Assurance} {fault : Fault}
    {record : EvidenceRef} {premise : Premise}
    (step : AssuranceStep before (.recordDurableRefutation fault record) after)
    (blames : fault.consequence = .refutes premise) : after.Refuted premise := by
  cases step
  refine ⟨⟨fault, .recorded record⟩, ?_, blames⟩
  exact List.mem_cons_self

/-- Every refutation a step enters blames a premise, so a `withinModel` fault never gets on
the record at all. -/
theorem step_refutations_blame_a_premise {before after : Assurance} {label : AssuranceLabel}
    (transition : AssuranceStep before label after)
    (blamed : ∀ entry ∈ before.refutations, ∃ premise, entry.fault.consequence = .refutes premise) :
    ∀ entry ∈ after.refutations, ∃ premise, entry.fault.consequence = .refutes premise := by
  cases transition with
  | recordDomainEvidence _ => exact blamed
  | recordDurableRefutation blames =>
      intro entry member
      rcases List.mem_cons.mp member with same | tail
      · rw [same]
        exact ⟨_, blames⟩
      · exact blamed entry tail
  | admitReport bound =>
      intro entry member
      rcases List.mem_append.mp member with reported | tail
      · rw [observedRefutations_eq] at reported
        obtain ⟨fault, inViolations, stamped⟩ := List.mem_map.mp reported
        obtain ⟨premise, blames, _⟩ := bound.2.2.2.2 fault inViolations
        refine ⟨premise, ?_⟩
        rw [← stamped]
        exact blames
      · exact blamed entry tail
  | compactCoverage => exact blamed

/-- **Nothing outside the premise plane reaches the record.** On every reachable ledger each
refutation names the premise it refutes, so an observation of a `withinModel` fault is
absent from the record rather than silently absorbed into it. This is the model-level form
of the rule that no platform fact becomes a premise because somebody watched it happen. -/
theorem reachable_refutations_blame_a_premise {self : Assurance} (reachable : Reachable self) :
    ∀ entry ∈ self.refutations, ∃ premise, entry.fault.consequence = .refutes premise := by
  induction reachable with
  | initial empty _ =>
      intro entry member
      rw [empty] at member
      exact absurd member List.not_mem_nil
  | step _ transition ih => exact step_refutations_blame_a_premise transition ih

/-- Every durable refutation names the premise it blames; the transition carries that
premise as its own precondition. -/
theorem durable_refutation_blames_a_premise {before after : Assurance} {fault : Fault}
    {record : EvidenceRef}
    (transition : AssuranceStep before (.recordDurableRefutation fault record) after) :
    ∃ premise, fault.consequence = .refutes premise := by
  cases transition
  exact ⟨_, by assumption⟩

/-- A durable record of a `withinModel` fault refutes nothing, so no transition enters it. -/
theorem within_model_fault_has_no_durable_refutation {before after : Assurance}
    {fault : Fault} {record : EvidenceRef} (modeled : fault.consequence = .withinModel) :
    ¬ AssuranceStep before (.recordDurableRefutation fault record) after := by
  intro transition
  obtain ⟨premise, blames⟩ := durable_refutation_blames_a_premise transition
  rw [modeled] at blames
  simp at blames

/-- Evidence is recorded once, against a premise that had none. -/
theorem domain_evidence_is_recorded_once {before after : Assurance} {premise : Premise}
    {record : EvidenceRef}
    (step : AssuranceStep before (.recordDomainEvidence premise record) after) :
    before.domainEvidence premise = none := by
  cases step
  assumption

/-- **A refutation dominates.** Recording durable evidence for a refuted premise leaves it
refuted; there is no transition that trades a refutation for a discharge. -/
theorem evidence_cannot_clear_a_refutation {before after : Assurance} {premise : Premise}
    {record : EvidenceRef} {subject : Premise}
    (step : AssuranceStep before (.recordDomainEvidence premise record) after)
    (refuted : before.Refuted subject) : after.standing subject = .refuted := by
  cases step
  exact Assurance.standing_refuted_iff.mpr refuted

/-- **Compaction changes no standing.** It writes neither evidence nor refutations, and
`standing` reads nothing else, so dropping dead reports is not a way to forget a refutation
or to invent a discharge. -/
theorem compaction_preserves_standing {before after : Assurance} {now : Time}
    (step : AssuranceStep before (.compactCoverage now) after) (premise : Premise) :
    after.standing premise = before.standing premise := by
  cases step
  rfl

/-- **Compaction changes no live coverage.** A dropped report's window had already closed, so
for every instant from the compaction instant onward it watched nothing either way. Retention
is bounded without weakening what a reader may currently rely on. -/
theorem compaction_preserves_watching {before after : Assurance} {now later : Time}
    (step : AssuranceStep before (.compactCoverage now) after) (premise : Premise)
    (onward : now.tick ≤ later.tick) :
    after.Watching premise later ↔ before.Watching premise later := by
  cases step
  constructor
  · rintro ⟨report, member, watches⟩
    obtain ⟨retained, _⟩ := List.mem_filter.mp member
    exact ⟨report, retained, watches⟩
  · rintro ⟨report, member, watches⟩
    refine ⟨report, ?_, watches⟩
    refine List.mem_filter.mpr ⟨member, ?_⟩
    have live : now.tick ≤ report.binding.window.closed.tick :=
      Nat.le_trans onward watches.2.2.2
    have unexpired : ¬ report.binding.window.closed.tick < now.tick :=
      Nat.not_lt_of_ge live
    have alive : report.dead now = false := by
      unfold Report.dead
      rw [if_neg unexpired]
    simp [alive]

end RuntimeAssurance
