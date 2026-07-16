import AgentCore.Proofs.Reachability

/-! Constructive witnesses for the final designated claim families. -/

namespace AgentCore.Examples

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
    [⟨0, firstKey, [⟨1, firstArgs, firstPreparedArgs⟩], firstPreparedArgs,
        firstEffectOutput, [⟨2, firstEffectOutput, firstPresentation⟩], firstPresentation⟩,
      ⟨1, secondKey, [⟨1, secondArgs, secondPreparedArgs⟩], secondPreparedArgs,
        secondEffectOutput, [⟨2, secondEffectOutput, secondPresentation⟩], secondPresentation⟩]⟩

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
  ⟨.principal principal, scope, .allow, header.permission, none, .manual⟩
private def binding : Binding := ⟨header.domain, scope, "observer", grantId, facet⟩
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
  ⟨tenant, workspace, agent, pins, ⟨100⟩, branchId, none, .active⟩
private def graphWithTurn : GraphStore := {
  (default : GraphStore) with
  runs := tableSet (default : GraphStore).runs runId directRun
  turns := tableSet (default : GraphStore).turns turnId runningTurn
}
private def directState : SystemState := {
  (default : SystemState) with authority := issuedAuthority, graph := graphWithTurn
}
private def directRequest : AdmissionRequest := ⟨prepared, scope, resolution.id, none, ⟨1⟩⟩

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

private def attempt0 : EffectAttempt :=
  ⟨invocationId, 0, 0, .run tenant runId, ⟨2⟩, firstKey, some token, ⟨1⟩⟩
private def attempt1 : EffectAttempt :=
  ⟨invocationId, 1, 0, .run tenant runId, ⟨3⟩, secondKey, some token, ⟨1⟩⟩
private def successReceipt : AttemptReceipt := ⟨⟨1⟩, .succeeded, none, ⟨4⟩⟩
private def failedReceipt : AttemptReceipt := ⟨⟨2⟩, .failed, none, ⟨5⟩⟩
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
private def retryNext : EffectAttempt := { attempt1 with ordinal := 1, auditCause := ⟨6⟩ }
private def retryClaimExpiry : Time := ⟨10⟩
private def retryAdmission : AttemptAdmission :=
  ⟨prepared.identity, principalRef, scope, resolution.id⟩
private def retryBefore : EffectLedger := {
  (default : EffectLedger) with
  invocations := tableSet (default : EffectLedger).invocations invocationId prepared
  attempts := tableSet (default : EffectLedger).attempts ⟨2⟩ retryPrior
  admissions := tableSet (default : EffectLedger).admissions ⟨3⟩ retryAdmission
  attemptReceipts := tableSet (default : EffectLedger).attemptReceipts ⟨11⟩ failedReceipt
  latestAttempt := fun invocation index =>
    if invocation = invocationId ∧ index = 1 then some ⟨2⟩ else none
  currentReceipt := fun invocation index =>
    if invocation = invocationId ∧ index = 1 then some (.attempt ⟨11⟩) else none
}

theorem nonvacuous_failed_retry :
    EffectStep retryBefore (.retryAttempt ⟨2⟩ ⟨3⟩)
      (retryBefore.addRetryAttempt ⟨3⟩ retryNext retryClaimExpiry) := by
  apply EffectStep.retryAttempt (prior := retryPrior) (prepared := prepared)
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
  · decide

private def indeterminateReceipt : AttemptReceipt := ⟨⟨1⟩, .indeterminate, none, ⟨7⟩⟩
private def supersedingReceipt : AttemptReceipt := ⟨⟨1⟩, .succeeded, some ⟨12⟩, ⟨8⟩⟩
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
  · trivial

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

private def issuedPermit : AuthorityPermit :=
  ⟨principalRef, invocationId, ⟨1⟩, 0, header.pathEvidence, 7, ⟨1⟩, ⟨10⟩⟩
private def permitLedger : PermitLedger :=
  ⟨fun nonce => if nonce = 7 then some issuedPermit else none, fun _ => False⟩

