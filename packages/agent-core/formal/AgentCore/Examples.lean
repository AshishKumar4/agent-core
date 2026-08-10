import AgentCore.Proofs.CanonicalMediatedTrace
import AgentCore.Slates
import AgentCore.Subscriptions
import AgentCore.Commands

/-! Constructive witnesses for the final designated claim families. -/

namespace AgentCore.Examples

theorem nonvacuous_canonical_mediated_attempt :
    ∃ state attemptId storedAttempt admission,
      Reachable state ∧
      state.core.effects.attempts attemptId = some storedAttempt ∧
      state.core.effects.admissions attemptId = some admission := by
  rcases CanonicalMediatedTrace.canonical_single_item_mediated_attempt_reachable with
    ⟨reachable, storedAttempt, admission, attemptLookup, admissionLookup, _, _⟩
  exact ⟨_, _, storedAttempt, admission, reachable, attemptLookup, admissionLookup⟩

theorem nonvacuous_canonical_mediated_attempt_audit_atomic :
    ∃ state attemptId auditId attempt entry,
      Reachable state ∧ state.core.effects.attempts attemptId = some attempt ∧
      state.core.audit.entries auditId = some entry ∧
      entry.kind = .attempt attemptId attempt.invocation ∧
      entry.cause = some attempt.auditCause := by
  obtain ⟨attempt, entry, attemptLookup, auditLookup, kind, cause⟩ :=
    CanonicalMediatedTrace.canonical_witness_attempt_and_audit_are_atomic
  exact ⟨_, _, _, attempt, entry,
    CanonicalMediatedTrace.canonical_single_item_mediated_attempt_reachable.1,
    attemptLookup, auditLookup, kind, cause⟩

private def tenant : TenantId := ⟨1⟩
private def workspace : WorkspaceId := ⟨1⟩
private def principal : PrincipalId := ⟨1⟩
private def principalRef : PrincipalRef := ⟨tenant, principal⟩
private def foreignTenantPrincipalRef : PrincipalRef := ⟨⟨2⟩, principal⟩
private def agent : AgentId := ⟨1⟩
private def runId : RunId := ⟨1⟩
private def turnId : TurnId := ⟨1⟩
private def branchId : BranchId := ⟨1⟩
private def facet : FacetId := ⟨1⟩
private def bindingId : BindingId := ⟨1⟩
private def invocationId : InvocationId := ⟨1⟩
private def scope : Scope := .workspace tenant none workspace
private def tenantScope : Scope := .tenant tenant
private def token : LeaseToken := ⟨turnId, principalRef, 1⟩

theorem nonvacuous_qualified_principal_identity : principalRef ≠ foreignTenantPrincipalRef := by
  apply principal_ref_tenant_is_identity
  decide

/-- The tenant-qualified subject refuses admission for real: a Principal from another
Tenant does not act under a Grant naming this one's Principal, whatever the ledger holds.
The two refs share a PrincipalId and differ only in Tenant, which is the confusion the
qualification exists to make unrepresentable. -/
theorem nonvacuous_foreign_tenant_principal_never_acts_under
    (ledger : AuthorityLedger) :
    ¬ ledger.ActsUnder foreignTenantPrincipalRef (.principal principalRef) := by
  apply AuthorityLedger.acts_under_principal_is_tenant_qualified
  decide

private def allModes : PlacementSet := ⟨true, true, true⟩
private def providerModes : PlacementSet := ⟨true, true, false⟩
private def bundledMode : PlacementSet := ⟨true, false, false⟩
private def bundledPlacement : PlacementSnapshot :=
  ⟨bundledMode, bundledMode, bundledMode, bundledMode, .bundled⟩

theorem nonvacuous_all_mode_preference :
    choosePlacement allModes allModes allModes allModes = some .dynamic ∧
    choosePlacement providerModes providerModes providerModes providerModes = some .provider ∧
    choosePlacement bundledMode bundledMode bundledMode bundledMode = some .bundled := by
  exact ⟨rfl, rfl, rfl⟩

private def firstArgs : StructuralValue := ⟨"json-v1", ["first"]⟩
private def secondArgs : StructuralValue := ⟨"json-v1", ["second"]⟩
private def header : InvocationHeader := {
  invocation := invocationId
  operation := ⟨facet, "observe", 1⟩
  impact := .observe
  domain := .run tenant runId
  target := .external tenant "resource"
  authority := .initiator principalRef bindingId
  caller := ⟨.run tenant runId, true⟩
  lease := some token
  placement := bundledPlacement
  pathEvidence := [⟨tenantScope, 0⟩, ⟨scope, 0⟩]
  routeEvidence := ⟨none, none⟩
  projectionDigest := none
  auditCause := ⟨1⟩
  idempotencySeed := "seed"
}
private def prepared : PreparedInvocation := ⟨header, .batch firstArgs [secondArgs]⟩
private def firstKey : ItemKey := deriveItemKey header prepared.payload 0 firstArgs
private def secondKey : ItemKey := deriveItemKey header prepared.payload 1 secondArgs
private def firstPreparedArgs : StructuralValue := ⟨"json-v1", ["first-prepared"]⟩
private def secondPreparedArgs : StructuralValue := ⟨"json-v1", ["second-prepared"]⟩
private def firstEffectOutput : StructuralValue := ⟨"json-v1", ["first-effect"]⟩
private def secondEffectOutput : StructuralValue := ⟨"json-v1", ["second-effect"]⟩
private def firstPresentation : StructuralValue := ⟨"json-v1", ["first-presented"]⟩
private def secondPresentation : StructuralValue := ⟨"json-v1", ["second-presented"]⟩
private def batchReplay : MediatedReplay :=
  ⟨invocationId,
    [⟨0, firstKey, [⟨⟨facet, 1⟩, firstArgs, firstPreparedArgs⟩], firstPreparedArgs,
        firstEffectOutput, [⟨⟨facet, 2⟩, firstEffectOutput, firstPresentation⟩],
        firstPresentation⟩,
      ⟨1, secondKey, [⟨⟨facet, 1⟩, secondArgs, secondPreparedArgs⟩], secondPreparedArgs,
        secondEffectOutput, [⟨⟨facet, 2⟩, secondEffectOutput, secondPresentation⟩],
        secondPresentation⟩]⟩

theorem nonvacuous_batch_replay_item_association :
    batchReplay.ValidFor prepared ∧
    batchReplay.items.map ReplayItem.index = [0, 1] ∧
    batchReplay.items.map ReplayItem.key = [firstKey, secondKey] := by
  have valid : batchReplay.ValidFor prepared := by
    simp [batchReplay, prepared, header, MediatedReplay.ValidFor,
      PreparedInvocation.items, InvocationPayload.arguments, prepareItems,
      prepareItemsFrom, ReplayItemsMatch, ReplayItem.ValidFor, TransformationChain,
      firstKey, secondKey]
  exact ⟨valid, rfl, rfl⟩

theorem nonvacuous_complete_identity_and_keys :
    prepared.header.invocation = invocationId ∧ prepared.items.length = 2 ∧
    ∀ item, item ∈ prepared.items →
      item.key.header = prepared.header ∧
      item.key = deriveItemKey prepared.header prepared.payload item.index item.arguments := by
  refine ⟨rfl, rfl, ?_⟩
  intro item member
  exact ⟨(prepared_item_key_commits_complete_structure member).2.1,
    prepared_item_key_is_derived member⟩

private def grantId : GrantId := .manual 1
private def allowGrant : Grant :=
  ⟨.principal principalRef, scope, .allow, header.permission, none, .manual⟩
private def binding : Binding := ⟨header.domain, scope, "observer", 1, grantId, facet⟩
private def authorityBase : AuthorityLedger := {
  (default : AuthorityLedger) with
  grants := tableSet (default : AuthorityLedger).grants grantId allowGrant
  bindings := tableSet (default : AuthorityLedger).bindings bindingId binding
}

private theorem authorized : authorityBase.Authorized principalRef header scope := by
  refine ⟨binding, allowGrant,
    by simp [authorityBase, header, InvocationHeader.binding, AuthoritySource.binding],
    rfl, rfl, rfl, rfl, ?_, rfl, ?_, ?_⟩
  · apply AuthorityLedger.LiveGrant.root
    · simp [authorityBase, binding, grantId]
    · rfl
    · intro revoked; contradiction
  · exact ⟨rfl, rfl, Scope.contains_refl scope, rfl, rfl⟩
  · intro denied
    obtain ⟨id, grant, live, deny, applies⟩ := denied
    cases live with
    | root lookup _ _ | child lookup _ _ _ =>
        by_cases same : id = grantId
        · subst id
          change tableSet (default : AuthorityLedger).grants grantId allowGrant grantId = some grant at lookup
          rw [tableSet_self] at lookup
          cases Option.some.inj lookup
          contradiction
        · change tableSet (default : AuthorityLedger).grants grantId allowGrant id = some grant at lookup
          rw [tableSet_other _ _ _ same] at lookup
          contradiction

private theorem completePath : authorityBase.PathEvidenceComplete header scope := by
  constructor
  · rfl
  · intro evidence member
    change evidence ∈ [⟨tenantScope, 0⟩, ⟨scope, 0⟩] at member
    simp only [List.mem_cons, List.mem_nil_iff, or_false] at member
    rcases member with rfl | rfl <;> rfl

private def resolution : Resolution :=
  ⟨⟨1⟩, principalRef, header, scope, ⟨0⟩, ⟨5⟩, some ⟨10⟩⟩
private def issuedAuthority : AuthorityLedger := authorityBase.issueResolution resolution

theorem nonvacuous_authorized_resolution_issue :
    AuthorityLedger.AuthorityStep authorityBase (.resolve resolution) issuedAuthority := by
  apply AuthorityLedger.AuthorityStep.resolve
  · rfl
  · exact authorized
  · exact completePath
  · intro evidence member
    change evidence ∈ [⟨tenantScope, 0⟩, ⟨scope, 0⟩] at member
    simp only [List.mem_cons, List.mem_nil_iff, or_false] at member
    rcases member with rfl | rfl <;> exact Nat.le_refl _
  · exact ⟨by decide, by simp [resolution, header, token]⟩

private def foreignMembership : Membership :=
  ⟨⟨2⟩, .foreign ⟨2⟩ principal, scope, ⟨2⟩⟩
private def denyRule : RoleRule :=
  ⟨.deny, ⟨.external tenant "admin", .administer⟩⟩
private def denyRole : Role := ⟨⟨2⟩, [denyRule]⟩

theorem nonvacuous_foreign_guest_deny :
    (materializeRole (default : AuthorityLedger) foreignMembership denyRole).grants
      (.role foreignMembership.id 0) =
      some (grantOfRoleRule foreignMembership denyRole 0 denyRule) := by
  apply guest_deny_is_preserved rfl rfl rfl

private def lease : TurnLease := ⟨turnId, some principalRef, 1, ⟨10⟩⟩
private def pins : RunPins :=
  ⟨⟨⟨1⟩, 1, 101⟩, [⟨⟨1⟩, 1, 201, 202⟩], ⟨agent, 1, 102⟩,
    ⟨⟨1⟩, 1, 301⟩, ⟨⟨1⟩, 1, 302⟩, ⟨⟨1⟩, 1, 303⟩⟩
private def differentEnvironmentPins : RunPins :=
  { pins with environment := ⟨⟨2⟩, pins.environment.revision, pins.environment.digest⟩ }
private def turnPins : TurnPins := ⟨pins, bundledPlacement⟩
private def runningTurn : Turn := ⟨runId, branchId, turnPins, .running, lease⟩
private def directRun : Run :=
  ⟨tenant, workspace, agent, pins, ⟨100⟩, branchId, none, .active, []⟩
private def graphWithTurn : GraphStore := {
  (default : GraphStore) with
  runs := tableSet (default : GraphStore).runs runId directRun
  turns := tableSet (default : GraphStore).turns turnId runningTurn
}
private def directState : SystemState := {
  (default : SystemState) with authority := issuedAuthority, graph := graphWithTurn
}
private def directRequest : AdmissionRequest := ⟨prepared, scope, resolution.id, none, ⟨1⟩, []⟩

theorem nonvacuous_exact_run_pin_sources :
    pins.blueprint.id = ⟨1⟩ ∧ pins.agent.id = agent ∧
    pins.effectivePolicy.id = ⟨1⟩ ∧ pins.modelPolicy.id = ⟨1⟩ ∧
    pins.environment.id = ⟨1⟩ ∧ pins ≠ differentEnvironmentPins := by
  refine ⟨rfl, rfl, rfl, rfl, rfl, ?_⟩
  exact (environment_pin_identity_prevents_revision_alias
    (left := pins) (right := differentEnvironmentPins) (by decide) rfl).1

private theorem directReady : DirectReady directState directRequest := by
  refine ⟨rfl, ⟨rfl, ?_⟩, ?_, rfl, rfl, rfl, ?_,
    resolution, token, runningTurn, ?_, rfl, ?_, rfl, ?_⟩
  · intro noLease
    simp [directRequest, prepared, header] at noLease
  · simp [RouteGate, InvocationHeader.RouteEvidenceConsistent, directRequest, prepared, header]
  · exact ⟨token, runningTurn, rfl,
      by simp [directState, graphWithTurn, token, turnId], rfl,
      ⟨directRun, by simp [directState, graphWithTurn, runningTurn], rfl, rfl, rfl⟩,
      ⟨rfl, rfl, rfl, by decide⟩⟩
  · change tableSet authorityBase.resolutions resolution.id resolution resolution.id = some resolution
    exact tableSet_self ..
  · simp [directState, graphWithTurn, token, turnId]
  · refine ⟨?_, Or.inr rfl, rfl, by decide, ?_⟩
    · change tableSet authorityBase.resolutions resolution.id resolution resolution.id = some resolution
      exact tableSet_self ..
    · intro evidence member
      change evidence ∈ [⟨tenantScope, 0⟩, ⟨scope, 0⟩] at member
      simp only [List.mem_cons, List.mem_nil_iff, or_false] at member
      rcases member with rfl | rfl <;> exact Nat.le_refl _

theorem nonvacuous_direct_nondurable : DirectStep directState directRequest directState :=
  .admit directReady

private def attempt0ClaimId : ItemClaimId := ⟨1⟩
private def attempt1ClaimId : ItemClaimId := ⟨2⟩
private def attempt0 : EffectAttempt :=
  ⟨invocationId, 0, 0, attempt0ClaimId, ⟨1⟩, firstKey, some token, ⟨1⟩⟩
private def attempt1 : EffectAttempt :=
  ⟨invocationId, 1, 0, attempt1ClaimId, ⟨1⟩, secondKey, some token, ⟨1⟩⟩
private def successReceipt : AttemptReceipt := ⟨⟨1⟩, .succeeded, none⟩
private def failedReceipt : AttemptReceipt := ⟨⟨2⟩, .failed, none⟩
private def mixedEffects : EffectLedger := {
  (default : EffectLedger) with
  invocations := tableSet (default : EffectLedger).invocations invocationId prepared
  attempts := tableSet (tableSet (default : EffectLedger).attempts ⟨1⟩ attempt0) ⟨2⟩ attempt1
  attemptReceipts := tableSet
    (tableSet (default : EffectLedger).attemptReceipts ⟨10⟩ successReceipt) ⟨11⟩ failedReceipt
  latestAttempt := fun invocation index =>
    if invocation = invocationId then if index = 0 then some ⟨1⟩ else if index = 1 then some ⟨2⟩ else none
    else none
  currentReceipt := fun invocation index =>
    if invocation = invocationId then
      if index = 0 then some (.attempt ⟨10⟩) else if index = 1 then some (.attempt ⟨11⟩) else none
    else none
}

private theorem item0Current : ItemCurrentOutcome mixedEffects invocationId 0 .succeeded := by
  exact ⟨successReceipt, attempt0,
    by
      change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨10⟩ successReceipt)
        ⟨11⟩ failedReceipt ⟨10⟩ = some successReceipt
      rw [tableSet_other _ _ _ (by decide)]
      exact tableSet_self ..,
    by
      change tableSet (tableSet (default : EffectLedger).attempts ⟨1⟩ attempt0)
        ⟨2⟩ attempt1 ⟨1⟩ = some attempt0
      rw [tableSet_other _ _ _ (by decide)]
      exact tableSet_self ..,
    rfl, rfl, rfl, Or.inl ⟨rfl, rfl⟩⟩

private theorem item1Current : ItemCurrentOutcome mixedEffects invocationId 1 .failed := by
  exact ⟨failedReceipt, attempt1, by
      change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨10⟩ successReceipt)
        ⟨11⟩ failedReceipt ⟨11⟩ = some failedReceipt
      exact tableSet_self ..,
    by simp [mixedEffects, failedReceipt], rfl, rfl, rfl,
    Or.inr (Or.inl ⟨rfl, rfl⟩)⟩

theorem nonvacuous_mixed_batch_partial :
    BatchTerminalOutcome mixedEffects prepared [.succeeded, .failed] .partiallySucceeded := by
  apply mixed_terminal_batch_is_partial rfl item0Current item1Current

private def retryPrior : EffectAttempt := attempt1
private def retryClaimId : ItemClaimId := ⟨3⟩
private def retryWorker : ClaimWorkerId := ⟨1⟩
private def retryClaim : ItemClaim :=
  ⟨retryClaimId, invocationId, 1, 1, .executor token retryWorker, ⟨10⟩⟩
private def retryNext : EffectAttempt :=
  { attempt1 with ordinal := 1, claim := retryClaimId, auditCause := ⟨6⟩ }
private def retryClaimExpiry : Time := ⟨10⟩
private def retryAdmission : AttemptAdmission :=
  ⟨prepared.identity, principalRef, scope, resolution.id⟩
private def retryBefore : EffectLedger := {
  (default : EffectLedger) with
  invocations := tableSet (default : EffectLedger).invocations invocationId prepared
  attempts := tableSet (default : EffectLedger).attempts ⟨2⟩ retryPrior
  admissions := tableSet (default : EffectLedger).admissions ⟨3⟩ retryAdmission
  claims := tableSet (default : EffectLedger).claims retryClaimId retryClaim
  attemptReceipts := tableSet (default : EffectLedger).attemptReceipts ⟨11⟩ failedReceipt
  latestAttempt := fun invocation index =>
    if invocation = invocationId ∧ index = 1 then some ⟨2⟩ else none
  currentReceipt := fun invocation index =>
    if invocation = invocationId ∧ index = 1 then some (.attempt ⟨11⟩) else none
  currentClaim := fun invocation index =>
    if invocation = invocationId ∧ index = 1 then some retryClaimId else none
}

theorem nonvacuous_failed_retry :
    EffectStep retryBefore (.retryAttempt ⟨2⟩ ⟨3⟩)
      (retryBefore.addRetryAttempt ⟨3⟩ retryNext) := by
  apply EffectStep.retryAttempt (prior := retryPrior) (prepared := prepared) (claim := retryClaim)
    (priorReceipt := ⟨11⟩)
  · rfl
  · simp [retryBefore, retryPrior, attempt1]
  · simp [retryBefore, retryPrior, attempt1, invocationId]
  · simp [retryBefore, retryPrior, attempt1, invocationId]
  · exact ⟨failedReceipt, by simp [retryBefore], rfl, rfl, trivial⟩
  · simp [retryBefore, retryPrior, attempt1]
  · exact ⟨retryAdmission, by simp [retryBefore], rfl, rfl,
      ⟨⟨1, secondArgs, secondKey⟩, rfl, rfl, rfl⟩⟩
  · exact ⟨⟨1, secondArgs, secondKey⟩, rfl, rfl, rfl⟩
  · rfl
  · rfl
  · rfl
  · simp [retryBefore, retryNext, retryClaim, retryClaimId]
  · simp [retryBefore, retryNext, retryClaimId, attempt1, invocationId]
  · exact ⟨rfl, rfl, rfl, rfl, rfl⟩
  · decide

private def indeterminateReceipt : AttemptReceipt := ⟨⟨1⟩, .indeterminate, none⟩
private def supersedingReceipt : AttemptReceipt := ⟨⟨1⟩, .succeeded, some ⟨12⟩⟩
private def supersedeBefore : EffectLedger := {
  (default : EffectLedger) with
  attempts := tableSet (default : EffectLedger).attempts ⟨1⟩ attempt0
  attemptReceipts := tableSet (default : EffectLedger).attemptReceipts ⟨12⟩ indeterminateReceipt
  latestAttempt := fun invocation index =>
    if invocation = invocationId ∧ index = 0 then some ⟨1⟩ else none
  currentReceipt := fun invocation index =>
    if invocation = invocationId ∧ index = 0 then some (.attempt ⟨12⟩) else none
}

theorem nonvacuous_same_attempt_supersession :
    EffectStep supersedeBefore (.supersedeReceipt ⟨12⟩ ⟨13⟩)
      (supersedeBefore.supersedeAttemptReceipt ⟨13⟩ ⟨12⟩ supersedingReceipt attempt0) := by
  apply EffectStep.supersedeAttemptReceipt (beforeReceipt := indeterminateReceipt)
    (attempt := attempt0)
  · rfl
  · rfl
  · simp [supersedeBefore, supersedingReceipt]
  · rfl
  · rfl
  · rfl
  · rfl
  · trivial
  · simp [supersedeBefore, supersedingReceipt]
  · simp [supersedeBefore, attempt0, invocationId]

private def rootAudit : AuditEntry :=
  ⟨.run tenant runId, 1, 7, none, .invocation invocationId⟩
private def auditOne : AuditLog := {
  entries := tableSet (default : AuditLog).entries ⟨1⟩ rootAudit
  atSequence := fun actor sequence => if actor = rootAudit.actor ∧ sequence = 1 then some ⟨1⟩ else none
}
private def childAudit : AuditEntry :=
  ⟨.run tenant runId, 2, 7, some ⟨1⟩, .attempt ⟨1⟩ invocationId⟩
private def auditTwo : AuditLog := auditOne.append ⟨2⟩ childAudit
private theorem rootChain : CausalChain (default : EventStore) auditOne ⟨1⟩ := by
  apply CausalChain.root (entry := rootAudit)
  · simp [auditOne]
  · rfl
  · trivial
private theorem childAuditStep :
    AuditStep mixedEffects (default : EventStore) auditOne (.append ⟨2⟩) auditTwo := by
  apply AuditStep.append
  · rfl
  · rfl
  · exact ⟨rootAudit, by simp [auditOne], rfl, by decide, rfl, rfl⟩
  · exact rootChain
  · refine ⟨attempt0, ?_, rfl, rfl⟩
    change tableSet (tableSet (default : EffectLedger).attempts ⟨1⟩ attempt0)
      ⟨2⟩ attempt1 ⟨1⟩ = some attempt0
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..

theorem nonvacuous_actor_local_typed_audit :
    ∃ after, AuditStep mixedEffects (default : EventStore) auditOne (.append ⟨2⟩) after := by
  exact ⟨auditTwo, childAuditStep⟩

private def reservationId : ReservationId := ⟨1⟩
private def projectionId : ProjectionId := ⟨1⟩
private def projectionDigest : StructuralValue := ⟨"projection-v1", ["route"]⟩
private def reservation : RouteReservation :=
  ⟨invocationId, .workspace tenant workspace, .run tenant runId, some turnId,
    ⟨20⟩, ⟨20⟩, .sameTenant (.initiator principalRef bindingId), projectionId,
    projectionDigest⟩
private def projection : RouteProjection :=
  ⟨reservationId, .run tenant runId, true, projectionDigest, none, ⟨1⟩⟩
private def delivery : RouteDelivery :=
  ⟨reservationId, some turnId, .succeeded, ⟨22⟩⟩
private def routedEvents : EventStore := {
  (default : EventStore) with
  reservations := tableSet (default : EventStore).reservations reservationId reservation
  reservationFor := tableSet (default : EventStore).reservationFor invocationId reservationId
  projections := tableSet (default : EventStore).projections projectionId projection
  projectionFor := tableSet (default : EventStore).projectionFor reservationId projectionId
}
private def deliveredEvents : EventStore := {
  routedEvents with deliveries := tableSet routedEvents.deliveries reservationId delivery
}
private def projectionAudit : AuditEntry :=
  ⟨.run tenant runId, 1, 9, none,
    .routeProjected projectionId reservationId invocationId⟩
private def projectionAuditLog : AuditLog := (default : AuditLog).append ⟨21⟩ projectionAudit
private def deliveryAudit : AuditEntry :=
  ⟨.run tenant runId, 2, 9, some ⟨21⟩,
    .delivery reservationId projectionId invocationId .succeeded⟩

theorem nonvacuous_projection_reservation_bridge :
    AuditStep (default : EffectLedger) routedEvents (default : AuditLog)
      (.projectBridge ⟨21⟩ projectionId) projectionAuditLog := by
  apply AuditStep.projectionBridge (projection := projection) (reservation := reservation)
  · rfl
  · rfl
  · simp [routedEvents, projectionId]
  · rfl
  · simp [routedEvents, projection, reservationId]
  · rfl
  · rfl
  · simp [routedEvents, projection, reservationId]
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · trivial

theorem nonvacuous_route_delivery :
    EventStep (fun _ => none) ⟨2⟩ routedEvents (.deliver reservationId) deliveredEvents := by
  apply EventStep.deliver (delivery := delivery) (reservation := reservation)
  · rfl
  · simp [routedEvents, reservationId]
  · rfl
  · rfl

theorem nonvacuous_delivery_local_audit :
    ∃ after, AuditStep (default : EffectLedger) deliveredEvents projectionAuditLog
      (.append ⟨22⟩) after := by
  refine ⟨projectionAuditLog.append ⟨22⟩ deliveryAudit, ?_⟩
  apply AuditStep.append
  · rfl
  · rfl
  · refine ⟨projectionAudit, ?_, rfl, by decide, rfl, ⟨rfl, rfl, rfl⟩⟩
    change tableSet (default : AuditLog).entries ⟨21⟩ projectionAudit ⟨21⟩ = some projectionAudit
    exact tableSet_self ..
  · apply CausalChain.bridge (entry := projectionAudit) (projectionId := projectionId)
      (reservationId := reservationId) (projection := projection) (reservation := reservation)
    · change tableSet (default : AuditLog).entries ⟨21⟩ projectionAudit ⟨21⟩ =
        some projectionAudit
      exact tableSet_self ..
    · rfl
    · simp [deliveredEvents, routedEvents, projectionId]
    · rfl
    · simp [deliveredEvents, routedEvents, projection, reservationId]
    · rfl
    · rfl
    · simp [projection, reservation]
    · simp [deliveredEvents, routedEvents, projection, reservationId]
    · rfl
    · rfl
    · rfl
  · trivial

private def noTurnHeader : InvocationHeader := {
  header with
  invocation := ⟨2⟩
  impact := .externalSend
  operation := ⟨facet, "send", 1⟩
  lease := none
  placement := ⟨allModes, allModes, allModes, allModes, .dynamic⟩
  auditCause := ⟨1⟩
}

theorem nonvacuous_optional_turn_owner_audit :
    MediatedLeaseGate { (default : SystemState) with audit := auditOne } noTurnHeader ⟨1⟩ := by
  exact ⟨rootAudit, by simp [auditOne, noTurnHeader, header], rfl, rfl, rfl⟩

private def selfEvent : Event :=
  ⟨tenant, .run tenant runId, .input, "self", ⟨false, false⟩, none, some token, .self⟩
private def eventAfter : EventStore := {
  (default : EventStore) with events := tableSet (default : EventStore).events ⟨1⟩ selfEvent
}

theorem nonvacuous_live_self_event :
    EventStep (fun id => if id = turnId then some lease else none) ⟨1⟩
      (default : EventStore) (.publish ⟨1⟩) eventAfter := by
  apply EventStep.publish
  · rfl
  · rfl
  · rfl
  · exact ⟨token, lease, rfl, by simp [token, turnId], ⟨rfl, rfl, rfl, by decide⟩⟩

private def rootCommitId : CommitId := ⟨100⟩
private def run : Run := ⟨tenant, workspace, agent, pins, rootCommitId, branchId, none, .active, []⟩
private def rootCommit : RunCommit :=
  ⟨runId, branchId, pins, .root ⟨1⟩, [], none, .root, none⟩
private def rootGraph : GraphStore := {
  (default : GraphStore) with
  runs := tableSet (default : GraphStore).runs runId run
  branches := tableSet (default : GraphStore).branches branchId ⟨runId⟩
  commits := tableSet (default : GraphStore).commits rootCommitId rootCommit
  heads := tableSet (default : GraphStore).heads branchId rootCommitId
  admissionRegistry := tableSet (default : GraphStore).admissionRegistry runId ⟨0, true, [], []⟩
}
private theorem rootCause : AuditCauseExists auditOne ⟨1⟩ runId :=
  ⟨rootAudit, by simp [auditOne], rfl⟩

theorem nonvacuous_pinned_root_writer :
    GraphStep (default : EffectLedger) (default : EventStore) auditOne
      (default : GraphStore) (.startRun runId rootCommitId) rootGraph := by
  apply GraphStep.startRun (cause := ⟨1⟩)
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · simp [RunPins.Valid, run, pins, agent]
  · simp [run]
  · simp [run]
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · exact rootCause

private def migratedRun : Run := { run with pins := differentEnvironmentPins }
private def migratedOldTurnGraph : GraphStore := {
  rootGraph with
  runs := tableSet rootGraph.runs runId migratedRun
  turns := tableSet rootGraph.turns turnId runningTurn
}

theorem nonvacuous_migrated_old_turn_rejected :
    ¬ GraphStep (default : EffectLedger) (default : EventStore) auditOne
      migratedOldTurnGraph (.terminalize runId turnId ⟨999⟩ rootCommitId)
      (default : GraphStore) := by
  apply migrated_old_turn_cannot_terminalize
    (runRecord := migratedRun) (turnRecord := runningTurn)
  · simp [migratedOldTurnGraph, migratedRun, rootGraph, runId]
  · simp [migratedOldTurnGraph, turnId]
  · decide

private def invalidMigrationPins : RunPins := { pins with packageClosure := [] }
private def invalidMigrationCommit : RunCommit :=
  ⟨runId, branchId, invalidMigrationPins, .system (.control ⟨34⟩ ⟨30⟩),
    [rootCommitId], none, .migration invalidMigrationPins header.operation ⟨30⟩, none⟩

theorem nonvacuous_invalid_migration_target_rejected :
    ¬ GraphStep (default : EffectLedger) (default : EventStore) auditOne rootGraph
      (.migrate runId ⟨998⟩ rootCommitId invalidMigrationCommit) (default : GraphStore) := by
  intro step
  obtain ⟨runRecord, target, operation, receipt, runLookup, kind, valid⟩ :=
    migration_requires_valid_target_pins step
  change invalidMigrationCommit.kind = .migration target operation receipt at kind
  injection kind with targetEq
  subst target
  exact valid.2.1 rfl

private def reservedRootGraph : GraphStore :=
  rootGraph.reserve runId ⟨0, true, [], []⟩ (.approval ⟨99⟩)

theorem nonvacuous_run_admission_reservation :
    GraphStep (default : EffectLedger) (default : EventStore) auditOne rootGraph
      (.reserveObligation runId 0 (.approval ⟨99⟩)) reservedRootGraph := by
  apply GraphStep.reserveObligation (run := run) (registry := ⟨0, true, [], []⟩)
  · simp [rootGraph, runId]
  · rfl
  · simp [rootGraph, runId]
  · rfl
  · trivial
  · simp
  · simp

theorem nonvacuous_exact_remote_reservation_epoch :
    (⟨runId, 0, .approval ⟨99⟩⟩ : AdmissionReservation).ValidIn reservedRootGraph := by
  refine ⟨⟨0, true, [.approval ⟨99⟩], []⟩, ?_, rfl, rfl, by simp, by simp⟩
  simp [reservedRootGraph, rootGraph, runId, GraphStore.reserve, RunAdmissionRegistry.reserve]

private def completedReservedRootGraph : GraphStore :=
  reservedRootGraph.complete runId ⟨0, true, [.approval ⟨99⟩], []⟩ (.approval ⟨99⟩)

theorem nonvacuous_run_admission_completion :
    GraphStep (default : EffectLedger) (default : EventStore) auditOne reservedRootGraph
      (.completeObligation runId 0 (.approval ⟨99⟩)) completedReservedRootGraph := by
  apply GraphStep.completeObligation (run := run)
    (registry := ⟨0, true, [.approval ⟨99⟩], []⟩)
  · simp [reservedRootGraph, rootGraph, runId, GraphStore.reserve,
      RunAdmissionRegistry.reserve]
  · rfl
  · simp [reservedRootGraph, rootGraph, runId, GraphStore.reserve,
      RunAdmissionRegistry.reserve]
  · rfl
  · trivial
  · simp
  · simp

theorem nonvacuous_registry_nonempty_and_completed_frontiers :
    (⟨0, true, [.approval ⟨99⟩], []⟩ : RunAdmissionRegistry).outstanding =
      [.approval ⟨99⟩] ∧
    (⟨0, true, [.approval ⟨99⟩], [.approval ⟨99⟩]⟩ : RunAdmissionRegistry).outstanding = [] := by
  decide

private def sourceBranch : BranchId := ⟨2⟩
private def sourceHead : CommitId := ⟨102⟩
private def sourceCommit : RunCommit :=
  ⟨runId, sourceBranch, pins, .root ⟨1⟩, [], none, .root, none⟩
private def mergeGraph : GraphStore := {
  rootGraph with
  branches := tableSet rootGraph.branches sourceBranch ⟨runId⟩
  commits := tableSet rootGraph.commits sourceHead sourceCommit
  heads := tableSet rootGraph.heads sourceBranch sourceHead
}
private def mergeCommit : RunCommit :=
  ⟨runId, branchId, pins, .system (.control ⟨1⟩ ⟨30⟩),
    [rootCommitId, sourceHead], none,
    .merge (.concatenate ⟨30⟩) (.clean ⟨1⟩), none⟩

theorem nonvacuous_equal_pin_current_merge_heads :
    CurrentMergeHeads mergeGraph mergeCommit rootCommitId := by
  refine ⟨sourceBranch, sourceHead, rootCommit, sourceCommit, by decide, ?_, ?_, by decide,
    rfl, ?_, ?_, rfl, rfl, rfl, rfl⟩
  · change tableSet (tableSet (default : GraphStore).heads branchId rootCommitId)
      sourceBranch sourceHead branchId = some rootCommitId
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..
  · change tableSet (tableSet (default : GraphStore).heads branchId rootCommitId)
      sourceBranch sourceHead sourceBranch = some sourceHead
    exact tableSet_self ..
  · change tableSet (tableSet (default : GraphStore).commits rootCommitId rootCommit)
      sourceHead sourceCommit rootCommitId = some rootCommit
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..
  · change tableSet (tableSet (default : GraphStore).commits rootCommitId rootCommit)
      sourceHead sourceCommit sourceHead = some sourceCommit
    exact tableSet_self ..

private def deliveryAuditLog : AuditLog := projectionAuditLog.append ⟨22⟩ deliveryAudit
private def deliveryCommit : RunCommit :=
  ⟨runId, branchId, pins, .system (.delivery ⟨22⟩ reservationId), [rootCommitId],
    some turnId, .deliveryEvidence header.operation reservationId .succeeded, none⟩

private theorem deliveryEvidenceWitness :
    DeliveryEvidence mixedEffects deliveredEvents reservationId header.operation .succeeded
      runId (some turnId) := by
  exact ⟨reservation, delivery, prepared, tenant,
    by simp [deliveredEvents, routedEvents, reservationId],
    by simp [deliveredEvents, reservationId], rfl, rfl,
    by simp [mixedEffects, reservation], rfl, rfl, rfl⟩

