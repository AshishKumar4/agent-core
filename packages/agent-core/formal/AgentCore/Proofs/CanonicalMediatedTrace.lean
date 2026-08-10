import AgentCore.Proofs.Reachability

/-!
# Canonical mediated-attempt witness

This file constructs one single-item, workspace-owned, mediated mutation. Trusted
bootstrap establishes the initial grant, binding, and resolution; runtime `SystemStep`
then establishes the root audit, persisted intent, item claim, distributed permit
issuance and transport, target authentication, and target-local atomic
consume-plus-attempt transition. The path deliberately includes duplication, loss,
restart, reset, and reauthentication. No assembled intermediate is assumed reachable.
-/

namespace AgentCore.CanonicalMediatedTrace

private def tenant : TenantId := ⟨1⟩
private def workspace : WorkspaceId := ⟨1⟩
private def principal : PrincipalId := ⟨1⟩
private def principalRef : PrincipalRef := ⟨tenant, principal⟩
private def facet : FacetId := ⟨1⟩
private def bindingId : BindingId := ⟨1⟩
private def grantId : GrantId := .manual 1
private def invocationId : InvocationId := ⟨1⟩
private def resolutionId : ResolutionId := ⟨1⟩
private def attemptId : AttemptId := ⟨1⟩
private def rootAuditId : AuditId := ⟨1⟩
private def attemptAuditId : AuditId := ⟨2⟩
private def claimId : ItemClaimId := ⟨1⟩
private def workerId : ClaimWorkerId := ⟨1⟩
private def nonce : PermitNonce := ⟨1⟩
private def scope : Scope := .workspace tenant none workspace
private def tenantScope : Scope := .tenant tenant
private def owner : ActorRef := .workspace tenant workspace
private def issuer : ActorRef := .tenant tenant

private def bundledModes : PlacementSet := ⟨true, false, false⟩
private def placement : PlacementSnapshot :=
  ⟨bundledModes, bundledModes, bundledModes, bundledModes, .bundled⟩
private def arguments : StructuralValue := ⟨"json-v1", ["mutation"]⟩

private def header : InvocationHeader := {
  invocation := invocationId
  operation := ⟨facet, "document.update", 1⟩
  impact := .mutate
  domain := .workspace tenant workspace
  target := .external tenant "document"
  authority := .initiator principalRef bindingId
  caller := ⟨owner, true⟩
  lease := none
  placement := placement
  pathEvidence := [⟨tenantScope, 0⟩, ⟨scope, 2⟩]
  routeEvidence := ⟨none, none⟩
  projectionDigest := none
  auditCause := rootAuditId
  idempotencySeed := "canonical-mediated-mutation"
}

private def prepared : PreparedInvocation := ⟨header, .single arguments⟩
private def item : PreparedItem :=
  ⟨0, arguments, deriveItemKey header prepared.payload 0 arguments⟩
private def grant : Grant :=
  ⟨.principal principalRef, scope, .allow, header.permission, none, .manual⟩
private def binding : Binding :=
  ⟨header.domain, scope, "document-writer", 1, grantId, facet⟩
private def rootAudit : AuditEntry :=
  ⟨owner, 1, 1, none, .invocation invocationId⟩

private def grantedAuthority : AuthorityLedger := {
  (default : AuthorityLedger).bumpScope scope with
  grants := tableSet (default : AuthorityLedger).grants grantId grant
}
private def grantedGenesis : SystemState := {
  (default : SystemState) with authority := grantedAuthority
}

private def boundAuthority : AuthorityLedger := {
  grantedAuthority.bumpScope scope with
  bindings := tableSet grantedAuthority.bindings bindingId binding
}
private def boundGenesis : SystemState := { grantedGenesis with authority := boundAuthority }

private def resolution : Resolution :=
  ⟨resolutionId, principalRef, header, scope, ⟨0⟩, ⟨5⟩, none⟩
private def resolvedAuthority : AuthorityLedger := boundAuthority.issueResolution resolution
private def trustedGenesis : SystemState := { boundGenesis with authority := resolvedAuthority }

private def auditLog : AuditLog := (default : AuditLog).append rootAuditId rootAudit
private def auditedState : SystemState := { trustedGenesis with audit := auditLog }

private def request : AdmissionRequest :=
  ⟨prepared, scope, resolutionId, none, ⟨1⟩, []⟩
private def intentEffects : EffectLedger := {
  (default : EffectLedger) with
  invocations := tableSet (default : EffectLedger).invocations invocationId prepared
}
private def intentState : SystemState := { auditedState with effects := intentEffects }

