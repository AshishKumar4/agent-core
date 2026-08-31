import RuntimeAssurance.External
import RuntimeAssurance.Claim

/-!
# Hostile observation probes

These are not deployment claims and they designate nothing in `AgentCore/Axioms.lean`. They
are the negative cases the runtime boundary must retain when a monitor is wired to a real
platform: stale coverage, missing observations, model substitution, outside-model events,
and a clean report being mistaken for durable proof.

Each result uses the concrete definitions rather than an unconstrained hypothesis. A change
that turns any refusal into a pass changes an example's type or its proof and fails this
library before it can be mistaken for an observational convenience.
-/

namespace RuntimeAssurance

/-- A window that closed before the instant queried supplies no coverage. -/
theorem hostile_stale_observation_is_not_coverage {report : Report} {premise : Premise}
    {now : AgentCore.Time} (stale : report.binding.window.closed.tick < now.tick) :
    ¬ report.Watches premise now :=
  stale_report_watches_nothing stale

/-- With no admitted reports there is no watcher. Missing is `conditional`, never a clean
monitor pass. -/
theorem hostile_missing_observation_is_not_coverage {self : Assurance} {premise : Premise}
    {now : AgentCore.Time} (bare : self.coverage = []) : ¬ self.Watching premise now :=
  no_coverage_watches_nothing bare

/-- A report against another model cannot be substituted into this deployment. -/
theorem hostile_substituted_model_is_refused {report : Report} {deployment : Deployment}
    (drift : report.binding.model ≠ deployment.model) : ¬ report.BoundTo deployment :=
  report_from_another_model_is_unbound drift

/-- An event the model already survives has no premise to blame. A monitor may observe it but
cannot use it to manufacture a platform assumption. -/
theorem hostile_outside_model_fault_is_refused {report : Report} {deployment : Deployment}
    {fault : Fault} (observed : fault ∈ report.violations)
    (modeled : fault.consequence = .withinModel) : ¬ report.BoundTo deployment :=
  within_model_verdict_is_unbound observed modeled

/-- A missing remote acknowledgement is not permission to apply the same key again. The two
acknowledgement observations carry one identical committed service state. -/
theorem hostile_lost_acknowledgement_is_not_a_retry {service : ExternalService}
    {request : ExternalRequest} :
    ExternalObservation.committed ⟨service, request, .lost⟩ =
      ExternalObservation.committed ⟨service, request, .acknowledged⟩ :=
  acknowledgement_loss_is_not_a_second_effect

/-- A bound report can take an unsupported premise away, but it cannot establish one. -/
theorem hostile_clean_monitor_never_discharges {before after : Assurance} {report : Report}
    {now : AgentCore.Time} {premise : Premise}
    (step : AssuranceStep before (.admitReport report now) after)
    (unestablished : before.standing premise ≠ .discharged) :
    after.standing premise ≠ .discharged :=
  admitting_a_report_never_discharges step unestablished

/-- An outside-model event voids coverage even when the report also carries a valid modeled
verdict. The verdict remains a refutation; the silent coverage claim does not. -/
theorem hostile_unmodeled_event_keeps_verdict_but_drops_coverage {before after : Assurance}
    {report : Report} {now : AgentCore.Time} {fault : Fault} {premise subject : Premise}
    {tag : Nat} (step : AssuranceStep before (.admitReport report now) after)
    (seen : tag ∈ report.unmodeled) (observed : fault ∈ report.violations)
    (blames : fault.consequence = .refutes premise) :
    after.Refuted premise ∧ ¬ report.Watches subject now :=
  unmodeled_event_drops_coverage_and_keeps_verdicts step seen observed blames subject

end RuntimeAssurance
