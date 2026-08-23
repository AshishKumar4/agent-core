import AgentCore.Environments

/-!
# Slate and the dynamic isolate (SPEC §4.6)

A Slate composes with the other primitives rather than duplicating them, and its
backend executes in a `dynamic` protection domain. Two transition systems carry the
§4.6 rules:

* `IsolateStep` is the dynamic domain of §1.5 and §10.2 rule 3. A fresh isolate holds
  nothing and can reach nothing — `globalOutbound: null` is the absence of any
  admissible action, not a filter — and every capability it ever exercises arrived
  through an explicit host `pass` of a Binding. Egress is per-destination: a passed
  Binding reaches exactly the destination it names.
* `SlateStep` is the record plane: committed versions and publications are immutable,
  `rollback` atomically retargets the active pointer to an existing successful
  deployment of the same Slate and contacts no provider, and a live preview is an
  Environment Session — the step consults the environment ledger for a live session
  behind a live exposure, so §4.5's fail-closed rules govern it.

Generated application code and concrete deployment-provider effects stay behind
`NC-SLATE-RUNTIME`.
-/

namespace AgentCore

structure SlateId where value : Nat deriving DecidableEq, Repr
structure SlateVersionId where value : Nat deriving DecidableEq, Repr
structure SlatePublicationId where value : Nat deriving DecidableEq, Repr
structure SlateDeploymentId where value : Nat deriving DecidableEq, Repr
structure SlatePreviewId where value : Nat deriving DecidableEq, Repr

/-- What an explicitly passed Binding lets the isolate do. A capability with a
destination admits egress to exactly that destination; one without admits only
invocation. -/
structure IsolateCapability where
  destination : Option Destination
  deriving DecidableEq, Repr

inductive IsolateAction where
  | invoke (binding : BindingId)
  | egress (binding : BindingId) (destination : Destination)
  deriving DecidableEq, Repr

def IsolateAction.binding : IsolateAction → BindingId
  | .invoke binding => binding
  | .egress binding _ => binding

/-- A dynamic protection domain: the capabilities its host has explicitly passed and
the actions its code has taken. -/
structure DynamicDomain where
  passed : BindingId → Option IsolateCapability
  actions : List IsolateAction

/-- §10.2 rule 3: a dynamic isolate boots with `globalOutbound: null` and an empty
capability table. -/
def DynamicDomain.fresh : DynamicDomain := ⟨fun _ => none, []⟩

inductive IsolateLabel where
  | pass (binding : BindingId) (capability : IsolateCapability)
  | invoke (binding : BindingId)
  | egress (binding : BindingId) (destination : Destination)

inductive IsolateStep : DynamicDomain → IsolateLabel → DynamicDomain → Prop
  | pass {domain binding capability} :
      domain.passed binding = none →
      IsolateStep domain (.pass binding capability)
        { domain with passed := tableSet domain.passed binding capability }
  | invoke {domain binding capability} :
      domain.passed binding = some capability →
      IsolateStep domain (.invoke binding)
        { domain with actions := .invoke binding :: domain.actions }
  | egress {domain binding capability destination} :
      domain.passed binding = some capability →
      capability.destination = some destination →
      IsolateStep domain (.egress binding destination)
        { domain with actions := .egress binding destination :: domain.actions }

inductive IsolateReachable : DynamicDomain → Prop
  | fresh : IsolateReachable .fresh
  | step {before label after} :
      IsolateReachable before → IsolateStep before label after → IsolateReachable after

/-- **A fresh dynamic isolate admits only a host pass.** With nothing passed, no invoke
and no egress is admissible: zero ambient authority and zero ambient egress are the
absence of any first move that is not the host explicitly handing a Binding over. -/
theorem fresh_dynamic_isolate_admits_only_host_pass {label after}
    (step : IsolateStep .fresh label after) :
    ∃ binding capability, label = .pass binding capability := by
  cases step with
  | pass fresh => exact ⟨_, _, rfl⟩
  | invoke lookup => exact (by cases lookup)
  | egress lookup _named => exact (by cases lookup)

/-- **An isolate invocation requires a passed Binding.** There is no ambient path: the
capability the invoke exercises is in the passed table at the moment of the step. -/
theorem isolate_invoke_requires_passed_binding {domain binding after}
    (step : IsolateStep domain (.invoke binding) after) :
    ∃ capability, domain.passed binding = some capability := by
  cases step with
  | invoke lookup => exact ⟨_, lookup⟩