theorem nonvacuous_delivery_writer :
    CommitAllowed rootGraph mixedEffects deliveredEvents deliveryAuditLog ⟨2⟩ deliveryCommit := by
  refine ⟨rfl, ?_, ?_, ?_⟩
  · exact ⟨run, deliveryAudit, reservation, delivery,
      by simp [deliveryCommit, rootGraph, runId],
      by
        change tableSet projectionAuditLog.entries ⟨22⟩ deliveryAudit ⟨22⟩ = some deliveryAudit
        exact tableSet_self ..,
      rfl, by simp [deliveredEvents, routedEvents, reservationId],
      by simp [deliveredEvents, reservationId], rfl, rfl, deliveryEvidenceWitness⟩
  · exact ⟨rootCommitId, rootCommit, rfl,
      by simp [rootGraph, rootCommitId], rfl⟩
  · exact deliveryEvidenceWitness

private def controlInvocation : InvocationId := ⟨3⟩
private def synthesisInvocation : InvocationId := ⟨4⟩
private def synthesisOperation : OperationId := ⟨facet, "synthesize", 1⟩
private def controlHeader : InvocationHeader := {
  header with
  invocation := controlInvocation
  operation := synthesisOperation
  impact := .administer
  lease := none
}
private def synthesisHeader : InvocationHeader := {
  header with
  invocation := synthesisInvocation
  operation := synthesisOperation
  impact := .execute
}
private def controlPrepared : PreparedInvocation := ⟨controlHeader, .single firstArgs⟩
private def synthesisPrepared : PreparedInvocation := ⟨synthesisHeader, .single secondArgs⟩
private def controlClaimId : ItemClaimId := ⟨30⟩
private def synthesisClaimId : ItemClaimId := ⟨31⟩
private def controlAttempt : EffectAttempt :=
  ⟨controlInvocation, 0, 0, controlClaimId, ⟨30⟩,
    deriveItemKey controlHeader controlPrepared.payload 0 firstArgs, none, ⟨1⟩⟩
private def synthesisAttempt : EffectAttempt :=
  ⟨synthesisInvocation, 0, 0, synthesisClaimId, ⟨31⟩,
    deriveItemKey synthesisHeader synthesisPrepared.payload 0 secondArgs, some token, ⟨1⟩⟩
private def controlReceipt : AttemptReceipt := ⟨⟨30⟩, .succeeded, none⟩
private def synthesisReceipt : AttemptReceipt := ⟨⟨31⟩, .succeeded, none⟩
private def synthesisEffects : EffectLedger := {
  (default : EffectLedger) with
  invocations := tableSet
    (tableSet (default : EffectLedger).invocations controlInvocation controlPrepared)
    synthesisInvocation synthesisPrepared
  attempts := tableSet
    (tableSet (default : EffectLedger).attempts ⟨30⟩ controlAttempt) ⟨31⟩ synthesisAttempt
  attemptReceipts := tableSet
    (tableSet (default : EffectLedger).attemptReceipts ⟨30⟩ controlReceipt)
    ⟨31⟩ synthesisReceipt
}
private def controlCommitAuditEntry : AuditEntry :=
  ⟨.run tenant runId, 1, 30, none,
    .attemptReceipt ⟨30⟩ ⟨30⟩ controlInvocation .succeeded⟩
private def synthesisAuditLog : AuditLog := {
  (default : AuditLog) with
  entries := tableSet (default : AuditLog).entries ⟨34⟩ controlCommitAuditEntry
}
private def synthesisCommit : RunCommit :=
  ⟨runId, branchId, pins, .system (.control ⟨34⟩ ⟨30⟩),
    [rootCommitId, sourceHead], some turnId,
    .merge (.synthesize synthesisOperation ⟨30⟩ ⟨31⟩ token synthesisPrepared.identity)
      (.clean ⟨2⟩), none⟩

private theorem controlSuccess :
    SuccessfulControl synthesisEffects ⟨30⟩ synthesisOperation runId := by
  exact ⟨controlReceipt, controlAttempt, controlPrepared,
    by
      change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨30⟩ controlReceipt)
        ⟨31⟩ synthesisReceipt ⟨30⟩ = some controlReceipt
      rw [tableSet_other _ _ _ (by decide)]
      exact tableSet_self ..,
    rfl,
    by
      change tableSet (tableSet (default : EffectLedger).attempts ⟨30⟩ controlAttempt)
        ⟨31⟩ synthesisAttempt ⟨30⟩ = some controlAttempt
      rw [tableSet_other _ _ _ (by decide)]
      exact tableSet_self ..,
    by
      change tableSet (tableSet (default : EffectLedger).invocations controlInvocation controlPrepared)
        synthesisInvocation synthesisPrepared controlInvocation = some controlPrepared
      rw [tableSet_other _ _ _ (by decide)]
      exact tableSet_self ..,
    rfl, rfl, ⟨tenant, rfl⟩⟩

private theorem synthesisSuccess :
    SuccessfulSynthesis synthesisEffects ⟨31⟩ synthesisOperation runId token
      synthesisPrepared.identity := by
  refine ⟨synthesisReceipt, synthesisAttempt, synthesisPrepared, ?_, rfl, ?_, ?_,
    rfl, rfl, rfl, rfl, rfl, ⟨tenant, rfl⟩⟩
  · change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨30⟩ controlReceipt)
      ⟨31⟩ synthesisReceipt ⟨31⟩ = some synthesisReceipt
    exact tableSet_self ..
  · change tableSet (tableSet (default : EffectLedger).attempts ⟨30⟩ controlAttempt)
      ⟨31⟩ synthesisAttempt synthesisReceipt.attempt = some synthesisAttempt
    simp [synthesisReceipt]
  · change tableSet (tableSet (default : EffectLedger).invocations controlInvocation controlPrepared)
      synthesisInvocation synthesisPrepared synthesisAttempt.invocation = some synthesisPrepared
    simp [synthesisAttempt]

private theorem controlCommitAuditWitness :
    ControlCommitAudit mergeGraph synthesisEffects synthesisAuditLog ⟨34⟩ ⟨30⟩
      synthesisOperation runId := by
  refine ⟨run, controlCommitAuditEntry, controlReceipt, controlAttempt, controlPrepared,
    ?_, ?_, rfl, ?_, rfl, ?_, ?_, rfl, rfl, ⟨tenant, rfl⟩, rfl⟩
  · simp [mergeGraph, rootGraph, runId]
  · simp [synthesisAuditLog]
  · change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨30⟩ controlReceipt)
      ⟨31⟩ synthesisReceipt ⟨30⟩ = some controlReceipt
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..
  · change tableSet (tableSet (default : EffectLedger).attempts ⟨30⟩ controlAttempt)
      ⟨31⟩ synthesisAttempt ⟨30⟩ = some controlAttempt
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..
  · change tableSet (tableSet (default : EffectLedger).invocations controlInvocation controlPrepared)
      synthesisInvocation synthesisPrepared controlInvocation = some controlPrepared
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..

theorem nonvacuous_system_synthesis_writer :
    CommitAllowed mergeGraph synthesisEffects (default : EventStore) synthesisAuditLog ⟨2⟩
      synthesisCommit := by
  exact ⟨rfl, controlCommitAuditWitness, controlSuccess, synthesisSuccess, rfl⟩

private def auditObligation : OpenObligation :=
  .item invocationId 0 firstKey
private def terminalControl : TerminalizationControl := ⟨turnId, ⟨30⟩, ⟨34⟩⟩
private def terminalBefore : GraphStore := {
  rootGraph with
  turns := tableSet rootGraph.turns turnId runningTurn
  admissionRegistry := tableSet rootGraph.admissionRegistry runId ⟨0, true, [auditObligation], []⟩
  terminalizing := tableSet rootGraph.terminalizing runId terminalControl
}
private def terminalCommitId : CommitId := ⟨101⟩
private def terminalCommit : RunCommit :=
  ⟨runId, branchId, pins, .turn token ⟨1⟩, [rootCommitId], some turnId,
    .terminal .succeeded, none⟩
private def terminalSnapshot : TerminalSnapshot :=
  ⟨runId, turnId, rootCommitId, terminalCommitId, .succeeded, 0, [auditObligation]⟩
private def terminalAfter : GraphStore := {
  (terminalBefore.append terminalCommitId terminalCommit) with
  runs := tableSet terminalBefore.runs runId { run with status := .terminal }
  turns := tableSet terminalBefore.turns turnId
    (runningTurn.withStatusLease .succeeded ⟨turnId, none, 2, ⟨10⟩⟩)
  terminalSnapshots := tableSet terminalBefore.terminalSnapshots runId terminalSnapshot
  admissionRegistry := tableSet terminalBefore.admissionRegistry runId ⟨1, false, [auditObligation], []⟩
  terminalizing := fun candidate => if candidate = runId then none else terminalBefore.terminalizing candidate
}

theorem nonvacuous_nonempty_audit_terminal_snapshot :
    ∃ after, GraphStep (default : EffectLedger) (default : EventStore) auditOne
      terminalBefore (.terminalize runId turnId terminalCommitId rootCommitId) after := by
  refine ⟨terminalAfter, ?_⟩
  apply GraphStep.terminalize (run := run) (turn := runningTurn) (token := token)
    (now := ⟨1⟩) (fenced := ⟨turnId, none, 2, ⟨10⟩⟩) (terminal := .succeeded)
    (registry := ⟨0, true, [auditObligation], []⟩) (commit := terminalCommit) (preterminal := rootCommit)
    (snapshot := terminalSnapshot) (cause := ⟨1⟩) (control := terminalControl)
  · simp [terminalBefore, rootGraph, runId]
  · rfl
  · simp [terminalBefore, turnId]
  · rfl
  · rfl
  · rfl
  · exact ⟨rfl, rfl, rfl, by decide⟩
  · simp [RunPins.Valid, pins, run, agent]
  · rfl
  · simp [terminalBefore, terminalControl, runId]
  · rfl
  · intro id candidate lookup sameRun different
    by_cases same : id = turnId
    · exact (different same).elim
    · change tableSet rootGraph.turns turnId runningTurn id = some candidate at lookup
      rw [tableSet_other _ _ _ same] at lookup
      contradiction
  · exact .terminalFence
  · exact Or.inl rfl
  · change tableSet (default : GraphStore).heads branchId rootCommitId runningTurn.branch =
      some rootCommitId
    simp [runningTurn]
  · simp [terminalBefore, rootGraph, rootCommitId]
  · rfl
  · rfl
  · rfl
  · simp [terminalBefore, runId]
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · exact rootCause
  · rfl
  · rfl
  · rfl
  · rfl

private def forcedSiblingId : TurnId := ⟨3⟩
private def forcedSibling : Turn :=
  ⟨runId, branchId, turnPins, .queued, TurnLease.initial forcedSiblingId⟩
private def terminalAuditLog : AuditLog := {
  synthesisAuditLog with
  entries := tableSet synthesisAuditLog.entries ⟨1⟩ rootAudit
}
private def forceSequenceBefore : GraphStore := {
  rootGraph with
  turns := tableSet (tableSet rootGraph.turns turnId runningTurn) forcedSiblingId forcedSibling
  admissionRegistry := tableSet rootGraph.admissionRegistry runId ⟨0, true, [auditObligation], []⟩
}
private def forceSequenceBegun : GraphStore := {
  forceSequenceBefore with
  terminalizing := tableSet forceSequenceBefore.terminalizing runId terminalControl
}
private def forcedSiblingCancelled : Turn :=
  forcedSibling.withStatusLease .cancelled
    ⟨forcedSiblingId, none, 1, forcedSibling.lease.expiresAt⟩
private def forcedCancellation : ForcedCancellation :=
  ⟨runId, turnId, forcedSiblingId, 0, 1, ⟨30⟩, ⟨34⟩, ⟨1⟩⟩
private def forceSequenceCancelled : GraphStore := {
  forceSequenceBegun with
  turns := tableSet forceSequenceBegun.turns forcedSiblingId forcedSiblingCancelled
  forcedCancellations := tableSet forceSequenceBegun.forcedCancellations forcedSiblingId forcedCancellation
}
private def forceSequenceTerminal : GraphStore := {
  (forceSequenceCancelled.append terminalCommitId terminalCommit) with
  runs := tableSet forceSequenceCancelled.runs runId { run with status := .terminal }
  turns := tableSet forceSequenceCancelled.turns turnId
    (runningTurn.withStatusLease .succeeded ⟨turnId, none, 2, ⟨10⟩⟩)
  terminalSnapshots := tableSet forceSequenceCancelled.terminalSnapshots runId terminalSnapshot
  admissionRegistry := tableSet forceSequenceCancelled.admissionRegistry runId ⟨1, false, [auditObligation], []⟩
  terminalizing := fun candidate => if candidate = runId then none else forceSequenceCancelled.terminalizing candidate
}

private theorem terminalControlAuditEntry :
    terminalAuditLog.entries ⟨34⟩ = some controlCommitAuditEntry := by
  change tableSet (tableSet (default : AuditLog).entries ⟨34⟩ controlCommitAuditEntry)
    ⟨1⟩ rootAudit ⟨34⟩ = some controlCommitAuditEntry
  rw [tableSet_other _ _ _ (by decide)]
  exact tableSet_self ..

private theorem terminalControlAuditCause : AuditCauseExists terminalAuditLog ⟨34⟩ runId :=
  ⟨controlCommitAuditEntry, terminalControlAuditEntry, rfl⟩

private theorem terminalControlValid :
    TerminalizationControl.Valid synthesisEffects terminalAuditLog runId terminalControl := by
  refine ⟨synthesisOperation, controlReceipt, controlAttempt, controlPrepared,
    controlCommitAuditEntry, controlSuccess, terminalControlAuditEntry, ?_, ?_, ?_, rfl⟩
  · change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨30⟩ controlReceipt)
      ⟨31⟩ synthesisReceipt ⟨30⟩ = some controlReceipt
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..
  · change tableSet (tableSet (default : EffectLedger).attempts ⟨30⟩ controlAttempt)
      ⟨31⟩ synthesisAttempt ⟨30⟩ = some controlAttempt
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..
  · change tableSet
      (tableSet (default : EffectLedger).invocations controlInvocation controlPrepared)
      synthesisInvocation synthesisPrepared controlInvocation = some controlPrepared
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..

private theorem forceTerminalLookup :
    forceSequenceBefore.turns turnId = some runningTurn := by
  change tableSet (tableSet rootGraph.turns turnId runningTurn) forcedSiblingId forcedSibling
    turnId = some runningTurn
  rw [tableSet_other _ _ _ (by decide)]
  exact tableSet_self ..

theorem nonvacuous_forced_sibling_system_fence :
    GraphStep synthesisEffects (default : EventStore) terminalAuditLog forceSequenceBefore
      (.beginTerminalization runId turnId ⟨30⟩) forceSequenceBegun ∧
    GraphStep synthesisEffects (default : EventStore) terminalAuditLog forceSequenceBegun
      (.forceCancelSibling runId turnId forcedSiblingId) forceSequenceCancelled ∧
    GraphStep synthesisEffects (default : EventStore) terminalAuditLog forceSequenceCancelled
      (.terminalize runId turnId terminalCommitId rootCommitId) forceSequenceTerminal := by
  constructor
  · apply GraphStep.beginTerminalization (run := run) (turn := runningTurn)
      (cause := ⟨34⟩)
    · simp [forceSequenceBefore, rootGraph, runId]
    · rfl
    · exact forceTerminalLookup
    · rfl
    · rfl
    · rfl
    · rfl
    · exact terminalControlValid
  constructor
  · apply GraphStep.forceCancelSibling (run := run) (terminalTurn := runningTurn)
      (sibling := forcedSibling) (fenced := forcedSiblingCancelled.lease)
      (evidence := forcedCancellation) (control := terminalControl)
      (cancellationAudit := ⟨1⟩)
    · simp [forceSequenceBegun, forceSequenceBefore, rootGraph, runId]
    · rfl
    · simp [forceSequenceBegun, terminalControl, runId]
    · rfl
    · decide
    · exact forceTerminalLookup
    · rfl
    · rfl
    · simp [forceSequenceBegun, forceSequenceBefore, forcedSiblingId]
    · rfl
    · exact Or.inl rfl
    · rfl
    · exact terminalControlAuditCause
    · exact ⟨rootAudit, by simp [terminalAuditLog, synthesisAuditLog, auditOne], rfl⟩
    · exact .terminalFence
    · rfl
  · apply GraphStep.terminalize (run := run) (turn := runningTurn) (token := token)
      (now := ⟨1⟩) (fenced := ⟨turnId, none, 2, ⟨10⟩⟩) (terminal := .succeeded)
      (registry := ⟨0, true, [auditObligation], []⟩) (commit := terminalCommit)
      (preterminal := rootCommit) (snapshot := terminalSnapshot) (cause := ⟨1⟩)
      (control := terminalControl)
    · simp [forceSequenceCancelled, forceSequenceBegun, forceSequenceBefore, rootGraph, runId]
    · rfl
    · change tableSet forceSequenceBefore.turns forcedSiblingId forcedSiblingCancelled turnId =
        some runningTurn
      rw [tableSet_other _ _ _ (by decide)]
      exact forceTerminalLookup
    · rfl
    · rfl
    · rfl
    · exact ⟨rfl, rfl, rfl, by decide⟩
    · simp [RunPins.Valid, run, pins, agent]
    · rfl
    · simp [forceSequenceCancelled, forceSequenceBegun, terminalControl, runId]
    · rfl
    · intro id candidate lookup sameRun different
      by_cases terminal : id = turnId
      · exact (different terminal).elim
      · by_cases sibling : id = forcedSiblingId
        · subst id
          simp [forceSequenceCancelled, forcedSiblingCancelled, forcedSiblingId] at lookup
          cases lookup
          exact ⟨Or.inr (Or.inr rfl), rfl⟩
        · change tableSet
            (tableSet (tableSet rootGraph.turns turnId runningTurn) forcedSiblingId forcedSibling)
            forcedSiblingId forcedSiblingCancelled id = some candidate at lookup
          rw [tableSet_other _ _ _ sibling] at lookup
          rw [tableSet_other _ _ _ sibling] at lookup
          rw [tableSet_other _ _ _ terminal] at lookup
          simp [rootGraph] at lookup
    · exact .terminalFence
    · exact Or.inl rfl
    · simp [forceSequenceCancelled, forceSequenceBegun, forceSequenceBefore, rootGraph,
        runningTurn]
    · simp [forceSequenceCancelled, forceSequenceBegun, forceSequenceBefore, rootGraph,
        rootCommitId]
    · rfl
    · rfl
    · rfl
    · simp [forceSequenceCancelled, forceSequenceBegun, forceSequenceBefore, rootGraph, runId]
    · rfl
    · rfl
    · rfl
    · rfl
    · rfl
    · exact ⟨rootAudit, by simp [terminalAuditLog, synthesisAuditLog, auditOne], rfl⟩
    · rfl
    · rfl
    · rfl
    · rfl

private def secondAttemptAudit : AuditEntry :=
  ⟨.run tenant runId, 3, 7, some ⟨1⟩, .attempt ⟨2⟩ invocationId⟩
private def auditThree : AuditLog := auditTwo.append ⟨5⟩ secondAttemptAudit
private def item0Audit : AuditEntry :=
  ⟨.run tenant runId, 4, 7, some ⟨2⟩,
    .attemptReceipt ⟨10⟩ ⟨1⟩ invocationId .succeeded⟩
private def item1Audit : AuditEntry :=
  ⟨.run tenant runId, 5, 7, some ⟨5⟩,
    .attemptReceipt ⟨11⟩ ⟨2⟩ invocationId .failed⟩
private def attemptedReceiptBeforeEffects : EffectLedger := {
  (default : EffectLedger) with
  invocations := tableSet (default : EffectLedger).invocations invocationId prepared
  attempts := tableSet (default : EffectLedger).attempts ⟨1⟩ attempt0
  latestAttempt := fun invocation index =>
    if invocation = invocationId ∧ index = 0 then some ⟨1⟩ else none
}
private def attemptedReceiptAfterEffects : EffectLedger :=
  attemptedReceiptBeforeEffects.addAttemptReceipt ⟨10⟩ successReceipt attempt0
private def attemptedReceiptAuditLog : AuditLog := auditTwo.append ⟨3⟩ item0Audit
private def attemptedReceiptBeforeState : SystemState := {
  (default : SystemState) with effects := attemptedReceiptBeforeEffects, audit := auditTwo
}
private def attemptedReceiptAfterState : SystemState := {
  attemptedReceiptBeforeState with
  effects := attemptedReceiptAfterEffects
  audit := attemptedReceiptAuditLog
}

private theorem attemptedReceiptAuditAppend :
    AttemptReceiptAuditAppend attemptedReceiptAfterEffects (default : EventStore) auditTwo
      ⟨10⟩ successReceipt invocationId ⟨3⟩ attemptedReceiptAuditLog := by
  refine ⟨⟨2⟩, item0Audit, ?_, ?_, ?_, rfl, rfl⟩
  · refine ⟨attempt0, childAudit, ?_, rfl, ?_, rfl, rfl⟩
    · simp [attemptedReceiptAfterEffects, attemptedReceiptBeforeEffects,
        EffectLedger.addAttemptReceipt, successReceipt]
    · change tableSet auditOne.entries ⟨2⟩ childAudit ⟨2⟩ = some childAudit
      exact tableSet_self ..
  · apply AuditStep.append
    · rfl
    · rfl
    · exact ⟨childAudit, by
        change tableSet auditOne.entries ⟨2⟩ childAudit ⟨2⟩ = some childAudit
        exact tableSet_self .., rfl, by decide, rfl, ⟨rfl, rfl⟩⟩
    · exact audit_step_establishes_causal_chain childAuditStep
    · refine ⟨successReceipt, attempt0, ?_, rfl, ?_, rfl, rfl⟩
      · simp [attemptedReceiptAfterEffects, EffectLedger.addAttemptReceipt]
      · simp [attemptedReceiptAfterEffects, attemptedReceiptBeforeEffects,
          EffectLedger.addAttemptReceipt, successReceipt]
  · change tableSet auditTwo.entries ⟨3⟩ item0Audit ⟨3⟩ = some item0Audit
    exact tableSet_self ..

private theorem attemptedReceiptStep :
    MediatedStep attemptedReceiptBeforeState
      (.attemptReceipt invocationId ⟨10⟩ ⟨3⟩) attemptedReceiptAfterState := by
  apply MediatedStep.attemptReceipt (receipt := successReceipt) (attempt := attempt0)
  · simp [attemptedReceiptBeforeState, attemptedReceiptBeforeEffects, successReceipt, attempt0]
  · rfl
  · apply EffectStep.firstAttemptReceipt
    · rfl
    · rfl
    · simp [attemptedReceiptBeforeState, attemptedReceiptBeforeEffects, successReceipt]
    · simp [attemptedReceiptBeforeState, attemptedReceiptBeforeEffects, successReceipt, attempt0]
    · rfl
    · rfl
  · simp [attemptedReceiptAfterState, attemptedReceiptAfterEffects,
      EffectLedger.addAttemptReceipt]
  · exact attemptedReceiptAuditAppend

theorem nonvacuous_attempt_receipt_audit_atomic :
    ∃ receipt attempt attemptAudit entry,
      attemptedReceiptAfterState.effects.attemptReceipts ⟨10⟩ = some receipt ∧
      attemptedReceiptAfterState.effects.attempts receipt.attempt = some attempt ∧
      ∃ attemptAuditEntry,
        attemptedReceiptBeforeState.audit.entries attemptAudit = some attemptAuditEntry ∧
        attemptAuditEntry.kind = .attempt receipt.attempt invocationId ∧
        attemptAuditEntry.cause = some attempt.auditCause ∧
      attemptedReceiptAfterState.audit.entries ⟨3⟩ = some entry ∧
      entry.kind = .attemptReceipt ⟨10⟩ receipt.attempt invocationId receipt.outcome ∧
      entry.cause = some attemptAudit := by
  obtain ⟨receipt, attempt, attemptAudit, attemptAuditEntry, entry, receiptLookup,
    attemptLookup, invocation, attemptAuditLookup, attemptKind, attemptCause, auditLookup,
    kind, cause⟩ :=
      attempt_receipt_and_exact_audit_are_one_transition attemptedReceiptStep
  exact ⟨receipt, attempt, attemptAudit, entry, receiptLookup, attemptLookup,
    attemptAuditEntry, attemptAuditLookup, attemptKind, attemptCause, auditLookup, kind, cause⟩

private def auditFour : AuditLog := auditThree.append ⟨3⟩ item0Audit
private def settlementAuditLog : AuditLog := auditFour.append ⟨4⟩ item1Audit

private theorem rootChainAuditTwo : CausalChain (default : EventStore) auditTwo ⟨1⟩ := by
  apply CausalChain.root (entry := rootAudit)
  · change tableSet auditOne.entries ⟨2⟩ childAudit ⟨1⟩ = some rootAudit
    rw [tableSet_other _ _ _ (by decide)]
    simp [auditOne]
  · rfl
  · trivial

private theorem childChainAuditThree : CausalChain (default : EventStore) auditThree ⟨2⟩ := by
  apply CausalChain.child (entry := childAudit) (parentEntry := rootAudit)
  · change tableSet auditTwo.entries ⟨5⟩ secondAttemptAudit ⟨2⟩ = some childAudit
    rw [tableSet_other _ _ _ (by decide)]
    change tableSet auditOne.entries ⟨2⟩ childAudit ⟨2⟩ = some childAudit
    exact tableSet_self ..
  · rfl
  · change tableSet auditTwo.entries ⟨5⟩ secondAttemptAudit ⟨1⟩ = some rootAudit
    rw [tableSet_other _ _ _ (by decide)]
    change tableSet auditOne.entries ⟨2⟩ childAudit ⟨1⟩ = some rootAudit
    rw [tableSet_other _ _ _ (by decide)]
    simp [auditOne]
  · rfl
  · decide
  · rfl
  · rfl
  · apply CausalChain.root (entry := rootAudit)
    · change tableSet auditTwo.entries ⟨5⟩ secondAttemptAudit ⟨1⟩ = some rootAudit
      rw [tableSet_other _ _ _ (by decide)]
      change tableSet auditOne.entries ⟨2⟩ childAudit ⟨1⟩ = some rootAudit
      rw [tableSet_other _ _ _ (by decide)]
      simp [auditOne]
    · rfl
    · trivial

private theorem secondAttemptStep :
    AuditStep mixedEffects (default : EventStore) auditTwo (.append ⟨5⟩) auditThree := by
  apply AuditStep.append
  · rfl
  · rfl
  · exact ⟨rootAudit, by
      change tableSet auditOne.entries ⟨2⟩ childAudit ⟨1⟩ = some rootAudit
      rw [tableSet_other _ _ _ (by decide)]
      simp [auditOne], rfl, by decide, rfl, rfl⟩
  · exact rootChainAuditTwo
  · simp [AuditEvidenceMatches, secondAttemptAudit, mixedEffects, attempt1]

private theorem item0Step :
    AuditStep mixedEffects (default : EventStore) auditThree (.append ⟨3⟩) auditFour := by
  apply AuditStep.append
  · rfl
  · rfl
  · exact ⟨childAudit, by
      change tableSet auditTwo.entries ⟨5⟩ secondAttemptAudit ⟨2⟩ = some childAudit
      rw [tableSet_other _ _ _ (by decide)]
      change tableSet auditOne.entries ⟨2⟩ childAudit ⟨2⟩ = some childAudit
      exact tableSet_self .., rfl, by decide, rfl, ⟨rfl, rfl⟩⟩
  · exact childChainAuditThree
  · exact ⟨successReceipt, attempt0,
      by
        change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨10⟩ successReceipt)
          ⟨11⟩ failedReceipt ⟨10⟩ = some successReceipt
        rw [tableSet_other _ _ _ (by decide)]
        exact tableSet_self ..,
      rfl,
      by
        change tableSet (tableSet (default : EffectLedger).attempts ⟨1⟩ attempt0)
          ⟨2⟩ attempt1 ⟨1⟩ = some attempt0
        rw [tableSet_other _ _ _ (by decide)]
        exact tableSet_self ..,
      rfl, rfl⟩

private theorem item1Step :
    AuditStep mixedEffects (default : EventStore) auditFour (.append ⟨4⟩)
      settlementAuditLog := by
  apply AuditStep.append
  · rfl
  · rfl
  · exact ⟨secondAttemptAudit, by
      change tableSet auditThree.entries ⟨3⟩ item0Audit ⟨5⟩ = some secondAttemptAudit
      rw [tableSet_other _ _ _ (by decide)]
      change tableSet auditTwo.entries ⟨5⟩ secondAttemptAudit ⟨5⟩ = some secondAttemptAudit
      exact tableSet_self .., rfl, by decide, rfl, ⟨rfl, rfl⟩⟩
  · exact causal_chain_preserved_by_step item0Step
      (audit_step_establishes_causal_chain secondAttemptStep)
  · refine ⟨failedReceipt, attempt1, ?_, rfl, ?_, rfl, rfl⟩
    · change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨10⟩ successReceipt)
        ⟨11⟩ failedReceipt ⟨11⟩ = some failedReceipt
      exact tableSet_self ..
    · change tableSet (tableSet (default : EffectLedger).attempts ⟨1⟩ attempt0)
        ⟨2⟩ attempt1 ⟨2⟩ = some attempt1
      exact tableSet_self ..
private def settledGraph : GraphStore := {
  terminalBefore with
  runs := tableSet terminalBefore.runs runId { run with status := .terminal }
  turns := tableSet terminalBefore.turns turnId { runningTurn with status := .succeeded }
  commits := tableSet terminalBefore.commits terminalCommitId terminalCommit
  terminalSnapshots := tableSet terminalBefore.terminalSnapshots runId terminalSnapshot
}
private def settledState : SystemState := {
  (default : SystemState) with
  effects := mixedEffects
  audit := settlementAuditLog
  graph := settledGraph
}

theorem nonvacuous_audit_complete_derived_settled : Settled settledState runId := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩
  · exact ⟨{ run with status := .terminal }, terminalSnapshot,
      by simp [settledState, settledGraph, terminalBefore, rootGraph, runId], rfl,
      by simp [settledState, settledGraph, terminalSnapshot, runId],
      rfl,
      ⟨{ run with status := .terminal }, { runningTurn with status := .succeeded },
        terminalCommit,
        by simp [settledState, settledGraph, terminalSnapshot, terminalBefore, rootGraph, runId], rfl,
        by simp [settledState, settledGraph, terminalSnapshot, turnId], rfl,
        by simp [settledState, settledGraph, terminalSnapshot, terminalCommitId],
        rfl, rfl, rfl, rfl⟩⟩
  · intro id actual lookup sameRun
    by_cases same : id = turnId
    · subst id
      simp [settledState, settledGraph, turnId] at lookup
      cases lookup
      exact Or.inl rfl
    · change tableSet (tableSet rootGraph.turns turnId runningTurn) turnId
        { runningTurn with status := .succeeded } id = some actual at lookup
      rw [tableSet_other _ _ _ same] at lookup
      rw [tableSet_other _ _ _ same] at lookup
      contradiction
  · intro invocation actual lookup target item member
    by_cases same : invocation = invocationId
    · subst invocation
      change tableSet (default : EffectLedger).invocations invocationId prepared invocationId =
        some actual at lookup
      rw [tableSet_self] at lookup
      cases Option.some.inj lookup
      change item ∈ [⟨0, firstArgs, firstKey⟩, ⟨1, secondArgs, secondKey⟩] at member
      simp only [List.mem_cons, List.mem_nil_iff, or_false] at member
      rcases member with rfl | rfl
      · refine ⟨.succeeded, item0Current, by decide, ?_⟩
        refine ⟨⟨3⟩, successReceipt, attempt0, item0Audit, ?_, ?_, ?_, ?_⟩
        · change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨10⟩ successReceipt)
            ⟨11⟩ failedReceipt ⟨10⟩ = some successReceipt
          rw [tableSet_other _ _ _ (by decide)]
          exact tableSet_self ..
        · change tableSet (tableSet (default : EffectLedger).attempts ⟨1⟩ attempt0)
            ⟨2⟩ attempt1 ⟨1⟩ = some attempt0
          rw [tableSet_other _ _ _ (by decide)]
          exact tableSet_self ..
        · change tableSet auditFour.entries ⟨4⟩ item1Audit ⟨3⟩ = some item0Audit
          rw [tableSet_other _ _ _ (by decide)]
          change tableSet auditThree.entries ⟨3⟩ item0Audit ⟨3⟩ = some item0Audit
          exact tableSet_self ..
        · exact ⟨rfl, causal_chain_preserved_by_step item1Step
            (audit_step_establishes_causal_chain item0Step)⟩
      · refine ⟨.failed, item1Current, by decide, ?_⟩
        refine ⟨⟨4⟩, failedReceipt, attempt1, item1Audit, ?_, ?_, ?_, ?_⟩
        · change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨10⟩ successReceipt)
            ⟨11⟩ failedReceipt ⟨11⟩ = some failedReceipt
          exact tableSet_self ..
        · change tableSet (tableSet (default : EffectLedger).attempts ⟨1⟩ attempt0)
            ⟨2⟩ attempt1 ⟨2⟩ = some attempt1
          exact tableSet_self ..
        · change tableSet auditFour.entries ⟨4⟩ item1Audit ⟨4⟩ = some item1Audit
          exact tableSet_self ..
        · exact ⟨rfl, audit_step_establishes_causal_chain item1Step⟩
    · change tableSet (default : EffectLedger).invocations invocationId prepared invocation =
        some actual at lookup
      rw [tableSet_other _ _ _ same] at lookup
      contradiction
  · intro invocation actual lookup target
    refine ⟨?_, ?_⟩
    · intro reservation reservationLookup
      simp [settledState] at reservationLookup
    · intro reservation reservationLookup
      simp [settledState] at reservationLookup
  · intro snapshot snapshotLookup obligation obligationMember
    simp [settledState, settledGraph, terminalSnapshot, runId] at snapshotLookup
    cases snapshotLookup
    simp at obligationMember
    subst obligation
    refine ⟨prepared, ⟨0, firstArgs, firstKey⟩, .succeeded, ⟨3⟩, ?_, rfl, rfl,
      item0Current, by decide, ?_⟩
    · simp [settledState, mixedEffects, invocationId]
    · refine ⟨successReceipt, attempt0, item0Audit, ?_, ?_, ?_, rfl, ?_⟩
      · change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨10⟩ successReceipt)
          ⟨11⟩ failedReceipt ⟨10⟩ = some successReceipt
        rw [tableSet_other _ _ _ (by decide)]
        exact tableSet_self ..
      · change tableSet (tableSet (default : EffectLedger).attempts ⟨1⟩ attempt0)
          ⟨2⟩ attempt1 ⟨1⟩ = some attempt0
        rw [tableSet_other _ _ _ (by decide)]
        exact tableSet_self ..
      · change tableSet auditFour.entries ⟨4⟩ item1Audit ⟨3⟩ = some item0Audit
        rw [tableSet_other _ _ _ (by decide)]
        change tableSet auditThree.entries ⟨3⟩ item0Audit ⟨3⟩ = some item0Audit
        exact tableSet_self ..
      · exact causal_chain_preserved_by_step item1Step
          (audit_step_establishes_causal_chain item0Step)
  · intro conflict; contradiction