private def claim : ItemClaim :=
  ⟨claimId, invocationId, 0, 0, .system owner workerId, ⟨10⟩⟩
private def claimedEffects : EffectLedger := intentEffects.setClaim claim
private def claimedState : SystemState := { intentState with effects := claimedEffects }

private def attempt : EffectAttempt :=
  ⟨invocationId, 0, 0, claimId, rootAuditId, item.key, none, ⟨2⟩⟩
private def admittedEffects : EffectLedger :=
  claimedEffects.recordAdmission attemptId (admissionFor request)
private def attemptedEffects : EffectLedger := admittedEffects.addAttempt attemptId attempt
private def attemptAudit : AuditEntry :=
  ⟨owner, 2, 1, some rootAuditId, .attempt attemptId invocationId⟩
private def attemptAuditLog : AuditLog := auditLog.append attemptAuditId attemptAudit
private def attemptedState : SystemState := {
  claimedState with effects := attemptedEffects, audit := attemptAuditLog
}

private def expectation : PermitExpectation :=
  ⟨prepared, scope, resolutionId, none, [], claim, issuer, owner, owner, 0, 1⟩
private def targetRequest : TargetPermitRequest := ⟨expectation, nonce⟩
private def permit : AuthorityPermit := ⟨expectation, nonce, ⟨1⟩, ⟨5⟩⟩
private def requestMessage : PermitMessage := .request targetRequest
private def candidate : PermitMessage := .issued permit

private def trustedDistributed : DistributedSystemState := ⟨trustedGenesis, default⟩
private def auditedDistributed : DistributedSystemState := ⟨auditedState, default⟩
private def intentDistributed : DistributedSystemState := ⟨intentState, default⟩
private def claimedDistributed : DistributedSystemState := ⟨claimedState, default⟩
private def localAttemptedDistributed : DistributedSystemState := ⟨attemptedState, default⟩
private def timedPermits : PermitProtocolState := { (default : PermitProtocolState) with now := ⟨1⟩ }
private def timedState : DistributedSystemState := ⟨claimedState, timedPermits⟩
private def requestedPermits : PermitProtocolState := {
  timedPermits with
  targetRequests := tableSet2 timedPermits.targetRequests owner nonce (some targetRequest)
}
private def requestedState : DistributedSystemState := ⟨claimedState, requestedPermits⟩
private def forwardedPermits : PermitProtocolState := {
  requestedPermits with transport := [requestMessage]
}
private def forwardedState : DistributedSystemState := ⟨claimedState, forwardedPermits⟩
private def issuedPermits : PermitProtocolState := {
  forwardedPermits with
  issuerRecords := tableSet2 forwardedPermits.issuerRecords issuer nonce (some (.issued permit))
}
private def issuedState : DistributedSystemState := ⟨claimedState, issuedPermits⟩
private def emittedPermits : PermitProtocolState := {
  issuedPermits with transport := [requestMessage, candidate]
}
private def emittedState : DistributedSystemState := ⟨claimedState, emittedPermits⟩
private def duplicatedPermits : PermitProtocolState := {
  emittedPermits with transport := [requestMessage, candidate, candidate]
}
private def duplicatedState : DistributedSystemState := ⟨claimedState, duplicatedPermits⟩
private def deliveredPermits : PermitProtocolState := {
  duplicatedPermits with transport := [requestMessage, candidate]
}
private def deliveredState : DistributedSystemState := ⟨claimedState, deliveredPermits⟩
private def restartedPermits : PermitProtocolState := {
  deliveredPermits with incarnation := fun actor => if actor = owner then 1 else 0
}
private def restartedState : DistributedSystemState := ⟨claimedState, restartedPermits⟩
private def authenticatedOncePermits : PermitProtocolState := {
  restartedPermits with
  authentications := tableSet2 restartedPermits.authentications owner nonce
    (some ⟨permit, restartedPermits.incarnation owner⟩)
}
private def authenticatedOnceState : DistributedSystemState :=
  ⟨claimedState, authenticatedOncePermits⟩
private def resetPermits : PermitProtocolState := {
  authenticatedOncePermits with incarnation := fun actor =>
    if actor = owner then authenticatedOncePermits.incarnation actor + 1
    else authenticatedOncePermits.incarnation actor
}
private def resetState : DistributedSystemState := ⟨claimedState, resetPermits⟩
private def authenticatedPermits : PermitProtocolState := {
  resetPermits with
  authentications := tableSet2 resetPermits.authentications owner nonce
    (some ⟨permit, resetPermits.incarnation owner⟩)
}
private def authenticatedState : DistributedSystemState := ⟨claimedState, authenticatedPermits⟩
private def consumedPermits : PermitProtocolState := {
  authenticatedPermits with
  consumptions := tableSet2 authenticatedPermits.consumptions owner nonce
    (some ⟨permit, attemptId⟩)
}
private def attemptedDistributed : DistributedSystemState :=
  ⟨attemptedState, consumedPermits⟩