theorem nonvacuous_post_issuance_watermark_cutoff :
    permitLedger.Consumable issuedPermit ⟨2⟩ := by
  apply post_issuance_watermark_cannot_cancel_permit
    (before := authorityBase) (after := authorityBase.observeForHolder principalRef scope)
  · intro target
    by_cases member : target ∈ scope.path
    · simp [AuthorityLedger.observeForHolder, issuedPermit, member]
      exact Nat.le_max_left _ _
    · simp [AuthorityLedger.observeForHolder, issuedPermit, member]
  exact ⟨by simp [permitLedger, issuedPermit], by simp [permitLedger], by decide, by decide⟩

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
private def run : Run := ⟨tenant, workspace, agent, pins, rootCommitId, branchId, none, .active⟩
private def rootCommit : RunCommit :=
  ⟨runId, branchId, pins, .root ⟨1⟩, [], none, .root⟩
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
  · simp [RunPins.Valid, run, pins, agent]
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
    [rootCommitId], none, .migration invalidMigrationPins header.operation ⟨30⟩⟩

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
  ⟨runId, sourceBranch, pins, .root ⟨1⟩, [], none, .root⟩
private def mergeGraph : GraphStore := {
  rootGraph with
  branches := tableSet rootGraph.branches sourceBranch ⟨runId⟩
  commits := tableSet rootGraph.commits sourceHead sourceCommit
  heads := tableSet rootGraph.heads sourceBranch sourceHead
}
private def mergeCommit : RunCommit :=
  ⟨runId, branchId, pins, .system (.control ⟨1⟩ ⟨30⟩),
    [rootCommitId, sourceHead], none,
    .merge (.concatenate ⟨30⟩) (.clean ⟨1⟩)⟩

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
    some turnId, .deliveryEvidence header.operation reservationId .succeeded⟩

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
private def controlAttempt : EffectAttempt :=
  ⟨controlInvocation, 0, 0, .run tenant runId, ⟨30⟩,
    deriveItemKey controlHeader controlPrepared.payload 0 firstArgs, none, ⟨1⟩⟩
private def synthesisAttempt : EffectAttempt :=
  ⟨synthesisInvocation, 0, 0, .run tenant runId, ⟨31⟩,
    deriveItemKey synthesisHeader synthesisPrepared.payload 0 secondArgs, some token, ⟨1⟩⟩
private def controlReceipt : AttemptReceipt := ⟨⟨30⟩, .succeeded, none, ⟨32⟩⟩
private def synthesisReceipt : AttemptReceipt := ⟨⟨31⟩, .succeeded, none, ⟨33⟩⟩
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
      (.clean ⟨2⟩)⟩

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
    .terminal .succeeded⟩
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

private theorem terminalControlAuditCause : AuditCauseExists terminalAuditLog ⟨34⟩ runId := by
  refine ⟨controlCommitAuditEntry, ?_, rfl⟩
  change tableSet (tableSet (default : AuditLog).entries ⟨34⟩ controlCommitAuditEntry)
    ⟨1⟩ rootAudit ⟨34⟩ = some controlCommitAuditEntry
  rw [tableSet_other _ _ _ (by decide)]
  exact tableSet_self ..

private theorem terminalControlValid :
    TerminalizationControl.Valid synthesisEffects terminalAuditLog runId terminalControl := by
  refine ⟨synthesisOperation, controlReceipt, controlAttempt, controlPrepared,
    controlCommitAuditEntry, controlSuccess, ?_, ?_, ?_, ?_, rfl⟩
  · change tableSet (tableSet (default : AuditLog).entries ⟨34⟩ controlCommitAuditEntry)
      ⟨1⟩ rootAudit ⟨34⟩ = some controlCommitAuditEntry
    rw [tableSet_other _ _ _ (by decide)]
    exact tableSet_self ..
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
  · trivial

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
private def indeterminateAttempt : EffectAttempt :=
  ⟨invocationId, 0, 0, .run tenant runId, ⟨40⟩,
    deriveItemKey header oneItemPrepared.payload 0 firstArgs, some token, ⟨1⟩⟩
private def batchIndeterminateReceipt : AttemptReceipt := ⟨⟨40⟩, .indeterminate, none, ⟨41⟩⟩
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
private def actionHeader : InvocationHeader := {
  noTurnHeader with
  authority := .initiator principalRef actionBindingId
}
private def actionPrepared : PreparedInvocation := ⟨actionHeader, .batch firstArgs [secondArgs]⟩
private def actionGrant : Grant :=
  ⟨.principal principal, scope, .allow, actionHeader.permission, none, .manual⟩