/-- **Isolate egress reaches exactly a passed destination.** An egress step names a
passed Binding whose capability records exactly the destination reached — a domain in
which code can open a connection the platform did not give it is not a dynamic
domain. -/
theorem isolate_egress_matches_passed_destination {domain binding destination after}
    (step : IsolateStep domain (.egress binding destination) after) :
    ∃ capability, domain.passed binding = some capability ∧
      capability.destination = some destination := by
  cases step with
  | egress lookup named => exact ⟨_, lookup, named⟩

/-- **Capabilities grow only by host pass.** Any transition that changes the passed
table is a `pass` — isolate code cannot mint, widen, or copy a capability into its own
table. -/
theorem isolate_capability_growth_is_host_pass {domain label after binding}
    (step : IsolateStep domain label after)
    (grew : after.passed binding ≠ domain.passed binding) :
    ∃ capability, label = .pass binding capability := by
  cases step with
  | pass fresh =>
      rename_i passed capability
      by_cases same : binding = passed
      · subst same; exact ⟨capability, rfl⟩
      · exact absurd (tableSet_other _ _ _ same _) grew
  | invoke lookup => exact absurd rfl grew
  | egress lookup named => exact absurd rfl grew

/-- Every recorded action is backed by a currently passed capability, and an egress
action is backed by one naming exactly its destination. -/
def ActionsBacked (domain : DynamicDomain) : Prop :=
  ∀ action, action ∈ domain.actions →
    ∃ capability, domain.passed action.binding = some capability ∧
      ∀ binding destination, action = .egress binding destination →
        capability.destination = some destination

theorem fresh_actions_backed : ActionsBacked .fresh := fun action member =>
  absurd member List.not_mem_nil

theorem isolate_step_preserves_actions_backed {domain label after}
    (backed : ActionsBacked domain) (step : IsolateStep domain label after) :
    ActionsBacked after := by
  cases step with
  | pass fresh =>
      rename_i passed capability
      intro action member
      obtain ⟨found, lookup, egressNamed⟩ := backed action member
      refine ⟨found, ?_, egressNamed⟩
      by_cases same : action.binding = passed
      · rw [same, fresh] at lookup
        exact (by cases lookup)
      · exact Eq.trans (tableSet_other _ _ _ same _) lookup
  | invoke lookup =>
      intro action member
      rcases List.mem_cons.mp member with equal | tail
      · subst equal
        exact ⟨_, lookup, fun _ _ impossible => IsolateAction.noConfusion impossible⟩
      · exact backed action tail
  | egress lookup named =>
      intro action member
      rcases List.mem_cons.mp member with equal | tail
      · subst equal
        refine ⟨_, lookup, fun binding destination egressEq => ?_⟩
        cases egressEq
        exact named
      · exact backed action tail

/-- **Every action a reachable isolate ever took is Binding-backed.** At any reachable
state, each recorded invoke names a passed capability and each recorded egress names a
passed capability granting exactly that destination — capability provenance is the host
pass, with no ambient path (§1.5, §10.2 rule 3, P11-SLATE-BINDINGS). -/
theorem reachable_isolate_actions_are_binding_backed {domain}
    (reachable : IsolateReachable domain) : ActionsBacked domain := by
  induction reachable with
  | fresh => exact fresh_actions_backed
  | step _ step ih => exact isolate_step_preserves_actions_backed ih step

/-- The §4.6 backend manifest: `dynamic` only. -/
def dynamicOnlyManifest : PlacementSet := ⟨false, false, true⟩

/-- **A dynamic-only manifest never lands in an ambient domain.** Whatever policy,
substrate, and trust admit, §9.2's intersection selects `dynamic` or nothing — a Slate
backend can never be placed `bundled` or `provider`, so §1.5's zero-ambient-authority
rules always apply to it (P11-SLATE-DYNAMIC). -/
theorem dynamic_only_manifest_never_places_ambient (policy substrate trust : PlacementSet) :
    choosePlacement dynamicOnlyManifest policy substrate trust = some .dynamic ∨
    choosePlacement dynamicOnlyManifest policy substrate trust = none := by
  unfold choosePlacement placementIntersection PlacementSet.intersect dynamicOnlyManifest
  by_cases admits : ((policy.dynamic && substrate.dynamic) && trust.dynamic) = true
  · simp [admits]
  · simp [Bool.not_eq_true] at admits
    simp [admits]