private def replayRestartedPermits : PermitProtocolState := {
  consumedPermits with incarnation := fun actor =>
    if actor = owner then consumedPermits.incarnation actor + 1
    else consumedPermits.incarnation actor
}
private def replayRestartedState : DistributedSystemState :=
  ⟨attemptedState, replayRestartedPermits⟩
private def replayAuthenticatedPermits : PermitProtocolState := {
  replayRestartedPermits with
  authentications := tableSet2 replayRestartedPermits.authentications owner nonce
    (some ⟨permit, replayRestartedPermits.incarnation owner⟩)
}
private def replayAuthenticatedState : DistributedSystemState :=
  ⟨attemptedState, replayAuthenticatedPermits⟩

private theorem appendRootAudit :
    MediatedStep trustedGenesis (.audit (.append rootAuditId)) auditedState := by
  apply MediatedStep.audit
  apply AuditStep.append
  · rfl
  · rfl
  · trivial
  · trivial
  · trivial

private theorem issueGrant :
    AuthorityLedger.AuthorityStep (default : AuthorityLedger) (.issueGrant grantId)
      grantedAuthority := by
  apply AuthorityLedger.AuthorityStep.issueGrant
  · rfl
  · rfl
  · rfl

private theorem grantedLive : grantedAuthority.LiveGrant grantId grant := by
  apply AuthorityLedger.LiveGrant.root
  · simp [grantedAuthority, grantId]
  · rfl
  · intro revoked
    contradiction

private theorem bindGrant :
    AuthorityLedger.AuthorityStep grantedAuthority (.bind bindingId) boundAuthority := by
  apply AuthorityLedger.AuthorityStep.bind (binding := binding) (grant := grant)
  · exact grantedLive
  · rfl
  · rfl

private theorem boundAuthorized : boundAuthority.Authorized principalRef header scope := by
  refine ⟨binding, grant, ?_, rfl, rfl, rfl, rfl, ?_, rfl, ?_, ?_⟩
  · change tableSet grantedAuthority.bindings bindingId binding bindingId = some binding
    exact tableSet_self ..
  · apply AuthorityLedger.LiveGrant.root
    · change tableSet (default : AuthorityLedger).grants grantId grant grantId = some grant
      exact tableSet_self ..
    · rfl
    · intro revoked
      contradiction
  · exact ⟨rfl, rfl, Scope.contains_refl scope, rfl, rfl⟩
  · intro denied
    obtain ⟨id, deniedGrant, live, deniedEffect, _⟩ := denied
    cases live with
    | root lookup _ _ | child lookup _ _ _ =>
        by_cases same : id = grantId
        · subst id
          change tableSet (default : AuthorityLedger).grants grantId grant grantId =
            some deniedGrant at lookup
          rw [tableSet_self] at lookup
          cases Option.some.inj lookup
          contradiction
        · change tableSet (default : AuthorityLedger).grants grantId grant id =
            some deniedGrant at lookup
          rw [tableSet_other _ _ _ same] at lookup
          contradiction

private theorem boundPathComplete : boundAuthority.PathEvidenceComplete header scope := by
  constructor
  · rfl
  · intro evidence member
    change evidence ∈ [⟨tenantScope, 0⟩, ⟨scope, 2⟩] at member
    simp only [List.mem_cons, List.mem_nil_iff, or_false] at member
    rcases member with rfl | rfl
    · change 0 = 0
      rfl
    · change 2 = 2
      rfl

private theorem issueResolution :
    AuthorityLedger.AuthorityStep boundAuthority (.resolve resolution) resolvedAuthority := by
  apply AuthorityLedger.AuthorityStep.resolve
  · rfl
  · exact boundAuthorized
  · exact boundPathComplete
  · trivial
  · constructor
    · decide
    · simp [resolution, header]