private def actionBinding : Binding :=
  ⟨actionHeader.domain, scope, "sender", actionGrantId, facet⟩
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
private def actionState : SystemState := {
  (default : SystemState) with
  authority := actionAuthority
  audit := auditOne
  graph := actionGraph
}
private def actionRequest (obligation : OpenObligation) : AdmissionRequest :=
  ⟨actionPrepared, scope, actionResolution.id, some ⟨runId, 0, obligation⟩, ⟨1⟩⟩
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
  · exact ⟨rootAudit, by simp [actionState, auditOne, actionRequest, actionPrepared,
      actionHeader, noTurnHeader, header], rfl, rfl, rfl⟩
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
private def actionAttempt : EffectAttempt :=
  ⟨actionInvocation, 0, 0, .run tenant runId, ⟨50⟩,
    deriveItemKey actionHeader actionPrepared.payload 0 firstArgs, none, ⟨2⟩⟩
private def actionClaim : ItemClaim :=
  ⟨actionInvocation, 0, 0, .run tenant runId, ⟨10⟩⟩
private def claimedEffects : EffectLedger := requestedEffects.setClaim actionClaim
private def claimedState : SystemState := { approvedState with effects := claimedEffects }
private def startedEffects : EffectLedger :=
  (claimedEffects.recordAdmission ⟨50⟩ (admissionFor actionFirstRequest)).addAttempt
    ⟨50⟩ actionAttempt