structure SlateRecord where
  head : Option SlateVersionId
  active : Option SlateDeploymentId
  deriving DecidableEq, Repr

structure SlateVersionRecord where
  slate : SlateId
  source : Nat
  parent : Option SlateVersionId
  deriving DecidableEq, Repr

structure SlatePublicationRecord where
  slate : SlateId
  version : SlateVersionId
  deriving DecidableEq, Repr

structure SlateDeploymentRecord where
  slate : SlateId
  publication : SlatePublicationId
  succeeded : Bool
  deriving DecidableEq, Repr

structure SlatePreviewRecord where
  slate : SlateId
  session : SessionId
  exposure : ExposureId
  deriving DecidableEq, Repr

structure SlateLedger where
  slates : SlateId → Option SlateRecord
  versions : SlateVersionId → Option SlateVersionRecord
  publications : SlatePublicationId → Option SlatePublicationRecord
  deployments : SlateDeploymentId → Option SlateDeploymentRecord
  previews : SlatePreviewId → Option SlatePreviewRecord
  providerContacts : List SlateDeploymentId

def SlateLedger.empty : SlateLedger := {
  slates := fun _ => none
  versions := fun _ => none
  publications := fun _ => none
  deployments := fun _ => none
  previews := fun _ => none
  providerContacts := []
}

instance : Inhabited SlateLedger where default := .empty

inductive SlateLabel where
  | create (slate : SlateId)
  | commit (slate : SlateId) (version : SlateVersionId) (source : Nat)
  | publish (slate : SlateId) (publication : SlatePublicationId) (version : SlateVersionId)
  | deploy (slate : SlateId) (deployment : SlateDeploymentId)
      (publication : SlatePublicationId) (succeeded : Bool)
  | rollback (slate : SlateId) (deployment : SlateDeploymentId)
  | openPreview (slate : SlateId) (preview : SlatePreviewId) (session : SessionId)
      (exposure : ExposureId)

/-- Slate transitions, judged against the environment ledger that hosts previews. -/
inductive SlateStep (env : EnvironmentLedger) : SlateLedger → SlateLabel → SlateLedger → Prop
  | create {ledger slate} :
      ledger.slates slate = none →
      SlateStep env ledger (.create slate)
        { ledger with slates := tableSet ledger.slates slate ⟨none, none⟩ }
  | commit {ledger slate version source record} :
      ledger.slates slate = some record →
      ledger.versions version = none →
      SlateStep env ledger (.commit slate version source)
        { ledger with
          versions := tableSet ledger.versions version ⟨slate, source, record.head⟩
          slates := tableSet ledger.slates slate { record with head := some version } }
  | publish {ledger slate publication version versionRecord} :
      ledger.versions version = some versionRecord → versionRecord.slate = slate →
      ledger.publications publication = none →
      SlateStep env ledger (.publish slate publication version)
        { ledger with
          publications := tableSet ledger.publications publication ⟨slate, version⟩ }
  | deploy {ledger slate deployment publication succeeded record publicationRecord} :
      ledger.slates slate = some record →
      ledger.publications publication = some publicationRecord →
      publicationRecord.slate = slate →
      ledger.deployments deployment = none →
      SlateStep env ledger (.deploy slate deployment publication succeeded)
        { ledger with
          deployments := tableSet ledger.deployments deployment
            ⟨slate, publication, succeeded⟩
          providerContacts := deployment :: ledger.providerContacts
          slates := tableSet ledger.slates slate
            (if succeeded then { record with active := some deployment } else record) }
  | rollback {ledger slate deployment record deploymentRecord} :
      ledger.slates slate = some record →
      ledger.deployments deployment = some deploymentRecord →
      deploymentRecord.slate = slate → deploymentRecord.succeeded = true →
      SlateStep env ledger (.rollback slate deployment)
        { ledger with
          slates := tableSet ledger.slates slate { record with active := some deployment } }
  | openPreview {ledger slate preview session exposure record exposureRecord sessionRecord} :
      ledger.slates slate = some record →
      ledger.previews preview = none →
      env.exposures exposure = some exposureRecord → exposureRecord.live = true →
      exposureRecord.session = session →
      env.sessions session = some sessionRecord → sessionRecord.phase = .live →
      sessionRecord.epoch = exposureRecord.sessionEpoch →
      SlateStep env ledger (.openPreview slate preview session exposure)
        { ledger with
          previews := tableSet ledger.previews preview ⟨slate, session, exposure⟩ }

