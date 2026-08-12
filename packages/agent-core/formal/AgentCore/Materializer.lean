import AgentCore.Subscriptions

/-!
# Blueprint materializer idempotence for Subscriptions (SPEC §9.3)

"A materializer projects a Blueprint into records — Facet installs, Bindings,
Subscriptions, slots, policies, scope scaffolding — idempotently: re-applying
reconciles (create, update, remove-managed) rather than duplicates." That idempotence
promise is exactly what makes `AC-ROUTING-001`'s per-Subscription at-most-once an
*end-to-end* guarantee: two distinct `SubscriptionId`s materialized for the same
declared automation would each independently dedupe their own firings while jointly
firing the automation twice. This module proves the promise holds for Subscriptions
specifically, in the same install/reconcile idempotent-no-op shape `AC-COMMAND-001`
already uses for Commands (`CommandStep.installCommand`/`reinstallCommand`).

Package/Blueprint validation, loading, and contribution assembly generally stay out of
scope (`NC-BLUEPRINT-MATERIALIZATION`); only the Subscription-materialization slice is
modeled here.
-/

namespace AgentCore

structure SubscriptionTemplateName where value : Nat deriving DecidableEq, Repr

/-- A declared automation (§9.2's `SubscriptionTemplate`), reduced to what
    materialization needs: the tenant and target it will route to, and the accepted
    trust it will filter on. -/
structure SubscriptionTemplate where
  name : SubscriptionTemplateName
  tenant : TenantId
  target : InvocationId
  admits : TrustTier → Bool

def SubscriptionTemplate.materialize (template : SubscriptionTemplate) : RoutedSubscription :=
  ⟨template.tenant, template.target, template.admits, true⟩

structure MaterializerLedger where
  installed : BlueprintId → SubscriptionTemplateName → Option SubscriptionId
  routing : SubscriptionLedger

def MaterializerLedger.boot : MaterializerLedger := ⟨fun _ _ => none, default⟩

instance : Inhabited MaterializerLedger where default := .boot

/-- Not `DecidableEq`/`Repr`-derivable: `SubscriptionTemplate` carries the `admits`
    predicate as a function field, matching how `DispatchPolicy` and the `schemas` /
    `mappings` parameters elsewhere in this codebase stay outside those derivations. -/
inductive MaterializeLabel where
  | materialize (blueprint : BlueprintId) (template : SubscriptionTemplate) (id : SubscriptionId)
  | reconcile (blueprint : BlueprintId) (template : SubscriptionTemplate)

/-- Materializer transitions.

* `materialize` — a template never before materialized under this Blueprint gets a
  fresh `SubscriptionId`, indexed by `(blueprint, template.name)` and declared in the
  routing ledger.
* `reconcile` — the stored no-op for a template already materialized: re-applying the
  Blueprint touches nothing. This is the whole idempotence promise: there is no
  transition that materializes an already-materialized template a second time. -/
inductive MaterializeStep : MaterializerLedger → MaterializeLabel → MaterializerLedger → Prop
  | materialize {ledger blueprint template id} :
      ledger.installed blueprint template.name = none →
      ledger.routing.subscriptions id = none →
      MaterializeStep ledger (.materialize blueprint template id)
        { installed := fun candidateBlueprint candidateName =>
            if candidateBlueprint = blueprint ∧ candidateName = template.name then some id
            else ledger.installed candidateBlueprint candidateName
          routing := { ledger.routing with
            subscriptions := tableSet ledger.routing.subscriptions id template.materialize } }
  | reconcile {ledger blueprint template id} :
      ledger.installed blueprint template.name = some id →
      MaterializeStep ledger (.reconcile blueprint template) ledger

/-- **Materialization registers the exact derived Subscription at a fresh id.** -/
theorem materialize_registers_exact_subscription {ledger after blueprint template id}
    (step : MaterializeStep ledger (.materialize blueprint template id) after) :
    after.installed blueprint template.name = some id ∧
      after.routing.subscriptions id = some template.materialize := by
  cases step with
  | materialize _ _ =>
      refine ⟨?_, tableSet_self ..⟩
      simp

/-- **An already-materialized template can never be materialized again.** Whichever
    `SubscriptionId` a second attempt would use — even a fresh one no Subscription
    currently occupies — no `materialize` step for an already-installed
    `(blueprint, template.name)` is admissible. This is the end-to-end idempotence
    claim: only `reconcile`'s no-op path exists once a template is installed, so a
    declared automation can never end up routed through two distinct Subscriptions. -/
theorem already_materialized_template_cannot_rematerialize {ledger after blueprint template id}
    {existing : SubscriptionId} (materialized : ledger.installed blueprint template.name = some existing) :
    ¬ MaterializeStep ledger (.materialize blueprint template id) after := by
  intro step
  cases step with
  | materialize fresh _ => rw [materialized] at fresh; contradiction

/-- **Reconciliation is a stored identity.** The no-op path exists only for an
    already-materialized template and changes nothing — not the installed index, not
    the routing ledger, not any Subscription's enabled state or consumed set. -/
theorem reconcile_is_stored_identity {ledger after blueprint template}
    (step : MaterializeStep ledger (.reconcile blueprint template) after) :
    after = ledger ∧ ∃ id, ledger.installed blueprint template.name = some id := by
  cases step with
  | reconcile lookup => exact ⟨rfl, _, lookup⟩

/-- **The installed mapping is stable across every transition.** Once
    `(blueprint, template.name)` names an id, every later step — materializing a
    different template or reconciling this one — keeps it at that same id. -/
theorem materialize_step_preserves_installed_mapping {ledger after label}
    {blueprint : BlueprintId} {name : SubscriptionTemplateName} {id : SubscriptionId}
    (step : MaterializeStep ledger label after)
    (installed : ledger.installed blueprint name = some id) :
    after.installed blueprint name = some id := by
  cases step with
  | @materialize candidateBlueprint candidateTemplate candidateId fresh _ =>
      show (if blueprint = candidateBlueprint ∧ name = candidateTemplate.name then some candidateId
          else ledger.installed blueprint name) = some id
      by_cases same : blueprint = candidateBlueprint ∧ name = candidateTemplate.name
      · exfalso
        obtain ⟨sameBlueprint, sameName⟩ := same
        rw [sameBlueprint, sameName] at installed
        rw [installed] at fresh
        contradiction
      · rw [if_neg same]
        exact installed
  | reconcile _ => exact installed

/-- **Only the installed id ever fires for a materialized template.** Combined with
    `already_materialized_template_cannot_rematerialize`, a materialized automation has
    exactly one `SubscriptionId` for its entire lifetime, so `AC-ROUTING-001`'s
    per-Subscription `consumed_key_never_refires` at-most-once is the *automation's*
    at-most-once, not just one of several Subscriptions racing to fire it. -/
theorem materialized_automation_has_unique_firing_subscription
    {ledger : MaterializerLedger} {blueprint : BlueprintId} {template : SubscriptionTemplate}
    {leftId rightId : SubscriptionId}
    (left : ledger.installed blueprint template.name = some leftId)
    (right : ledger.installed blueprint template.name = some rightId) :
    leftId = rightId := by
  rw [left] at right
  exact Option.some.inj right

end AgentCore