private def oneItemPrepared : PreparedInvocation := ⟨header, .single firstArgs⟩
private def indeterminateClaimId : ItemClaimId := ⟨40⟩
private def indeterminateAttempt : EffectAttempt :=
  ⟨invocationId, 0, 0, indeterminateClaimId, ⟨40⟩,
    deriveItemKey header oneItemPrepared.payload 0 firstArgs, some token, ⟨1⟩⟩
private def batchIndeterminateReceipt : AttemptReceipt := ⟨⟨40⟩, .indeterminate, none⟩
private def indeterminateEffects : EffectLedger := {
  (default : EffectLedger) with
  invocations := tableSet (default : EffectLedger).invocations invocationId oneItemPrepared
  attempts := tableSet (default : EffectLedger).attempts ⟨40⟩ indeterminateAttempt
  attemptReceipts := tableSet (default : EffectLedger).attemptReceipts ⟨41⟩ batchIndeterminateReceipt
  latestAttempt := fun invocation index =>
    if invocation = invocationId ∧ index = 0 then some ⟨40⟩ else none
  currentReceipt := fun invocation index =>
    if invocation = invocationId ∧ index = 0 then some (.attempt ⟨41⟩) else none
}
private theorem indeterminateCurrent :
    ItemCurrentOutcome indeterminateEffects invocationId 0 .indeterminate := by
  exact ⟨batchIndeterminateReceipt, indeterminateAttempt,
    by simp [indeterminateEffects], by simp [indeterminateEffects, batchIndeterminateReceipt],
    rfl, rfl, rfl, Or.inr (Or.inr ⟨rfl, rfl⟩)⟩

theorem nonvacuous_indeterminate_batch_current_not_terminal :
    BatchCurrentOutcome indeterminateEffects oneItemPrepared [.indeterminate] .indeterminate ∧
    ¬ BatchTerminalOutcome indeterminateEffects oneItemPrepared [.indeterminate] .indeterminate :=
  indeterminate_batch_is_current_not_terminal rfl indeterminateCurrent

private def actionBindingId : BindingId := ⟨2⟩
private def actionGrantId : GrantId := .manual 2
private def actionInvocation : InvocationId := ⟨2⟩
private def actionApproval : ApprovalId := ⟨2⟩
private def actionRootAuditId : AuditId := ⟨40⟩
private def actionHeader : InvocationHeader := {
  noTurnHeader with
  authority := .initiator principalRef actionBindingId
  auditCause := actionRootAuditId
}
private def actionPrepared : PreparedInvocation := ⟨actionHeader, .batch firstArgs [secondArgs]⟩
private def actionGrant : Grant :=
  ⟨.principal principalRef, scope, .allow, actionHeader.permission, none, .manual⟩
private def actionBinding : Binding :=
  ⟨actionHeader.domain, scope, "sender", 1, actionGrantId, facet⟩
private def actionAuthorityBase : AuthorityLedger := {
  (default : AuthorityLedger) with
  grants := tableSet (default : AuthorityLedger).grants actionGrantId actionGrant
  bindings := tableSet (default : AuthorityLedger).bindings actionBindingId actionBinding
}
private theorem actionAuthorized : actionAuthorityBase.Authorized principalRef actionHeader scope := by
  refine ⟨actionBinding, actionGrant,
    by simp [actionAuthorityBase, actionHeader, noTurnHeader, InvocationHeader.binding,
      AuthoritySource.binding], rfl, rfl, rfl, rfl, ?_, rfl, ?_, ?_⟩
  · apply AuthorityLedger.LiveGrant.root
    · simp [actionAuthorityBase, actionBinding, actionGrantId]
    · rfl
    · intro revoked; contradiction
  · exact ⟨rfl, rfl, Scope.contains_refl scope, rfl, rfl⟩
  · intro denied
    obtain ⟨id, grant, live, deny, applies⟩ := denied
    cases live with
    | root lookup _ _ | child lookup _ _ _ =>
        by_cases same : id = actionGrantId
        · subst id
          change tableSet (default : AuthorityLedger).grants actionGrantId actionGrant actionGrantId =
            some grant at lookup
          rw [tableSet_self] at lookup
          cases Option.some.inj lookup
          contradiction
        · change tableSet (default : AuthorityLedger).grants actionGrantId actionGrant id =
            some grant at lookup
          rw [tableSet_other _ _ _ same] at lookup
          contradiction

private def actionResolution : Resolution :=
  ⟨⟨2⟩, principalRef, actionHeader, scope, ⟨0⟩, ⟨5⟩, none⟩
private def actionAuthority : AuthorityLedger := actionAuthorityBase.issueResolution actionResolution
private theorem actionAuthorizedIssued : actionAuthority.Authorized principalRef actionHeader scope := by
  refine ⟨actionBinding, actionGrant,
    by simp [actionAuthority, AuthorityLedger.issueResolution, actionAuthorityBase,
      actionHeader, noTurnHeader, InvocationHeader.binding, AuthoritySource.binding],
    rfl, rfl, rfl, rfl, ?_, rfl, ?_, ?_⟩
  · apply AuthorityLedger.LiveGrant.root
    · simp [actionAuthority, AuthorityLedger.issueResolution, actionAuthorityBase,
        actionBinding, actionGrantId]
    · rfl
    · intro revoked; contradiction
  · exact ⟨rfl, rfl, Scope.contains_refl scope, rfl, rfl⟩
  · intro denied
    obtain ⟨id, grant, live, deny, applies⟩ := denied
    cases live with
    | root lookup _ _ | child lookup _ _ _ =>
        by_cases same : id = actionGrantId
        · subst id
          change tableSet (default : AuthorityLedger).grants actionGrantId actionGrant actionGrantId =
            some grant at lookup
          rw [tableSet_self] at lookup
          cases Option.some.inj lookup
          contradiction
        · change tableSet (default : AuthorityLedger).grants actionGrantId actionGrant id =
            some grant at lookup
          rw [tableSet_other _ _ _ same] at lookup
          contradiction
private def actionApprovalObligation : OpenObligation := .approval actionApproval
private def actionFirstObligation : OpenObligation :=
  .item actionInvocation 0 (deriveItemKey actionHeader actionPrepared.payload 0 firstArgs)
private def actionSecondObligation : OpenObligation :=
  .item actionInvocation 1 (deriveItemKey actionHeader actionPrepared.payload 1 secondArgs)
private def actionRegistry : RunAdmissionRegistry :=
  ⟨0, true, [actionApprovalObligation, actionFirstObligation, actionSecondObligation], []⟩
private def actionGraph : GraphStore := {
  rootGraph with admissionRegistry := tableSet rootGraph.admissionRegistry runId actionRegistry
}
private def actionRootAudit : AuditEntry :=
  ⟨.run tenant runId, 1, 8, none, .invocation actionInvocation⟩
private def actionAuditOne : AuditLog :=
  (default : AuditLog).append actionRootAuditId actionRootAudit
private def actionState : SystemState := {
  (default : SystemState) with
  authority := actionAuthority
  audit := actionAuditOne
  graph := actionGraph
}
private def actionRequest (obligation : OpenObligation) : AdmissionRequest :=
  ⟨actionPrepared, scope, actionResolution.id, some ⟨runId, 0, obligation⟩, ⟨1⟩, []⟩
private def actionApprovalRequest : AdmissionRequest := actionRequest actionApprovalObligation
private def actionFirstRequest : AdmissionRequest := actionRequest actionFirstObligation
private def actionSecondRequest : AdmissionRequest := actionRequest actionSecondObligation

private theorem actionReady (obligation : OpenObligation)
    (reserved : obligation ∈ actionRegistry.reserved) :
    MediatedReady actionState (actionRequest obligation) := by
  refine ⟨rfl, ⟨rfl, by intro noLease; rfl⟩, by
      simp [RouteGate, InvocationHeader.RouteEvidenceConsistent, actionRequest,
        actionPrepared, actionHeader, noTurnHeader, header],
    rfl, ?_, ?_, actionResolution, ?_, ?_⟩
  · exact ⟨actionRootAudit, by
      change tableSet (default : AuditLog).entries actionRootAuditId actionRootAudit
        actionRootAuditId = some actionRootAudit
      exact tableSet_self .., rfl, rfl, rfl⟩
  · refine ⟨run, ⟨runId, 0, obligation⟩, ?_, rfl, rfl, rfl, actionRegistry, ?_, rfl,
      rfl, reserved, by simp [actionRegistry]⟩
    · simp [actionState, actionGraph, rootGraph, runId]
    · simp [actionState, actionGraph, runId]
  · change tableSet actionAuthorityBase.resolutions actionResolution.id actionResolution
      actionResolution.id = some actionResolution
    exact tableSet_self ..
  · refine ⟨by
      change tableSet actionAuthorityBase.resolutions actionResolution.id actionResolution
        actionResolution.id = some actionResolution
      exact tableSet_self .., rfl, ?_, ?_⟩
    · exact actionAuthorizedIssued
    · constructor
      · rfl
      · intro evidence member
        change evidence ∈ [⟨tenantScope, 0⟩, ⟨scope, 0⟩] at member
        simp only [List.mem_cons, List.mem_nil_iff, or_false] at member
        rcases member with rfl | rfl <;> rfl

private theorem actionApprovalReady : MediatedReady actionState actionApprovalRequest := by
  exact actionReady actionApprovalObligation (by simp [actionRegistry, actionApprovalObligation])

private theorem actionFirstReady : MediatedReady actionState actionFirstRequest := by
  exact actionReady actionFirstObligation (by simp [actionRegistry])

private theorem actionSecondReady : MediatedReady actionState actionSecondRequest := by
  exact actionReady actionSecondObligation (by simp [actionRegistry])

theorem nonvacuous_exact_mediated_run_reservation :
    ∃ runRecord reservation registry,
      actionState.graph.runs runId = some runRecord ∧ runRecord.tenant = tenant ∧
      actionFirstRequest.reservation = some reservation ∧ reservation.run = runId ∧
      reservation.obligation = actionFirstObligation ∧
      actionState.graph.admissionRegistry runId = some registry ∧
      registry.accepting = true ∧ registry.epoch = reservation.epoch ∧
      actionFirstObligation ∈ registry.reserved ∧
      actionFirstObligation ∉ registry.completed := by
  apply mediated_ready_reserves_exact_obligation actionFirstReady
  · rfl
  · simp [AdmissionRequest.ReservedFor, actionFirstRequest, actionRequest, actionPrepared,
      actionHeader, noTurnHeader, header]

private def changedActionGraph : GraphStore := {
  actionGraph with
  admissionRegistry := tableSet actionGraph.admissionRegistry runId
    { actionRegistry with epoch := 1 }
}
private def changedActionState : SystemState := { actionState with graph := changedActionGraph }

theorem nonvacuous_changed_run_registry_epoch_rejected :
    ¬ MediatedReady changedActionState actionFirstRequest := by
  apply changed_registry_epoch_blocks_mediated_ready
    (reservation := ⟨runId, 0, actionFirstObligation⟩)
    (registry := { actionRegistry with epoch := 1 })
  · rfl
  · rfl
  · simp [changedActionState, changedActionGraph, runId]
  · decide

private def actionTicket : ApprovalTicket :=
  ⟨actionInvocation, actionPrepared.identity, actionPrepared.digest, principal, ⟨10⟩, .pending⟩
private def requestedEffects : EffectLedger := {
  (default : EffectLedger) with
  invocations := tableSet (default : EffectLedger).invocations actionInvocation actionPrepared
}
private def requestedApprovals : ApprovalLedger :=
  (default : ApprovalLedger).setTicket actionApproval actionTicket
private def requestedState : SystemState := {
  actionState with effects := requestedEffects, approvals := requestedApprovals
}
private def approvedTicket : ApprovalTicket := { actionTicket with phase := .approved }
private def approvedApprovals : ApprovalLedger := requestedApprovals.setTicket actionApproval approvedTicket
private def approvedState : SystemState := { requestedState with approvals := approvedApprovals }
private def actionClaimId : ItemClaimId := ⟨50⟩
private def actionSecondClaimId : ItemClaimId := ⟨51⟩
private def actionWorker : ClaimWorkerId := ⟨1⟩
private def actionAttempt : EffectAttempt :=
  ⟨actionInvocation, 0, 0, actionClaimId, actionRootAuditId,
    deriveItemKey actionHeader actionPrepared.payload 0 firstArgs, none, ⟨2⟩⟩
private def actionClaim : ItemClaim :=
  ⟨actionClaimId, actionInvocation, 0, 0, .system (.run tenant runId) actionWorker, ⟨10⟩⟩
private def claimedEffects : EffectLedger := requestedEffects.setClaim actionClaim
private def claimedState : SystemState := { approvedState with effects := claimedEffects }
private def startedEffects : EffectLedger :=
  (claimedEffects.recordAdmission ⟨50⟩ (admissionFor actionFirstRequest)).addAttempt
    ⟨50⟩ actionAttempt
private def actionAttemptAudit : AuditEntry :=
  ⟨.run tenant runId, 2, 8, some actionRootAuditId, .attempt ⟨50⟩ actionInvocation⟩
private def actionAuditTwo : AuditLog := actionAuditOne.append ⟨50⟩ actionAttemptAudit
private def startedState : SystemState := {
  claimedState with
  approvals := approvedApprovals.consume actionApproval actionPrepared ⟨50⟩
  effects := startedEffects
  audit := actionAuditTwo
}

theorem nonvacuous_persisted_approval_continuation :
    startedState.approvals.Continues actionApproval actionPrepared := by
  refine ⟨⟨actionApproval, actionInvocation, actionPrepared.identity, actionPrepared.digest, ⟨50⟩⟩,
    ?_, ?_, rfl, rfl, rfl, rfl⟩
  · simp [startedState, ApprovalLedger.consume, actionPrepared, actionHeader, noTurnHeader,
      actionInvocation]
  · simp [startedState, ApprovalLedger.consume, actionPrepared, actionHeader, noTurnHeader,
      actionInvocation]

private def actionSecondClaim : ItemClaim :=
  ⟨actionSecondClaimId, actionInvocation, 1, 0,
    .system (.run tenant runId) actionWorker, ⟨10⟩⟩
private def actionSecondAttempt : EffectAttempt :=
  ⟨actionInvocation, 1, 0, actionSecondClaimId, actionRootAuditId,
    deriveItemKey actionHeader actionPrepared.payload 1 secondArgs, none, ⟨3⟩⟩
private def secondClaimedEffects : EffectLedger := startedEffects.setClaim actionSecondClaim
private def secondClaimedState : SystemState := { startedState with effects := secondClaimedEffects }
private def continuedEffects : EffectLedger :=
  (secondClaimedEffects.recordAdmission ⟨51⟩ (admissionFor actionSecondRequest)).addAttempt
    ⟨51⟩ actionSecondAttempt
private def actionSecondAttemptAudit : AuditEntry :=
  ⟨.run tenant runId, 3, 8, some actionRootAuditId, .attempt ⟨51⟩ actionInvocation⟩
private def actionAuditThree : AuditLog :=
  actionAuditTwo.append ⟨51⟩ actionSecondAttemptAudit
private def continuedState : SystemState := {
  secondClaimedState with effects := continuedEffects, audit := actionAuditThree
}

private theorem actionRootChain :
    CausalChain (default : EventStore) actionAuditOne actionRootAuditId := by
  apply CausalChain.root (entry := actionRootAudit)
  · change tableSet (default : AuditLog).entries actionRootAuditId actionRootAudit
      actionRootAuditId = some actionRootAudit
    exact tableSet_self ..
  · rfl
  · trivial

private theorem firstActionAttemptAuditAppend :
    AttemptAuditAppend startedEffects (default : EventStore) actionAuditOne ⟨50⟩
      actionInvocation ⟨50⟩ actionAuditTwo := by
  refine ⟨actionAttemptAudit, ?_, ?_, rfl⟩
  · apply AuditStep.append
    · decide
    · decide
    · exact ⟨actionRootAudit, by
        change tableSet (default : AuditLog).entries actionRootAuditId actionRootAudit
          actionRootAuditId = some actionRootAudit
        exact tableSet_self .., rfl, by decide, rfl, rfl⟩
    · exact actionRootChain
    · refine ⟨actionAttempt, ?_, rfl, rfl⟩
      simp [startedEffects, EffectLedger.addAttempt]
  · change tableSet actionAuditOne.entries ⟨50⟩ actionAttemptAudit ⟨50⟩ =
      some actionAttemptAudit
    exact tableSet_self ..

private theorem actionRootChainAfterFirstAttempt :
    CausalChain (default : EventStore) actionAuditTwo actionRootAuditId := by
  apply CausalChain.root (entry := actionRootAudit)
  · change tableSet actionAuditOne.entries ⟨50⟩ actionAttemptAudit actionRootAuditId =
      some actionRootAudit
    rw [tableSet_other _ _ _ (by decide)]
    change tableSet (default : AuditLog).entries actionRootAuditId actionRootAudit
      actionRootAuditId = some actionRootAudit
    exact tableSet_self ..
  · rfl
  · trivial

private theorem secondActionAttemptAuditAppend :
    AttemptAuditAppend continuedEffects (default : EventStore) actionAuditTwo ⟨51⟩
      actionInvocation ⟨51⟩ actionAuditThree := by
  refine ⟨actionSecondAttemptAudit, ?_, ?_, rfl⟩
  · apply AuditStep.append
    · decide
    · decide
    · exact ⟨actionRootAudit, by
        change tableSet actionAuditOne.entries ⟨50⟩ actionAttemptAudit actionRootAuditId =
          some actionRootAudit
        rw [tableSet_other _ _ _ (by decide)]
        change tableSet (default : AuditLog).entries actionRootAuditId actionRootAudit
          actionRootAuditId = some actionRootAudit
        exact tableSet_self .., rfl, by decide, rfl, rfl⟩
    · exact actionRootChainAfterFirstAttempt
    · refine ⟨actionSecondAttempt, ?_, rfl, rfl⟩
      simp [continuedEffects, EffectLedger.addAttempt]
  · change tableSet actionAuditTwo.entries ⟨51⟩ actionSecondAttemptAudit ⟨51⟩ =
      some actionSecondAttemptAudit
    exact tableSet_self ..

theorem nonvacuous_claim_records_future_expiry :
    EffectStep requestedEffects (.claimItem actionInvocation 0 ⟨1⟩) claimedEffects ∧
    ∃ claim, claimedEffects.currentClaim actionInvocation 0 = some claim.id ∧
      claimedEffects.claims claim.id = some claim ∧ 1 < claim.expiresAt.tick := by
  have claimStep :
      EffectStep requestedEffects (.claimItem actionInvocation 0 ⟨1⟩) claimedEffects := by
    apply EffectStep.claimItem (prepared := actionPrepared) (claim := actionClaim)
      (item := ⟨0, firstArgs,
        deriveItemKey actionHeader actionPrepared.payload 0 firstArgs⟩)
    · simp [requestedEffects, actionClaim]
    · rfl
    · rfl
    · exact Or.inl ⟨rfl, rfl, rfl⟩
    · decide
    · rfl
    · rfl
  exact ⟨claimStep, claim_records_future_expiry claimStep⟩