inductive SlateReachable (env : EnvironmentLedger) : SlateLedger → Prop
  | empty : SlateReachable env .empty
  | step {before label after} :
      SlateReachable env before → SlateStep env before label after → SlateReachable env after

/-- **A committed version is immutable.** Once a version record exists, every later
transition — commits, publishes, deploys, rollbacks, previews — leaves it exactly as
committed. -/
theorem committed_version_is_immutable {env ledger label after id record}
    (step : SlateStep env ledger label after)
    (lookup : ledger.versions id = some record) :
    after.versions id = some record := by
  cases step with
  | commit slateLookup fresh =>
      rename_i _slate version _source _record
      by_cases same : id = version
      · subst same
        rw [lookup] at fresh
        exact (by cases fresh)
      · exact Eq.trans (tableSet_other _ _ _ same _) lookup
  | _ => exact lookup

/-- **A publication is immutable.** A published version's publication record is never
rewritten by any later transition (P11-SLATE-IMMUTABLE-PUBLICATION). -/
theorem publication_is_immutable {env ledger label after id record}
    (step : SlateStep env ledger label after)
    (lookup : ledger.publications id = some record) :
    after.publications id = some record := by
  cases step with
  | publish versionLookup owned fresh =>
      rename_i _slate publication _version _versionRecord
      by_cases same : id = publication
      · subst same
        rw [lookup] at fresh
        exact (by cases fresh)
      · exact Eq.trans (tableSet_other _ _ _ same _) lookup
  | _ => exact lookup

/-- **Rollback retargets only an owned successful deployment, touching nothing else.**
The target deployment already exists, belongs to the same Slate, and succeeded; the
transition changes exactly the Slate's active pointer (P11-SLATE-ROLLBACK-POINTER). -/
theorem rollback_retargets_only_owned_successful_deployment {env ledger slate deployment
    after} (step : SlateStep env ledger (.rollback slate deployment) after) :
    ∃ record deploymentRecord,
      ledger.slates slate = some record ∧
      ledger.deployments deployment = some deploymentRecord ∧
      deploymentRecord.slate = slate ∧ deploymentRecord.succeeded = true ∧
      after = { ledger with
        slates := tableSet ledger.slates slate { record with active := some deployment } } := by
  cases step with
  | rollback slateLookup deploymentLookup owned succeeded =>
      exact ⟨_, _, slateLookup, deploymentLookup, owned, succeeded, rfl⟩

/-- **Only deploy contacts the provider.** The provider-contact log grows exactly at a
`deploy`; a rollback — like every other Slate transition — records no provider contact,
so applying a version to an external provider is always `deploy` with its
`externalSend` impact, never `rollback` (P11-SLATE-ROLLBACK-NO-DEPLOY). -/
theorem provider_contact_only_from_deploy {env ledger label after}
    (step : SlateStep env ledger label after)
    (grew : after.providerContacts ≠ ledger.providerContacts) :
    ∃ slate deployment publication succeeded,
      label = .deploy slate deployment publication succeeded ∧
      after.providerContacts = deployment :: ledger.providerContacts := by
  cases step with
  | deploy slateLookup publicationLookup owned fresh => exact ⟨_, _, _, _, rfl, rfl⟩
  | _ => exact absurd rfl grew

/-- **A live preview is an Environment Session.** Opening a preview requires a live
exposure over a live session at the exposure's exact epoch in the environment ledger,
and records exactly that session — so §4.5's revocation and staleness rules close a
preview the moment its session or exposure dies (P11-SLATE-PREVIEW). -/
theorem preview_is_live_environment_session {env ledger slate preview session exposure
    after} (step : SlateStep env ledger (.openPreview slate preview session exposure) after) :
    ∃ exposureRecord sessionRecord,
      env.exposures exposure = some exposureRecord ∧ exposureRecord.live = true ∧
      exposureRecord.session = session ∧
      env.sessions session = some sessionRecord ∧ sessionRecord.phase = .live ∧
      sessionRecord.epoch = exposureRecord.sessionEpoch ∧
      after.previews preview = some ⟨slate, session, exposure⟩ := by
  cases step with
  | openPreview slateLookup fresh exposureLookup live sessionEq sessionLookup phase epoch =>
      exact ⟨_, _, exposureLookup, live, sessionEq, sessionLookup, phase, epoch,
        tableSet_self ..⟩

end AgentCore