private def startedState : SystemState := {
  claimedState with
  approvals := approvedApprovals.consume actionApproval actionPrepared ⟨50⟩
  effects := startedEffects
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
  ⟨actionInvocation, 1, 0, .run tenant runId, ⟨10⟩⟩
private def actionSecondAttempt : EffectAttempt :=
  ⟨actionInvocation, 1, 0, .run tenant runId, ⟨51⟩,
    deriveItemKey actionHeader actionPrepared.payload 1 secondArgs, none, ⟨3⟩⟩
private def secondClaimedEffects : EffectLedger := startedEffects.setClaim actionSecondClaim
private def secondClaimedState : SystemState := { startedState with effects := secondClaimedEffects }
private def continuedEffects : EffectLedger :=
  (secondClaimedEffects.recordAdmission ⟨51⟩ (admissionFor actionSecondRequest)).addAttempt
    ⟨51⟩ actionSecondAttempt
private def continuedState : SystemState := { secondClaimedState with effects := continuedEffects }

theorem nonvacuous_claim_records_future_expiry :
    EffectStep requestedEffects (.claimItem actionInvocation 0 ⟨1⟩) claimedEffects ∧
    ∃ claim, claimedEffects.claims actionInvocation 0 = some claim ∧ 1 < claim.expiresAt.tick := by
  have claimStep :
      EffectStep requestedEffects (.claimItem actionInvocation 0 ⟨1⟩) claimedEffects := by
    apply EffectStep.claimItem (prepared := actionPrepared) (claim := actionClaim)
      (item := ⟨0, firstArgs,
        deriveItemKey actionHeader actionPrepared.payload 0 firstArgs⟩)
    · simp [requestedEffects, actionClaim]
    · rfl
    · rfl
    · decide
    · rfl
    · rfl
    · rfl
  exact ⟨claimStep, claim_records_future_expiry claimStep⟩

theorem nonvacuous_request_approve_start_trace :
    MediatedStep actionState (.requestApproval actionApproval actionInvocation) requestedState ∧
    ApprovalStep requestedApprovals (.approve actionApproval principal ⟨1⟩) approvedApprovals ∧
    MediatedStep approvedState (.claimItem actionInvocation 0 ⟨1⟩) claimedState ∧
    MediatedStep claimedState (.approvalStart actionApproval actionInvocation ⟨50⟩) startedState := by
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
        · decide
        · rfl
        · rfl
        · rfl
    · have claimedReady : MediatedReady claimedState actionFirstRequest := by
        simpa [claimedState] using approvedReady
      change MediatedStep claimedState
        (.approvalStart actionApproval actionPrepared.header.invocation ⟨50⟩) startedState
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
            rfl, rfl, rfl, rfl, by decide⟩
        · rfl
        · rfl
      · simp [startedEffects, EffectLedger.addAttempt, tableSet_self]

theorem nonvacuous_approval_start_then_continue :
    MediatedStep claimedState (.approvalStart actionApproval actionInvocation ⟨50⟩) startedState ∧
    MediatedStep startedState (.claimItem actionInvocation 1 ⟨1⟩) secondClaimedState ∧
    MediatedStep secondClaimedState
      (.approvalContinue actionApproval actionInvocation ⟨51⟩) continuedState := by
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
      · decide
      · rfl
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
          rfl, rfl, rfl, rfl, by decide⟩
      · rfl
      · rfl
    · simp [continuedEffects, EffectLedger.addAttempt, tableSet_self]

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
      (.approvalContinue actionApproval actionInvocation ⟨51⟩) continuedState := by
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
  ⟨.principal principal, tenantScope, .allow, header.permission, none, .manual⟩
private def childGrant : Grant :=
  ⟨.principal principal, scope, .allow, header.permission, some parentGrantId, .manual⟩
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
  ⟨actionInvocation, 0, .denied, ⟨60⟩⟩
private def staleEffects : EffectLedger := requestedEffects.addPreReceipt ⟨60⟩ staleReceipt
private theorem actionPathComplete : actionAuthority.PathEvidenceComplete actionHeader scope := by
  constructor
  · rfl
  · intro evidence member
    change evidence ∈ [⟨tenantScope, 0⟩, ⟨scope, 0⟩] at member
    simp only [List.mem_cons, List.mem_nil_iff, or_false] at member
    rcases member with rfl | rfl <;> rfl

theorem nonvacuous_stale_mediated_denial :
    MediatedStep staleState (.staleDenied actionInvocation ⟨60⟩) {
      staleState with
      authority := staleAuthority.observeForHolder principalRef scope
      effects := staleEffects
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
  ⟨runId, branchId, pins, .turn token ⟨1⟩, [rootCommitId], some turnId, .message⟩
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
    ReachableFrom claimedState startedState ∧
    ∃ attempt admission,
      startedState.effects.attempts ⟨50⟩ = some attempt ∧
      startedState.effects.admissions ⟨50⟩ = some admission ∧
      admission.identity = actionPrepared.identity ∧
      admission.principal = actionPrepared.header.authority.principal := by
  have transition := nonvacuous_request_approve_start_trace.2.2.2
  have reachable : ReachableFrom claimedState startedState := .step .initial transition
  refine ⟨reachable, actionAttempt, admissionFor actionFirstRequest, ?_, ?_, rfl, rfl⟩
  · simp [startedState, startedEffects, EffectLedger.addAttempt]
  · simp [startedState, startedEffects, EffectLedger.addAttempt, EffectLedger.recordAdmission]

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
private def recoveredClaim : ItemClaim :=
  { actionClaim with owner := .workspace tenant workspace, expiresAt := ⟨10⟩ }
private def abandonedClaimLedger : EffectLedger := requestedEffects.setClaim abandonedClaim
private def recoveredClaimLedger : EffectLedger := abandonedClaimLedger.setClaim recoveredClaim

theorem nonvacuous_abandoned_claim_same_ordinal_recovery :
    EffectStep abandonedClaimLedger (.recoverItemClaim actionInvocation 0 ⟨3⟩)
      recoveredClaimLedger ∧
    abandonedClaim.expiresAt.tick ≤ 3 ∧ 3 < recoveredClaim.expiresAt.tick ∧
    recoveredClaim.ordinal = abandonedClaim.ordinal ∧
    NoEffectAttemptFor abandonedClaimLedger actionInvocation 0 := by
  have recovery :
      EffectStep abandonedClaimLedger (.recoverItemClaim actionInvocation 0 ⟨3⟩)
        recoveredClaimLedger := by
    apply EffectStep.recoverItemClaim (previous := abandonedClaim) (replacement := recoveredClaim)
    · simp [abandonedClaimLedger, abandonedClaim, actionClaim, EffectLedger.setClaim]
    · decide
    · rfl
    · rfl
    · rfl
    · decide
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

end AgentCore.Examples