private theorem resolvedAuthorized : resolvedAuthority.Authorized principalRef header scope := by
  refine ⟨binding, grant, ?_, rfl, rfl, rfl, rfl, ?_, rfl, ?_, ?_⟩
  · change tableSet grantedAuthority.bindings bindingId binding bindingId = some binding
    exact tableSet_self ..
  · apply AuthorityLedger.LiveGrant.root
    · change tableSet (default : AuthorityLedger).grants grantId grant grantId = some grant
      exact tableSet_self ..
    · rfl
    · intro revoked
      contradiction
  · exact ⟨rfl, rfl, Scope.contains_refl scope, rfl, rfl⟩
  · intro denied
    obtain ⟨id, deniedGrant, live, _, _⟩ := denied
    cases live with
    | root lookup _ _ | child lookup _ _ _ =>
        by_cases same : id = grantId
        · subst id
          change tableSet (default : AuthorityLedger).grants grantId grant grantId =
            some deniedGrant at lookup
          rw [tableSet_self] at lookup
          cases Option.some.inj lookup
          contradiction
        · change tableSet (default : AuthorityLedger).grants grantId grant id =
            some deniedGrant at lookup
          rw [tableSet_other _ _ _ same] at lookup
          contradiction

private theorem resolvedPathComplete :
    resolvedAuthority.PathEvidenceComplete header scope := by
  change boundAuthority.PathEvidenceComplete header scope
  exact boundPathComplete

private theorem mediatedReady : MediatedReady auditedState request := by
  refine ⟨rfl, ⟨rfl, ?_⟩, ?_, rfl, ?_, rfl, ?_⟩
  · intro _
    rfl
  · simp [RouteGate, InvocationHeader.RouteEvidenceConsistent, request, prepared, header]
  · refine ⟨rootAudit, ?_, rfl, rfl, rfl⟩
    change tableSet (default : AuditLog).entries rootAuditId rootAudit rootAuditId =
      some rootAudit
    exact tableSet_self ..
  · refine ⟨resolution, ?_, ?_⟩
    · change tableSet boundAuthority.resolutions resolutionId resolution resolutionId =
        some resolution
      exact tableSet_self ..
    · refine ⟨?_, rfl, resolvedAuthorized, resolvedPathComplete⟩
      change tableSet boundAuthority.resolutions resolutionId resolution resolutionId =
        some resolution
      exact tableSet_self ..

private theorem persistIntent :
    MediatedStep auditedState (.persistIntent invocationId) intentState := by
  apply MediatedStep.persistIntent (request := request)
  · exact mediatedReady
  · exact EffectStep.persistIntent rfl

private theorem intentReady : MediatedReady intentState request := by
  simpa [intentState] using mediatedReady

