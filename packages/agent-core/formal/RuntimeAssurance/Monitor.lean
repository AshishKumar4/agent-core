import RuntimeAssurance.Fault

/-!
# Monitor evidence, and what binds it

A monitor watches the deployed world and says what it saw. Three things make its word
usable and each is a separate check.

* **Identity.** A report carries the model, adapter, and runtime fingerprints it was built
  against. The ledger compares them to the deployment's own. A report from another model,
  another adapter, or another runtime is refused, so an observation cannot be substituted
  across a boundary where its meaning changed. The model never computes a fingerprint: a
  monitor is handed the identities it was built against, because a monitor that certifies
  the identity of the thing it watches cannot detect that the thing changed.
* **Window.** A report names the interval it observed. A window that closes before it opens
  is malformed. A window that has already closed relative to the instant being asked about
  is stale, and a stale window covers nothing.
* **Attribution.** A verdict names a fault, and that fault must refute a premise the report
  declares it watched. Two things follow, and both are refusals rather than warnings: a
  monitor cannot blame a premise it was not built to observe, and a monitor observing a
  `withinModel` fault has nothing to enter at all.

The asymmetry between violations and coverage is deliberate and it is the whole design.

A violation is a fact about a past instant. Premises are not re-established by the passage
of time, so a violation is admitted on identity and attribution alone — its window may have
closed long ago. Coverage is the opposite: "we watched this premise and saw nothing" is a
statement about an interval, and it expires with the interval. Refusing a stale coverage
claim fails closed; refusing a stale violation would let a deployment forget an incident by
waiting.

An outside-model event splits the same way. A monitor that saw something its model cannot
describe has not proved a premise false — attributing it would be a guess — so the ledger
records no refutation for it. Neither does it pass: the report's coverage claim is void, so
silence over that window stops reassuring anyone. The report's own modeled violations still
stand, so injecting an unmodeled event cannot suppress a genuine verdict.

Nothing here discharges a premise. `Assurance.standing` reads only durable evidence and
refutations, which `Assurance.watching_is_not_standing` proves.
-/

namespace RuntimeAssurance

open AgentCore (Time)

/-- An opaque content hash. -/
structure Fingerprint where
  value : Nat
  deriving DecidableEq, Repr

structure ReportId where
  value : Nat
  deriving DecidableEq, Repr

structure MonitorId where
  value : Nat
  deriving DecidableEq, Repr

/-- The interval a report observed. -/
structure ObservationWindow where
  opened : Time
  closed : Time
  deriving DecidableEq, Repr

def ObservationWindow.WellFormed (window : ObservationWindow) : Prop :=
  window.opened.tick ≤ window.closed.tick

/-- A window covers an instant when the instant is inside it. Both bounds matter: a window
that has not opened yet says nothing about now either. -/
def ObservationWindow.Covers (window : ObservationWindow) (now : Time) : Prop :=
  window.opened.tick ≤ now.tick ∧ now.tick ≤ window.closed.tick

theorem stale_window_covers_nothing {window : ObservationWindow} {now : Time}
    (stale : window.closed.tick < now.tick) : ¬ window.Covers now := by
  intro covers
  exact Nat.not_lt_of_ge covers.2 stale

theorem unopened_window_covers_nothing {window : ObservationWindow} {now : Time}
    (early : now.tick < window.opened.tick) : ¬ window.Covers now := by
  intro covers
  exact Nat.not_lt_of_ge covers.1 early

/-- What a report is bound to: the model it was written against, the adapter that produced
it, the runtime it observed, and the window it observed over. -/
structure MonitorBinding where
  model : Fingerprint
  adapter : Fingerprint
  runtime : Fingerprint
  window : ObservationWindow
  deriving DecidableEq, Repr

/-- The deployment's own identity. A report is compared against exactly this. -/
structure Deployment where
  model : Fingerprint
  adapter : Fingerprint
  runtime : Fingerprint
  deriving DecidableEq, Repr

/--
One monitor report.

`covers` is what the monitor claims to have watched, `violations` is what it saw, and
`unmodeled` carries the events it saw and could not describe. The last field is why the
report is honest rather than merely quiet: a monitor with no way to say "something happened
that I do not model" would report clean coverage over a window it did not understand.
-/
structure Report where
  id : ReportId
  monitor : MonitorId
  binding : MonitorBinding
  covers : List Premise
  violations : List Fault
  unmodeled : List Nat
  deriving DecidableEq, Repr

/-- Every verdict names a fault that refutes a premise this report declares coverage of. -/
def Report.AttributesWithinCoverage (report : Report) : Prop :=
  ∀ fault ∈ report.violations,
    ∃ premise, fault.consequence = .refutes premise ∧ premise ∈ report.covers