theorem nonvacuous_request_approve_start_trace :
    MediatedStep actionState (.requestApproval actionApproval actionInvocation) requestedState ∧
    ApprovalStep requestedApprovals (.approve actionApproval principal ⟨1⟩) approvedApprovals ∧
    MediatedStep approvedState (.claimItem actionInvocation 0 ⟨1⟩) claimedState ∧
    MediatedStep claimedState (.approvalStart actionApproval actionInvocation ⟨50⟩ ⟨50⟩)
      startedState := by
  constructor
  · change MediatedStep actionState
      (.requestApproval actionApproval actionPrepared.header.invocation) requestedState
    apply MediatedStep.requestApproval (state := actionState) (request := actionApprovalRequest)
      (ticket := actionTicket) (approvals' := requestedApprovals) (effects' := requestedEffects)
    · exact actionApprovalReady
    · rfl
    · simp [AdmissionRequest.ReservedFor, actionApprovalRequest, actionRequest,
        actionApprovalObligation, actionPrepared, actionHeader, noTurnHeader, header]
    · rfl
    · rfl
    · rfl
    · rfl
    · exact EffectStep.persistIntent rfl
    · exact ApprovalStep.request rfl rfl rfl rfl
    · simp [requestedApprovals, ApprovalLedger.setTicket, actionApproval]
  constructor
  · apply ApprovalStep.approve (ticket := actionTicket)
    · simp [requestedApprovals, ApprovalLedger.setTicket, actionApproval]
    · rfl
    · rfl
    · decide
  · have approvedReady : MediatedReady approvedState actionFirstRequest := by
      simpa [approvedState, requestedState] using actionFirstReady
    constructor
    · apply MediatedStep.claimItem (request := actionFirstRequest) (claim := actionClaim)
        (effects' := claimedEffects) approvedReady
      · change actionFirstRequest.ReservesItem 0
        refine ⟨⟨0, firstArgs,
          deriveItemKey actionHeader actionPrepared.payload 0 firstArgs⟩, rfl, ?_⟩
        simp [AdmissionRequest.ReservedFor, actionFirstRequest, actionRequest,
          actionFirstObligation, actionPrepared, actionHeader, noTurnHeader,
          actionInvocation, header]
      · simp [approvedState, requestedState, requestedEffects, actionFirstRequest, actionRequest,
          actionPrepared,
          actionHeader, noTurnHeader, actionInvocation]
      · rfl
      · apply EffectStep.claimItem (prepared := actionPrepared)
          (item := ⟨0, firstArgs,
            deriveItemKey actionHeader actionPrepared.payload 0 firstArgs⟩)
        · simp [approvedState, requestedState, requestedEffects, actionClaim]
        · rfl
        · rfl
        · exact Or.inl ⟨rfl, rfl, rfl⟩
        · decide
        · rfl
        · rfl
    · have claimedReady : MediatedReady claimedState actionFirstRequest := by
        simpa [claimedState] using approvedReady
      change MediatedStep claimedState
        (.approvalStart actionApproval actionPrepared.header.invocation ⟨50⟩ ⟨50⟩)
        startedState
      apply MediatedStep.approvalStart (state := claimedState) (request := actionFirstRequest)
        (attempt := actionAttempt) (effects' := startedEffects) claimedReady
      · simp [AdmissionRequest.ReservedFor, actionFirstRequest, actionRequest,
          actionFirstObligation, actionAttempt, actionPrepared, actionHeader, noTurnHeader,
          actionInvocation, header]
      · simp [claimedState, claimedEffects, EffectLedger.setClaim, requestedEffects,
          actionFirstRequest, actionRequest, actionPrepared, actionHeader, noTurnHeader,
          actionInvocation]
      · exact ⟨approvedTicket,
          by simp [claimedState, approvedState, approvedApprovals, ApprovalLedger.setTicket,
            actionApproval], rfl, rfl, rfl, rfl, by decide,
          by simp [claimedState, approvedState, approvedApprovals, ApprovalLedger.setTicket,
            requestedApprovals, actionTicket, actionApproval, actionFirstRequest, actionRequest,
            actionPrepared,
            approvedTicket, actionHeader, noTurnHeader, actionInvocation, tableSet_self],
          rfl, rfl⟩
      · refine ⟨rfl, rfl, ⟨⟨0, firstArgs,
          deriveItemKey actionHeader actionPrepared.payload 0 firstArgs⟩, rfl, rfl, ?_⟩⟩
        simp [actionFirstRequest, actionRequest, actionPrepared, actionHeader, noTurnHeader,
          actionAttempt]
      · apply EffectStep.firstAttempt (prepared := actionPrepared)
        · rfl
        · simp [EffectLedger.recordAdmission, claimedState, claimedEffects,
            EffectLedger.setClaim, requestedEffects, actionAttempt]
        · exact ⟨admissionFor actionFirstRequest, by simp [EffectLedger.recordAdmission],
            rfl, rfl, ⟨⟨0, firstArgs,
              deriveItemKey actionHeader actionPrepared.payload 0 firstArgs⟩, rfl, rfl, by
              simp [actionPrepared, actionHeader, noTurnHeader, actionAttempt]⟩⟩
        · exact ⟨⟨0, firstArgs,
            deriveItemKey actionHeader actionPrepared.payload 0 firstArgs⟩, rfl, rfl, by
            simp [actionPrepared, actionHeader, noTurnHeader, actionAttempt]⟩
        · rfl
        · exact ⟨actionClaim,
            by simp [EffectLedger.recordAdmission, claimedState, claimedEffects,
              EffectLedger.setClaim, actionClaim, actionAttempt],
            by simp [EffectLedger.recordAdmission, claimedState, claimedEffects,
              EffectLedger.setClaim, actionClaim, actionAttempt],
            ⟨rfl, rfl, rfl, rfl, rfl⟩, by decide⟩
        · rfl
        · rfl
      · simp [startedEffects, EffectLedger.addAttempt, tableSet_self]
      · exact firstActionAttemptAuditAppend

theorem nonvacuous_approval_start_then_continue :
    MediatedStep claimedState (.approvalStart actionApproval actionInvocation ⟨50⟩ ⟨50⟩)
      startedState ∧
    MediatedStep startedState (.claimItem actionInvocation 1 ⟨1⟩) secondClaimedState ∧
    MediatedStep secondClaimedState
      (.approvalContinue actionApproval actionInvocation ⟨51⟩ ⟨51⟩) continuedState := by
  refine ⟨nonvacuous_request_approve_start_trace.2.2.2, ?_, ?_⟩
  · have ready : MediatedReady startedState actionSecondRequest := by
      simpa [startedState, claimedState, approvedState, requestedState] using actionSecondReady
    apply MediatedStep.claimItem (request := actionSecondRequest) (claim := actionSecondClaim)
      (effects' := secondClaimedEffects) ready
    · change actionSecondRequest.ReservesItem 1
      refine ⟨⟨1, secondArgs,
        deriveItemKey actionHeader actionPrepared.payload 1 secondArgs⟩, rfl, ?_⟩
      simp [AdmissionRequest.ReservedFor, actionSecondRequest, actionRequest,
        actionSecondObligation, actionPrepared, actionHeader, noTurnHeader,
        actionInvocation, header]
    · simp [startedState, startedEffects, claimedState, claimedEffects, requestedEffects,
        actionSecondRequest, actionRequest, actionPrepared, actionHeader, noTurnHeader,
        actionInvocation,
        EffectLedger.addAttempt, EffectLedger.recordAdmission, EffectLedger.setClaim,
        tableSet_self]
    · rfl
    · apply EffectStep.claimItem (prepared := actionPrepared)
        (item := ⟨1, secondArgs,
          deriveItemKey actionHeader actionPrepared.payload 1 secondArgs⟩)
      · simp [startedState, startedEffects, claimedState, claimedEffects, requestedEffects,
          secondClaimedEffects,
          actionSecondClaim, EffectLedger.addAttempt, EffectLedger.recordAdmission,
          EffectLedger.setClaim, tableSet_self]
      · rfl
      · rfl
      · refine Or.inl ⟨rfl, ?_, rfl⟩
        change (default : EffectLedger).latestAttempt actionInvocation 1 = none
        rfl
      · decide
      · rfl
      · rfl
  · have ready : MediatedReady secondClaimedState actionSecondRequest := by
      simpa [secondClaimedState, startedState, claimedState, approvedState, requestedState]
        using actionSecondReady
    apply MediatedStep.approvalContinue (state := secondClaimedState)
      (request := actionSecondRequest)
      (approvalId := actionApproval) (attempt := actionSecondAttempt)
      (effects' := continuedEffects)
      (continuation := ⟨actionApproval, actionInvocation, actionPrepared.identity,
        actionPrepared.digest, ⟨50⟩⟩) ready
    · simp [AdmissionRequest.ReservedFor, actionSecondRequest, actionRequest,
        actionSecondObligation, actionSecondAttempt, actionPrepared, actionHeader,
        noTurnHeader, actionInvocation, header]
    · simp [secondClaimedState, secondClaimedEffects, startedEffects, claimedEffects,
        requestedEffects, actionSecondRequest, actionRequest, actionPrepared, actionHeader,
        noTurnHeader,
        actionInvocation, EffectLedger.addAttempt, EffectLedger.recordAdmission,
        EffectLedger.setClaim, tableSet_self]
    · simpa [secondClaimedState] using nonvacuous_persisted_approval_continuation
    · simp [secondClaimedState, startedState, ApprovalLedger.consume, actionSecondRequest,
        actionRequest,
        actionPrepared, actionHeader, noTurnHeader, actionInvocation, tableSet_self]
    · refine ⟨actionAttempt, ⟨0, firstArgs,
        deriveItemKey actionHeader actionPrepared.payload 0 firstArgs⟩, ?_, rfl, rfl, rfl⟩
      simp [secondClaimedState, secondClaimedEffects, startedEffects, claimedEffects,
        requestedEffects, actionAttempt, EffectLedger.addAttempt,
        EffectLedger.recordAdmission, EffectLedger.setClaim, tableSet_self]
    · decide
    · refine ⟨rfl, rfl, ⟨⟨1, secondArgs,
        deriveItemKey actionHeader actionPrepared.payload 1 secondArgs⟩, rfl, rfl, ?_⟩⟩
      simp [actionSecondRequest, actionRequest, actionPrepared, actionHeader, noTurnHeader,
        actionSecondAttempt]
    · apply EffectStep.firstAttempt (prepared := actionPrepared)
      · rfl
      · simp [EffectLedger.recordAdmission, secondClaimedState, secondClaimedEffects,
          startedEffects, claimedEffects, requestedEffects, actionSecondAttempt,
          EffectLedger.addAttempt, EffectLedger.setClaim, tableSet_self]
      · exact ⟨admissionFor actionSecondRequest, by simp [EffectLedger.recordAdmission],
          rfl, rfl, ⟨⟨1, secondArgs,
            deriveItemKey actionHeader actionPrepared.payload 1 secondArgs⟩, rfl, rfl, by
            simp [actionPrepared, actionHeader, noTurnHeader, actionSecondAttempt]⟩⟩
      · exact ⟨⟨1, secondArgs,
          deriveItemKey actionHeader actionPrepared.payload 1 secondArgs⟩, rfl, rfl, by
          simp [actionPrepared, actionHeader, noTurnHeader, actionSecondAttempt]⟩
      · rfl
      · exact ⟨actionSecondClaim,
          by simp [EffectLedger.recordAdmission, secondClaimedState, secondClaimedEffects,
            startedEffects, claimedEffects, requestedEffects, actionSecondClaim,
            actionSecondAttempt, EffectLedger.setClaim, tableSet_self],
          by simp [EffectLedger.recordAdmission, secondClaimedState, secondClaimedEffects,
            startedEffects, claimedEffects, requestedEffects, actionSecondClaim,
            actionSecondAttempt, EffectLedger.setClaim, tableSet_self],
          ⟨rfl, rfl, rfl, rfl, rfl⟩, by decide⟩
      · rfl
      · rfl
    · simp [continuedEffects, EffectLedger.addAttempt, tableSet_self]
    · exact secondActionAttemptAuditAppend

theorem nonvacuous_approved_attempt_audit_atomic :
    ∃ attempt entry,
      startedState.effects.attempts ⟨50⟩ = some attempt ∧
      startedState.audit.entries ⟨50⟩ = some entry ∧
      entry.kind = .attempt ⟨50⟩ actionInvocation ∧
      entry.cause = some attempt.auditCause := by
  obtain ⟨attempt, entry, attemptLookup, auditLookup, kind, invocation, cause⟩ :=
    approved_attempt_and_exact_audit_are_one_transition
      nonvacuous_request_approve_start_trace.2.2.2
  exact ⟨attempt, entry, attemptLookup, auditLookup, kind, cause⟩

theorem nonvacuous_continued_attempt_audit_atomic :
    ∃ attempt entry,
      continuedState.effects.attempts ⟨51⟩ = some attempt ∧
      continuedState.audit.entries ⟨51⟩ = some entry ∧
      entry.kind = .attempt ⟨51⟩ actionInvocation ∧
      entry.cause = some attempt.auditCause := by
  obtain ⟨attempt, entry, attemptLookup, auditLookup, kind, invocation, cause⟩ :=
    continued_attempt_and_exact_audit_are_one_transition
      nonvacuous_approval_start_then_continue.2.2
  exact ⟨attempt, entry, attemptLookup, auditLookup, kind, cause⟩

private def malformedContinuation : ApprovalContinuation :=
  ⟨actionApproval, actionInvocation, actionPrepared.identity, actionPrepared.digest, ⟨999⟩⟩
private def malformedContinuationState : SystemState := {
  startedState with
  approvals := { startedState.approvals with
    continuations := tableSet startedState.approvals.continuations actionInvocation
      malformedContinuation }
}

theorem nonvacuous_malformed_approval_continuation_rejected :
    ¬ MediatedStep malformedContinuationState
      (.approvalContinue actionApproval actionInvocation ⟨51⟩ ⟨51⟩) continuedState := by
  apply malformed_first_attempt_cannot_continue
    (prepared := actionPrepared) (continuation := malformedContinuation)
  · simp [malformedContinuationState, startedState, startedEffects, claimedEffects,
      requestedEffects, EffectLedger.addAttempt, EffectLedger.recordAdmission,
      EffectLedger.setClaim, tableSet_self]
  · simp [malformedContinuationState]
  · intro valid
    obtain ⟨attempt, item, lookup, invocation, itemAt, key⟩ := valid
    change tableSet (default : EffectLedger).attempts (⟨50⟩ : AttemptId) actionAttempt
      (⟨999⟩ : AttemptId) = some attempt at lookup
    simp [tableSet] at lookup

private def parentGrantId : GrantId := .manual 10
private def childGrantId : GrantId := .manual 11
private def parentGrant : Grant :=
  ⟨.principal principalRef, tenantScope, .allow, header.permission, none, .manual⟩
private def childGrant : Grant :=
  ⟨.principal principalRef, scope, .allow, header.permission, some parentGrantId, .manual⟩
private def delegationLedger : AuthorityLedger := {
  (default : AuthorityLedger) with
  grants := tableSet (default : AuthorityLedger).grants parentGrantId parentGrant
}

theorem nonvacuous_delegation_containment :
    ∃ after, AuthorityLedger.AuthorityStep delegationLedger (.delegate childGrantId) after := by
  refine ⟨{ delegationLedger.bumpScope scope with
    grants := tableSet delegationLedger.grants childGrantId childGrant }, ?_⟩
  apply AuthorityLedger.AuthorityStep.delegate (parentGrant := parentGrant)
  · rfl
  · rfl
  · apply AuthorityLedger.LiveGrant.root
    · simp [delegationLedger, parentGrantId]
    · rfl
    · intro revoked; contradiction
  · rfl
  · rfl
  · rfl
  · change tenantScope ∈ scope.path
    simp [Scope.path, scope, tenantScope]
  · rfl

private def expiredLease : TurnLease := ⟨turnId, some principalRef, 1, ⟨2⟩⟩
private def reclaimedLease : TurnLease := ⟨turnId, some principalRef, 2, ⟨10⟩⟩
private def suspendedLease : TurnLease := ⟨turnId, none, 2, ⟨10⟩⟩
private def resumedLease : TurnLease := ⟨turnId, some principalRef, 3, ⟨12⟩⟩

theorem nonvacuous_lease_reclaim_and_same_turn_resume :
    LeaseStep expiredLease (.reclaim principalRef ⟨3⟩ ⟨10⟩) reclaimedLease ∧
    LeaseStep suspendedLease (.resume principalRef ⟨3⟩ ⟨12⟩) resumedLease := by
  exact ⟨.reclaim (by decide) (by decide) (by decide), .resume rfl (by decide)⟩

theorem nonvacuous_resolution_deadline_bound :
    resolution.deadline.tick ≤ (⟨10⟩ : Time).tick :=
  AuthorityLedger.direct_deadline_cannot_exceed_original_lease
    (ledger := authorityBase) (resolution := resolution)
    ⟨by decide, by simp [resolution, header, token]⟩ rfl rfl

private def staleAuthority : AuthorityLedger := actionAuthority.bumpScope scope
private def staleState : SystemState := {
  actionState with authority := staleAuthority, effects := requestedEffects
}
private def staleReceipt : PreEffectReceipt :=
  ⟨actionInvocation, 0, .denied⟩
private def staleEffects : EffectLedger := requestedEffects.addPreReceipt ⟨60⟩ staleReceipt
private def staleReceiptAudit : AuditEntry :=
  ⟨.run tenant runId, 2, 8, some actionRootAuditId,
    .preReceipt ⟨60⟩ actionInvocation 0 .denied⟩
private def staleAuditLog : AuditLog := actionAuditOne.append ⟨60⟩ staleReceiptAudit
private theorem staleReceiptAuditAppend :
    PreReceiptAuditAppend staleEffects (default : EventStore) actionAuditOne ⟨60⟩
      staleReceipt ⟨60⟩ staleAuditLog := by
  refine ⟨actionRootAuditId, staleReceiptAudit, ?_, ?_, ?_, rfl, rfl⟩
  · exact ⟨actionRootAudit, by
      change tableSet (default : AuditLog).entries actionRootAuditId actionRootAudit
        actionRootAuditId = some actionRootAudit
      exact tableSet_self .., rfl⟩
  · apply AuditStep.append
    · decide
    · decide
    · exact ⟨actionRootAudit, by
        change tableSet (default : AuditLog).entries actionRootAuditId actionRootAudit
          actionRootAuditId = some actionRootAudit
        exact tableSet_self .., rfl, by decide, rfl, rfl⟩
    · exact actionRootChain
    · refine ⟨staleReceipt, ?_, rfl, rfl, rfl⟩
      simp [staleEffects, EffectLedger.addPreReceipt]
  · change tableSet actionAuditOne.entries ⟨60⟩ staleReceiptAudit ⟨60⟩ =
      some staleReceiptAudit
    exact tableSet_self ..
private theorem actionPathComplete : actionAuthority.PathEvidenceComplete actionHeader scope := by
  constructor
  · rfl
  · intro evidence member
    change evidence ∈ [⟨tenantScope, 0⟩, ⟨scope, 0⟩] at member
    simp only [List.mem_cons, List.mem_nil_iff, or_false] at member
    rcases member with rfl | rfl <;> rfl

theorem nonvacuous_stale_mediated_denial :
    MediatedStep staleState (.staleDenied actionInvocation ⟨60⟩ ⟨60⟩) {
      staleState with
      authority := staleAuthority.observeForHolder principalRef scope
      effects := staleEffects
      audit := staleAuditLog
    } := by
  apply MediatedStep.staleDenied (request := actionFirstRequest) (resolution := actionResolution)
    (holder := principalRef)
    (item := ⟨0, firstArgs, deriveItemKey actionHeader actionPrepared.payload 0 firstArgs⟩)
    (receipt := staleReceipt)
  · change tableSet actionAuthorityBase.resolutions actionResolution.id actionResolution
      actionResolution.id = some actionResolution
    exact tableSet_self ..
  · rfl
  · change tableSet (default : EffectLedger).invocations actionInvocation actionPrepared
      actionFirstRequest.prepared.header.invocation = some actionFirstRequest.prepared
    simp [actionFirstRequest, actionRequest, actionPrepared, actionHeader, noTurnHeader,
      actionInvocation]
  · apply AuthorityLedger.bump_scope_stales_path_evidence
      (ledger := actionAuthority) (header := actionHeader) (target := scope)
      (scope := scope) (evidence := ⟨scope, 0⟩)
    · exact actionPathComplete
    · change (⟨scope, 0⟩ : PathEpoch) ∈ [⟨tenantScope, 0⟩, ⟨scope, 0⟩]
      exact List.mem_cons_of_mem _ (List.mem_cons_self _ _)
    · rfl
  · rfl
  · exact AuthorityLedger.AuthorityStep.observe
  · rfl
  · rfl
  · rfl
  · apply EffectStep.preReceipt (prepared := actionPrepared)
    · rfl
    · rfl
    · change tableSet (default : EffectLedger).invocations actionInvocation actionPrepared
        staleReceipt.invocation = some actionPrepared
      simp [staleReceipt]
    · exact ⟨⟨0, firstArgs, deriveItemKey actionHeader actionPrepared.payload 0 firstArgs⟩, rfl⟩
    · rfl
    · rfl
    · rfl
  · rfl
  · exact staleReceiptAuditAppend

theorem nonvacuous_stale_denial_audit_atomic :
    ∃ receipt parent parentEntry entry,
      staleEffects.preReceipts ⟨60⟩ = some receipt ∧
      actionAuditOne.entries parent = some parentEntry ∧
      MayCause parentEntry.kind
        (.preReceipt ⟨60⟩ receipt.invocation receipt.itemIndex receipt.outcome) ∧
      staleAuditLog.entries ⟨60⟩ = some entry ∧
      entry.kind = .preReceipt ⟨60⟩ receipt.invocation receipt.itemIndex receipt.outcome ∧
      receipt.outcome = .denied ∧ entry.cause = some parent := by
  obtain ⟨receipt, parent, parentEntry, entry, receiptLookup, parentLookup, permitted,
    auditLookup, kind, invocation, denied, cause⟩ :=
    stale_denial_and_exact_audit_are_one_transition nonvacuous_stale_mediated_denial
  exact ⟨receipt, parent, parentEntry, entry, receiptLookup, parentLookup, permitted,
    auditLookup, kind, denied, cause⟩

private def viewStart : ViewState := ⟨0, ⟨["a"]⟩⟩
private def viewDeltaOne : ViewDelta := ⟨0, .append ⟨["b"]⟩⟩
private def viewDeltaTwo : ViewDelta := ⟨1, .replace ⟨["c"]⟩⟩

theorem nonvacuous_view_replay :
    replay viewStart [viewDeltaOne, viewDeltaTwo] = some ⟨2, ⟨["c"]⟩⟩ := rfl

private def wrongTurnToken : LeaseToken := ⟨⟨99⟩, principalRef, 1⟩
private def staleLeaseToken : LeaseToken := ⟨turnId, principalRef, 0⟩

theorem nonvacuous_wrong_turn_rejection : ¬ lease.Admits wrongTurnToken ⟨1⟩ :=
  wrong_turn_rejects (by decide)

theorem nonvacuous_stale_token_rejection : ¬ lease.Admits staleLeaseToken ⟨1⟩ :=
  stale_token_rejects (by decide)

theorem nonvacuous_stale_self_rejection :
    ¬ HostDerivedTrust (fun _ => some lease) ⟨1⟩
      { selfEvent with leaseToken := some staleLeaseToken, acceptedTier := .self } := by
  intro trust
  unfold HostDerivedTrust at trust
  obtain ⟨token, actual, tokenField, lookup, admits⟩ := trust
  change some staleLeaseToken = some token at tokenField
  cases Option.some.inj tokenField
  cases Option.some.inj lookup
  exact stale_token_rejects (by decide) admits

private def writerGraph : GraphStore := {
  rootGraph with turns := tableSet rootGraph.turns turnId runningTurn
}
private def messageCommit : RunCommit :=
  ⟨runId, branchId, pins, .turn token ⟨1⟩, [rootCommitId], some turnId, .message, none⟩
private theorem messageAllowed :
    CommitAllowed writerGraph (default : EffectLedger) (default : EventStore) auditOne ⟨1⟩
      messageCommit := by
  refine ⟨⟨rootCommitId, rootCommit, rfl, ?_, rfl⟩, ?_, rfl⟩
  · change tableSet (default : GraphStore).commits rootCommitId rootCommit rootCommitId =
      some rootCommit
    exact tableSet_self ..
  exact ⟨runningTurn, by simp [writerGraph, token, turnId], rfl, rfl, rfl, rfl,
    ⟨rfl, rfl, rfl, by decide⟩, rootCause⟩

theorem nonvacuous_unary_commit_pin_inheritance :
    CommitAllowed writerGraph (default : EffectLedger) (default : EventStore) auditOne ⟨1⟩
      messageCommit ∧ UnaryPinsInherited writerGraph messageCommit :=
  ⟨messageAllowed, unary_commit_inherits_pins messageAllowed (Or.inl rfl)⟩

private def denyGrantId : GrantId := .manual 20
private def denyGrant : Grant := { allowGrant with effect := .deny }
private def denyAuthority : AuthorityLedger := {
  authorityBase with grants := tableSet authorityBase.grants denyGrantId denyGrant
}

theorem nonvacuous_live_deny_override :
    denyAuthority.Denied principalRef scope header.permission ∧
      ¬ denyAuthority.Authorized principalRef header scope := by
  have live : denyAuthority.LiveGrant denyGrantId denyGrant := by
    apply AuthorityLedger.LiveGrant.root
    · simp [denyAuthority, denyGrantId]
    · rfl
    · intro revoked; contradiction
  have denied : denyAuthority.Denied principalRef scope header.permission :=
    ⟨denyGrantId, denyGrant, live, rfl,
      ⟨rfl, rfl, Scope.contains_refl scope, rfl, rfl⟩⟩
  exact ⟨denied, AuthorityLedger.deny_overrides denied⟩

private def elevatedAllowRule : RoleRule :=
  ⟨.allow, ⟨.external tenant "admin", .administer⟩⟩
private def elevatedAllowRole : Role := ⟨⟨3⟩, [elevatedAllowRule]⟩
private def elevatedMembership : Membership :=
  ⟨⟨3⟩, .foreign ⟨2⟩ principal, scope, elevatedAllowRole.id⟩

theorem nonvacuous_guest_elevated_allow_filtered :
    (materializeRole (default : AuthorityLedger) elevatedMembership elevatedAllowRole).grants
      (.role elevatedMembership.id 0) = none := by
  apply guest_allow_is_attenuated
  · rfl
  · rfl
  · rfl
  · rfl

theorem nonvacuous_role_rematerialization_epoch :
    MaterializationStep (default : AuthorityLedger) elevatedMembership elevatedAllowRole
      (materializeRole ((default : AuthorityLedger).bumpScope elevatedMembership.scope)
        elevatedMembership elevatedAllowRole) := by
  exact MaterializationStep.rematerialize rfl

private def emptyPlacement : PlacementSet := ⟨false, false, false⟩

theorem nonvacuous_empty_placement_rejected :
    choosePlacement allModes allModes emptyPlacement allModes = none := by
  apply empty_intersection_rejects
  rfl

theorem nonvacuous_source_tier_rejected :
    ¬ acceptsSourceTier ⟨false, false⟩ .owner := by
  apply source_asserted_tier_rejected
  decide

theorem nonvacuous_receipt_audit_append :
    AuditStep mixedEffects (default : EventStore) auditThree (.append ⟨3⟩) auditFour :=
  item0Step

theorem nonvacuous_causal_chain_preserved :
    CausalChain (default : EventStore) auditFour ⟨2⟩ :=
  causal_chain_preserved_by_step item0Step childChainAuditThree

private def orphanAttemptAudit : AuditEntry :=
  ⟨.run tenant runId, 1, 99, none, .attempt ⟨99⟩ invocationId⟩
private def orphanAuditAfter : AuditLog :=
  (default : AuditLog).append ⟨99⟩ orphanAttemptAudit

theorem nonvacuous_nonroot_cause_free_append_impossible :
    ¬ AuditStep (default : EffectLedger) (default : EventStore) (default : AuditLog)
      (.append ⟨99⟩) orphanAuditAfter := by
  apply nonroot_cannot_append_without_cause (entry := orphanAttemptAudit)
    (after := orphanAuditAfter)
  · change tableSet (default : AuditLog).entries ⟨99⟩ orphanAttemptAudit ⟨99⟩ =
      some orphanAttemptAudit
    exact tableSet_self ..
  · simp [RootKindAllowed, orphanAttemptAudit]
  · rfl

theorem nonvacuous_guarded_attempt_reachability :
    ∃ state attemptId attempt,
      Reachable state ∧ state.core.effects.attempts attemptId = some attempt := by
  obtain ⟨reachable, stored⟩ := CanonicalMediatedTrace.canonical_actor_local_attempt_reachable
  exact ⟨_, _, _, reachable, stored⟩

theorem nonvacuous_actor_local_mediated_attempt :
    ∃ before after invocation attemptId auditId attempt,
      Reachable before ∧
      SystemStep before (.mediated (.start invocation attemptId auditId)) after ∧
      after.core.effects.attempts attemptId = some attempt ∧
      after.permits = before.permits :=
  CanonicalMediatedTrace.canonical_actor_local_attempt_step

theorem nonvacuous_distributed_permit_issue_consume :
    ∃ state target nonce consumption,
      Reachable state ∧
      state.permits.consumptions target nonce = some consumption ∧
      exactRequested state.permits
        ⟨consumption.permit.expectation, consumption.permit.nonce⟩ ∧
      exactIssued state.permits consumption.permit ∧
      exactAuthenticated state.permits consumption.permit ∧
      consumption.permit.expectation.issuer ≠ target := by
  obtain ⟨reachable, _, _, _, _, _, _, _⟩ :=
    CanonicalMediatedTrace.canonical_single_item_mediated_attempt_reachable
  obtain ⟨consumption, consumed, requested, issued, authenticated, crossActor⟩ :=
    CanonicalMediatedTrace.canonical_cross_actor_consumption_has_historical_issuance
  exact ⟨_, _, _, consumption, reachable, consumed, requested, issued, authenticated, crossActor⟩

theorem nonvacuous_distributed_permit_replay_after_restart :
    ∃ state permit,
      Reachable state ∧ exactAuthenticated state.permits permit ∧
      ∀ next observation after,
        ¬ PermitStep state
          (.consume permit.expectation.target permit.nonce next observation) after := by
  obtain ⟨reachable, authenticated, blocked⟩ :=
    CanonicalMediatedTrace.canonical_replay_after_restart_is_reauthenticated_but_cannot_reconsume
  refine ⟨_, _, reachable, authenticated, ?_⟩
  simpa using blocked

theorem nonvacuous_missing_target_request_authentication_fails_closed :
    ∃ state target nonce,
      ∀ after, ¬ PermitStep state (.authenticate target nonce) after := by
  refine ⟨default, .workspace ⟨1⟩ ⟨1⟩, ⟨1⟩, ?_⟩
  intro after
  apply missing_target_request_cannot_authenticate
  intro permit targetEq nonceEq
  simp [exactRequested]

private def renewedLease : TurnLease := { lease with expiresAt := ⟨12⟩ }

theorem nonvacuous_renewal_preserves_turn_and_resolution_deadline :
    LeaseStep lease (.renew token ⟨1⟩ ⟨12⟩) renewedLease ∧
    renewedLease.turn = lease.turn ∧ resolution.deadline.tick ≤ renewedLease.expiresAt.tick := by
  have renewal : LeaseStep lease (.renew token ⟨1⟩ ⟨12⟩) renewedLease :=
    .renew ⟨rfl, rfl, rfl, by decide⟩ (by decide)
  exact ⟨renewal, lease_turn_immutable renewal,
    renewal_cannot_extend_resolution_deadline renewal (by decide)⟩

private def reservedEvents : EventStore := {
  (default : EventStore) with
  reservations := tableSet (default : EventStore).reservations reservationId reservation
  reservationFor := tableSet (default : EventStore).reservationFor invocationId reservationId
}

theorem nonvacuous_exact_route_projection :
    EventStep (fun _ => none) ⟨1⟩ reservedEvents (.project projectionId) routedEvents := by
  apply EventStep.project (projection := projection) (reservation := reservation)
  · rfl
  · simp [reservedEvents, projection, reservationId]
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl

private def sourceEventRecord : Event :=
  ⟨tenant, .workspace tenant workspace, .input, "source", ⟨false, false⟩, none, none,
    .external⟩
private def sourceEventAuditEntry : AuditEntry :=
  ⟨.workspace tenant workspace, 1, 20, none,
    .event reservation.sourceEvent reservation.invocation⟩
private def sourceEventStore : EventStore := {
  (default : EventStore) with
  events := tableSet (default : EventStore).events reservation.sourceEvent sourceEventRecord
}
private def sourceReservedStore : EventStore := {
  sourceEventStore with
  reservations := tableSet sourceEventStore.reservations reservationId reservation
  reservationFor := tableSet sourceEventStore.reservationFor invocationId reservationId
}
private def sourceEventAuditLog : AuditLog := {
  (default : AuditLog) with
  entries := tableSet (default : AuditLog).entries reservation.sourceAudit sourceEventAuditEntry
}
private def sourceRouteState : SystemState := {
  (default : SystemState) with events := sourceEventStore, audit := sourceEventAuditLog
}
private def sourceReservedState : SystemState := {
  sourceRouteState with events := sourceReservedStore
}

theorem nonvacuous_source_reservation_audit_binding :
    MediatedStep sourceRouteState (.event (.reserve reservationId)) sourceReservedState := by
  apply MediatedStep.event (leases := fun _ => none) (now := ⟨1⟩)
  · apply EventStep.reserveSameTenant (reservation := reservation) (event := sourceEventRecord)
      (source := .initiator principalRef bindingId)
    · rfl
    · rfl
    · simp [sourceRouteState, sourceEventStore, reservation]
    · rfl
    · rfl
    · rfl
  · intro turn
    rfl
  · exact ⟨reservation, sourceEventRecord, sourceEventAuditEntry,
      by simp [sourceReservedStore, reservationId],
      by simp [sourceReservedStore, sourceEventStore, reservation], rfl,
      by simp [sourceRouteState, sourceEventAuditLog, reservation], rfl, rfl⟩

theorem nonvacuous_graph_freshness_rejection :
    ¬ GraphStep (default : EffectLedger) (default : EventStore) auditOne rootGraph
      (.spawnChild turnId ⟨2⟩ rootCommitId) (default : GraphStore) := by
  apply spawn_child_rejects_existing_root (record := rootCommit)
  simp [rootGraph, rootCommitId]

theorem nonvacuous_typed_system_writer_audit :
    ControlCommitAudit mergeGraph synthesisEffects synthesisAuditLog ⟨34⟩ ⟨30⟩
      synthesisOperation runId := controlCommitAuditWitness

theorem nonvacuous_holder_watermark_inequality :
    ∃ exactToken, directRequest.prepared.header.lease = some exactToken ∧
      directState.authority.holderWatermark exactToken.holder tenantScope ≤ 0 := by
  simpa [directRequest, prepared, header] using
    (direct_ready_uses_exact_holder_watermark_inequality directReady
      (evidence := ⟨tenantScope, 0⟩) (by simp [directRequest, prepared, header]))

private def hostileTierEvent : Event :=
  { selfEvent with assertedTier := some .owner }
private def hostileTierAfter : EventStore := {
  (default : EventStore) with
  events := tableSet (default : EventStore).events ⟨90⟩ hostileTierEvent
}

theorem nonvacuous_hostile_tier_publication_rejected :
    ¬ EventStep (fun id => if id = turnId then some lease else none) ⟨1⟩
      (default : EventStore) (.publish ⟨90⟩) hostileTierAfter := by
  apply asserted_tier_publish_rejected (event := hostileTierEvent) (tier := .owner)
  · simp [hostileTierAfter]
  · rfl

private def receiptCollisionLedger : EffectLedger := {
  (default : EffectLedger) with
  preReceipts := tableSet (default : EffectLedger).preReceipts ⟨91⟩ staleReceipt
}

theorem nonvacuous_receipt_id_disjointness_rejection :
    ¬ EffectStep receiptCollisionLedger (.attemptReceipt ⟨91⟩) (default : EffectLedger) := by
  apply pre_receipt_id_cannot_be_reused_for_attempt (record := staleReceipt)
  simp [receiptCollisionLedger]

private def abandonedClaim : ItemClaim :=
  { actionClaim with expiresAt := ⟨2⟩ }
private def recoveredClaimId : ItemClaimId := ⟨52⟩
private def recoveredWorker : ClaimWorkerId := ⟨2⟩
private def recoveredClaim : ItemClaim :=
  { actionClaim with
    id := recoveredClaimId
    owner := .system (.run tenant runId) recoveredWorker
    expiresAt := ⟨10⟩ }
private def abandonedClaimLedger : EffectLedger := requestedEffects.setClaim abandonedClaim
private def recoveredClaimLedger : EffectLedger := abandonedClaimLedger.setClaim recoveredClaim

theorem nonvacuous_abandoned_claim_same_ordinal_recovery :
    EffectStep abandonedClaimLedger (.recoverItemClaim actionInvocation 0 ⟨3⟩)
      recoveredClaimLedger ∧
    abandonedClaim.expiresAt.tick ≤ 3 ∧ 3 < recoveredClaim.expiresAt.tick ∧
    recoveredClaim.ordinal = abandonedClaim.ordinal ∧
    NoEffectAttemptFor abandonedClaimLedger actionInvocation 0 abandonedClaim.ordinal := by
  have recovery :
      EffectStep abandonedClaimLedger (.recoverItemClaim actionInvocation 0 ⟨3⟩)
        recoveredClaimLedger := by
    apply EffectStep.recoverItemClaim (previous := abandonedClaim) (replacement := recoveredClaim)
      (prepared := actionPrepared)
    · simp [abandonedClaimLedger, abandonedClaim, actionClaim, EffectLedger.setClaim]
    · simp [abandonedClaimLedger, abandonedClaim, actionClaim, EffectLedger.setClaim]
    · simp [abandonedClaimLedger, requestedEffects, abandonedClaim, actionClaim,
        EffectLedger.setClaim]
    · rfl
    · rfl
    · change tableSet (default : EffectLedger).claims actionClaimId abandonedClaim
        recoveredClaimId = none
      rw [tableSet_other _ _ _ (by decide)]
      rfl
    · decide
    · decide
    · rfl
    · rfl
    · rfl
    · change (⟨2⟩ : ClaimWorkerId) ≠ ⟨1⟩
      decide
    · decide
    · intro id attempt lookup
      simp [abandonedClaimLedger, requestedEffects, EffectLedger.setClaim] at lookup
  refine ⟨recovery, by decide, by decide, rfl, ?_⟩
  intro id attempt lookup
  simp [abandonedClaimLedger, requestedEffects, EffectLedger.setClaim] at lookup

private def emptyTerminalBefore : GraphStore := {
  rootGraph with
  turns := tableSet rootGraph.turns turnId runningTurn
  terminalizing := tableSet rootGraph.terminalizing runId terminalControl
}
private def emptyTerminalSnapshot : TerminalSnapshot :=
  ⟨runId, turnId, rootCommitId, terminalCommitId, .succeeded, 0, []⟩

theorem nonvacuous_empty_coherent_terminalization :
    ∃ after, GraphStep (default : EffectLedger) (default : EventStore) auditOne
      emptyTerminalBefore (.terminalize runId turnId terminalCommitId rootCommitId) after := by
  refine ⟨{
    (emptyTerminalBefore.append terminalCommitId terminalCommit) with
    runs := tableSet emptyTerminalBefore.runs runId { run with status := .terminal }
    turns := tableSet emptyTerminalBefore.turns turnId
      (runningTurn.withStatusLease .succeeded ⟨turnId, none, 2, ⟨10⟩⟩)
    terminalSnapshots := tableSet emptyTerminalBefore.terminalSnapshots runId emptyTerminalSnapshot
    admissionRegistry := tableSet emptyTerminalBefore.admissionRegistry runId ⟨1, false, [], []⟩
    terminalizing := fun candidate => if candidate = runId then none else emptyTerminalBefore.terminalizing candidate
  }, ?_⟩
  apply GraphStep.terminalize (run := run) (turn := runningTurn) (token := token)
    (now := ⟨1⟩) (fenced := ⟨turnId, none, 2, ⟨10⟩⟩) (terminal := .succeeded)
    (registry := ⟨0, true, [], []⟩) (commit := terminalCommit) (preterminal := rootCommit)
    (snapshot := emptyTerminalSnapshot) (cause := ⟨1⟩) (control := terminalControl)
  · simp [emptyTerminalBefore, rootGraph, runId]
  · rfl
  · simp [emptyTerminalBefore, turnId]
  · rfl
  · rfl
  · rfl
  · exact ⟨rfl, rfl, rfl, by decide⟩
  · simp [RunPins.Valid, pins, run, agent]
  · rfl
  · simp [emptyTerminalBefore, terminalControl, runId]
  · rfl
  · intro id candidate lookup sameRun different
    by_cases same : id = turnId
    · exact (different same).elim
    · change tableSet rootGraph.turns turnId runningTurn id = some candidate at lookup
      rw [tableSet_other _ _ _ same] at lookup
      contradiction
  · exact .terminalFence
  · exact Or.inl rfl
  · simp [emptyTerminalBefore, rootGraph, runningTurn]
  · simp [emptyTerminalBefore, rootGraph, rootCommitId]
  · rfl
  · rfl
  · rfl
  · simp [emptyTerminalBefore, rootGraph, runId]
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · exact rootCause
  · rfl
  · rfl
  · rfl
  · rfl

private def siblingTurnId : TurnId := ⟨2⟩
private def unheldSuspendedSibling : Turn :=
  ⟨runId, branchId, turnPins, .suspended, ⟨siblingTurnId, none, 1, ⟨10⟩⟩⟩
private def unheldNonterminalSiblingGraph : GraphStore := {
  emptyTerminalBefore with
  turns := tableSet emptyTerminalBefore.turns siblingTurnId unheldSuspendedSibling
}

theorem nonvacuous_unheld_nonterminal_sibling_rejected :
    ¬ GraphStep (default : EffectLedger) (default : EventStore) auditOne
      unheldNonterminalSiblingGraph
      (.terminalize runId turnId terminalCommitId rootCommitId) (default : GraphStore) := by
  intro step
  have siblings := terminalization_requires_terminal_and_unheld_siblings step
  have sibling := siblings siblingTurnId unheldSuspendedSibling
    (by simp [unheldNonterminalSiblingGraph, siblingTurnId]) rfl (by decide)
  simp [unheldSuspendedSibling] at sibling

/-! ## Event → Subscription routing witnesses (SPEC §6.2)

A concrete trace proving the routing LTS is livable: an owner-channel Event fires an
enabled Subscription once, and the same key is inert on redelivery. -/

private def routedTenant : TenantId := ⟨1⟩
private def routedEventId : EventId := ⟨1⟩
private def redeliveredEventId : EventId := ⟨2⟩
private def routedSubscriptionId : SubscriptionId := ⟨1⟩
private def routedTarget : InvocationId := ⟨41⟩
private def routedKey : EventKey := ⟨7⟩
private def ownerChannel : Provenance := ⟨true, true⟩
private def routedEvent : RoutedEvent := ⟨routedTenant, routedKey, ownerChannel⟩
private def routedSubscription : RoutedSubscription :=
  ⟨routedTenant, routedTarget, fun tier => tier == TrustTier.owner, true⟩
private def routedLedger : SubscriptionLedger :=
  { subscriptions := tableSet (fun _ => none) routedSubscriptionId routedSubscription
    events := tableSet (fun _ => none) routedEventId routedEvent
    consumed := fun _ _ => False }

theorem nonvacuous_subscription_fires :
    RoutingStep routedLedger (.fire routedSubscriptionId routedEventId routedTarget)
      (routedLedger.consume routedSubscriptionId routedKey) := by
  have step := RoutingStep.fire (ledger := routedLedger)
    (subscriptionId := routedSubscriptionId) (eventId := routedEventId)
    (subscription := routedSubscription) (event := routedEvent)
    (by simp [routedLedger, tableSet]) rfl (by simp [routedLedger, tableSet]) rfl
    (by decide) (fun consumed => consumed)
  exact step

/-- The same happening redelivered under a fresh EventId (same key) cannot refire. -/
private def redeliveredLedger : SubscriptionLedger :=
  { routedLedger.consume routedSubscriptionId routedKey with
    events := tableSet
      (tableSet (fun _ => none) routedEventId routedEvent) redeliveredEventId routedEvent }

theorem nonvacuous_redelivery_is_inert {after : SubscriptionLedger} :
    ¬ RoutingStep redeliveredLedger
      (.fire routedSubscriptionId redeliveredEventId routedTarget) after := by
  apply consumed_key_never_refires (event := routedEvent)
  · simp [redeliveredLedger, tableSet]
  · exact Or.inl ⟨rfl, rfl⟩

theorem nonvacuous_same_event_never_refires {after : SubscriptionLedger} :
    ¬ RoutingStep (routedLedger.consume routedSubscriptionId routedKey)
      (.fire routedSubscriptionId routedEventId routedTarget) after := by
  apply consumed_key_never_refires (event := routedEvent)
  · simp [routedLedger, SubscriptionLedger.consume, tableSet]
  · exact Or.inl ⟨rfl, rfl⟩

/-! ## Representation witnesses: broker gate and aggregation chain -/

theorem nonvacuous_broker_available :
    approvedApprovals.Available actionApproval actionPrepared ⟨5⟩ := by
  refine ⟨approvedTicket,
    by simp [approvedApprovals, ApprovalLedger.setTicket, actionApproval],
    rfl, rfl, rfl, rfl, by decide,
    by simp [approvedApprovals, ApprovalLedger.setTicket, requestedApprovals, actionTicket,
      actionApproval, actionPrepared, approvedTicket, actionHeader, noTurnHeader,
      actionInvocation, tableSet_self],
    rfl, rfl⟩

/-- The broker's guarded mutation is livable: a concrete approved, unconsumed,
    unexpired ticket admits `applyAction` from the bootstrap state. -/
theorem nonvacuous_broker_apply_action :
    Representation.Broker.GateStep
      (Representation.Broker.initial approvedApprovals)
      { Representation.Broker.initial approvedApprovals with
        ledger := approvedApprovals.consume actionApproval actionPrepared ⟨50⟩ } :=
  Representation.Broker.GateStep.applyAction (now := ⟨5⟩) nonvacuous_broker_available

private def chainRootId : CommitId := ⟨101⟩
private def chainProposerHeadId : CommitId := ⟨102⟩
private def chainMergeId : CommitId := ⟨103⟩
private def chainDestinationBranch : BranchId := ⟨11⟩
private def chainProposerBranch : BranchId := ⟨12⟩
private def chainProposer : Representation.MixtureOfAgents.Proposer :=
  ⟨chainProposerBranch, chainProposerHeadId⟩
private def chainRootCommit : RunCommit :=
  ⟨runId, chainDestinationBranch, pins, .root ⟨0⟩, [], none, .root, none⟩
private def chainProposerCommit : RunCommit :=
  ⟨runId, chainProposerBranch, pins, .root ⟨0⟩, [chainRootId], none, .checkpoint, none⟩
private def chainMergeCommit : RunCommit :=
  ⟨runId, chainDestinationBranch, pins, .root ⟨0⟩,
    [chainRootId, chainProposerHeadId], none, .checkpoint, none⟩
private def chainStore : GraphStore := {
  (default : GraphStore) with
  commits := tableSet (tableSet (tableSet (default : GraphStore).commits
    chainRootId chainRootCommit) chainProposerHeadId chainProposerCommit)
    chainMergeId chainMergeCommit
}

/-- A concrete two-commit aggregation: one proposer folded into the destination head
    by a binary equal-pin merge. Proves the chain shape is livable in the core commit
    graph, and that lineage completeness bites on it. -/
theorem nonvacuous_aggregation_chain :
    Representation.MixtureOfAgents.AggregationChain chainStore runId pins
      chainRootId [chainProposer] chainMergeId ∧
    Ancestor chainStore chainProposerHeadId chainMergeId := by
  have chain : Representation.MixtureOfAgents.AggregationChain chainStore runId pins
      chainRootId [chainProposer] chainMergeId := by
    have base := Representation.MixtureOfAgents.AggregationChain.root
      (store := chainStore) (run := runId) (pins := pins)
      (id := chainRootId) (commit := chainRootCommit)
      (by simp [chainStore, tableSet, chainRootId, chainProposerHeadId, chainMergeId]) rfl rfl
    have step := Representation.MixtureOfAgents.AggregationChain.merge
      (proposer := chainProposer) (mergeId := chainMergeId) (commit := chainMergeCommit)
      (proposerCommit := chainProposerCommit) base
      (by simp [chainStore, tableSet, chainMergeId]) rfl rfl rfl
      (by simp [chainStore, tableSet, chainProposer, chainProposerHeadId, chainMergeId]) rfl rfl rfl
    simpa using step
  refine ⟨chain, ?_⟩
  have := Representation.MixtureOfAgents.proposers_are_ancestors chain chainProposer
    (List.mem_singleton.mpr rfl)
  simpa using this

/-- A disabled Subscription refuses to fire even with a fresh key. -/
private def disabledLedger : SubscriptionLedger :=
  { routedLedger with
    subscriptions := tableSet routedLedger.subscriptions routedSubscriptionId
      routedSubscription.disable }

theorem nonvacuous_disabled_subscription_rejected {after : SubscriptionLedger} :
    ¬ RoutingStep disabledLedger
      (.fire routedSubscriptionId routedEventId routedTarget) after := by
  apply disabled_never_fires (subscription := routedSubscription.disable)
  · simp [disabledLedger, tableSet]
  · rfl

/-- A granted (agent, device) pair yields a live stamp: the consent gate is livable. -/
private def consentPair : Representation.Consent.Pair := ⟨⟨1⟩, ⟨1⟩⟩
private def ungrantedConsent : Representation.Consent.ConsentState :=
  ⟨fun _ => False, fun _ => 0⟩

theorem nonvacuous_consent_grant_is_live :
    Representation.Consent.Live
      (Representation.Consent.grant ungrantedConsent consentPair)
      ⟨consentPair, 0⟩ :=
  ⟨Or.inl rfl, rfl⟩

theorem nonvacuous_consent_revocation_blocks :
    ¬ Representation.Consent.Live
      (Representation.Consent.revoke
        (Representation.Consent.grant ungrantedConsent consentPair) consentPair)
      ⟨consentPair, 0⟩ :=
  Representation.Consent.revoke_blocks

/-- A concrete stale executor: its token carries epoch 0 after the lease moved to
    epoch 1, so mid-turn injection is refused. -/
private def injectionLease : TurnLease := ⟨⟨9⟩, some principalRef, 1, ⟨10⟩⟩
private def staleInjectionToken : LeaseToken := ⟨⟨9⟩, principalRef, 0⟩

theorem nonvacuous_midturn_stale_injection_rejected :
    ¬ injectionLease.Admits staleInjectionToken ⟨5⟩ :=
  Representation.Reaction.stale_injection_rejected (by decide)

/-! Acceptance criteria (§5.2) over the transition system. One trace opens a Run that declares
    a criterion and records the verifier's verdict against the Run's own head tree; the
    obligation is still outstanding afterwards, because nothing completes it. A second pair of
    states is the terminal Run at settlement: the same graph twice, with the same effects,
    events and audit log, differing only in which subject the one recorded verdict names. -/

private def acceptanceId : AcceptanceId := ⟨0⟩
private def acceptanceCriterion : AcceptanceCriterion := ⟨acceptanceId, header.operation⟩
private def acceptanceHead : TreeId := ⟨0⟩
private def acceptanceOtherHead : TreeId := ⟨1⟩
private def acceptanceReceipt : ReceiptId := ⟨10⟩
private def verdictAtHead : AcceptanceVerdict := ⟨acceptanceId, acceptanceHead, acceptanceReceipt⟩
private def verdictAtOther : AcceptanceVerdict :=
  ⟨acceptanceId, acceptanceOtherHead, acceptanceReceipt⟩

/-- The succeeded attempt Receipt of the criterion's own declared verifier Operation. -/
private theorem acceptanceVerifierReceipt :
    VerifierReceipt mixedEffects acceptanceReceipt header.operation .succeeded := by
  refine ⟨successReceipt, attempt0, prepared, ?_, rfl, ?_, ?_, rfl⟩
  · change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨10⟩ successReceipt)
      ⟨11⟩ failedReceipt ⟨10⟩ = some successReceipt
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..
  · change tableSet (tableSet (default : EffectLedger).attempts ⟨1⟩ attempt0)
      ⟨2⟩ attempt1 ⟨1⟩ = some attempt0
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..
  · change tableSet (default : EffectLedger).invocations invocationId prepared invocationId =
      some prepared
    exact tableSet_self ..

private theorem defaultDeclaresNoAcceptance (accId : AcceptanceId) :
    ¬ (default : GraphStore).DeclaresAcceptance accId := by
  intro ⟨candidate, criterion, member, _⟩
  simp [GraphStore.acceptanceCriteria] at member

private theorem writerGraphDeclaresNoAcceptance (accId : AcceptanceId) :
    ¬ writerGraph.DeclaresAcceptance accId := by
  intro ⟨candidate, criterion, member, _⟩
  by_cases same : candidate = runId
  · rw [same] at member
    simp [GraphStore.acceptanceCriteria, writerGraph, rootGraph, run] at member
  · simp [GraphStore.acceptanceCriteria, writerGraph, rootGraph, tableSet, same] at member

private def acceptanceRunRecord : Run :=
  ⟨tenant, workspace, agent, pins, rootCommitId, branchId, none, .active, [acceptanceCriterion]⟩
private def acceptanceRootCommit : RunCommit :=
  ⟨runId, branchId, pins, .root ⟨1⟩, [], none, .root, some acceptanceHead⟩
private def acceptanceRegistry : RunAdmissionRegistry := ⟨0, true, [.acceptance acceptanceId], []⟩
private def acceptanceOpenGraph : GraphStore := {
  (default : GraphStore) with
  runs := tableSet (default : GraphStore).runs runId acceptanceRunRecord
  branches := tableSet (default : GraphStore).branches branchId ⟨runId⟩
  commits := tableSet (default : GraphStore).commits rootCommitId acceptanceRootCommit
  heads := tableSet (default : GraphStore).heads branchId rootCommitId
  admissionRegistry := tableSet (default : GraphStore).admissionRegistry runId acceptanceRegistry
  acceptanceVerdicts := fun _ => []
}

private theorem acceptanceOpenRun : acceptanceOpenGraph.runs runId = some acceptanceRunRecord := by
  simp [acceptanceOpenGraph]
private theorem acceptanceOpenAdmission :
    acceptanceOpenGraph.admissionRegistry runId = some acceptanceRegistry := by
  simp [acceptanceOpenGraph]

private theorem acceptanceOpenStepOver (effects : EffectLedger) (audit : AuditLog)
    (cause : AuditCauseExists audit ⟨1⟩ runId) :
    GraphStep effects (default : EventStore) audit (default : GraphStore)
      (.startRun runId rootCommitId) acceptanceOpenGraph := by
  apply GraphStep.startRun (cause := ⟨1⟩)
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · simp [RunPins.Valid, acceptanceRunRecord, pins, agent]
  · simp [acceptanceRunRecord]
  · exact fun criterion _ => defaultDeclaresNoAcceptance criterion.id
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · exact cause

private theorem acceptanceOpenStep :
    GraphStep mixedEffects (default : EventStore) auditOne (default : GraphStore)
      (.startRun runId rootCommitId) acceptanceOpenGraph :=
  acceptanceOpenStepOver mixedEffects auditOne rootCause

private def acceptanceVerdictGraph : GraphStore := acceptanceOpenGraph.recordVerdict verdictAtHead

private theorem acceptanceVerdictRecorded :
    verdictAtHead ∈ acceptanceVerdictGraph.acceptanceVerdicts acceptanceId := by
  simp [acceptanceVerdictGraph, GraphStore.recordVerdict, verdictAtHead]

private theorem acceptanceOpenRetryAdmissible (accId : AcceptanceId) (subject : TreeId) :
    acceptanceOpenGraph.AcceptanceRetryAdmissible accId subject := by
  intro verdict member _
  exact absurd member (by simp [acceptanceOpenGraph, GraphStore.acceptanceVerdicts])

private theorem acceptanceVerdictStepOver {effects : EffectLedger} {audit : AuditLog}
    {verdict : AcceptanceVerdict} (named : verdict.acceptance = acceptanceId)
    (receipt : VerifierReceipt effects verdict.receipt header.operation .succeeded) :
    GraphStep effects (default : EventStore) audit acceptanceOpenGraph
      (.recordAcceptanceVerdict runId verdict) (acceptanceOpenGraph.recordVerdict verdict) := by
  apply GraphStep.recordAcceptanceVerdict (run := acceptanceRunRecord)
    (criterion := acceptanceCriterion) (registry := acceptanceRegistry) (outcome := .succeeded)
  · exact acceptanceOpenRun
  · rfl
  · simp [acceptanceRunRecord]
  · exact named.symm
  · exact acceptanceOpenAdmission
  · rfl
  · simp [acceptanceRegistry, named]
  · simp [acceptanceRegistry]
  · exact acceptanceOpenRetryAdmissible _ _
  · exact receipt

private theorem acceptanceVerdictStep :
    GraphStep mixedEffects (default : EventStore) auditOne acceptanceOpenGraph
      (.recordAcceptanceVerdict runId verdictAtHead) acceptanceVerdictGraph :=
  acceptanceVerdictStepOver rfl acceptanceVerifierReceipt

private theorem acceptanceVerdictHeadTree :
    acceptanceVerdictGraph.HeadTree runId acceptanceHead := by
  refine ⟨acceptanceRunRecord, rootCommitId, acceptanceRootCommit, ?_, ?_, ?_, rfl, rfl⟩
  · simp [acceptanceVerdictGraph, GraphStore.recordVerdict, acceptanceOpenGraph]
  · simp [acceptanceVerdictGraph, GraphStore.recordVerdict, acceptanceOpenGraph,
      acceptanceRunRecord]
  · simp [acceptanceVerdictGraph, GraphStore.recordVerdict, acceptanceOpenGraph]

/-- Opening the Run reserves exactly the criterion it declared, completes none of it, and could
    not have redeclared an identity another Run already holds. -/
theorem nonvacuous_acceptance_criteria_reserved_at_open :
    ∃ record registry, acceptanceOpenGraph.runs runId = some record ∧
      acceptanceOpenGraph.admissionRegistry runId = some registry ∧ registry.completed = [] ∧
      (record.acceptance.map AcceptanceCriterion.id).Nodup ∧
      (∀ criterion ∈ record.acceptance,
        ¬ (default : GraphStore).DeclaresAcceptance criterion.id) ∧
      ∀ obligation, obligation ∈ registry.reserved ↔
        ∃ criterion ∈ record.acceptance, OpenObligation.acceptance criterion.id = obligation :=
  run_start_reserves_exactly_declared_acceptance acceptanceOpenStep

/-- Recording the verdict binds it to the criterion's declared verifier Receipt, and the
    verdict is on the record afterwards. -/
theorem nonvacuous_acceptance_verdict_recorded :
    ∃ record criterion outcome, acceptanceOpenGraph.runs runId = some record ∧
      criterion ∈ record.acceptance ∧ criterion.id = verdictAtHead.acceptance ∧
      VerifierReceipt mixedEffects verdictAtHead.receipt criterion.operation outcome ∧
      acceptanceOpenGraph.AcceptanceRetryAdmissible verdictAtHead.acceptance
        verdictAtHead.subject ∧
      verdictAtHead ∈ acceptanceVerdictGraph.acceptanceVerdicts verdictAtHead.acceptance :=
  acceptance_verdict_step_requires_declared_verifier_receipt acceptanceVerdictStep

/-- Open, then record: a reachable graph that exercises both acceptance transitions from the
    empty graph. -/
theorem nonvacuous_acceptance_open_verdict_trace :
    GraphReachable mixedEffects (default : EventStore) auditOne (default : GraphStore)
      acceptanceVerdictGraph :=
  .step (.step (.refl _) acceptanceOpenStep) acceptanceVerdictStep

/-- All four invariants survive that trace, so none is vacuously preserved. -/
theorem nonvacuous_acceptance_invariants_along_trace :
    AcceptanceObligationsOutstanding acceptanceVerdictGraph ∧
    AcceptanceCriteriaUnique acceptanceVerdictGraph ∧
    AcceptanceVerdictsEarned acceptanceVerdictGraph mixedEffects ∧
    TerminalSnapshotsMatchRegistry acceptanceVerdictGraph :=
  ⟨graph_reachable_preserves_acceptance_outstanding empty_graph_acceptance_is_outstanding
      nonvacuous_acceptance_open_verdict_trace,
    graph_reachable_preserves_acceptance_criteria_unique empty_graph_acceptance_criteria_unique
      nonvacuous_acceptance_open_verdict_trace,
    graph_reachable_preserves_earned_verdicts empty_graph_verdicts_earned
      nonvacuous_acceptance_open_verdict_trace,
    graph_reachable_preserves_snapshot_registry_agreement empty_graph_snapshots_match_registry
      nonvacuous_acceptance_open_verdict_trace⟩

/-- The corrected semantics, on a concrete graph: the criterion is satisfied at the head the
    verdict names, and the obligation is nevertheless still reserved, still uncompleted, and
    still the whole outstanding frontier. Completing it here is what would later let the Run
    settle on a stale proof, and nothing in the model does it. -/
theorem nonvacuous_acceptance_obligation_stays_outstanding :
    AcceptanceSatisfied acceptanceVerdictGraph mixedEffects runId acceptanceId ∧
    ∃ registry, acceptanceVerdictGraph.admissionRegistry runId = some registry ∧
      OpenObligation.acceptance acceptanceId ∈ registry.reserved ∧
      OpenObligation.acceptance acceptanceId ∉ registry.completed ∧
      registry.outstanding = [.acceptance acceptanceId] := by
  refine ⟨⟨acceptanceHead, verdictAtHead, header.operation, acceptanceVerdictHeadTree,
      acceptanceVerdictRecorded, rfl, rfl, acceptanceVerifierReceipt⟩, ?_⟩
  obtain ⟨registry, registryLookup, reserved, notCompleted⟩ :=
    nonvacuous_acceptance_invariants_along_trace.1 runId acceptanceCriterion
      (by simp [GraphStore.acceptanceCriteria, acceptanceVerdictGraph, GraphStore.recordVerdict,
        acceptanceOpenGraph, acceptanceRunRecord])
  refine ⟨registry, registryLookup, reserved, notCompleted, ?_⟩
  obtain rfl : registry = acceptanceRegistry := by
    have exactly : acceptanceVerdictGraph.admissionRegistry runId = some acceptanceRegistry := by
      simp [acceptanceVerdictGraph, GraphStore.recordVerdict, acceptanceOpenGraph]
    exact Option.some.inj (registryLookup.symm.trans exactly)
  simp [acceptanceRegistry, RunAdmissionRegistry.outstanding, acceptanceCriterion]

/-- No transition can put the acceptance obligation into the completed frontier: the generic
    completion path refuses it outright, and it is the only path that writes one. -/
theorem nonvacuous_acceptance_completion_step_rejected :
    ¬ ∃ after, GraphStep mixedEffects (default : EventStore) auditOne acceptanceVerdictGraph
      (.completeObligation runId 0 (.acceptance acceptanceId)) after := by
  intro ⟨_, step⟩
  exact generic_completion_refuses_acceptance step

/-- Recording the verdict cannot have completed anything either: reservations only grew and no
    acceptance obligation appeared completed. -/
theorem nonvacuous_acceptance_verdict_step_advances_registries :
    RegistriesAdvance acceptanceOpenGraph acceptanceVerdictGraph :=
  graph_step_advances_registries acceptanceVerdictStep

/-- Once a subject holds a verdict, the recording transition against that same subject is no
    longer available: changed input, never elapsed time, unblocks the verifier. -/
theorem nonvacuous_acceptance_verdict_blocks_retry :
    ¬ acceptanceVerdictGraph.AcceptanceRetryAdmissible acceptanceId acceptanceHead :=
  acceptance_current_verdict_blocks_retry (verdict := verdictAtHead) acceptanceVerdictRecorded
    rfl rfl

theorem nonvacuous_acceptance_repeat_verdict_step_rejected :
    ¬ GraphStep mixedEffects (default : EventStore) auditOne acceptanceVerdictGraph
      (.recordAcceptanceVerdict runId verdictAtHead) acceptanceVerdictGraph :=
  recorded_verdict_blocks_repeat_verdict_step (recorded := verdictAtHead)
    acceptanceVerdictRecorded rfl rfl

/-! A verdict earned under some other Operation is not this criterion's evidence. The graph
    below is `acceptanceOpenGraph` with one field changed -- the criterion names a verifier the
    Receipt did not come from -- and the recording transition is unavailable there. -/

private def acceptanceForeignOperation : OperationId := ⟨facet, "verify", 1⟩
private def acceptanceForeignCriterion : AcceptanceCriterion :=
  ⟨acceptanceId, acceptanceForeignOperation⟩
private def acceptanceForeignRun : Run :=
  { acceptanceRunRecord with acceptance := [acceptanceForeignCriterion] }
private def acceptanceForeignGraph : GraphStore :=
  { acceptanceOpenGraph with
    runs := tableSet acceptanceOpenGraph.runs runId acceptanceForeignRun }

theorem nonvacuous_foreign_verifier_verdict_rejected :
    ¬ ∃ after, GraphStep mixedEffects (default : EventStore) auditOne acceptanceForeignGraph
      (.recordAcceptanceVerdict runId verdictAtHead) after := by
  intro ⟨_, step⟩
  obtain ⟨record, criterion, outcome, runLookup, declared, criterionId, receipt, _, _⟩ :=
    acceptance_verdict_step_requires_declared_verifier_receipt step
  obtain rfl : record = acceptanceForeignRun :=
    Option.some.inj (runLookup.symm.trans (by simp [acceptanceForeignGraph]))
  obtain rfl : criterion = acceptanceForeignCriterion := by
    simpa [acceptanceForeignRun, acceptanceRunRecord] using declared
  exact absurd (verifier_receipt_is_functional receipt acceptanceVerifierReceipt).1
    (by decide)

/-! A spawned child Run declares its own criteria, and the spawn reserves exactly those. -/

private def acceptanceChildRunId : RunId := ⟨2⟩
private def acceptanceChildBranchId : BranchId := ⟨3⟩
private def acceptanceChildRootId : CommitId := ⟨110⟩
private def acceptanceChildId : AcceptanceId := ⟨1⟩
private def acceptanceChildCriterion : AcceptanceCriterion := ⟨acceptanceChildId, header.operation⟩
private def acceptanceChildRun : Run :=
  ⟨tenant, workspace, agent, pins, acceptanceChildRootId, acceptanceChildBranchId, some runId,
    .active, [acceptanceChildCriterion]⟩
private def acceptanceChildRoot : RunCommit :=
  ⟨acceptanceChildRunId, acceptanceChildBranchId, pins, .root ⟨6⟩, [], none, .root,
    some acceptanceHead⟩
private def acceptanceChildAudit : AuditEntry :=
  ⟨.run tenant acceptanceChildRunId, 1, 7, none, .invocation invocationId⟩
private def acceptanceChildAuditLog : AuditLog := auditOne.append ⟨6⟩ acceptanceChildAudit
private def acceptanceSpawnGraph : GraphStore := {
  writerGraph with
  runs := tableSet writerGraph.runs acceptanceChildRunId acceptanceChildRun
  branches := tableSet writerGraph.branches acceptanceChildBranchId ⟨acceptanceChildRunId⟩
  commits := tableSet writerGraph.commits acceptanceChildRootId acceptanceChildRoot
  heads := tableSet writerGraph.heads acceptanceChildBranchId acceptanceChildRootId
  admissionRegistry := tableSet writerGraph.admissionRegistry acceptanceChildRunId
    ⟨0, true, [.acceptance acceptanceChildId], []⟩
}

private theorem acceptanceSpawnStep :
    GraphStep mixedEffects (default : EventStore) acceptanceChildAuditLog writerGraph
      (.spawnChild turnId acceptanceChildRunId acceptanceChildRootId) acceptanceSpawnGraph := by
  apply GraphStep.spawnChild (parent := runningTurn) (token := token) (now := ⟨1⟩)
    (child := acceptanceChildRun) (root := acceptanceChildRoot) (cause := ⟨6⟩)
  · simp [writerGraph, turnId]
  · rfl
  · rfl
  · exact ⟨rfl, rfl, rfl, by decide⟩
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · simp [acceptanceChildRun]
  · exact fun criterion _ => writerGraphDeclaresNoAcceptance criterion.id
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · rfl
  · refine ⟨acceptanceChildAudit, ?_, rfl⟩
    change tableSet auditOne.entries ⟨6⟩ acceptanceChildAudit ⟨6⟩ = some acceptanceChildAudit
    exact tableSet_self ..

/-- Spawning a child Run reserves exactly the criteria that child declared, and could not have
    redeclared an identity the parent graph already holds. -/
theorem nonvacuous_child_acceptance_criteria_reserved_at_spawn :
    ∃ record registry, acceptanceSpawnGraph.runs acceptanceChildRunId = some record ∧
      acceptanceSpawnGraph.admissionRegistry acceptanceChildRunId = some registry ∧
      registry.completed = [] ∧
      (record.acceptance.map AcceptanceCriterion.id).Nodup ∧
      (∀ criterion ∈ record.acceptance, ¬ writerGraph.DeclaresAcceptance criterion.id) ∧
      ∀ obligation, obligation ∈ registry.reserved ↔
        ∃ criterion ∈ record.acceptance, OpenObligation.acceptance criterion.id = obligation :=
  spawn_child_reserves_exactly_declared_acceptance acceptanceSpawnStep

/-! The settlement pair. `acceptanceSettlementGraph` is the already-terminal Run of
    `settledState` with one declared criterion, its own head tree, and a closed registry whose
    outstanding frontier is exactly that criterion. The two states below are that same graph
    with the same effects, events, and audit log -- they differ only in which subject the one
    recorded verdict names, so the settlement refusal is caused by the acceptance obligation
    and by nothing else. -/

private def acceptanceTerminalRun : Run :=
  { run with status := .terminal, acceptance := [acceptanceCriterion] }
private def acceptanceHeadCommit : RunCommit :=
  { rootCommit with treeCheckpoint := some acceptanceHead }
private def acceptanceTerminalSnapshot : TerminalSnapshot :=
  { terminalSnapshot with obligations := [.acceptance acceptanceId] }
private def acceptanceClosedRegistry : RunAdmissionRegistry :=
  ⟨1, false, [.acceptance acceptanceId], []⟩
private def acceptanceSettlementGraph (verdicts : List AcceptanceVerdict) : GraphStore := {
  settledGraph with
  runs := tableSet settledGraph.runs runId acceptanceTerminalRun
  commits := tableSet settledGraph.commits rootCommitId acceptanceHeadCommit
  terminalSnapshots := tableSet settledGraph.terminalSnapshots runId acceptanceTerminalSnapshot
  admissionRegistry := tableSet settledGraph.admissionRegistry runId acceptanceClosedRegistry
  acceptanceVerdicts := fun candidate => if candidate = acceptanceId then verdicts else []
}
private def acceptanceUnsettledState : SystemState :=
  { settledState with graph := acceptanceSettlementGraph [verdictAtOther] }
private def acceptanceSettledState : SystemState :=
  { settledState with graph := acceptanceSettlementGraph [verdictAtHead] }

private theorem acceptanceSettlementRun (verdicts : List AcceptanceVerdict) :
    (acceptanceSettlementGraph verdicts).runs runId = some acceptanceTerminalRun := by
  simp [acceptanceSettlementGraph]

private theorem acceptanceSettlementSnapshot (verdicts : List AcceptanceVerdict) :
    (acceptanceSettlementGraph verdicts).terminalSnapshots runId =
      some acceptanceTerminalSnapshot := by
  simp [acceptanceSettlementGraph]

private theorem acceptanceSettlementCriterion (verdicts : List AcceptanceVerdict) :
    acceptanceCriterion ∈ (acceptanceSettlementGraph verdicts).acceptanceCriteria runId := by
  simp [GraphStore.acceptanceCriteria, acceptanceSettlementRun verdicts, acceptanceTerminalRun]

private theorem acceptanceSettlementHeadTree (verdicts : List AcceptanceVerdict) :
    (acceptanceSettlementGraph verdicts).HeadTree runId acceptanceHead := by
  refine ⟨acceptanceTerminalRun, rootCommitId, acceptanceHeadCommit,
    acceptanceSettlementRun verdicts, ?_, ?_, rfl, rfl⟩
  · simp [acceptanceSettlementGraph, settledGraph, terminalBefore, rootGraph,
      acceptanceTerminalRun, run]
  · simp [acceptanceSettlementGraph]

private theorem acceptanceSettlementCoherent (verdicts : List AcceptanceVerdict) :
    ∃ record snapshot, (acceptanceSettlementGraph verdicts).runs runId = some record ∧
      record.status = .terminal ∧
      (acceptanceSettlementGraph verdicts).terminalSnapshots runId = some snapshot ∧
      snapshot.run = runId ∧
      TerminalSnapshotCoherent (acceptanceSettlementGraph verdicts) snapshot := by
  refine ⟨acceptanceTerminalRun, acceptanceTerminalSnapshot, acceptanceSettlementRun verdicts,
    rfl, acceptanceSettlementSnapshot verdicts, rfl, acceptanceTerminalRun,
    { runningTurn with status := .succeeded }, terminalCommit, ?_, rfl, ?_, rfl, ?_, rfl, rfl,
    rfl, rfl⟩
  · exact acceptanceSettlementRun verdicts
  · simp [acceptanceSettlementGraph, settledGraph, acceptanceTerminalSnapshot, terminalSnapshot]
  · simp [acceptanceSettlementGraph, settledGraph, acceptanceTerminalSnapshot, terminalSnapshot,
      terminalCommitId, rootCommitId, terminalBefore, rootGraph, tableSet]

/-- A stale verdict (subject ≠ current head) does not satisfy the criterion, though a succeeded
    verifier Receipt backs it: the head has moved past what any verdict names. -/
theorem nonvacuous_acceptance_verdict_wrong_subject :
    ¬ AcceptanceSatisfied acceptanceUnsettledState.graph
      acceptanceUnsettledState.effects runId acceptanceId := by
  apply acceptance_verdict_only_for_its_subject (subject := acceptanceHead)
    (acceptanceSettlementHeadTree _)
  intro verdict member _
  have exactly : verdict = verdictAtOther := by
    simpa [acceptanceUnsettledState, acceptanceSettlementGraph] using member
  subst exactly
  decide

/-- The unsatisfied acceptance obligation is captured in the terminal snapshot, so the Run is
    genuinely not Settled. -/
theorem nonvacuous_unsatisfied_acceptance_blocks_settled :
    ¬ Settled acceptanceUnsettledState runId :=
  acceptance_unsatisfied_not_settled (snapshot := acceptanceTerminalSnapshot)
    (acceptanceSettlementSnapshot _) (by simp [acceptanceTerminalSnapshot])
    nonvacuous_acceptance_verdict_wrong_subject

/-- A verdict naming exactly the current head, backed by a succeeded Receipt, satisfies the
    criterion. -/
theorem nonvacuous_acceptance_satisfied_at_head :
    AcceptanceSatisfied acceptanceSettledState.graph acceptanceSettledState.effects
      runId acceptanceId :=
  ⟨acceptanceHead, verdictAtHead, header.operation, acceptanceSettlementHeadTree _,
    by simp [acceptanceSettledState, acceptanceSettlementGraph], rfl, rfl,
    acceptanceVerifierReceipt⟩

/-- The same graph with the current verdict is Settled. Since the two states differ only in
    the recorded verdict list, the refusal above is caused by the acceptance obligation
    alone. -/
theorem nonvacuous_acceptance_verdict_settles_run : Settled acceptanceSettledState runId := by
  refine ⟨acceptanceSettlementCoherent _, nonvacuous_audit_complete_derived_settled.2.1,
    nonvacuous_audit_complete_derived_settled.2.2.1,
    nonvacuous_audit_complete_derived_settled.2.2.2.1, ?_,
    nonvacuous_audit_complete_derived_settled.2.2.2.2.2⟩
  intro snapshot snapshotLookup obligation member
  obtain rfl : snapshot = acceptanceTerminalSnapshot :=
    Option.some.inj (snapshotLookup.symm.trans (acceptanceSettlementSnapshot [verdictAtHead]))
  have exactly : obligation = .acceptance acceptanceId := by
    simpa [acceptanceTerminalSnapshot] using member
  subst exactly
  exact nonvacuous_acceptance_satisfied_at_head

/-- The four invariants hold of the settled state, so the settlement theorem's hypotheses are
    jointly satisfiable rather than vacuous. -/
theorem nonvacuous_acceptance_settlement_invariants :
    AcceptanceObligationsOutstanding acceptanceSettledState.graph ∧
    AcceptanceCriteriaUnique acceptanceSettledState.graph ∧
    AcceptanceVerdictsEarned acceptanceSettledState.graph acceptanceSettledState.effects ∧
    TerminalSnapshotsMatchRegistry acceptanceSettledState.graph := by
  have criteria : ∀ candidate criterion,
      criterion ∈ acceptanceSettledState.graph.acceptanceCriteria candidate →
        candidate = runId ∧ criterion = acceptanceCriterion := by
    intro candidate criterion declared
    by_cases same : candidate = runId
    · refine ⟨same, ?_⟩
      rw [same] at declared
      simpa [GraphStore.acceptanceCriteria, acceptanceSettledState,
        acceptanceSettlementRun [verdictAtHead], acceptanceTerminalRun] using declared
    · exact absurd declared (by
        simp [GraphStore.acceptanceCriteria, acceptanceSettledState, acceptanceSettlementGraph,
          settledGraph, terminalBefore, rootGraph, tableSet_other _ _ _ same, same])
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro candidate criterion declared
    obtain ⟨rfl, rfl⟩ := criteria candidate criterion declared
    exact ⟨acceptanceClosedRegistry, by simp [acceptanceSettledState, acceptanceSettlementGraph],
      by simp [acceptanceClosedRegistry, acceptanceCriterion],
      by simp [acceptanceClosedRegistry]⟩
  · intro leftRun rightRun left right leftMem rightMem _
    obtain ⟨_, rfl⟩ := criteria leftRun left leftMem
    obtain ⟨_, rfl⟩ := criteria rightRun right rightMem
    rfl
  · intro accId verdict member
    by_cases same : accId = acceptanceId
    · rw [same] at member
      obtain rfl : verdict = verdictAtHead := by
        simpa [acceptanceSettledState, acceptanceSettlementGraph] using member
      exact ⟨runId, acceptanceCriterion, .succeeded, acceptanceSettlementCriterion _,
        by rw [same]; rfl, acceptanceVerifierReceipt⟩
    · exact absurd member
        (by simp [acceptanceSettledState, acceptanceSettlementGraph, same])
  · intro candidate snapshot snapshotLookup
    by_cases same : candidate = runId
    · rw [same] at snapshotLookup ⊢
      obtain rfl : snapshot = acceptanceTerminalSnapshot :=
        Option.some.inj (snapshotLookup.symm.trans (acceptanceSettlementSnapshot [verdictAtHead]))
      refine ⟨acceptanceClosedRegistry, by simp [acceptanceSettledState, acceptanceSettlementGraph],
        rfl, fun obligation => ?_⟩
      simp [acceptanceTerminalSnapshot, acceptanceClosedRegistry]
    · exact absurd snapshotLookup (by
        simp [acceptanceSettledState, acceptanceSettlementGraph, settledGraph, terminalBefore,
          rootGraph, tableSet_other _ _ _ same, same])

/-- The headline settlement property on a concrete Settled Run: its one declared criterion
    holds a recorded verdict whose subject is the Run's current head tree, whose Receipt
    succeeded, and whose Operation is the criterion's own declared verifier. -/
theorem nonvacuous_settled_acceptance_holds_at_current_head :
    ∃ subject verdict,
      acceptanceSettledState.graph.HeadTree runId subject ∧
      verdict ∈ acceptanceSettledState.graph.acceptanceVerdicts acceptanceCriterion.id ∧
      verdict.acceptance = acceptanceCriterion.id ∧ verdict.subject = subject ∧
      VerifierReceipt acceptanceSettledState.effects verdict.receipt
        acceptanceCriterion.operation .succeeded :=
  settled_run_acceptance_holds_at_current_head nonvacuous_acceptance_settlement_invariants.1
    nonvacuous_acceptance_settlement_invariants.2.1
    nonvacuous_acceptance_settlement_invariants.2.2.1
    nonvacuous_acceptance_settlement_invariants.2.2.2
    (acceptanceSettlementCriterion _) nonvacuous_acceptance_verdict_settles_run


/-! Undo as append-only selection (§5.2). One branch, one Turn, four transitions: append a
    message, refuse the undo while the Turn still holds the branch, fence the Turn, then append
    the undo and its redo. The refusal and the acceptance differ in exactly one thing -- whether
    the Turn's lease still names a holder -- and the lease is already expired at the instant the
    undo is refused, so it is the fence and not the clock that unblocks it. -/

private def undoMessageId : CommitId := ⟨200⟩
private def undoCommitId : CommitId := ⟨201⟩
private def redoCommitId : CommitId := ⟨202⟩
private def undoCommit : RunCommit :=
  ⟨runId, branchId, pins, .system (.control ⟨34⟩ ⟨30⟩), [undoMessageId], none,
    .undo rootCommitId ⟨30⟩, none⟩
private def redoCommit : RunCommit :=
  ⟨runId, branchId, pins, .system (.control ⟨34⟩ ⟨30⟩), [undoCommitId], none,
    .undo undoMessageId ⟨30⟩, none⟩
private def undoAfterMessage : GraphStore := writerGraph.append undoMessageId messageCommit
private def undoFencedTurn : Turn :=
  runningTurn.withStatusLease .suspended ⟨turnId, none, 2, ⟨10⟩⟩
private def undoFenced : GraphStore :=
  { undoAfterMessage with turns := tableSet undoAfterMessage.turns turnId undoFencedTurn }
private def undoApplied : GraphStore := undoFenced.append undoCommitId undoCommit
private def undoRedone : GraphStore := undoApplied.append redoCommitId redoCommit

private theorem writerGraphRun : writerGraph.runs runId = some run := by
  change tableSet (default : GraphStore).runs runId run runId = some run
  exact tableSet_self ..

private theorem writerGraphBranch : writerGraph.branches branchId = some ⟨runId⟩ := by
  change tableSet (default : GraphStore).branches branchId (⟨runId⟩ : RunBranch) branchId =
    some ⟨runId⟩
  exact tableSet_self ..

private theorem writerGraphHead : writerGraph.heads branchId = some rootCommitId := by
  change tableSet (default : GraphStore).heads branchId rootCommitId branchId = some rootCommitId
  exact tableSet_self ..

private theorem writerGraphTurn : writerGraph.turns turnId = some runningTurn := by
  change tableSet (default : GraphStore).turns turnId runningTurn turnId = some runningTurn
  exact tableSet_self ..

private theorem writerGraphRoot : writerGraph.commits rootCommitId = some rootCommit := by
  change tableSet (default : GraphStore).commits rootCommitId rootCommit rootCommitId =
    some rootCommit
  exact tableSet_self ..

private theorem writerGraphFresh (id : CommitId) (different : id ≠ rootCommitId) :
    writerGraph.commits id = none := by
  change tableSet (default : GraphStore).commits rootCommitId rootCommit id = none
  rw [tableSet_other _ _ _ different]
  rfl

private theorem undoMessageTurn : undoAfterMessage.turns turnId = some runningTurn := writerGraphTurn

private theorem undoMessageStored : undoAfterMessage.commits undoMessageId = some messageCommit := by
  change tableSet writerGraph.commits undoMessageId messageCommit undoMessageId =
    some messageCommit
  exact tableSet_self ..

private theorem undoRootStored : undoAfterMessage.commits rootCommitId = some rootCommit := by
  change tableSet writerGraph.commits undoMessageId messageCommit rootCommitId = some rootCommit
  rw [tableSet_other _ _ _ (by decide)]
  exact writerGraphRoot

private theorem undoMessageHead : undoAfterMessage.heads branchId = some undoMessageId := by
  change tableSet writerGraph.heads messageCommit.branch undoMessageId branchId =
    some undoMessageId
  exact tableSet_self ..

private theorem undoAfterMessageFresh (id : CommitId) (fromRoot : id ≠ rootCommitId)
    (fromMessage : id ≠ undoMessageId) : undoAfterMessage.commits id = none := by
  change tableSet writerGraph.commits undoMessageId messageCommit id = none
  rw [tableSet_other _ _ _ fromMessage]
  exact writerGraphFresh id fromRoot

private theorem undoFencedHead : undoFenced.heads branchId = some undoMessageId := undoMessageHead

private theorem undoFencedMessageStored :
    undoFenced.commits undoMessageId = some messageCommit := undoMessageStored

private theorem undoFencedFresh : undoFenced.commits undoCommitId = none :=
  undoAfterMessageFresh undoCommitId (by decide) (by decide)

private theorem undoAppliedHead : undoApplied.heads branchId = some undoCommitId := by
  change tableSet undoFenced.heads undoCommit.branch undoCommitId branchId = some undoCommitId
  exact tableSet_self ..

private theorem undoAppliedStored : undoApplied.commits undoCommitId = some undoCommit := by
  change tableSet undoFenced.commits undoCommitId undoCommit undoCommitId = some undoCommit
  exact tableSet_self ..

private theorem undoAppliedMessageStored :
    undoApplied.commits undoMessageId = some messageCommit := by
  change tableSet undoFenced.commits undoCommitId undoCommit undoMessageId = some messageCommit
  rw [tableSet_other _ _ _ (by decide)]
  exact undoMessageStored

private theorem undoAppliedFresh : undoApplied.commits redoCommitId = none := by
  change tableSet undoFenced.commits undoCommitId undoCommit redoCommitId = none
  rw [tableSet_other _ _ _ (by decide)]
  exact undoAfterMessageFresh redoCommitId (by decide) (by decide)

private theorem undoMessageAllowed :
    CommitAllowed writerGraph synthesisEffects (default : EventStore) terminalAuditLog ⟨1⟩
      messageCommit :=
  ⟨⟨rootCommitId, rootCommit, rfl, writerGraphRoot, rfl⟩,
    ⟨runningTurn, writerGraphTurn, rfl, rfl, rfl, rfl, ⟨rfl, rfl, rfl, by decide⟩,
      ⟨rootAudit, by simp [terminalAuditLog, synthesisAuditLog, auditOne], rfl⟩⟩,
    rfl⟩

private theorem undoControlAudit {store : GraphStore} (runLookup : store.runs runId = some run) :
    ControlCommitAudit store synthesisEffects terminalAuditLog ⟨34⟩ ⟨30⟩ synthesisOperation
      runId := by
  refine ⟨run, controlCommitAuditEntry, controlReceipt, controlAttempt, controlPrepared,
    runLookup, terminalControlAuditEntry, rfl, ?_, rfl, ?_, ?_, rfl, rfl, ⟨tenant, rfl⟩, rfl⟩
  · change tableSet (tableSet (default : EffectLedger).attemptReceipts ⟨30⟩ controlReceipt)
      ⟨31⟩ synthesisReceipt ⟨30⟩ = some controlReceipt
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..
  · change tableSet (tableSet (default : EffectLedger).attempts ⟨30⟩ controlAttempt)
      ⟨31⟩ synthesisAttempt ⟨30⟩ = some controlAttempt
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..
  · change tableSet
      (tableSet (default : EffectLedger).invocations controlInvocation controlPrepared)
      synthesisInvocation synthesisPrepared controlInvocation = some controlPrepared
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..

private theorem fencedBranchUnheld (store : GraphStore)
    (turns : ∀ candidate, store.turns candidate = undoFenced.turns candidate) :
    BranchUnheld store runId branchId := by
  intro candidate held
  obtain ⟨record, lookup, _, _, running, _⟩ := held
  rw [turns candidate] at lookup
  by_cases same : candidate = turnId
  · subst same
    change tableSet undoAfterMessage.turns turnId undoFencedTurn turnId = some record at lookup
    rw [tableSet_self] at lookup
    cases Option.some.inj lookup
    exact absurd running (by decide)
  · change tableSet undoAfterMessage.turns turnId undoFencedTurn candidate = some record at lookup
    rw [tableSet_other _ _ _ same] at lookup
    change tableSet (default : GraphStore).turns turnId runningTurn candidate = some record at lookup
    rw [tableSet_other _ _ _ same] at lookup
    exact Option.noConfusion lookup

private theorem undoAllowed {store : GraphStore} {selected parent : CommitId}
    {parentRecord : RunCommit}
    (runLookup : store.runs runId = some run)
    (turns : ∀ candidate, store.turns candidate = undoFenced.turns candidate)
    (parentLookup : store.commits parent = some parentRecord)
    (parentPins : parentRecord.pins = pins)
    (ancestry : Ancestor store selected parent) :
    CommitAllowed store synthesisEffects (default : EventStore) terminalAuditLog ⟨1⟩
      ⟨runId, branchId, pins, .system (.control ⟨34⟩ ⟨30⟩), [parent], none,
        .undo selected ⟨30⟩, none⟩ :=
  ⟨rfl, ⟨parent, parentRecord, rfl, parentLookup, parentPins.symm⟩,
    ⟨synthesisOperation, undoControlAudit runLookup, controlSuccess⟩,
    fencedBranchUnheld _ turns, parent, List.mem_singleton.mpr rfl, ancestry⟩

/-- The Turn holds the branch and its lease has already expired -- it admits no token at all --
    and the undo is refused anyway, under every label and every `now`. Without the fence
    precondition this step would be available, so the refusal is that precondition's doing. -/
theorem nonvacuous_expired_held_turn_blocks_undo :
    (∀ token, ¬ runningTurn.lease.Admits token ⟨20⟩) ∧
    BranchHeldBy undoAfterMessage runId branchId turnId ∧
    ¬ ∃ label after, GraphStep synthesisEffects (default : EventStore) terminalAuditLog
      undoAfterMessage label after ∧ after.commits undoCommitId = some undoCommit := by
  obtain ⟨expired, held⟩ :=
    expired_lease_still_holds_branch (store := undoAfterMessage) (run := runId)
      (branch := branchId) (record := runningTurn) (now := ⟨20⟩) undoMessageTurn rfl rfl rfl
      (by decide) (by decide)
  refine ⟨expired, held, ?_⟩
  intro ⟨label, after, step, introduced⟩
  exact undo_fences_held_turn step (undoAfterMessageFresh undoCommitId (by decide) (by decide))
    introduced rfl held

/-- The whole trace: append a message, fence the Turn that held the branch, then append the undo
    and its redo. Fencing is the only thing that changed between the refusal above and the third
    step here. -/
theorem nonvacuous_fenced_undo_redo_trace :
    GraphStep synthesisEffects (default : EventStore) terminalAuditLog writerGraph
      (.append undoMessageId rootCommitId messageCommit) undoAfterMessage ∧
    GraphStep synthesisEffects (default : EventStore) terminalAuditLog undoAfterMessage
      (.suspendTurn turnId) undoFenced ∧
    GraphStep synthesisEffects (default : EventStore) terminalAuditLog undoFenced
      (.append undoCommitId undoMessageId undoCommit) undoApplied ∧
    GraphStep synthesisEffects (default : EventStore) terminalAuditLog undoApplied
      (.append redoCommitId undoCommitId redoCommit) undoRedone := by
  refine ⟨?_, ?_, ?_, ?_⟩
  · exact GraphStep.append (run := run) (branch := ⟨runId⟩) (now := ⟨1⟩)
      (writerGraphFresh undoMessageId (by decide)) writerGraphRun rfl writerGraphBranch rfl
      writerGraphHead
      (fun parent member => ⟨rootCommit, by
        rw [List.mem_singleton.mp member]; exact writerGraphRoot, rfl⟩)
      rfl undoMessageAllowed
  · exact GraphStep.suspendTurn (turn := runningTurn) undoMessageTurn rfl .suspendFence
  · exact GraphStep.append (run := run) (branch := ⟨runId⟩) (now := ⟨1⟩)
      undoFencedFresh writerGraphRun rfl writerGraphBranch rfl undoFencedHead
      (fun parent member => ⟨messageCommit, by
        rw [List.mem_singleton.mp member]; exact undoFencedMessageStored, rfl⟩)
      rfl
      (undoAllowed writerGraphRun (fun _ => rfl) undoFencedMessageStored rfl
        (.parent undoFencedMessageStored (List.mem_singleton.mpr rfl) (.refl undoRootStored)))
  · exact GraphStep.append (run := run) (branch := ⟨runId⟩) (now := ⟨1⟩)
      undoAppliedFresh writerGraphRun rfl writerGraphBranch rfl undoAppliedHead
      (fun parent member => ⟨undoCommit, by
        rw [List.mem_singleton.mp member]; exact undoAppliedStored, rfl⟩)
      rfl
      (undoAllowed writerGraphRun (fun _ => rfl) undoAppliedStored rfl
        (.parent undoAppliedStored (List.mem_singleton.mpr rfl) (.refl undoAppliedMessageStored)))

/-- Selection, not rewind. The undo advances the head to itself while the branch's effective
    state becomes the ancestor it selected; the redo puts the effective state back; and every
    commit ever written -- root, message, undo, redo -- is still in the graph, with the head it
    replaced and the commit it selected both still ancestors of the head. -/
theorem nonvacuous_undo_selects_ancestor_and_redo_restores :
    GraphReachable synthesisEffects (default : EventStore) terminalAuditLog writerGraph
      undoRedone ∧
    undoFenced.effectiveState branchId = some undoMessageId ∧
    undoApplied.heads branchId = some undoCommitId ∧
    undoApplied.effectiveState branchId = some rootCommitId ∧
    undoRedone.effectiveState branchId = undoFenced.effectiveState branchId ∧
    undoRedone.commits rootCommitId = some rootCommit ∧
    undoRedone.commits undoMessageId = some messageCommit ∧
    Ancestor undoApplied rootCommitId undoCommitId ∧
    Ancestor undoApplied undoMessageId undoCommitId := by
  have priorEffective : undoFenced.effectiveState branchId = some undoMessageId := by
    simp [GraphStore.effectiveState, undoFencedHead, undoFencedMessageStored, messageCommit]
  obtain ⟨messageStep, fenceStep, undoStep, redoStep⟩ := nonvacuous_fenced_undo_redo_trace
  obtain ⟨head, effective⟩ := undo_selects_effective_state undoStep (selected := rootCommitId) rfl
  obtain ⟨growth, _, _, priorHead, selectedAncestor⟩ :=
    undo_keeps_prior_head_reachable undoStep (selected := rootCommitId) rfl
  obtain ⟨_, restored, _⟩ :=
    undo_then_redo_restores_effective_state (selected := rootCommitId) (redoReceipt := ⟨30⟩)
      priorEffective undoStep rfl redoStep rfl rfl
  exact ⟨.step (.step (.step (.step (.refl _) messageStep) fenceStep) undoStep) redoStep,
    priorEffective, head, effective, restored,
    graph_reachable_preserves_commits
      (.step (.step (.step (.step (.refl _) messageStep) fenceStep) undoStep) redoStep)
      writerGraphRoot,
    graph_step_preserves_commits redoStep (growth _ _ undoMessageStored),
    selectedAncestor, priorHead⟩


/-! A Settled Run reached from the empty graph. Every settlement claim so far has had either a
    reachable-graph witness or a `Settled`-state witness, never one object that is both: the
    terminal fixtures planted `terminalizing` without an administer control Receipt behind it.
    The trace below plants nothing. It opens a Run that declares an acceptance criterion,
    records the verifier's verdict, reserves an item obligation, starts and claims the Turn,
    begins terminalization against a real succeeded administer Receipt carrying its own audit
    chain, and terminalizes -- seven `GraphStep`s from `default`. It is parameterised by the
    subject the one verdict names, so the same trace produces a Settled Run and an unsettled
    one. -/

private def reachVerifyInvocation : InvocationId := ⟨70⟩
private def reachControlInvocation : InvocationId := ⟨71⟩
private def reachControlOperation : OperationId := ⟨facet, "terminalize", 1⟩
private def reachVerifyHeader : InvocationHeader :=
  { header with invocation := reachVerifyInvocation, auditCause := ⟨1⟩ }
private def reachControlHeader : InvocationHeader :=
  { header with
    invocation := reachControlInvocation, operation := reachControlOperation,
    impact := .administer, lease := none, auditCause := ⟨4⟩ }
private def reachVerifyPrepared : PreparedInvocation := ⟨reachVerifyHeader, .single firstArgs⟩
private def reachControlPrepared : PreparedInvocation := ⟨reachControlHeader, .single firstArgs⟩
private def reachVerifyKey : ItemKey :=
  deriveItemKey reachVerifyHeader reachVerifyPrepared.payload 0 firstArgs
private def reachControlKey : ItemKey :=
  deriveItemKey reachControlHeader reachControlPrepared.payload 0 firstArgs
private def reachVerifyAttemptId : AttemptId := ⟨70⟩
private def reachControlAttemptId : AttemptId := ⟨71⟩
private def reachVerifyReceiptId : ReceiptId := ⟨70⟩
private def reachControlReceiptId : ReceiptId := ⟨71⟩
private def reachVerifyAttempt : EffectAttempt :=
  ⟨reachVerifyInvocation, 0, 0, ⟨70⟩, ⟨1⟩, reachVerifyKey, some token, ⟨1⟩⟩
private def reachControlAttempt : EffectAttempt :=
  ⟨reachControlInvocation, 0, 0, ⟨71⟩, ⟨4⟩, reachControlKey, none, ⟨1⟩⟩
private def reachVerifyReceipt : AttemptReceipt := ⟨reachVerifyAttemptId, .succeeded, none⟩
private def reachControlReceipt : AttemptReceipt := ⟨reachControlAttemptId, .succeeded, none⟩

private def reachEffects : EffectLedger := {
  (default : EffectLedger) with
  invocations := fun id =>
    if id = reachVerifyInvocation then some reachVerifyPrepared
    else if id = reachControlInvocation then some reachControlPrepared else none
  attempts := fun id =>
    if id = reachVerifyAttemptId then some reachVerifyAttempt
    else if id = reachControlAttemptId then some reachControlAttempt else none
  attemptReceipts := fun id =>
    if id = reachVerifyReceiptId then some reachVerifyReceipt
    else if id = reachControlReceiptId then some reachControlReceipt else none
  latestAttempt := fun invocation index =>
    if invocation = reachVerifyInvocation ∧ index = 0 then some reachVerifyAttemptId
    else if invocation = reachControlInvocation ∧ index = 0 then some reachControlAttemptId
    else none
  currentReceipt := fun invocation index =>
    if invocation = reachVerifyInvocation ∧ index = 0 then some (.attempt reachVerifyReceiptId)
    else if invocation = reachControlInvocation ∧ index = 0 then
      some (.attempt reachControlReceiptId)
    else none
}

private def reachRunActor : ActorRef := .run tenant runId
private def reachVerifyInvocationAudit : AuditEntry :=
  ⟨reachRunActor, 1, 7, none, .invocation reachVerifyInvocation⟩
private def reachVerifyAttemptAudit : AuditEntry :=
  ⟨reachRunActor, 2, 7, some ⟨1⟩, .attempt reachVerifyAttemptId reachVerifyInvocation⟩
private def reachVerifyReceiptAudit : AuditEntry :=
  ⟨reachRunActor, 3, 7, some ⟨2⟩,
    .attemptReceipt reachVerifyReceiptId reachVerifyAttemptId reachVerifyInvocation .succeeded⟩
private def reachControlInvocationAudit : AuditEntry :=
  ⟨reachRunActor, 4, 8, none, .invocation reachControlInvocation⟩
private def reachControlAttemptAudit : AuditEntry :=
  ⟨reachRunActor, 5, 8, some ⟨4⟩, .attempt reachControlAttemptId reachControlInvocation⟩
private def reachControlReceiptAudit : AuditEntry :=
  ⟨reachRunActor, 6, 8, some ⟨5⟩,
    .attemptReceipt reachControlReceiptId reachControlAttemptId reachControlInvocation .succeeded⟩

private def reachAudit : AuditLog := {
  entries := fun id =>
    if id = ⟨1⟩ then some reachVerifyInvocationAudit
    else if id = ⟨2⟩ then some reachVerifyAttemptAudit
    else if id = ⟨3⟩ then some reachVerifyReceiptAudit
    else if id = ⟨4⟩ then some reachControlInvocationAudit
    else if id = ⟨5⟩ then some reachControlAttemptAudit
    else if id = ⟨6⟩ then some reachControlReceiptAudit
    else none
  atSequence := fun actor sequence =>
    if actor = reachRunActor then
      if sequence = 1 then some ⟨1⟩ else if sequence = 2 then some ⟨2⟩
      else if sequence = 3 then some ⟨3⟩ else if sequence = 4 then some ⟨4⟩
      else if sequence = 5 then some ⟨5⟩ else if sequence = 6 then some ⟨6⟩ else none
    else none
}

private theorem reachAuditVerifyInvocation :
    reachAudit.entries ⟨1⟩ = some reachVerifyInvocationAudit := by simp [reachAudit]
private theorem reachAuditVerifyAttempt :
    reachAudit.entries ⟨2⟩ = some reachVerifyAttemptAudit := by simp [reachAudit]
private theorem reachAuditVerifyReceipt :
    reachAudit.entries ⟨3⟩ = some reachVerifyReceiptAudit := by simp [reachAudit]
private theorem reachAuditControlInvocation :
    reachAudit.entries ⟨4⟩ = some reachControlInvocationAudit := by simp [reachAudit]
private theorem reachAuditControlAttempt :
    reachAudit.entries ⟨5⟩ = some reachControlAttemptAudit := by simp [reachAudit]
private theorem reachAuditControlReceipt :
    reachAudit.entries ⟨6⟩ = some reachControlReceiptAudit := by simp [reachAudit]

private theorem reachVerifyReceiptLookup :
    reachEffects.attemptReceipts reachVerifyReceiptId = some reachVerifyReceipt := by
  simp [reachEffects]
private theorem reachControlReceiptLookup :
    reachEffects.attemptReceipts reachControlReceiptId = some reachControlReceipt := by
  simp [reachEffects, reachVerifyReceiptId, reachControlReceiptId]
private theorem reachVerifyAttemptLookup :
    reachEffects.attempts reachVerifyAttemptId = some reachVerifyAttempt := by simp [reachEffects]
private theorem reachControlAttemptLookup :
    reachEffects.attempts reachControlAttemptId = some reachControlAttempt := by
  simp [reachEffects, reachVerifyAttemptId, reachControlAttemptId]
private theorem reachVerifyPreparedLookup :
    reachEffects.invocations reachVerifyInvocation = some reachVerifyPrepared := by
  simp [reachEffects]
private theorem reachControlPreparedLookup :
    reachEffects.invocations reachControlInvocation = some reachControlPrepared := by
  simp [reachEffects, reachVerifyInvocation, reachControlInvocation]
private theorem reachVerifyCurrent :
    reachEffects.currentReceipt reachVerifyInvocation 0 = some (.attempt reachVerifyReceiptId) := by
  simp [reachEffects]
private theorem reachControlCurrent :
    reachEffects.currentReceipt reachControlInvocation 0 =
      some (.attempt reachControlReceiptId) := by
  simp [reachEffects, reachVerifyInvocation, reachControlInvocation]
private theorem reachVerifyLatest :
    reachEffects.latestAttempt reachVerifyInvocation 0 = some reachVerifyAttemptId := by
  simp [reachEffects]
private theorem reachControlLatest :
    reachEffects.latestAttempt reachControlInvocation 0 = some reachControlAttemptId := by
  simp [reachEffects, reachVerifyInvocation, reachControlInvocation]

/-- The verdict Receipt is a succeeded attempted Receipt of the criterion's own verifier. -/
private theorem reachVerifierReceipt :
    VerifierReceipt reachEffects reachVerifyReceiptId header.operation .succeeded :=
  ⟨reachVerifyReceipt, reachVerifyAttempt, reachVerifyPrepared, reachVerifyReceiptLookup, rfl,
    reachVerifyAttemptLookup, reachVerifyPreparedLookup, rfl⟩

/-- The terminalization control is a genuine succeeded `administer` Receipt in the Run's own
    domain, with the typed audit entry that names it. -/
private theorem reachControlSuccess :
    SuccessfulControl reachEffects reachControlReceiptId reachControlOperation runId :=
  ⟨reachControlReceipt, reachControlAttempt, reachControlPrepared, reachControlReceiptLookup, rfl,
    reachControlAttemptLookup, reachControlPreparedLookup, rfl, rfl, ⟨tenant, rfl⟩⟩

private def reachControl : TerminalizationControl := ⟨turnId, reachControlReceiptId, ⟨6⟩⟩

private theorem reachControlValid :
    TerminalizationControl.Valid reachEffects reachAudit runId reachControl :=
  ⟨reachControlOperation, reachControlReceipt, reachControlAttempt, reachControlPrepared,
    reachControlReceiptAudit, reachControlSuccess, reachAuditControlReceipt,
    reachControlReceiptLookup, reachControlAttemptLookup, reachControlPreparedLookup, rfl⟩

private theorem reachRootCause : AuditCauseExists reachAudit ⟨1⟩ runId :=
  ⟨reachVerifyInvocationAudit, reachAuditVerifyInvocation, rfl⟩

private theorem reachVerifyChain : CausalChain (default : EventStore) reachAudit ⟨3⟩ :=
  .child (entry := reachVerifyReceiptAudit) (parent := ⟨2⟩)
    (parentEntry := reachVerifyAttemptAudit) reachAuditVerifyReceipt rfl reachAuditVerifyAttempt
    rfl (by decide) rfl ⟨rfl, rfl⟩
    (.child (entry := reachVerifyAttemptAudit) (parent := ⟨1⟩)
      (parentEntry := reachVerifyInvocationAudit) reachAuditVerifyAttempt rfl
      reachAuditVerifyInvocation rfl (by decide) rfl rfl
      (.root (entry := reachVerifyInvocationAudit) reachAuditVerifyInvocation rfl trivial))

private theorem reachControlChain : CausalChain (default : EventStore) reachAudit ⟨6⟩ :=
  .child (entry := reachControlReceiptAudit) (parent := ⟨5⟩)
    (parentEntry := reachControlAttemptAudit) reachAuditControlReceipt rfl reachAuditControlAttempt
    rfl (by decide) rfl ⟨rfl, rfl⟩
    (.child (entry := reachControlAttemptAudit) (parent := ⟨4⟩)
      (parentEntry := reachControlInvocationAudit) reachAuditControlAttempt rfl
      reachAuditControlInvocation rfl (by decide) rfl rfl
      (.root (entry := reachControlInvocationAudit) reachAuditControlInvocation rfl trivial))

private def reachItemObligation : OpenObligation := .item reachVerifyInvocation 0 reachVerifyKey
private def reachReservedRegistry : RunAdmissionRegistry :=
  ⟨0, true, [.acceptance acceptanceId, reachItemObligation], []⟩
private def reachVerdict (subject : TreeId) : AcceptanceVerdict :=
  ⟨acceptanceId, subject, reachVerifyReceiptId⟩
private def reachVerdictGraph (subject : TreeId) : GraphStore :=
  acceptanceOpenGraph.recordVerdict (reachVerdict subject)
private def reachReservedGraph (subject : TreeId) : GraphStore :=
  (reachVerdictGraph subject).reserve runId acceptanceRegistry reachItemObligation
private def reachQueuedTurn : Turn := ⟨runId, branchId, turnPins, .queued, TurnLease.initial turnId⟩
private def reachQueuedGraph (subject : TreeId) : GraphStore :=
  { reachReservedGraph subject with
    turns := tableSet (reachReservedGraph subject).turns turnId reachQueuedTurn }
private def reachRunningGraph (subject : TreeId) : GraphStore :=
  { reachQueuedGraph subject with
    turns := tableSet (reachQueuedGraph subject).turns turnId runningTurn }
private def reachTerminalizingGraph (subject : TreeId) : GraphStore :=
  { reachRunningGraph subject with
    terminalizing := tableSet (reachRunningGraph subject).terminalizing runId reachControl }
private def reachTerminalCommitId : CommitId := ⟨101⟩
private def reachTerminalCommit : RunCommit :=
  ⟨runId, branchId, pins, .turn token ⟨1⟩, [rootCommitId], some turnId, .terminal .succeeded,
    some acceptanceHead⟩
private def reachTerminalRun : Run := { acceptanceRunRecord with status := .terminal }
private def reachTerminalTurn : Turn :=
  runningTurn.withStatusLease .succeeded ⟨turnId, none, 2, ⟨10⟩⟩
private def reachSnapshot : TerminalSnapshot :=
  ⟨runId, turnId, rootCommitId, reachTerminalCommitId, .succeeded, 0,
    reachReservedRegistry.outstanding⟩
private def reachSettledGraph (subject : TreeId) : GraphStore := {
  ((reachTerminalizingGraph subject).append reachTerminalCommitId reachTerminalCommit) with
  runs := tableSet (reachTerminalizingGraph subject).runs runId reachTerminalRun
  turns := tableSet (reachTerminalizingGraph subject).turns turnId reachTerminalTurn
  terminalSnapshots :=
    tableSet (reachTerminalizingGraph subject).terminalSnapshots runId reachSnapshot
  admissionRegistry :=
    tableSet (reachTerminalizingGraph subject).admissionRegistry runId reachReservedRegistry.close
  terminalizing := fun candidate =>
    if candidate = runId then none else (reachTerminalizingGraph subject).terminalizing candidate }
private def reachState (subject : TreeId) : SystemState := {
  (default : SystemState) with
  effects := reachEffects
  audit := reachAudit
  graph := reachSettledGraph subject
}

private theorem reachOpenRun (subject : TreeId) :
    (reachTerminalizingGraph subject).runs runId = some acceptanceRunRecord := acceptanceOpenRun

private theorem reachOpenBranch (subject : TreeId) :
    (reachTerminalizingGraph subject).branches branchId = some ⟨runId⟩ := by
  change tableSet (default : GraphStore).branches branchId (⟨runId⟩ : RunBranch) branchId =
    some ⟨runId⟩
  exact tableSet_self ..

private theorem reachOpenHead (subject : TreeId) :
    (reachTerminalizingGraph subject).heads branchId = some rootCommitId := by
  change tableSet (default : GraphStore).heads branchId rootCommitId branchId = some rootCommitId
  exact tableSet_self ..

private theorem reachOpenRoot (subject : TreeId) :
    (reachTerminalizingGraph subject).commits rootCommitId = some acceptanceRootCommit := by
  change tableSet (default : GraphStore).commits rootCommitId acceptanceRootCommit rootCommitId =
    some acceptanceRootCommit
  exact tableSet_self ..

private theorem reachTerminalCommitFresh (subject : TreeId) :
    (reachTerminalizingGraph subject).commits reachTerminalCommitId = none := by
  change tableSet (default : GraphStore).commits rootCommitId acceptanceRootCommit
    reachTerminalCommitId = none
  rw [tableSet_other _ _ _ (by decide)]
  rfl

private theorem reachReservedRegistryLookup (subject : TreeId) :
    (reachTerminalizingGraph subject).admissionRegistry runId = some reachReservedRegistry := by
  change tableSet (reachVerdictGraph subject).admissionRegistry runId
    (acceptanceRegistry.reserve reachItemObligation) runId = some reachReservedRegistry
  exact tableSet_self ..

private theorem reachNoTurnYet (subject : TreeId) (candidate : TurnId) :
    (reachReservedGraph subject).turns candidate = none := rfl

private theorem reachQueuedTurnLookup (subject : TreeId) :
    (reachQueuedGraph subject).turns turnId = some reachQueuedTurn := by
  change tableSet (reachReservedGraph subject).turns turnId reachQueuedTurn turnId =
    some reachQueuedTurn
  exact tableSet_self ..

private theorem reachRunningTurnLookup (subject : TreeId) :
    (reachTerminalizingGraph subject).turns turnId = some runningTurn := by
  change tableSet (reachQueuedGraph subject).turns turnId runningTurn turnId = some runningTurn
  exact tableSet_self ..

private theorem reachNoTerminalizing (subject : TreeId) :
    (reachRunningGraph subject).terminalizing runId = none := rfl

private theorem reachTerminalizingLookup (subject : TreeId) :
    (reachTerminalizingGraph subject).terminalizing runId = some reachControl := by
  change tableSet (reachRunningGraph subject).terminalizing runId reachControl runId =
    some reachControl
  exact tableSet_self ..

private theorem reachOnlyTurn (subject : TreeId) (candidate : TurnId) (record : Turn)
    (lookup : (reachTerminalizingGraph subject).turns candidate = some record) :
    candidate = turnId := by
  by_cases same : candidate = turnId
  · exact same
  · exfalso
    change tableSet (reachQueuedGraph subject).turns turnId runningTurn candidate = some record
      at lookup
    rw [tableSet_other _ _ _ same] at lookup
    change tableSet (reachReservedGraph subject).turns turnId reachQueuedTurn candidate =
      some record at lookup
    rw [tableSet_other _ _ _ same] at lookup
    rw [reachNoTurnYet subject candidate] at lookup
    exact Option.noConfusion lookup

private theorem reachSiblingsTerminal (subject : TreeId) :
    SiblingTurnsTerminalAndUnheld (reachTerminalizingGraph subject) runId turnId := by
  intro candidate record lookup _ different
  exact absurd (reachOnlyTurn subject candidate record lookup) different

private theorem reachOpenStep :
    GraphStep reachEffects (default : EventStore) reachAudit (default : GraphStore)
      (.startRun runId rootCommitId) acceptanceOpenGraph :=
  acceptanceOpenStepOver reachEffects reachAudit reachRootCause

private theorem reachVerdictStep (subject : TreeId) :
    GraphStep reachEffects (default : EventStore) reachAudit acceptanceOpenGraph
      (.recordAcceptanceVerdict runId (reachVerdict subject)) (reachVerdictGraph subject) :=
  acceptanceVerdictStepOver rfl reachVerifierReceipt

private theorem reachReserveStep (subject : TreeId) :
    GraphStep reachEffects (default : EventStore) reachAudit (reachVerdictGraph subject)
      (.reserveObligation runId 0 reachItemObligation) (reachReservedGraph subject) :=
  GraphStep.reserveObligation (run := acceptanceRunRecord) (registry := acceptanceRegistry)
    acceptanceOpenRun rfl acceptanceOpenAdmission rfl trivial (by decide) (by decide)

private theorem reachStartTurnStep (subject : TreeId) :
    GraphStep reachEffects (default : EventStore) reachAudit (reachReservedGraph subject)
      (.startTurn turnId) (reachQueuedGraph subject) :=
  GraphStep.startTurn (turn := reachQueuedTurn) (run := acceptanceRunRecord) (branch := ⟨runId⟩)
    (reachNoTurnYet subject turnId) acceptanceOpenRun rfl (reachOpenBranch subject) rfl rfl rfl
    rfl rfl

private theorem reachClaimStep (subject : TreeId) :
    GraphStep reachEffects (default : EventStore) reachAudit (reachQueuedGraph subject)
      (.claimTurn turnId) (reachRunningGraph subject) :=
  GraphStep.claimTurn (turn := reachQueuedTurn) (holder := principalRef) (now := ⟨1⟩)
    (expires := ⟨10⟩) (reachQueuedTurnLookup subject) rfl (.claim rfl (by decide))

private theorem reachBeginStep (subject : TreeId) :
    GraphStep reachEffects (default : EventStore) reachAudit (reachRunningGraph subject)
      (.beginTerminalization runId turnId reachControlReceiptId) (reachTerminalizingGraph subject) :=
  GraphStep.beginTerminalization (run := acceptanceRunRecord) (turn := runningTurn) (cause := ⟨6⟩)
    acceptanceOpenRun rfl (reachRunningTurnLookup subject) rfl rfl rfl
    (reachNoTerminalizing subject) reachControlValid

private theorem reachTerminalizeStep (subject : TreeId) :
    GraphStep reachEffects (default : EventStore) reachAudit (reachTerminalizingGraph subject)
      (.terminalize runId turnId reachTerminalCommitId rootCommitId) (reachSettledGraph subject) :=
  GraphStep.terminalize (run := acceptanceRunRecord) (turn := runningTurn) (token := token)
    (now := ⟨1⟩) (fenced := ⟨turnId, none, 2, ⟨10⟩⟩) (terminal := .succeeded)
    (registry := reachReservedRegistry) (commit := reachTerminalCommit)
    (preterminal := acceptanceRootCommit) (snapshot := reachSnapshot) (cause := ⟨1⟩)
    (control := reachControl)
    (reachOpenRun subject) rfl (reachRunningTurnLookup subject) rfl rfl rfl
    ⟨rfl, rfl, rfl, by decide⟩ (by simp [RunPins.Valid, acceptanceRunRecord, pins, agent]) rfl
    (reachTerminalizingLookup subject) rfl (reachSiblingsTerminal subject) .terminalFence
    (Or.inl rfl) (reachOpenHead subject) (reachOpenRoot subject) rfl rfl
    (reachTerminalCommitFresh subject) (reachReservedRegistryLookup subject) rfl rfl rfl rfl rfl
    reachRootCause rfl rfl rfl rfl

/-- Seven transitions from the empty graph: open the Run with its acceptance criterion, record
    the verifier's verdict, reserve the item obligation, start and claim the Turn, begin
    terminalization against the control Receipt, and terminalize. -/
private theorem reachTrace (subject : TreeId) :
    GraphReachable reachEffects (default : EventStore) reachAudit (default : GraphStore)
      (reachSettledGraph subject) :=
  .step (.step (.step (.step (.step (.step (.step (.refl _) reachOpenStep)
    (reachVerdictStep subject)) (reachReserveStep subject)) (reachStartTurnStep subject))
    (reachClaimStep subject)) (reachBeginStep subject)) (reachTerminalizeStep subject)

private theorem reachSettledRun (subject : TreeId) :
    (reachSettledGraph subject).runs runId = some reachTerminalRun := by
  change tableSet (reachTerminalizingGraph subject).runs runId reachTerminalRun runId =
    some reachTerminalRun
  exact tableSet_self ..

private theorem reachSettledSnapshot (subject : TreeId) :
    (reachSettledGraph subject).terminalSnapshots runId = some reachSnapshot := by
  change tableSet (reachTerminalizingGraph subject).terminalSnapshots runId reachSnapshot runId =
    some reachSnapshot
  exact tableSet_self ..

private theorem reachSettledTurn (subject : TreeId) :
    (reachSettledGraph subject).turns turnId = some reachTerminalTurn := by
  change tableSet (reachTerminalizingGraph subject).turns turnId reachTerminalTurn turnId =
    some reachTerminalTurn
  exact tableSet_self ..

private theorem reachSettledCommit (subject : TreeId) :
    (reachSettledGraph subject).commits reachTerminalCommitId = some reachTerminalCommit := by
  change tableSet (reachTerminalizingGraph subject).commits reachTerminalCommitId
    reachTerminalCommit reachTerminalCommitId = some reachTerminalCommit
  exact tableSet_self ..

private theorem reachSettledHead (subject : TreeId) :
    (reachSettledGraph subject).heads branchId = some reachTerminalCommitId := by
  change tableSet (reachTerminalizingGraph subject).heads branchId reachTerminalCommitId branchId =
    some reachTerminalCommitId
  exact tableSet_self ..

private theorem reachSettledVerdicts (subject : TreeId) :
    (reachSettledGraph subject).acceptanceVerdicts acceptanceId = [reachVerdict subject] := by
  change (if acceptanceId = (reachVerdict subject).acceptance then
      reachVerdict subject :: acceptanceOpenGraph.acceptanceVerdicts acceptanceId
    else acceptanceOpenGraph.acceptanceVerdicts acceptanceId) = [reachVerdict subject]
  simp [reachVerdict, acceptanceOpenGraph]

private theorem reachSettledHeadTree (subject : TreeId) :
    (reachSettledGraph subject).HeadTree runId acceptanceHead :=
  ⟨reachTerminalRun, reachTerminalCommitId, reachTerminalCommit, reachSettledRun subject,
    reachSettledHead subject, reachSettledCommit subject, rfl, rfl⟩

private theorem reachSettledCriterion (subject : TreeId) :
    acceptanceCriterion ∈ (reachSettledGraph subject).acceptanceCriteria runId := by
  simp [GraphStore.acceptanceCriteria, reachSettledRun subject, reachTerminalRun,
    acceptanceRunRecord]

private theorem reachVerifyItemOutcome :
    ItemCurrentOutcome reachEffects reachVerifyInvocation 0 .succeeded := by
  unfold ItemCurrentOutcome
  rw [reachVerifyCurrent]
  exact ⟨reachVerifyReceipt, reachVerifyAttempt, reachVerifyReceiptLookup,
    reachVerifyAttemptLookup, reachVerifyLatest, rfl, rfl, Or.inl ⟨rfl, rfl⟩⟩

private theorem reachControlItemOutcome :
    ItemCurrentOutcome reachEffects reachControlInvocation 0 .succeeded := by
  unfold ItemCurrentOutcome
  rw [reachControlCurrent]
  exact ⟨reachControlReceipt, reachControlAttempt, reachControlReceiptLookup,
    reachControlAttemptLookup, reachControlLatest, rfl, rfl, Or.inl ⟨rfl, rfl⟩⟩

private theorem reachVerifyItemAudited (subject : TreeId) :
    CurrentReceiptAudited (reachState subject) reachVerifyInvocation 0 ⟨3⟩ := by
  unfold CurrentReceiptAudited
  rw [show (reachState subject).effects.currentReceipt reachVerifyInvocation 0 =
    some (.attempt reachVerifyReceiptId) from reachVerifyCurrent]
  exact ⟨reachVerifyReceipt, reachVerifyAttempt, reachVerifyReceiptAudit,
    reachVerifyReceiptLookup, reachVerifyAttemptLookup, reachAuditVerifyReceipt, rfl,
    reachVerifyChain⟩

private theorem reachControlItemAudited (subject : TreeId) :
    CurrentReceiptAudited (reachState subject) reachControlInvocation 0 ⟨6⟩ := by
  unfold CurrentReceiptAudited
  rw [show (reachState subject).effects.currentReceipt reachControlInvocation 0 =
    some (.attempt reachControlReceiptId) from reachControlCurrent]
  exact ⟨reachControlReceipt, reachControlAttempt, reachControlReceiptAudit,
    reachControlReceiptLookup, reachControlAttemptLookup, reachAuditControlReceipt, rfl,
    reachControlChain⟩

private theorem reachSnapshotObligations :
    reachSnapshot.obligations = [.acceptance acceptanceId, reachItemObligation] := by
  simp [reachSnapshot, reachReservedRegistry, RunAdmissionRegistry.outstanding]

private theorem reachItemDischarged (subject : TreeId) :
    ObligationDischarged (reachState subject) runId reachItemObligation :=
  ⟨reachVerifyPrepared, ⟨0, firstArgs, reachVerifyKey⟩, .succeeded, ⟨3⟩,
    reachVerifyPreparedLookup, rfl, rfl, reachVerifyItemOutcome, by decide,
    reachVerifyItemAudited subject⟩

/-- The reached graph is genuinely Settled when the one verdict names the head the Run finished
    on: a coherent terminal snapshot, a terminal Turn, every item of every Run-domain Invocation
    carrying a non-indeterminate audited current Receipt, no live route, both captured
    obligations discharged, and no conflict. -/
theorem nonvacuous_reachable_settled_run :
    GraphReachable reachEffects (default : EventStore) reachAudit (default : GraphStore)
      (reachState acceptanceHead).graph ∧
    Settled (reachState acceptanceHead) runId := by
  have turnLookup : (reachState acceptanceHead).graph.turns turnId = some reachTerminalTurn :=
    reachSettledTurn acceptanceHead
  have snapshotLookup :
      (reachState acceptanceHead).graph.terminalSnapshots runId = some reachSnapshot :=
    reachSettledSnapshot acceptanceHead
  have verdicts : (reachState acceptanceHead).graph.acceptanceVerdicts acceptanceId =
      [reachVerdict acceptanceHead] := reachSettledVerdicts acceptanceHead
  have verifyLookup : (reachState acceptanceHead).effects.invocations reachVerifyInvocation =
      some reachVerifyPrepared := reachVerifyPreparedLookup
  have controlLookup : (reachState acceptanceHead).effects.invocations reachControlInvocation =
      some reachControlPrepared := reachControlPreparedLookup
  refine ⟨reachTrace acceptanceHead, ⟨?_, ?_, ?_, ?_, ?_, ?_⟩⟩
  · exact ⟨reachTerminalRun, reachSnapshot, reachSettledRun _, rfl, reachSettledSnapshot _, rfl,
      reachTerminalRun, reachTerminalTurn, reachTerminalCommit, reachSettledRun _, rfl,
      reachSettledTurn _, rfl, reachSettledCommit _, rfl, rfl, rfl, rfl⟩
  · intro candidate record lookup _
    by_cases same : candidate = turnId
    · subst same
      rw [turnLookup] at lookup
      cases Option.some.inj lookup
      exact Or.inl rfl
    · exfalso
      have staged : tableSet (reachTerminalizingGraph acceptanceHead).turns turnId reachTerminalTurn
          candidate = some record := lookup
      rw [tableSet_other _ _ _ same] at staged
      exact same (reachOnlyTurn acceptanceHead candidate record staged)
  · intro invocation prepared lookup _ item member
    by_cases verify : invocation = reachVerifyInvocation
    · subst verify
      rw [verifyLookup] at lookup
      cases Option.some.inj lookup
      have single : item ∈ [(⟨0, firstArgs, reachVerifyKey⟩ : PreparedItem)] := member
      rw [List.mem_singleton.mp single]
      exact ⟨.succeeded, reachVerifyItemOutcome, by decide, ⟨3⟩, reachVerifyItemAudited _⟩
    · by_cases control : invocation = reachControlInvocation
      · subst control
        rw [controlLookup] at lookup
        cases Option.some.inj lookup
        have single : item ∈ [(⟨0, firstArgs, reachControlKey⟩ : PreparedItem)] := member
        rw [List.mem_singleton.mp single]
        exact ⟨.succeeded, reachControlItemOutcome, by decide, ⟨6⟩, reachControlItemAudited _⟩
      · exact absurd lookup (by simp [reachState, reachEffects, verify, control])
  · intro invocation prepared lookup _
    exact ⟨fun reservation reservationLookup => absurd reservationLookup (by simp [reachState]),
      fun reservation reservationLookup => absurd reservationLookup (by simp [reachState])⟩
  · intro snapshot lookup obligation member
    obtain rfl : snapshot = reachSnapshot :=
      Option.some.inj (lookup.symm.trans snapshotLookup)
    rw [reachSnapshotObligations] at member
    have alternatives :
        obligation = .acceptance acceptanceId ∨ obligation = reachItemObligation := by
      simpa using member
    rcases alternatives with rfl | rfl
    · exact ⟨acceptanceHead, reachVerdict acceptanceHead, header.operation,
        reachSettledHeadTree acceptanceHead,
        by rw [verdicts]; exact List.mem_singleton.mpr rfl, rfl, rfl, reachVerifierReceipt⟩
    · exact reachItemDischarged acceptanceHead
  · exact fun conflict => conflict

/-- The same seven transitions with the one verdict naming a tree the Run's head moved past: the
    graph is just as reachable and the Run is not Settled. The two runs of the trace differ in
    nothing but that subject, so the refusal is the acceptance obligation's doing. -/
theorem nonvacuous_reachable_stale_verdict_not_settled :
    GraphReachable reachEffects (default : EventStore) reachAudit (default : GraphStore)
      (reachState acceptanceOtherHead).graph ∧
    ¬ Settled (reachState acceptanceOtherHead) runId := by
  have runLookup : (reachState acceptanceOtherHead).graph.runs runId = some reachTerminalRun :=
    reachSettledRun acceptanceOtherHead
  have headLookup : (reachState acceptanceOtherHead).graph.heads reachTerminalRun.rootBranch =
      some reachTerminalCommitId := reachSettledHead acceptanceOtherHead
  have commitLookup : (reachState acceptanceOtherHead).graph.commits reachTerminalCommitId =
      some reachTerminalCommit := reachSettledCommit acceptanceOtherHead
  have verdicts : (reachState acceptanceOtherHead).graph.acceptanceVerdicts acceptanceId =
      [reachVerdict acceptanceOtherHead] := reachSettledVerdicts acceptanceOtherHead
  refine ⟨reachTrace acceptanceOtherHead, ?_⟩
  apply acceptance_unsatisfied_not_settled (snapshot := reachSnapshot) (accId := acceptanceId)
    (reachSettledSnapshot acceptanceOtherHead) (by rw [reachSnapshotObligations]; simp)
  intro satisfied
  obtain ⟨subject, verdict, verifier, headTree, member, named, atSubject, _⟩ := satisfied
  obtain ⟨record, head, commit, actualRun, actualHead, actualCommit, _, checkpoint⟩ := headTree
  obtain rfl : record = reachTerminalRun := Option.some.inj (actualRun.symm.trans runLookup)
  obtain rfl : head = reachTerminalCommitId := Option.some.inj (actualHead.symm.trans headLookup)
  obtain rfl : commit = reachTerminalCommit :=
    Option.some.inj (actualCommit.symm.trans commitLookup)
  obtain rfl : subject = acceptanceHead := Option.some.inj checkpoint.symm
  rw [verdicts] at member
  rw [List.mem_singleton.mp member] at atSubject
  exact absurd atSubject (by decide)

/-- The headline settlement claims, on one object that is both reachable and Settled: the
    coherent snapshot with exactly-discharged obligations, and the declared acceptance criterion
    holding a verdict of its own verifier at the head the Run finished on. -/
theorem nonvacuous_reachable_settled_obligations_and_acceptance :
    (∃ snapshot, (reachState acceptanceHead).graph.terminalSnapshots runId = some snapshot ∧
      snapshot.run = runId ∧
      TerminalSnapshotCoherent (reachState acceptanceHead).graph snapshot) ∧
    (∀ snapshot, (reachState acceptanceHead).graph.terminalSnapshots runId = some snapshot →
      ∀ obligation ∈ snapshot.obligations,
        ObligationDischarged (reachState acceptanceHead) runId obligation) ∧
    ∃ subject verdict,
      (reachState acceptanceHead).graph.HeadTree runId subject ∧
      verdict ∈ (reachState acceptanceHead).graph.acceptanceVerdicts acceptanceCriterion.id ∧
      verdict.acceptance = acceptanceCriterion.id ∧ verdict.subject = subject ∧
      VerifierReceipt (reachState acceptanceHead).effects verdict.receipt
        acceptanceCriterion.operation .succeeded :=
  ⟨(settled_has_coherent_snapshot_and_exact_obligations nonvacuous_reachable_settled_run.2).1,
    (settled_has_coherent_snapshot_and_exact_obligations nonvacuous_reachable_settled_run.2).2,
    graph_reachable_settled_acceptance_holds_at_current_head nonvacuous_reachable_settled_run.1
      (reachSettledCriterion acceptanceHead) nonvacuous_reachable_settled_run.2⟩

/-! ## Contribution and slot witnesses (SPEC §4.2)

A concrete slot ledger proving the contribution LTS is livable: an installed
declaration accepts two contributions from different facets, arrival order is recorded
yet resolution presents declared order, and each collision path rejects. -/

private def cardSchema : SchemaId := ⟨1⟩
private def noteSchema : SchemaId := ⟨2⟩

private def slotSchemas : SchemaId → StructuralValue → Bool
  | ⟨1⟩, value => value.format == "card"
  | _, _ => false

private def dashboardSlot : SlotDeclaration := ⟨⟨1⟩, cardSchema⟩

/-- Arrives first but carries the larger ordinal, so it presents second. -/
private def firstCard : SlotEntry := ⟨⟨1⟩, dashboardSlot.name, ⟨1⟩, 2, ⟨"card", ["usage"]⟩⟩
/-- Arrives second but carries the smaller ordinal, so it presents first. -/
private def secondCard : SlotEntry := ⟨⟨2⟩, dashboardSlot.name, ⟨2⟩, 1, ⟨"card", ["deploys"]⟩⟩

private def installedSlotLedger : SlotLedger :=
  ⟨tableSet (fun _ => none) dashboardSlot.name dashboardSlot, []⟩
private def firstArrivalLedger : SlotLedger :=
  { installedSlotLedger with entries := [firstCard] }
private def firstThenSecond : SlotLedger :=
  { installedSlotLedger with entries := [firstCard, secondCard] }
private def secondThenFirst : SlotLedger :=
  { installedSlotLedger with entries := [secondCard, firstCard] }

private theorem firstThenSecond_origins : firstThenSecond.OriginsUnique := by
  show ∀ left ∈ firstThenSecond.entries, ∀ right ∈ firstThenSecond.entries,
    left.SameOrigin right → left = right
  decide

theorem nonvacuous_slot_contribution_lifecycle :
    SlotStep slotSchemas (default : SlotLedger) (.installSlot dashboardSlot)
      installedSlotLedger ∧
    SlotStep slotSchemas installedSlotLedger (.contribute firstCard) firstArrivalLedger ∧
    SlotStep slotSchemas firstArrivalLedger (.contribute secondCard) firstThenSecond ∧
    firstThenSecond.OriginsUnique ∧
    firstThenSecond.EntriesConform slotSchemas ∧
    firstThenSecond.slots dashboardSlot.name = some dashboardSlot := by
  refine ⟨SlotStep.installSlot rfl,
    SlotStep.contribute rfl rfl (by intro stored member; cases member),
    SlotStep.contribute rfl rfl ?_, firstThenSecond_origins, ?_, rfl⟩
  · intro stored member
    rw [List.mem_singleton.mp member]
    exact ⟨by decide, by decide⟩
  · intro entry member
    rcases List.mem_cons.mp member with equal | member
    · rw [equal]; exact ⟨dashboardSlot, rfl, rfl⟩
    · rw [List.mem_singleton.mp member]; exact ⟨dashboardSlot, rfl, rfl⟩

/-- Resolution reorders arrivals: the ledger stores `[firstCard, secondCard]` yet
    resolves to declared `(ordinal, contributor)` order. Fails if resolution presented
    the arrival log. -/
theorem nonvacuous_resolution_reorders_arrivals :
    firstThenSecond.entries = [firstCard, secondCard] ∧
    firstThenSecond.resolve dashboardSlot.name = [secondCard, firstCard] := by
  refine ⟨rfl, resolution_is_unique_declared_order firstThenSecond_origins ?_ ?_⟩
  · rw [show firstThenSecond.entries.filter
        (fun entry => decide (entry.slot = dashboardSlot.name)) =
        [firstCard, secondCard] from by decide]
    exact List.Perm.swap firstCard secondCard []
  · decide

/-- The same two contributions in the opposite arrival order resolve identically —
    and the two ledgers genuinely differ as arrival logs. -/
theorem nonvacuous_arrival_free_resolution :
    firstThenSecond.entries ≠ secondThenFirst.entries ∧
    firstThenSecond.resolve dashboardSlot.name =
      secondThenFirst.resolve dashboardSlot.name := by
  refine ⟨by decide, resolution_ignores_arrival_order firstThenSecond_origins ?_⟩
  exact List.Perm.swap secondCard firstCard []

private def conflictingDashboardSlot : SlotDeclaration := ⟨dashboardSlot.name, noteSchema⟩

theorem nonvacuous_slot_redeclaration_rejected {after : SlotLedger} :
    ¬ SlotStep slotSchemas installedSlotLedger (.installSlot conflictingDashboardSlot) after :=
  occupied_slot_redeclaration_rejected (existing := dashboardSlot) rfl

theorem nonvacuous_uninstalled_contribution_rejected {after : SlotLedger} :
    ¬ SlotStep slotSchemas (default : SlotLedger) (.contribute firstCard) after :=
  uninstalled_slot_contribution_rejected rfl

private def rejectedNote : SlotEntry := ⟨⟨3⟩, dashboardSlot.name, ⟨3⟩, 1, ⟨"note", []⟩⟩

theorem nonvacuous_nonvalidating_contribution_rejected {after : SlotLedger} :
    ¬ SlotStep slotSchemas installedSlotLedger (.contribute rejectedNote) after :=
  nonvalidating_contribution_rejected (declaration := dashboardSlot) rfl rfl

/-- Same `(slot, contributor, ordinal)` origin as `firstCard`, different id and value. -/
private def usurpingCard : SlotEntry := ⟨⟨4⟩, dashboardSlot.name, ⟨1⟩, 2, ⟨"card", ["v2"]⟩⟩

theorem nonvacuous_conflicting_origin_rejected {after : SlotLedger} :
    ¬ SlotStep slotSchemas firstThenSecond (.contribute usurpingCard) after :=
  conflicting_origin_contribution_rejected (stored := firstCard) (by decide) (by decide)

/-- Reuses the stored id of `firstCard` under a fresh origin. -/
private def idReusingCard : SlotEntry := ⟨⟨1⟩, dashboardSlot.name, ⟨9⟩, 9, ⟨"card", []⟩⟩

theorem nonvacuous_entry_id_reuse_rejected {after : SlotLedger} :
    ¬ SlotStep slotSchemas firstThenSecond (.contribute idReusingCard) after :=
  entry_id_reuse_rejected (stored := firstCard) (by decide) (by decide)

theorem nonvacuous_slot_noop_reinstallation :
    SlotStep slotSchemas firstThenSecond (.reinstallSlot dashboardSlot) firstThenSecond ∧
    SlotStep slotSchemas firstThenSecond (.recontribute firstCard) firstThenSecond :=
  ⟨SlotStep.reinstallSlot rfl, SlotStep.recontribute (by decide)⟩

/-! ## Command witnesses (SPEC §4.3)

A deploy command installed into a composer surface, invoked with schema-valid
arguments; collisions, deviating routes, unsafe mappings, and invalid arguments each
reject; a resubmitted envelope yields the recorded outcome and nothing else. -/

private def commandArgumentsSchema : SchemaId := ⟨11⟩
private def commandInputSchema : SchemaId := ⟨12⟩

private def commandSchemas : SchemaId → StructuralValue → Bool
  | ⟨11⟩, value => value.format == "args"
  | ⟨12⟩, value => value.format == "input"
  | _, _ => false

private def deployMapping : MappingId := ⟨21⟩
private def identityMapping : MappingId := ⟨22⟩

private def commandMappings : MappingId → StructuralValue → StructuralValue
  | ⟨21⟩, value => ⟨"input", value.tokens⟩
  | _, value => value

private def commandScope : Scope := .tenant tenant
private def composerSurface : SlotName := ⟨31⟩
private def deployOperation : OperationId := ⟨⟨7⟩, "deploy.run", 1⟩

private def deployCommand : CommandDecl :=
  ⟨⟨41⟩, [composerSurface], commandArgumentsSchema, deployOperation, commandInputSchema,
    bindingId, deployMapping, none⟩

private def deployRegistry : CommandRegistry :=
  (default : CommandRegistry).installCommand commandScope deployCommand

private def deployArguments : StructuralValue := ⟨"args", ["staging"]⟩
private def deployInvocation : CommandInvocation :=
  ⟨commandScope, deployCommand.id, ⟨"input", ["staging"]⟩⟩
private def invokedDeployRegistry : CommandRegistry :=
  { deployRegistry with invoked := [deployInvocation] }

private def deployInstallStep :
    CommandStep commandSchemas commandMappings (default : CommandRegistry)
      (.installCommand commandScope deployCommand) deployRegistry :=
  CommandStep.installCommand (by decide)
    (fun tiers h => nomatch (show (none : Option (List TrustTier)) = some tiers from h))
    (fun value _ => rfl) rfl (fun surface _ => rfl)

theorem nonvacuous_command_installation_and_validated_invocation :
    CommandStep commandSchemas commandMappings (default : CommandRegistry)
      (.installCommand commandScope deployCommand) deployRegistry ∧
    deployRegistry.commands commandScope deployCommand.id =
      some ⟨deployCommand, deriveCommandRoute deployCommand⟩ ∧
    deployRegistry.surfaces commandScope composerSurface deployCommand.name =
      some deployCommand.id ∧
    deployRegistry.InstalledMappingsSafe commandSchemas commandMappings ∧
    CommandStep commandSchemas commandMappings deployRegistry
      (.invoke commandScope deployCommand.id deployArguments) invokedDeployRegistry ∧
    commandSchemas commandInputSchema deployInvocation.input = true ∧
    (deriveCommandRoute deployCommand).authority = .initiator bindingId ∧
    (deriveCommandRoute deployCommand).dedupe = .event ∧
    (deriveCommandRoute deployCommand).acceptedTrust ≠ [] ∧
    invokedDeployRegistry.surfaces commandScope composerSurface deployCommand.name =
      some deployCommand.id :=
  ⟨deployInstallStep, rfl, rfl,
    command_step_preserves_installed_mapping_safety
      (fun _ _ installed lookup =>
        nomatch (show (none : Option InstalledCommand) = some installed from lookup))
      deployInstallStep,
    CommandStep.invoke (installed := ⟨deployCommand, deriveCommandRoute deployCommand⟩) rfl rfl,
    rfl, rfl, rfl, by decide, rfl⟩

/-- Same command name declared into the same surface slot by a different facet: a
    later contribution colliding on `(Scope, surface, name)` rejects. -/
private def rivalDeployCommand : CommandDecl :=
  ⟨⟨41⟩, [composerSurface], commandArgumentsSchema, ⟨⟨8⟩, "deploy.run", 1⟩,
    commandInputSchema, bindingId, deployMapping, none⟩

theorem nonvacuous_command_surface_collision_rejected {after : CommandRegistry} :
    ¬ CommandStep commandSchemas commandMappings deployRegistry
      (.installCommand commandScope rivalDeployCommand) after :=
  command_surface_collision_rejected (surface := composerSurface)
    (occupant := deployCommand.id) (by decide) rfl

theorem nonvacuous_occupied_command_id_installation_rejected {after : CommandRegistry} :
    ¬ CommandStep commandSchemas commandMappings deployRegistry
      (.installCommand commandScope deployCommand) after :=
  occupied_command_id_installation_rejected
    (installed := ⟨deployCommand, deriveCommandRoute deployCommand⟩) rfl

theorem nonvacuous_command_reinstallation_identity :
    CommandStep commandSchemas commandMappings deployRegistry
      (.reinstallCommand commandScope deployCommand.id) deployRegistry :=
  CommandStep.reinstallCommand
    (installed := ⟨deployCommand, deriveCommandRoute deployCommand⟩) rfl

/-- A registry whose stored route swapped initiator authority for delegated: no
    installation step can produce it, from any starting registry. -/
private def hijackedRoute : CommandRoute :=
  { deriveCommandRoute deployCommand with authority := .delegated bindingId }
private def hijackedRegistry : CommandRegistry :=
  { (default : CommandRegistry) with
    commands := fun scope id =>
      if scope = commandScope ∧ id = deployCommand.id then
        some ⟨deployCommand, hijackedRoute⟩
      else none }

theorem nonvacuous_nonderived_route_rejected {registry : CommandRegistry} :
    ¬ CommandStep commandSchemas commandMappings registry
      (.installCommand commandScope deployCommand) hijackedRegistry :=
  nonderived_route_installation_rejected (installed := ⟨deployCommand, hijackedRoute⟩)
    rfl (by decide)

/-- Declares an explicit empty trust set. -/
private def emptyTrustCommand : CommandDecl :=
  ⟨⟨43⟩, [composerSurface], commandArgumentsSchema, ⟨⟨7⟩, "deploy.status", 1⟩,
    commandInputSchema, bindingId, deployMapping, some []⟩

theorem nonvacuous_empty_trust_installation_rejected {after : CommandRegistry} :
    ¬ CommandStep commandSchemas commandMappings (default : CommandRegistry)
      (.installCommand commandScope emptyTrustCommand) after :=
  empty_trust_installation_rejected rfl

/-- Passes arguments through unmapped, so a schema-valid argument value reaches the
    Operation input schema unvalidated — install rejects it. -/
private def unsafeRawCommand : CommandDecl :=
  ⟨⟨42⟩, [composerSurface], commandArgumentsSchema, ⟨⟨7⟩, "deploy.raw", 1⟩,
    commandInputSchema, bindingId, identityMapping, none⟩

theorem nonvacuous_unsafe_mapping_installation_rejected {after : CommandRegistry} :
    ¬ CommandStep commandSchemas commandMappings (default : CommandRegistry)
      (.installCommand commandScope unsafeRawCommand) after :=
  unsafe_mapping_installation_rejected
    (fun safe => absurd (safe ⟨"args", []⟩ rfl) (by decide))

theorem nonvacuous_uninstalled_invocation_rejected {after : CommandRegistry} :
    ¬ CommandStep commandSchemas commandMappings (default : CommandRegistry)
      (.invoke commandScope deployCommand.id deployArguments) after :=
  uninstalled_command_invocation_rejected rfl

theorem nonvacuous_invalid_arguments_invocation_rejected {after : CommandRegistry} :
    ¬ CommandStep commandSchemas commandMappings deployRegistry
      (.invoke commandScope deployCommand.id ⟨"junk", []⟩) after :=
  invalid_arguments_invocation_rejected
    (installed := ⟨deployCommand, deriveCommandRoute deployCommand⟩) rfl rfl

/-! ## Command submission witnesses (§4.3 via §6.1 `host.command.submit`) -/

private def submissionIdentity : SubmissionIdentity := ⟨.principal principalRef, ⟨61⟩⟩
private def committedSubmission : SubmissionWrite :=
  ⟨submissionIdentity, .committed, ⟨"receipt", ["ok"]⟩⟩
private def duplicateSubmission : SubmissionWrite :=
  ⟨submissionIdentity, .duplicate ⟨1⟩, ⟨"receipt", ["ok"]⟩⟩

private def committedSubmissionLedger : SubmissionLedger :=
  { writes := tableSet (fun _ => none) ⟨1⟩ committedSubmission
    reserved := tableSet (fun _ => none) submissionIdentity ⟨1⟩
    invoked := [⟨71⟩] }
private def resubmittedLedger : SubmissionLedger :=
  { committedSubmissionLedger with
    writes := tableSet committedSubmissionLedger.writes ⟨2⟩ duplicateSubmission }

private def commitSubmissionStep :
    SubmissionStep (default : SubmissionLedger) (.commit ⟨1⟩ ⟨71⟩)
      committedSubmissionLedger :=
  SubmissionStep.commit (write := committedSubmission) rfl rfl rfl

/-- A committed submission followed by a resubmission of the same identity: the
    duplicate write carries the recorded reply, cites the reserving original, reserves
    nothing new, and mints no second `command.invoked` Event. -/
theorem nonvacuous_duplicate_submission_is_recorded_evidence :
    SubmissionStep (default : SubmissionLedger) (.commit ⟨1⟩ ⟨71⟩)
      committedSubmissionLedger ∧
    committedSubmissionLedger.ReservationConsistent ∧
    SubmissionStep committedSubmissionLedger (.resubmit ⟨2⟩) resubmittedLedger ∧
    resubmittedLedger.reserved = committedSubmissionLedger.reserved ∧
    resubmittedLedger.invoked = committedSubmissionLedger.invoked ∧
    resubmittedLedger.writes ⟨2⟩ = some duplicateSubmission ∧
    duplicateSubmission.reply = committedSubmission.reply :=
  by
  refine ⟨commitSubmissionStep, ?_, ?_, rfl, rfl, rfl, rfl⟩
  · exact submission_step_preserves_reservation_consistency
      (And.intro
        (fun _ id lookup =>
          nomatch (show (none : Option SubmissionWriteId) = some id from lookup))
        (fun _ write lookup _ =>
          nomatch (show (none : Option SubmissionWrite) = some write from lookup)))
      commitSubmissionStep
  · exact SubmissionStep.resubmit (write := duplicateSubmission) (originalId := ⟨1⟩)
      (original := committedSubmission) rfl rfl rfl rfl rfl rfl

/-- The state a recommitment of the reserved identity would produce: impossible. -/
private def recommitSubmission : SubmissionWrite :=
  ⟨submissionIdentity, .committed, ⟨"receipt", ["again"]⟩⟩
private def recommitAttempt : SubmissionLedger :=
  { writes := tableSet committedSubmissionLedger.writes ⟨2⟩ recommitSubmission
    reserved := tableSet committedSubmissionLedger.reserved submissionIdentity ⟨2⟩
    invoked := ⟨72⟩ :: committedSubmissionLedger.invoked }

theorem nonvacuous_reserved_identity_recommit_rejected :
    ¬ SubmissionStep committedSubmissionLedger (.commit ⟨2⟩ ⟨72⟩) recommitAttempt :=
  reserved_identity_cannot_recommit (write := recommitSubmission)
    (originalId := ⟨1⟩) rfl rfl

/-- A ledger holding two reserving writes for one identity violates reservation
    consistency — the invariant genuinely excludes double reservation. -/
private def doubleReservationLedger : SubmissionLedger :=
  { writes := tableSet (tableSet (fun _ => none) ⟨1⟩ committedSubmission) ⟨2⟩
      recommitSubmission
    reserved := tableSet (fun _ => none) submissionIdentity ⟨1⟩
    invoked := [] }

theorem nonvacuous_double_reservation_is_inconsistent :
    ¬ doubleReservationLedger.ReservationConsistent := by
  intro consistent
  have same := at_most_one_reserving_write_per_identity consistent
    (leftId := ⟨1⟩) (rightId := ⟨2⟩)
    (left := committedSubmission) (right := recommitSubmission)
    rfl rfl rfl trivial trivial
  exact absurd same (by decide)
/-! ## Environment, Session, Slate, and dynamic-isolate witnesses (SPEC §4.5, §4.6) -/

private def envId : EnvironmentId := ⟨41⟩
private def sessionId : SessionId := ⟨1⟩
private def secretId : SecretId := ⟨7⟩
private def egressBindingId : BindingId := ⟨41⟩
private def envDestination : Destination := ⟨9⟩
private def envGrant : EgressGrant := ⟨envDestination, some secretId⟩
private def envUse : SessionUse := ⟨sessionId, 0, token, ⟨5⟩⟩
private def snapId : SnapshotId := ⟨1⟩
private def exposureId : ExposureId := ⟨1⟩
private def claimedLease : TurnLease := ⟨turnId, some principalRef, 1, ⟨100⟩⟩

private def envTurnRegistered : EnvironmentLedger :=
  { EnvironmentLedger.boot with
    leases := tableSet EnvironmentLedger.boot.leases turnId (TurnLease.initial turnId) }
private def envTurnClaimed : EnvironmentLedger :=
  { envTurnRegistered with
    leases := tableSet envTurnRegistered.leases turnId claimedLease }
private def envProvisioned : EnvironmentLedger :=
  { envTurnClaimed with
    environments := tableSet envTurnClaimed.environments envId ⟨0, 0⟩ }
private def envBound : EnvironmentLedger :=
  { envProvisioned with
    egressGrants := tableSet envProvisioned.egressGrants egressBindingId envGrant }
private def envOpened : EnvironmentLedger :=
  { envBound with
    sessions := tableSet envBound.sessions sessionId ⟨envId, 0, 0, turnId, 0, .live⟩
    files := setFiles envBound.files sessionId (fun _ => none) }
private def envWritten : EnvironmentLedger :=
  { envOpened with
    files := setFiles envOpened.files sessionId
      (tableSet (envOpened.files sessionId) "config" (AgentValue.ref secretId).stored) }
private def envSent : EnvironmentLedger :=
  { envWritten with
    egress := ⟨sessionId, egressBindingId, envDestination, some secretId⟩ :: envWritten.egress }
private def envSnapshotted : EnvironmentLedger :=
  { envSent with
    snapshots := tableSet envSent.snapshots snapId ⟨sessionId, envSent.files sessionId⟩ }
private def envRotated : EnvironmentLedger :=
  { envSnapshotted with
    environments := tableSet envSnapshotted.environments envId ⟨1, 1⟩ }

private def envSessionRecord : SessionRecord := ⟨envId, 0, 0, turnId, 0, .live⟩

private theorem envLeaseAdmits : claimedLease.Admits token ⟨5⟩ := by decide

private theorem envUseAdmittedOpened : UseAdmitted envOpened envUse :=
  ⟨envSessionRecord, claimedLease, rfl, rfl, rfl, rfl, rfl, envLeaseAdmits⟩
private theorem envUseAdmittedWritten : UseAdmitted envWritten envUse :=
  ⟨envSessionRecord, claimedLease, rfl, rfl, rfl, rfl, rfl, envLeaseAdmits⟩
private theorem envUseAdmittedSent : UseAdmitted envSent envUse :=
  ⟨envSessionRecord, claimedLease, rfl, rfl, rfl, rfl, rfl, envLeaseAdmits⟩
private theorem envUseAdmittedRotated : UseAdmitted envRotated envUse :=
  ⟨envSessionRecord, claimedLease, rfl, rfl, rfl, rfl, rfl, envLeaseAdmits⟩

private theorem envReachableRotated : EnvReachable envRotated := by
  have r1 : EnvReachable envTurnRegistered := .step .boot (.registerTurn rfl)
  have s2 : EnvironmentStep envTurnRegistered
      (.leaseAction turnId (.claim principalRef ⟨0⟩ ⟨100⟩)) envTurnClaimed :=
    .leaseAction (lease := TurnLease.initial turnId) rfl
      (.claim (lease := TurnLease.initial turnId) rfl (by decide))
  have r2 : EnvReachable envTurnClaimed := .step r1 s2
  have r3 : EnvReachable envProvisioned := .step r2 (.provision rfl)
  have r4 : EnvReachable envBound := .step r3 (.bindEgress rfl)
  have s5 : EnvironmentStep envBound
      (.openSession sessionId envId turnId token ⟨5⟩ none) envOpened :=
    .openSession (record := ⟨0, 0⟩) (lease := claimedLease) (content := fun _ => none)
      rfl rfl rfl rfl envLeaseAdmits rfl
  have r5 : EnvReachable envOpened := .step r4 s5
  have s6 : EnvironmentStep envOpened
      (.write envUse "config" (.ref secretId)) envWritten := .write envUseAdmittedOpened
  have r6 : EnvReachable envWritten := .step r5 s6
  have s7 : EnvironmentStep envWritten (.send envUse egressBindingId) envSent :=
    .send (grant := envGrant) envUseAdmittedWritten rfl
  have r7 : EnvReachable envSent := .step r6 s7
  have s8 : EnvironmentStep envSent (.snapshot envUse snapId) envSnapshotted :=
    .snapshot envUseAdmittedSent rfl
  have r8 : EnvReachable envSnapshotted := .step r7 s8
  exact .step r8 (.rotate (record := ⟨0, 0⟩) rfl)

/-- The credential-isolation seam exercised end to end, non-vacuously: a reachable
trace opens a Turn-owned Session, writes the SecretRef into the session filesystem,
sends through the proxy under an explicit egress Binding — the egress record names
the injected credential, so the secret is genuinely usable *by* the Session —
snapshots the filesystem, and rotates the Environment. Isolation still holds: no file
and no snapshot cell holds plaintext, the unbound Binding still cannot send, and the
open session kept its pre-rotation pin while the head advanced. Removing the proxy
seam (writing the resolved credential into session state), the egress-grant gate, or
the rotation pinning each makes a component here false. -/
theorem nonvacuous_credential_isolated_session_trace :
    EnvReachable envRotated ∧
    envRotated.egress = [⟨sessionId, egressBindingId, envDestination, some secretId⟩] ∧
    envRotated.files sessionId "config" = some (.ref secretId) ∧
    (∃ record, envRotated.snapshots snapId = some record ∧
      record.content "config" = some (.ref secretId)) ∧
    envRotated.sessions sessionId = some envSessionRecord ∧
    envRotated.environments envId = some ⟨1, 1⟩ ∧
    (∀ after, ¬ EnvironmentStep envRotated (.send envUse bindingId) after) ∧
    CredentialIsolated envRotated :=
  ⟨envReachableRotated, rfl, rfl, ⟨⟨sessionId, envSent.files sessionId⟩, rfl, rfl⟩, rfl, rfl,
    fun _ => unbound_send_is_refused rfl,
    reachable_credential_isolation envReachableRotated⟩

private def leakedLedger : EnvironmentLedger :=
  { EnvironmentLedger.boot with files := fun _ _ => some (.plaintext secretId) }

/-- The violation is representable and refuted: a ledger whose session filesystem
holds resolved credential plaintext exists as a state — and is proved unreachable.
Adding any transition that resolves a credential into session-visible state (the
".netrc" design this seam exists to forbid) would make this witness false. -/
theorem nonvacuous_plaintext_session_state_unreachable :
    leakedLedger.files sessionId "netrc" = some (.plaintext secretId) ∧
    ¬ EnvReachable leakedLedger :=
  ⟨rfl, plaintext_in_session_state_is_unreachable (ledger := leakedLedger)
    (session := sessionId) (path := "netrc") (secret := secretId) rfl⟩

private def closedSessionRecord : SessionRecord := ⟨envId, 0, 0, turnId, 1, .closed⟩

private def envClosed : EnvironmentLedger :=
  { envRotated with
    sessions := tableSet envRotated.sessions sessionId closedSessionRecord
    files := setFiles envRotated.files sessionId (fun _ => none)
    exposures := revokeSessionExposures envRotated.exposures sessionId }

private theorem envCloseStep :
    EnvironmentStep envRotated (.closeSession sessionId) envClosed :=
  .closeSession (record := envSessionRecord) rfl (by decide)

/-- Fail-closed session lifetime, non-vacuously: closing the reachable session
disposes its state behind a fresh epoch, a child-Facet write against the closed
session is refused, and every further transition of any kind leaves the closed record
untouched — the child Facets cannot outlive their Session. A model that let a closed
or stale session admit a use, or that reopened a closed record, falsifies this. -/
theorem nonvacuous_stale_and_closed_session_rejection :
    EnvironmentStep envRotated (.closeSession sessionId) envClosed ∧
    EnvReachable envClosed ∧
    envClosed.sessions sessionId = some closedSessionRecord ∧
    envClosed.files sessionId "config" = none ∧
    (∀ after, ¬ EnvironmentStep envClosed (.write envUse "x" (.data 1)) after) ∧
    (∀ label after, EnvironmentStep envClosed label after →
      after.sessions sessionId = some closedSessionRecord) :=
  ⟨envCloseStep, .step envReachableRotated envCloseStep, rfl, rfl,
    fun _ => stale_session_admits_nothing (session := closedSessionRecord)
      rfl (Or.inl (by decide)) rfl,
    fun _ _ step => closed_session_is_terminal (record := closedSessionRecord) step rfl rfl⟩

private def liveExposure : ExposureRecord := ⟨sessionId, 0, 3000, true⟩

private def envExposed : EnvironmentLedger :=
  { envRotated with
    exposures := tableSet envRotated.exposures exposureId liveExposure }
private def envPreviewed : EnvironmentLedger :=
  { envExposed with ingress := ⟨exposureId, sessionId, 3000⟩ :: envExposed.ingress }
private def envRevoked : EnvironmentLedger :=
  { envPreviewed with
    exposures := tableSet envPreviewed.exposures exposureId ⟨sessionId, 0, 3000, false⟩ }
private def lostSessionRecord : SessionRecord := ⟨envId, 0, 0, turnId, 1, .lost⟩
private def envLostSession : EnvironmentLedger :=
  { envPreviewed with
    sessions := tableSet envPreviewed.sessions sessionId lostSessionRecord }

private theorem envExposeStep :
    EnvironmentStep envRotated (.expose envUse exposureId 3000) envExposed :=
  .expose envUseAdmittedRotated rfl
private theorem envPreviewStep :
    EnvironmentStep envExposed (.previewIngress exposureId) envPreviewed :=
  .previewIngress (exposure := liveExposure) (session := envSessionRecord)
    rfl rfl rfl rfl rfl
private theorem envRevokeStep :
    EnvironmentStep envPreviewed (.revoke exposureId) envRevoked :=
  .revoke (exposure := liveExposure) rfl
private theorem envLostStep :
    EnvironmentStep envPreviewed (.markLost sessionId) envLostSession :=
  .markLost (record := envSessionRecord) rfl rfl

/-- Preview exposure, non-vacuously: on the reachable session an exposure admits a
preview ingress that reaches exactly the exposed session and port; after revocation
the same exposure admits nothing, and after the session is lost the still-live
exposure record admits nothing either. A preview URL that reached any other target,
survived revocation, or outlived its session falsifies a component here. -/
theorem nonvacuous_preview_exposure_lifecycle :
    EnvReachable envRevoked ∧
    EnvironmentStep envPreviewed (.markLost sessionId) envLostSession ∧
    envPreviewed.ingress = [⟨exposureId, sessionId, 3000⟩] ∧
    (∀ after, EnvironmentStep envExposed (.previewIngress exposureId) after →
      after.ingress = ⟨exposureId, sessionId, 3000⟩ :: envExposed.ingress) ∧
    (∀ after, ¬ EnvironmentStep envRevoked (.previewIngress exposureId) after) ∧
    (∀ after, ¬ EnvironmentStep envLostSession (.previewIngress exposureId) after) := by
  refine ⟨.step (.step (.step envReachableRotated envExposeStep) envPreviewStep)
      envRevokeStep,
    envLostStep, rfl, ?_,
    fun _ => revoked_exposure_admits_no_ingress
      (exposure := ⟨sessionId, 0, 3000, false⟩) rfl rfl,
    fun _ => stale_exposure_admits_no_ingress (exposure := liveExposure)
      (session := lostSessionRecord) rfl rfl (Or.inl (by decide))⟩
  intro after step
  obtain ⟨exposure, session, lookup, _live, _sessionLookup, _phase, _epoch, ingressEq⟩ :=
    preview_ingress_is_exactly_the_exposed_port step
  have exposureExact : exposure = liveExposure := by
    have expected : envExposed.exposures exposureId = some liveExposure := rfl
    rw [expected] at lookup
    exact (Option.some.inj lookup).symm
  subst exposureExact
  exact ingressEq

/-- The §7.2 floor with the Turn-owned Environment Session direct-execute exception,
computed on both sides: a Turn-owned session execute is direct exactly when bundled,
and an unowned execute stays mediated. Dropping the exception fails the first
conjunct; dropping the bundled co-location requirement fails the middle two. -/
theorem nonvacuous_turn_owned_execute_tier :
    effectiveTier .bundled .execute true false = .direct ∧
    effectiveTier .provider .execute true false = .mediated ∧
    effectiveTier .dynamic .execute true false = .mediated ∧
    effectiveTier .bundled .execute false false = .mediated := by decide

private def isolateEgressBinding : BindingId := ⟨61⟩
private def isolateInvokeBinding : BindingId := ⟨62⟩
private def isolateDestination : Destination := ⟨5⟩
private def isolatePassedOne : DynamicDomain :=
  { DynamicDomain.fresh with
    passed := tableSet DynamicDomain.fresh.passed isolateEgressBinding
      ⟨some isolateDestination⟩ }
private def isolatePassedBoth : DynamicDomain :=
  { isolatePassedOne with
    passed := tableSet isolatePassedOne.passed isolateInvokeBinding ⟨none⟩ }
private def isolateInvoked : DynamicDomain :=
  { isolatePassedBoth with
    actions := .invoke isolateInvokeBinding :: isolatePassedBoth.actions }
private def isolateActive : DynamicDomain :=
  { isolateInvoked with
    actions := .egress isolateEgressBinding isolateDestination :: isolateInvoked.actions }

private theorem isolateReachableActive : IsolateReachable isolateActive := by
  have s1 : IsolateStep .fresh
      (.pass isolateEgressBinding ⟨some isolateDestination⟩) isolatePassedOne := .pass rfl
  have r1 : IsolateReachable isolatePassedOne := .step .fresh s1
  have s2 : IsolateStep isolatePassedOne
      (.pass isolateInvokeBinding ⟨none⟩) isolatePassedBoth := .pass rfl
  have r2 : IsolateReachable isolatePassedBoth := .step r1 s2
  have s3 : IsolateStep isolatePassedBoth
      (.invoke isolateInvokeBinding) isolateInvoked := .invoke (capability := ⟨none⟩) rfl
  have r3 : IsolateReachable isolateInvoked := .step r2 s3
  have s4 : IsolateStep isolateInvoked
      (.egress isolateEgressBinding isolateDestination) isolateActive :=
    .egress (capability := ⟨some isolateDestination⟩) rfl rfl
  exact .step r3 s4

/-- Zero ambient authority for a dynamic isolate, non-vacuously: the fresh isolate
admits no first move but a host pass — in particular its egress to a real destination
is refused — while after two explicit passes the isolate genuinely invokes and sends,
every recorded action is backed by a passed Binding, and egress through the
destination-free Binding is still refused. An isolate with any ambient capability or
any reach beyond a passed Binding's named destination falsifies a component here. -/
theorem nonvacuous_dynamic_isolate_provenance :
    (∀ label after, IsolateStep .fresh label after →
      ∃ binding capability, label = .pass binding capability) ∧
    (∀ after, ¬ IsolateStep .fresh (.egress isolateEgressBinding isolateDestination) after) ∧
    IsolateReachable isolateActive ∧
    isolateActive.actions =
      [.egress isolateEgressBinding isolateDestination, .invoke isolateInvokeBinding] ∧
    ActionsBacked isolateActive ∧
    (∀ after, ¬ IsolateStep isolateActive
      (.egress isolateInvokeBinding isolateDestination) after) := by
  refine ⟨fun _ _ step => fresh_dynamic_isolate_admits_only_host_pass step,
    fun _ step => ?_, isolateReachableActive, rfl,
    reachable_isolate_actions_are_binding_backed isolateReachableActive,
    fun _ step => ?_⟩
  · obtain ⟨binding, capability, equal⟩ := fresh_dynamic_isolate_admits_only_host_pass step
    exact IsolateLabel.noConfusion equal
  · obtain ⟨capability, lookup, named⟩ := isolate_egress_matches_passed_destination step
    have destinationFree : capability = ⟨none⟩ := by
      have expected : isolateActive.passed isolateInvokeBinding = some ⟨none⟩ := rfl
      rw [expected] at lookup
      exact (Option.some.inj lookup).symm
    subst destinationFree
    exact Option.noConfusion named

/-- The §4.6 backend manifest admits only `dynamic`: with everything else permissive
the selector places it dynamic, and with a substrate that cannot host dynamic it
places nothing — never an ambient-authority domain. -/
theorem nonvacuous_dynamic_only_manifest_placement :
    choosePlacement dynamicOnlyManifest allModes allModes allModes = some .dynamic ∧
    choosePlacement dynamicOnlyManifest allModes providerModes allModes = none := by decide

private def slateId : SlateId := ⟨1⟩
private def slateVersionOne : SlateVersionId := ⟨1⟩
private def slateVersionTwo : SlateVersionId := ⟨2⟩
private def slatePublicationOne : SlatePublicationId := ⟨1⟩
private def slatePublicationTwo : SlatePublicationId := ⟨2⟩
private def slateDeploymentOne : SlateDeploymentId := ⟨1⟩
private def slateDeploymentTwo : SlateDeploymentId := ⟨2⟩
private def slatePreviewRef : SlatePreviewId := ⟨1⟩

private def slateCreated : SlateLedger :=
  { SlateLedger.empty with
    slates := tableSet SlateLedger.empty.slates slateId ⟨none, none⟩ }
private def slateCommittedOne : SlateLedger :=
  { slateCreated with
    versions := tableSet slateCreated.versions slateVersionOne ⟨slateId, 10, none⟩
    slates := tableSet slateCreated.slates slateId ⟨some slateVersionOne, none⟩ }
private def slatePublishedOne : SlateLedger :=
  { slateCommittedOne with
    publications := tableSet slateCommittedOne.publications slatePublicationOne
      ⟨slateId, slateVersionOne⟩ }
private def slateDeployedOne : SlateLedger :=
  { slatePublishedOne with
    deployments := tableSet slatePublishedOne.deployments slateDeploymentOne
      ⟨slateId, slatePublicationOne, true⟩
    providerContacts := slateDeploymentOne :: slatePublishedOne.providerContacts
    slates := tableSet slatePublishedOne.slates slateId
      ⟨some slateVersionOne, some slateDeploymentOne⟩ }
private def slateCommittedTwo : SlateLedger :=
  { slateDeployedOne with
    versions := tableSet slateDeployedOne.versions slateVersionTwo
      ⟨slateId, 20, some slateVersionOne⟩
    slates := tableSet slateDeployedOne.slates slateId
      ⟨some slateVersionTwo, some slateDeploymentOne⟩ }
private def slatePublishedTwo : SlateLedger :=
  { slateCommittedTwo with
    publications := tableSet slateCommittedTwo.publications slatePublicationTwo
      ⟨slateId, slateVersionTwo⟩ }
private def slateDeployedTwo : SlateLedger :=
  { slatePublishedTwo with
    deployments := tableSet slatePublishedTwo.deployments slateDeploymentTwo
      ⟨slateId, slatePublicationTwo, true⟩
    providerContacts := slateDeploymentTwo :: slatePublishedTwo.providerContacts
    slates := tableSet slatePublishedTwo.slates slateId
      ⟨some slateVersionTwo, some slateDeploymentTwo⟩ }
private def slateRolledBack : SlateLedger :=
  { slateDeployedTwo with
    slates := tableSet slateDeployedTwo.slates slateId
      ⟨some slateVersionTwo, some slateDeploymentOne⟩ }
private def slatePreviewed : SlateLedger :=
  { slateRolledBack with
    previews := tableSet slateRolledBack.previews slatePreviewRef
      ⟨slateId, sessionId, exposureId⟩ }

private theorem slateRollbackStep :
    SlateStep envExposed slateDeployedTwo (.rollback slateId slateDeploymentOne)
      slateRolledBack :=
  .rollback (record := ⟨some slateVersionTwo, some slateDeploymentTwo⟩)
    (deploymentRecord := ⟨slateId, slatePublicationOne, true⟩) rfl rfl rfl rfl

private theorem slateReachablePreviewed :
    SlateReachable envExposed slatePreviewed := by
  have s1 : SlateStep envExposed SlateLedger.empty (.create slateId) slateCreated :=
    .create rfl
  have r1 : SlateReachable envExposed slateCreated := .step .empty s1
  have s2 : SlateStep envExposed slateCreated
      (.commit slateId slateVersionOne 10) slateCommittedOne :=
    .commit (record := ⟨none, none⟩) rfl rfl
  have r2 : SlateReachable envExposed slateCommittedOne := .step r1 s2
  have s3 : SlateStep envExposed slateCommittedOne
      (.publish slateId slatePublicationOne slateVersionOne) slatePublishedOne :=
    .publish (versionRecord := ⟨slateId, 10, none⟩) rfl rfl rfl
  have r3 : SlateReachable envExposed slatePublishedOne := .step r2 s3
  have s4 : SlateStep envExposed slatePublishedOne
      (.deploy slateId slateDeploymentOne slatePublicationOne true) slateDeployedOne :=
    .deploy (record := ⟨some slateVersionOne, none⟩)
      (publicationRecord := ⟨slateId, slateVersionOne⟩) rfl rfl rfl rfl
  have r4 : SlateReachable envExposed slateDeployedOne := .step r3 s4
  have s5 : SlateStep envExposed slateDeployedOne
      (.commit slateId slateVersionTwo 20) slateCommittedTwo :=
    .commit (record := ⟨some slateVersionOne, some slateDeploymentOne⟩) rfl rfl
  have r5 : SlateReachable envExposed slateCommittedTwo := .step r4 s5
  have s6 : SlateStep envExposed slateCommittedTwo
      (.publish slateId slatePublicationTwo slateVersionTwo) slatePublishedTwo :=
    .publish (versionRecord := ⟨slateId, 20, some slateVersionOne⟩) rfl rfl rfl
  have r6 : SlateReachable envExposed slatePublishedTwo := .step r5 s6
  have s7 : SlateStep envExposed slatePublishedTwo
      (.deploy slateId slateDeploymentTwo slatePublicationTwo true) slateDeployedTwo :=
    .deploy (record := ⟨some slateVersionTwo, some slateDeploymentOne⟩)
      (publicationRecord := ⟨slateId, slateVersionTwo⟩) rfl rfl rfl rfl
  have r7 : SlateReachable envExposed slateDeployedTwo := .step r6 s7
  have r8 : SlateReachable envExposed slateRolledBack := .step r7 slateRollbackStep
  have s9 : SlateStep envExposed slateRolledBack
      (.openPreview slateId slatePreviewRef sessionId exposureId) slatePreviewed :=
    .openPreview (record := ⟨some slateVersionTwo, some slateDeploymentOne⟩)
      (exposureRecord := liveExposure) (sessionRecord := envSessionRecord)
      rfl rfl rfl rfl rfl rfl rfl rfl
  exact .step r8 s9

/-- The Slate record plane exercised end to end against the live Environment: two
commits, two publications, two provider-contacting deploys, a rollback, and a
preview. The first version and publication survive every later transition exactly as
written, the provider-contact log shows the two deploys and nothing for the rollback,
the rollback landed the active pointer on the earlier owned successful deployment,
and the preview binds the live Environment Session behind the live exposure. A
mutable version, a provider-contacting rollback, or a preview that is not an
Environment Session falsifies a component here. -/
theorem nonvacuous_slate_lifecycle :
    SlateReachable envExposed slatePreviewed ∧
    SlateStep envExposed slateDeployedTwo (.rollback slateId slateDeploymentOne)
      slateRolledBack ∧
    slatePreviewed.slates slateId = some ⟨some slateVersionTwo, some slateDeploymentOne⟩ ∧
    slatePreviewed.versions slateVersionOne = some ⟨slateId, 10, none⟩ ∧
    slatePreviewed.publications slatePublicationOne = some ⟨slateId, slateVersionOne⟩ ∧
    slatePreviewed.providerContacts = [slateDeploymentTwo, slateDeploymentOne] ∧
    slatePreviewed.previews slatePreviewRef = some ⟨slateId, sessionId, exposureId⟩ :=
  ⟨slateReachablePreviewed, slateRollbackStep, rfl, rfl, rfl, rfl, rfl⟩
/-! §4.4 interception pipeline witnesses. Three interceptors over one value in flight:
`alpha` rewrites, `gamma` passes through unchanged, `beta` rewrites again. `gamma` and
`beta` share a priority, so only the facet component separates them — the order tie the
total `(priority, facetId, interceptorId)` key exists to break. -/

private def alphaRef : InterceptorRef := ⟨⟨1⟩, 1⟩
private def gammaRef : InterceptorRef := ⟨⟨1⟩, 2⟩
private def betaRef : InterceptorRef := ⟨⟨2⟩, 1⟩
private def rogueRef : InterceptorRef := ⟨⟨3⟩, 1⟩
private def alphaContribution : InterceptorContribution := ⟨alphaRef, .before, 1⟩
private def gammaContribution : InterceptorContribution := ⟨gammaRef, .before, 2⟩
private def betaContribution : InterceptorContribution := ⟨betaRef, .before, 2⟩
private def pipelineSchedule : List InterceptorContribution :=
  [alphaContribution, gammaContribution, betaContribution]

private def rawValue : StructuralValue := ⟨"json-v1", ["raw"]⟩
private def proxiedValue : StructuralValue := ⟨"json-v1", ["proxied"]⟩
private def stampedValue : StructuralValue := ⟨"json-v1", ["stamped"]⟩

private def pipelineBehavior : InterceptorBehavior := fun interceptor value =>
  if interceptor = alphaRef then .proceed proxiedValue
  else if interceptor = betaRef then .proceed stampedValue
  else .proceed value

private def pipelineTrace : List InterceptorTransformation :=
  [⟨alphaRef, rawValue, proxiedValue⟩, ⟨gammaRef, proxiedValue, proxiedValue⟩,
    ⟨betaRef, proxiedValue, stampedValue⟩]
private def pipelineFinal : InterceptionState :=
  ⟨rawValue, stampedValue, pipelineTrace, [], none⟩

private theorem pipelineOrdered : ScheduleOrdered pipelineSchedule :=
  ⟨Or.inl (by decide), Or.inr ⟨rfl, Or.inl (by decide)⟩, trivial⟩

private theorem pipelineRun : InterceptRun pipelineBehavior
    (startInterception pipelineSchedule rawValue) pipelineFinal :=
  .step (.proceed (next := alphaContribution)
      (rest := [gammaContribution, betaContribution]) (output := proxiedValue) rfl rfl rfl)
    (.step (.proceed (next := gammaContribution) (rest := [betaContribution])
        (output := proxiedValue) rfl rfl rfl)
      (.step (.proceed (next := betaContribution) (rest := [])
          (output := stampedValue) rfl rfl rfl)
        (.refl pipelineFinal)))

/-- The pipeline consequences on one concrete run. Discrimination: the misordered
permutation is refused, so ordering is not vacuously total; the trace names the
interceptors in exactly the schedule order; attribution picks `beta` — the *last*
rewriter, not the first (`alpha`) and not the last executed (`gamma`, which passed
unchanged); replay reproduces the final value from the trace alone; and every halted
outcome of the same start equals this one, so the step relation admits no second
execution order. -/
theorem nonvacuous_interception_pipeline_run :
    ScheduleOrdered pipelineSchedule ∧
    ¬ ScheduleOrdered [alphaContribution, betaContribution, gammaContribution] ∧
    (∀ schedule, ScheduleOrdered schedule →
      (∀ contribution, contribution ∈ schedule ↔ contribution ∈ pipelineSchedule) →
      schedule = pipelineSchedule) ∧
    InterceptRun pipelineBehavior (startInterception pipelineSchedule rawValue)
      pipelineFinal ∧
    pipelineFinal.Completed ∧
    pipelineFinal.trace.map InterceptorTransformation.interceptor =
      pipelineSchedule.map InterceptorContribution.interceptor ∧
    lastRewrite pipelineFinal.trace = some ⟨betaRef, proxiedValue, stampedValue⟩ ∧
    replayInterceptions rawValue pipelineFinal.trace = some stampedValue ∧
    (∀ outcome,
      InterceptRun pipelineBehavior (startInterception pipelineSchedule rawValue) outcome →
      outcome.Halted → outcome = pipelineFinal) := by
  refine ⟨pipelineOrdered, ?_, ?_, pipelineRun, ⟨rfl, rfl⟩, rfl, by decide, by decide, ?_⟩
  · intro misordered
    exact interceptor_order_asymm (left := gammaContribution) (right := betaContribution)
      (Or.inr ⟨rfl, Or.inl (by decide)⟩) misordered.2.1
  · intro schedule ordered same
    exact ordered_schedule_unique ordered pipelineOrdered same
  · intro outcome run halted
    exact interception_outcome_deterministic run halted pipelineRun (Or.inl rfl)

private def blockingBehavior : InterceptorBehavior := fun interceptor _ =>
  if interceptor = alphaRef then .proceed proxiedValue
  else if interceptor = gammaRef then .block "policy denied"
  else .proceed stampedValue

private def blockedFinal : InterceptionState :=
  ⟨rawValue, proxiedValue, [⟨alphaRef, rawValue, proxiedValue⟩], [betaContribution],
    some ⟨gammaRef, "policy denied"⟩⟩

private theorem blockedRun : InterceptRun blockingBehavior
    (startInterception pipelineSchedule rawValue) blockedFinal :=
  .step (.proceed (next := alphaContribution)
      (rest := [gammaContribution, betaContribution]) (output := proxiedValue) rfl rfl rfl)
    (.step (.block (next := gammaContribution) (rest := [betaContribution]) rfl rfl rfl)
      (.refl blockedFinal))

/-- A mid-schedule block on the same schedule. Discrimination: the blocked state names
exactly `gamma` with its reason, the trace keeps `alpha`'s completed rewrite, `beta` —
scheduled after the blocker — is never attributed anything, and no continuation of the
blocked pipeline completes. -/
theorem nonvacuous_interceptor_block_scoped_and_final :
    InterceptRun blockingBehavior (startInterception pipelineSchedule rawValue)
      blockedFinal ∧
    blockedFinal.blocked = some ⟨gammaRef, "policy denied"⟩ ∧
    (∃ ran blocker, pipelineSchedule = ran ++ blocker :: blockedFinal.pending ∧
      blocker.interceptor = gammaRef ∧
      blockedFinal.trace.map InterceptorTransformation.interceptor =
        ran.map InterceptorContribution.interceptor) ∧
    (∀ entry, entry ∈ blockedFinal.trace → entry.interceptor ≠ betaRef) ∧
    (∀ outcome, InterceptRun blockingBehavior blockedFinal outcome →
      ¬ outcome.Completed) := by
  refine ⟨blockedRun, rfl, blocked_names_exact_scheduled_interceptor blockedRun rfl, ?_, ?_⟩
  · intro entry member
    rcases List.mem_cons.mp member with rfl | absent
    · decide
    · cases absent
  · intro outcome run
    exact blocked_pipeline_never_completes rfl run

private def tamperedTrace : List InterceptorTransformation :=
  [⟨alphaRef, rawValue, proxiedValue⟩, ⟨betaRef, stampedValue, stampedValue⟩]

/-- Replay accepts exactly the recorded chain. Discrimination: the genuine trace
replays to the recorded result, while a tampered copy whose second entry claims a
different input than its predecessor produced is refused outright — no output
completes it as a chain. If replay ignored the nested link validation, the tampered
trace would still produce a value. -/
theorem nonvacuous_tampered_interception_replay_refused :
    replayInterceptions rawValue pipelineTrace = some stampedValue ∧
    replayInterceptions rawValue tamperedTrace = none ∧
    ¬ ∃ output, TransformationChain rawValue output tamperedTrace := by
  refine ⟨by decide, by decide, ?_⟩
  exact replay_refuses_exactly_broken_chains.mp (by decide)

private def firstPreparedItem : PreparedItem := ⟨0, firstArgs, firstKey⟩
private def afterContribution : InterceptorContribution := ⟨betaRef, .after, 1⟩

private def phaseBehavior : InterceptorBehavior := fun interceptor _ =>
  if interceptor = alphaRef then .proceed firstPreparedArgs else .proceed firstPresentation

private def beforePhaseFinal : InterceptionState :=
  ⟨firstArgs, firstPreparedArgs, [⟨alphaRef, firstArgs, firstPreparedArgs⟩], [], none⟩
private def afterPhaseFinal : InterceptionState :=
  ⟨firstEffectOutput, firstPresentation,
    [⟨betaRef, firstEffectOutput, firstPresentation⟩], [], none⟩

private theorem beforePhaseRun : InterceptRun phaseBehavior
    (startInterception [alphaContribution] firstArgs) beforePhaseFinal :=
  .step (.proceed (next := alphaContribution) (rest := [])
      (output := firstPreparedArgs) rfl rfl rfl)
    (.refl beforePhaseFinal)

private theorem afterPhaseRun : InterceptRun phaseBehavior
    (startInterception [afterContribution] firstEffectOutput) afterPhaseFinal :=
  .step (.proceed (next := afterContribution) (rest := [])
      (output := firstPresentation) rfl rfl rfl)
    (.refl afterPhaseFinal)

private def bridgedReplayItem : ReplayItem :=
  ⟨0, firstKey, [⟨alphaRef, firstArgs, firstPreparedArgs⟩], firstPreparedArgs,
    firstEffectOutput, [⟨betaRef, firstEffectOutput, firstPresentation⟩], firstPresentation⟩

/-- The runtime pipeline meets the persisted replay model on a real item of the batch
PreparedInvocation: a completed before run over the item's arguments and a completed
after run over its effect output assemble a `ReplayItem` that is `ValidFor` the exact
item, and its persisted chains replay to the persisted prepared arguments and
presentation without rerunning either pass. Discrimination: `ValidFor` binds index,
key, and both nested chains — a swapped key, reordered chain, or substituted output
breaks it. -/
theorem nonvacuous_interception_replay_item_bridge :
    firstPreparedItem ∈ prepared.items ∧
    ReplayItem.ValidFor bridgedReplayItem firstPreparedItem ∧
    replayInterceptions firstPreparedItem.arguments bridgedReplayItem.before =
      some bridgedReplayItem.preparedArguments ∧
    replayInterceptions bridgedReplayItem.effectOutput bridgedReplayItem.after =
      some bridgedReplayItem.presentation := by
  have valid : ReplayItem.ValidFor bridgedReplayItem firstPreparedItem :=
    completed_runs_assemble_valid_replay_item (item := firstPreparedItem)
      beforePhaseRun afterPhaseRun
  refine ⟨?_, valid, (replay_item_reuses_persisted_transformations valid).1,
    (replay_item_reuses_persisted_transformations valid).2⟩
  exact List.mem_cons_self ..

private def interceptionSite : InterceptionSite :=
  ⟨⟨⟨1⟩, "web.fetch", 1⟩, .workspace tenant workspace, true⟩
private def interceptionGrants : FacetId → OperationId → Prop :=
  fun contributor operation => contributor = ⟨2⟩ ∧ operation = interceptionSite.operation
private def interceptionDomains : FacetId → ProtectionDomain := fun _ => interceptionSite.domain

private theorem pipelineAdmitted : AdmittedSchedule interceptionGrants interceptionDomains
    interceptionSite .before pipelineSchedule := by
  refine ⟨pipelineOrdered, ?_⟩
  intro contribution member
  rcases List.mem_cons.mp member with rfl | member
  · exact ⟨rfl, rfl, Or.inl rfl⟩
  rcases List.mem_cons.mp member with rfl | member
  · exact ⟨rfl, rfl, Or.inl rfl⟩
  rcases List.mem_cons.mp member with rfl | member
  · exact ⟨rfl, rfl, Or.inr ⟨rfl, rfl, rfl⟩⟩
  · cases member

/-- The §4.4 rules 1-2 boundary, on the admitted pipeline. `alpha` and `gamma`
intercept their own facet's operation; `beta` is foreign but the target opted in and a
Grant exists. Discrimination: the rogue facet shares the protection domain and still
may not intercept — domain sharing confers nothing; the granted `beta` is refused the
moment its domain differs (rule 1) or the target withdraws `interceptable` (rule 2);
and across every state the concrete run reaches, no transformation is ever attributed
to the rogue. -/
theorem nonvacuous_unauthorized_interceptor_never_attributed :
    AdmittedSchedule interceptionGrants interceptionDomains interceptionSite .before
      pipelineSchedule ∧
    interceptionDomains rogueRef.facet = interceptionSite.domain ∧
    ¬ MayIntercept interceptionGrants interceptionDomains interceptionSite
      ⟨rogueRef, .before, 3⟩ ∧
    ¬ MayIntercept interceptionGrants (fun _ => .run tenant runId) interceptionSite
      betaContribution ∧
    ¬ MayIntercept interceptionGrants interceptionDomains
      { interceptionSite with interceptable := false } betaContribution ∧
    (∀ entry, entry ∈ pipelineFinal.trace → entry.interceptor ≠ rogueRef) := by
  refine ⟨pipelineAdmitted, rfl, ?_, ?_, ?_, ?_⟩
  · exact ungranted_cross_facet_interception_rejected (by decide)
      fun granted => absurd granted.1 (by decide)
  · exact cross_domain_interception_rejected (by decide)
  · exact undeclared_cross_facet_interception_rejected (by decide) rfl
  · exact unauthorized_interceptor_never_attributed pipelineAdmitted pipelineRun
      fun contribution named =>
        ungranted_cross_facet_interception_rejected
          (by rw [named]; decide) fun granted => absurd (named ▸ granted.1) (by decide)

private def interceptedObligation : OpenObligation := .item invocationId 0 firstKey
private def observedInterceptor : InterceptorContribution := ⟨⟨facet, 9⟩, .before, 5⟩
private def interceptedObservation : AdmissionRequest :=
  ⟨prepared, scope, resolution.id, some ⟨runId, 0, interceptedObligation⟩, ⟨1⟩,
    [observedInterceptor]⟩
private def interceptedRegistry : RunAdmissionRegistry := ⟨0, true, [interceptedObligation], []⟩
private def interceptedGraph : GraphStore := {
  graphWithTurn with
  admissionRegistry := tableSet graphWithTurn.admissionRegistry runId interceptedRegistry
}
private def interceptedState : SystemState := { directState with graph := interceptedGraph }
private def interceptedIntentEffects : EffectLedger := {
  (default : EffectLedger) with
  invocations := tableSet (default : EffectLedger).invocations invocationId prepared
}
private def interceptedIntentState : SystemState :=
  { interceptedState with effects := interceptedIntentEffects }

private theorem interceptedAuthorized :
    issuedAuthority.Authorized principalRef header scope := by
  refine ⟨binding, allowGrant,
    by simp [issuedAuthority, AuthorityLedger.issueResolution, authorityBase, header,
      InvocationHeader.binding, AuthoritySource.binding],
    rfl, rfl, rfl, rfl, ?_, rfl, ?_, ?_⟩
  · apply AuthorityLedger.LiveGrant.root
    · simp [issuedAuthority, AuthorityLedger.issueResolution, authorityBase, binding, grantId]
    · rfl
    · intro revoked; contradiction
  · exact ⟨rfl, rfl, Scope.contains_refl scope, rfl, rfl⟩
  · intro denied
    obtain ⟨id, grant, live, deny, applies⟩ := denied
    cases live with
    | root lookup _ _ | child lookup _ _ _ =>
        by_cases same : id = grantId
        · subst id
          change tableSet (default : AuthorityLedger).grants grantId allowGrant grantId =
            some grant at lookup
          rw [tableSet_self] at lookup
          cases Option.some.inj lookup
          contradiction
        · change tableSet (default : AuthorityLedger).grants grantId allowGrant id =
            some grant at lookup
          rw [tableSet_other _ _ _ same] at lookup
          contradiction

private theorem interceptedPathComplete :
    issuedAuthority.PathEvidenceComplete header scope := by
  change authorityBase.PathEvidenceComplete header scope
  exact completePath

private theorem interceptedMediatedReady :
    MediatedReady interceptedState interceptedObservation := by
  refine ⟨rfl, ⟨rfl, ?_⟩, ?_, rfl, ?_, ?_, resolution, ?_, ?_, rfl, ?_, ?_⟩
  · intro noLease
    simp [interceptedObservation, prepared, header] at noLease
  · simp [RouteGate, InvocationHeader.RouteEvidenceConsistent, interceptedObservation,
      prepared, header]
  · exact ⟨runningTurn,
      by simp [interceptedState, interceptedGraph, graphWithTurn, token, turnId], rfl,
      ⟨directRun, by simp [interceptedState, interceptedGraph, graphWithTurn, runningTurn],
        rfl, rfl, rfl⟩,
      ⟨rfl, rfl, rfl, by decide⟩⟩
  · refine ⟨directRun, ⟨runId, 0, interceptedObligation⟩,
      by simp [interceptedState, interceptedGraph, graphWithTurn, runningTurn],
      rfl, rfl, rfl, interceptedRegistry, ?_, rfl, rfl, ?_, ?_⟩
    · simp [interceptedState, interceptedGraph, runId]
    · exact List.mem_cons_self ..
    · simp [interceptedRegistry]
  · change tableSet authorityBase.resolutions resolution.id resolution resolution.id =
      some resolution
    exact tableSet_self ..
  · change tableSet authorityBase.resolutions resolution.id resolution resolution.id =
      some resolution
    exact tableSet_self ..
  · exact interceptedAuthorized
  · exact interceptedPathComplete

private theorem interceptedPersistIntent :
    MediatedStep interceptedState (.persistIntent invocationId) interceptedIntentState := by
  apply MediatedStep.persistIntent (request := interceptedObservation)
  · exact interceptedMediatedReady
  · exact EffectStep.persistIntent rfl

/-- §7.2 escalation, both directions on the same observe Invocation. Without the
interceptor the bundled, leased observe call is direct-admissible; the moment an
applicable `operation.before` contribution rides along, no state admits it directly —
and the same state that grounds the refusal admits it through the mediated pipeline by
durably persisting its intent. If the model dropped the interceptor tier raise, the
universal refusal below would be false at `directState`. -/
theorem nonvacuous_intercepted_observe_escalates_to_mediated :
    prepared.header.impact = .observe ∧
    prepared.header.placement.selected = .bundled ∧
    directRequest.interceptors = [] ∧
    DirectStep directState directRequest directState ∧
    interceptedObservation.prepared = directRequest.prepared ∧
    interceptedObservation.interceptors = [observedInterceptor] ∧
    (∀ before after, ¬ DirectStep before interceptedObservation after) ∧
    MediatedStep interceptedState (.persistIntent invocationId) interceptedIntentState := by
  refine ⟨rfl, rfl, rfl, .admit directReady, rfl, rfl, ?_, interceptedPersistIntent⟩
  exact applicable_interceptor_forbids_direct_admission (List.mem_cons_self ..)

end AgentCore.Examples