private theorem claimItem :
    MediatedStep intentState (.claimItem invocationId 0 ⟨1⟩) claimedState := by
  apply MediatedStep.claimItem (request := request) (claim := claim)
      (effects' := claimedEffects) intentReady
  · refine ⟨item, rfl, ?_⟩
    rfl
  · simp [intentState, intentEffects, request, prepared, header, invocationId]
  · rfl
  · apply EffectStep.claimItem (prepared := prepared) (item := item)
    · simp [intentState, intentEffects, claim]
    · rfl
    · simp [ClaimOwnerMatchesPrepared, prepared, header, claim, owner, domainOwner]
    · left
      exact ⟨rfl, rfl, rfl⟩
    · decide
    · rfl
    · rfl

private theorem claimedReady : MediatedReady claimedState request := by
  simpa [claimedState] using intentReady

private theorem startAttempt :
    MediatedStep claimedState (.start invocationId attemptId attemptAuditId) attemptedState := by
  apply MediatedStep.start (request := request) (attempt := attempt)
      (effects' := attemptedEffects) claimedReady
  · rfl
  · rfl
  · simp [claimedState, claimedEffects, EffectLedger.setClaim, intentEffects,
      request, prepared, header, invocationId]
  · refine ⟨rfl, rfl, item, rfl, rfl, ?_⟩
    simp [request, prepared, header, attempt]
  · apply EffectStep.firstAttempt (prepared := prepared)
    · rfl
    · change tableSet (default : EffectLedger).invocations invocationId prepared invocationId =
        some prepared
      exact tableSet_self ..
    · refine ⟨admissionFor request, ?_, rfl, rfl,
        ⟨item, rfl, rfl, by simp [prepared, header, attempt]⟩⟩
      change tableSet claimedEffects.admissions attemptId (admissionFor request) attemptId =
        some (admissionFor request)
      exact tableSet_self ..
    · exact ⟨item, rfl, rfl, by simp [prepared, header, attempt]⟩
    · rfl
    · refine ⟨claim, ?_, ?_, ?_, by decide⟩
      · change claimedEffects.claims claimId = some claim
        simp [claimedEffects, EffectLedger.setClaim, claim]
      · change claimedEffects.currentClaim invocationId 0 = some claimId
        simp [claimedEffects, EffectLedger.setClaim, claim]
      · simp [ClaimOwnsAttempt, ItemClaimOwner.token, claim, attempt]
    · rfl
    · rfl
  · simp [attemptedEffects, EffectLedger.addAttempt]
  · refine ⟨attemptAudit, ?_, ?_, rfl⟩
    · apply AuditStep.append
      · rfl
      · rfl
      · refine ⟨rootAudit, ?_, rfl, by decide, rfl, rfl⟩
        change tableSet (default : AuditLog).entries rootAuditId rootAudit rootAuditId =
          some rootAudit
        exact tableSet_self ..
      · apply CausalChain.root (entry := rootAudit)
        · change tableSet (default : AuditLog).entries rootAuditId rootAudit rootAuditId =
            some rootAudit
          exact tableSet_self ..
        · rfl
        · trivial
      · refine ⟨attempt, ?_, rfl, rfl⟩
        simp [attemptedEffects, EffectLedger.addAttempt]
    · change tableSet auditLog.entries attemptAuditId attemptAudit attemptAuditId =
        some attemptAudit
      exact tableSet_self ..

private theorem targetLocalReady :
    TargetLocalReady claimedState (expectation.requestAt ⟨1⟩) := by
  have ready := claimedReady
  exact ⟨ready.1, ready.2.1, ready.2.2.1, ready.2.2.2.1,
    ready.2.2.2.2.1, ready.2.2.2.2.2.1⟩

private theorem targetClaimReadyForAuthority (authority : AuthorityLedger) :
    expectation.ClaimReady { claimedState with authority := authority } ⟨1⟩ := by
  refine ⟨⟨item, rfl, rfl⟩, rfl, ?_, ?_, ?_, by decide⟩
  · change claimedEffects.invocations invocationId = some prepared
    simp [claimedEffects, EffectLedger.setClaim, intentEffects]
  · change claimedEffects.claims claimId = some claim
    simp [claimedEffects, EffectLedger.setClaim, claim]
  · change claimedEffects.currentClaim invocationId 0 = some claimId
    simp [claimedEffects, EffectLedger.setClaim, claim]

private theorem targetAttemptForAuthority (authority : AuthorityLedger) :
    TargetAttemptStep { claimedState with authority := authority } expectation ⟨1⟩
      attemptId attempt attemptAuditId { attemptedState with authority := authority } := by
  apply TargetAttemptStep.first (effects' := attemptedEffects)
  · exact targetLocalReady
  · exact targetClaimReadyForAuthority authority
  · rfl
  · rfl
  · change tableSet (default : EffectLedger).invocations invocationId prepared invocationId =
      some prepared
    exact tableSet_self ..
  · change claimedEffects.claims claimId = some claim
    simp [claimedEffects, EffectLedger.setClaim, claim]
  · refine ⟨rfl, rfl, rfl, rfl, rfl, item, rfl, ?_⟩
    rfl
  · exact ⟨rfl, rfl, item, rfl, rfl, by simp [expectation, prepared, header, attempt]⟩
  · apply EffectStep.firstAttempt (prepared := prepared)
    · rfl
    · change tableSet (default : EffectLedger).invocations invocationId prepared invocationId =
        some prepared
      exact tableSet_self ..
    · refine ⟨admissionFor request, ?_, rfl, rfl,
        ⟨item, rfl, rfl, by simp [prepared, header, attempt]⟩⟩
      change tableSet claimedEffects.admissions attemptId (admissionFor request) attemptId =
        some (admissionFor request)
      exact tableSet_self ..
    · exact ⟨item, rfl, rfl, by simp [prepared, header, attempt]⟩
    · rfl
    · refine ⟨claim, ?_, ?_, ?_, by decide⟩
      · change claimedEffects.claims claimId = some claim
        simp [claimedEffects, EffectLedger.setClaim, claim]
      · change claimedEffects.currentClaim invocationId 0 = some claimId
        simp [claimedEffects, EffectLedger.setClaim, claim]
      · simp [ClaimOwnsAttempt, ItemClaimOwner.token, claim, attempt]
    · rfl
    · rfl
  · simp [attemptedEffects, EffectLedger.addAttempt]
  · refine ⟨attemptAudit, ?_, ?_, rfl⟩
    · apply AuditStep.append
      · rfl
      · rfl
      · refine ⟨rootAudit, ?_, rfl, by decide, rfl, rfl⟩
        change tableSet (default : AuditLog).entries rootAuditId rootAudit rootAuditId =
          some rootAudit
        exact tableSet_self ..
      · apply CausalChain.root (entry := rootAudit)
        · change tableSet (default : AuditLog).entries rootAuditId rootAudit rootAuditId =
            some rootAudit
          exact tableSet_self ..
        · rfl
        · trivial
      · refine ⟨attempt, ?_, rfl, rfl⟩
        simp [attemptedEffects, EffectLedger.addAttempt]
    · change tableSet auditLog.entries attemptAuditId attemptAudit attemptAuditId =
        some attemptAudit
      exact tableSet_self ..

private theorem targetRequestReady : TargetRequestReady timedState targetRequest := by
  refine ⟨rfl, targetLocalReady, ?_⟩
  exact targetClaimReadyForAuthority resolvedAuthority

private theorem permitReady :
    PermitIssueReady (tenantIssueView forwardedState issuer) targetRequest := by
  refine ⟨rfl, ⟨?_, by decide⟩, ?_, ?_⟩
  · exact ⟨rfl, rfl, rfl, rfl⟩
  · refine ⟨binding, ?_, rfl, rfl⟩
    change tableSet grantedAuthority.bindings bindingId binding bindingId = some binding
    exact tableSet_self ..
  · refine ⟨resolution, ?_, ?_⟩
    · change tableSet boundAuthority.resolutions resolutionId resolution resolutionId =
        some resolution
      exact tableSet_self ..
    · refine ⟨?_, rfl, resolvedAuthorized, resolvedPathComplete⟩
      change tableSet boundAuthority.resolutions resolutionId resolution resolutionId =
        some resolution
      exact tableSet_self ..

private theorem advanceToIssueTime :
    PermitStep claimedDistributed (.advanceTime ⟨1⟩) timedState := by
  apply PermitStep.advanceTime
  decide

private theorem recordTargetRequest :
    PermitStep timedState (.request owner nonce .acknowledged) requestedState := by
  apply PermitStep.request (request := targetRequest)
  · exact targetRequestReady
  · rfl

private theorem forwardTargetRequest :
    PermitStep requestedState (.forwardRequest owner nonce) forwardedState := by
  apply PermitStep.forwardRequest (request := targetRequest)
  simp [exactRequested, requestedState, requestedPermits, targetRequest, expectation]

private theorem issuePermit :
    PermitStep forwardedState (.issue issuer nonce .unknown) issuedState := by
  apply PermitStep.issue (request := targetRequest) (expiresAt := ⟨5⟩)
  · simp [forwardedState, forwardedPermits, requestMessage]
  · exact permitReady
  · rfl
  · decide

private theorem emitPermit :
    PermitStep issuedState (.emit issuer nonce) emittedState := by
  apply PermitStep.emit (permit := permit)
  simp [exactIssued, issuedState, issuedPermits, permit, expectation]

private theorem duplicatePermit :
    PermitStep emittedState (.duplicate candidate) duplicatedState := by
  apply PermitStep.duplicate
  simp [emittedState, emittedPermits, candidate]

private theorem loseOneCopy :
    PermitStep duplicatedState (.drop candidate) deliveredState := by
  apply PermitStep.drop (beforeMessages := [requestMessage]) (afterMessages := [candidate])
  rfl

private theorem reorderDelivery :
    PermitStep deliveredState .reorder deliveredState := by
  apply PermitStep.reorder
  rfl

private theorem restartTarget :
    PermitStep deliveredState (.restart owner) restartedState := by
  apply PermitStep.restart

private theorem authenticateOnce :
    PermitStep restartedState (.authenticate owner nonce) authenticatedOnceState := by
  apply PermitStep.authenticate (permit := permit)
  · simp [restartedState, restartedPermits, deliveredPermits, candidate]
  · simp [exactRequested, restartedState, restartedPermits, deliveredPermits,
      duplicatedPermits, emittedPermits, issuedPermits, forwardedPermits,
      requestedPermits, targetRequest, permit, expectation]
  · rfl

private theorem resetTarget :
    PermitStep authenticatedOnceState (.reset owner) resetState := by
  apply PermitStep.reset

private theorem authenticateAfterReset :
    PermitStep resetState (.authenticate owner nonce) authenticatedState := by
  apply PermitStep.authenticate (permit := permit)
  · simp [resetState, resetPermits, authenticatedOncePermits, restartedPermits,
      deliveredPermits, candidate]
  · simp [exactRequested, resetState, resetPermits, authenticatedOncePermits,
      restartedPermits, deliveredPermits, duplicatedPermits, emittedPermits, issuedPermits,
      forwardedPermits, requestedPermits, targetRequest, permit, expectation]
  · rfl

private theorem targetAttempt :
    TargetAttemptStep claimedState expectation ⟨1⟩ attemptId attempt
      attemptAuditId attemptedState := by
  simpa [claimedState, attemptedState] using targetAttemptForAuthority resolvedAuthority

private theorem consumePermit :
    PermitStep authenticatedState (.consume owner nonce attemptId .unknown)
      attemptedDistributed := by
  apply PermitStep.consume (permit := permit) (attempt := attempt)
      (auditId := attemptAuditId)
  · simp [exactAuthenticated, authenticatedState, authenticatedPermits,
      permit, expectation]
  · simp [exactRequested, authenticatedState, authenticatedPermits, resetPermits,
      authenticatedOncePermits, restartedPermits, deliveredPermits, duplicatedPermits,
      emittedPermits, issuedPermits, forwardedPermits, requestedPermits,
      targetRequest, permit, expectation]
  · rfl
  · decide
  · decide
  · rfl
  · exact targetAttempt

private theorem restartAfterConsumption :
    PermitStep attemptedDistributed (.restart owner) replayRestartedState := by
  apply PermitStep.restart

private theorem authenticateReplay :
    PermitStep replayRestartedState (.authenticate owner nonce) replayAuthenticatedState := by
  apply PermitStep.authenticate (permit := permit)
  · simp [replayRestartedState, replayRestartedPermits, consumedPermits,
      authenticatedPermits, resetPermits, authenticatedOncePermits, restartedPermits,
      deliveredPermits, candidate]
  · simp [exactRequested, replayRestartedState, replayRestartedPermits, consumedPermits,
      authenticatedPermits, resetPermits, authenticatedOncePermits, restartedPermits,
      deliveredPermits, duplicatedPermits, emittedPermits, issuedPermits, forwardedPermits,
      requestedPermits, targetRequest, permit, expectation]
  · rfl

private theorem trustedBootstrap : TrustedGenesis trustedDistributed := by
  refine ⟨[.issueGrant grantId, .bind bindingId, .resolve resolution], ?_, rfl⟩
  exact .cons (.issueGrant issueGrant)
    (.cons (.bind bindGrant) (.cons (.resolve issueResolution) (.nil trustedGenesis)))

private theorem trustedReachable : Reachable trustedDistributed := .initial trustedBootstrap

private theorem auditedReachable : Reachable auditedDistributed :=
  .step trustedReachable (.mediated (label := .audit (.append rootAuditId)) appendRootAudit)

private theorem intentReachable : Reachable intentDistributed :=
  .step auditedReachable (.mediated (label := .persistIntent invocationId) persistIntent)

private theorem claimedReachable : Reachable claimedDistributed :=
  .step intentReachable (.mediated (label := .claimItem invocationId 0 ⟨1⟩) claimItem)

private theorem localAttemptedReachable : Reachable localAttemptedDistributed :=
  .step claimedReachable (.mediated (label := .start invocationId attemptId attemptAuditId)
    startAttempt)

private theorem timedReachable : Reachable timedState :=
  .step claimedReachable (.permit advanceToIssueTime)

private theorem requestedReachable : Reachable requestedState :=
  .step timedReachable (.permit recordTargetRequest)

private theorem forwardedReachable : Reachable forwardedState :=
  .step requestedReachable (.permit forwardTargetRequest)

private theorem issuedReachable : Reachable issuedState :=
  .step forwardedReachable (.permit issuePermit)

private theorem emittedReachable : Reachable emittedState :=
  .step issuedReachable (.permit emitPermit)

private theorem duplicatedReachable : Reachable duplicatedState :=
  .step emittedReachable (.permit duplicatePermit)

private theorem deliveredReachable : Reachable deliveredState :=
  .step duplicatedReachable (.permit loseOneCopy)

private theorem reorderedReachable : Reachable deliveredState :=
  .step deliveredReachable (.permit reorderDelivery)

private theorem restartedReachable : Reachable restartedState :=
  .step reorderedReachable (.permit restartTarget)

private theorem authenticatedOnceReachable : Reachable authenticatedOnceState :=
  .step restartedReachable (.permit authenticateOnce)

private theorem resetReachable : Reachable resetState :=
  .step authenticatedOnceReachable (.permit resetTarget)

private theorem authenticatedReachable : Reachable authenticatedState :=
  .step resetReachable (.permit authenticateAfterReset)

private theorem attemptedReachable : Reachable attemptedDistributed :=
  .step authenticatedReachable (.permit consumePermit)

private theorem replayRestartedReachable : Reachable replayRestartedState :=
  .step attemptedReachable (.permit restartAfterConsumption)

private theorem replayAuthenticatedReachable : Reachable replayAuthenticatedState :=
  .step replayRestartedReachable (.permit authenticateReplay)

theorem canonical_single_item_mediated_attempt_reachable :
    Reachable attemptedDistributed ∧
    ∃ storedAttempt admission,
      attemptedDistributed.core.effects.attempts attemptId = some storedAttempt ∧
      attemptedDistributed.core.effects.admissions attemptId = some admission ∧
      storedAttempt = attempt ∧ admission = admissionFor request := by
  refine ⟨attemptedReachable, attempt, admissionFor request, ?_, ?_, rfl, rfl⟩
  · rfl
  · rfl

theorem canonical_actor_local_attempt_reachable :
    Reachable localAttemptedDistributed ∧
    localAttemptedDistributed.core.effects.attempts attemptId = some attempt :=
  ⟨localAttemptedReachable, rfl⟩

theorem canonical_actor_local_attempt_step :
    ∃ before after invocation attemptId auditId attempt,
      Reachable before ∧
      SystemStep before (.mediated (.start invocation attemptId auditId)) after ∧
      after.core.effects.attempts attemptId = some attempt ∧
      after.permits = before.permits := by
  refine ⟨claimedDistributed, localAttemptedDistributed, invocationId, attemptId,
    attemptAuditId, attempt, claimedReachable, ?_, rfl, rfl⟩
  exact .mediated startAttempt

theorem canonical_witness_has_guarded_admission :
    AttemptsHaveGuardedAdmission attemptedDistributed.core.effects :=
  reachable_attempts_have_guarded_admission attemptedReachable

theorem canonical_witness_attempt_and_audit_are_atomic :
    ∃ storedAttempt auditEntry,
      attemptedDistributed.core.effects.attempts attemptId = some storedAttempt ∧
      attemptedDistributed.core.audit.entries attemptAuditId = some auditEntry ∧
      auditEntry.kind = .attempt attemptId storedAttempt.invocation ∧
      auditEntry.cause = some storedAttempt.auditCause := by
  refine ⟨attempt, attemptAudit, ?_, ?_, rfl, rfl⟩
  · simp [attemptedDistributed, attemptedState, attemptedEffects, EffectLedger.addAttempt]
  · simp [attemptedDistributed, attemptedState, attemptAuditLog, AuditLog.append]

theorem canonical_witness_reachability_preserves_exact_audit :
    AttemptsHaveExactAudit attemptedDistributed.core :=
  reachable_attempts_have_exact_audits attemptedReachable

theorem canonical_cross_actor_consumption_has_historical_issuance :
    ∃ consumption,
      attemptedDistributed.permits.consumptions owner nonce = some consumption ∧
      exactRequested attemptedDistributed.permits
        ⟨consumption.permit.expectation, consumption.permit.nonce⟩ ∧
      exactIssued attemptedDistributed.permits consumption.permit ∧
      exactAuthenticated attemptedDistributed.permits consumption.permit ∧
      consumption.permit.expectation.issuer ≠ owner := by
  refine ⟨⟨permit, attemptId⟩, rfl, ?_, ?_, ?_, ?_⟩
  · simp [exactRequested, attemptedDistributed, consumedPermits, authenticatedPermits,
      resetPermits, authenticatedOncePermits, restartedPermits, deliveredPermits,
      duplicatedPermits, emittedPermits, issuedPermits, forwardedPermits,
      requestedPermits, targetRequest, permit, expectation]
  have consumed : attemptedDistributed.permits.consumptions owner nonce =
      some (⟨permit, attemptId⟩ : PermitConsumption) := by
    simp [attemptedDistributed, consumedPermits]
  exact reachable_consumption_has_exact_historical_issuance attemptedReachable consumed
  · simp [exactAuthenticated, attemptedDistributed, consumedPermits,
      authenticatedPermits, permit, expectation]
  decide

theorem canonical_replay_after_restart_is_reauthenticated_but_cannot_reconsume :
    Reachable replayAuthenticatedState ∧
    exactAuthenticated replayAuthenticatedState.permits permit ∧
    ∀ next observation after,
      ¬ PermitStep replayAuthenticatedState (.consume owner nonce next observation) after := by
  refine ⟨replayAuthenticatedReachable, ?_, ?_⟩
  · simp [exactAuthenticated, replayAuthenticatedState, replayAuthenticatedPermits,
      permit, expectation]
  · intro next observation after
    apply consumed_nonce_cannot_be_consumed_again
    simp [replayAuthenticatedState, replayAuthenticatedPermits, replayRestartedPermits,
      consumedPermits]

end AgentCore.CanonicalMediatedTrace