/-- A report claims coverage only when it saw nothing outside its model. -/
def Report.ClaimsCoverage (report : Report) : Prop := report.unmodeled = []

/-- The report is bound to this deployment, its window is well formed, and every verdict is
attributable. Freshness is deliberately absent: it gates coverage, not refutation. -/
def Report.BoundTo (report : Report) (deployment : Deployment) : Prop :=
  report.binding.model = deployment.model ∧
  report.binding.adapter = deployment.adapter ∧
  report.binding.runtime = deployment.runtime ∧
  report.binding.window.WellFormed ∧
  report.AttributesWithinCoverage

/-- What this report says about one premise right now: it watched it, it understood
everything it saw, and its window is live. -/
def Report.Watches (report : Report) (premise : Premise) (now : Time) : Prop :=
  premise ∈ report.covers ∧ report.ClaimsCoverage ∧ report.binding.window.Covers now

/-- A report is dead at `now` when its window has closed and it saw nothing. It carries no
refutation to lose, and its coverage claim has already expired at `now` and at every later
instant, so a ledger may drop it without changing what anyone may rely on. -/
def Report.dead (report : Report) (now : Time) : Bool :=
  if report.binding.window.closed.tick < now.tick then report.violations.isEmpty else false

theorem report_from_another_model_is_unbound {report : Report} {deployment : Deployment}
    (drift : report.binding.model ≠ deployment.model) : ¬ report.BoundTo deployment :=
  fun bound => drift bound.1

theorem report_from_another_adapter_is_unbound {report : Report} {deployment : Deployment}
    (drift : report.binding.adapter ≠ deployment.adapter) : ¬ report.BoundTo deployment :=
  fun bound => drift bound.2.1

theorem report_from_another_runtime_is_unbound {report : Report} {deployment : Deployment}
    (drift : report.binding.runtime ≠ deployment.runtime) : ¬ report.BoundTo deployment :=
  fun bound => drift bound.2.2.1

theorem inverted_window_is_unbound {report : Report} {deployment : Deployment}
    (inverted : report.binding.window.closed.tick < report.binding.window.opened.tick) :
    ¬ report.BoundTo deployment := by
  intro bound
  have ordered : report.binding.window.opened.tick ≤ report.binding.window.closed.tick :=
    bound.2.2.2.1
  exact Nat.not_lt_of_ge ordered inverted

/-- A verdict about a premise the report never claimed to watch is refused. Without this a
monitor built to watch the clock could blame storage. -/
theorem verdict_outside_coverage_is_unbound {report : Report} {deployment : Deployment}
    {fault : Fault} {premise : Premise} (observed : fault ∈ report.violations)
    (refutes : fault.consequence = .refutes premise) (uncovered : premise ∉ report.covers) :
    ¬ report.BoundTo deployment := by
  intro bound
  obtain ⟨blamed, named, covered⟩ := bound.2.2.2.2 fault observed
  rw [refutes] at named
  have same : premise = blamed := Consequence.refutes.inj named
  apply uncovered
  rw [same]
  exact covered

/-- A fault the model already covers cannot enter the ledger at all. This is the anti-axiom
rule in its sharpest form: a monitor watching message order observes something real, and the
premise plane still learns nothing, because reordering refutes no premise. -/
theorem within_model_verdict_is_unbound {report : Report} {deployment : Deployment}
    {fault : Fault} (observed : fault ∈ report.violations)
    (modeled : fault.consequence = .withinModel) : ¬ report.BoundTo deployment := by
  intro bound
  obtain ⟨_, named, _⟩ := bound.2.2.2.2 fault observed
  rw [modeled] at named
  simp at named

/-- An outside-model event voids the report's coverage of every premise. -/
theorem unmodeled_event_watches_nothing {report : Report} {premise : Premise} {now : Time}
    {tag : Nat} (seen : tag ∈ report.unmodeled) : ¬ report.Watches premise now := by
  intro watches
  have silent : report.unmodeled = [] := watches.2.1
  rw [silent] at seen
  exact absurd seen List.not_mem_nil

/-- A stale report watches nothing, whatever it covered while its window was live. -/
theorem stale_report_watches_nothing {report : Report} {premise : Premise} {now : Time}
    (stale : report.binding.window.closed.tick < now.tick) : ¬ report.Watches premise now :=
  fun watches => stale_window_covers_nothing stale watches.2.2

/-- A report says nothing about a premise outside its declared coverage. -/
theorem uncovered_premise_is_unwatched {report : Report} {premise : Premise} {now : Time}
    (uncovered : premise ∉ report.covers) : ¬ report.Watches premise now :=
  fun watches => uncovered watches.1

end RuntimeAssurance
