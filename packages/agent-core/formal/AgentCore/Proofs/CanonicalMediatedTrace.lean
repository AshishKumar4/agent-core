import AgentCore.Proofs.Reachability

/-!
# Canonical mediated-attempt witness

This file constructs one single-item, workspace-owned, mediated mutation. Trusted
bootstrap establishes the initial grant, binding, and resolution; runtime `SystemStep`
then establishes the root audit, persisted intent, item claim, and atomic first
attempt-plus-audit transition. No assembled intermediate is assumed reachable.
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
private def scope : Scope := .workspace tenant none workspace
private def tenantScope : Scope := .tenant tenant
private def owner : ActorRef := .workspace tenant workspace

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
  ⟨.principal principal, scope, .allow, header.permission, none, .manual⟩
private def binding : Binding :=
  ⟨header.domain, scope, "document-writer", grantId, facet⟩
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
  ⟨prepared, scope, resolutionId, none, ⟨1⟩⟩
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

private theorem trustedBootstrap : TrustedGenesis trustedGenesis := by
  refine ⟨[.issueGrant grantId, .bind bindingId, .resolve resolution], ?_⟩
  exact .cons (.issueGrant issueGrant)
    (.cons (.bind bindGrant) (.cons (.resolve issueResolution) (.nil trustedGenesis)))

private theorem trustedReachable : Reachable trustedGenesis := .initial trustedBootstrap

private theorem auditedReachable : Reachable auditedState :=
  .step trustedReachable (.mediated appendRootAudit)

private theorem intentReachable : Reachable intentState :=
  .step auditedReachable (.mediated persistIntent)

private theorem claimedReachable : Reachable claimedState :=
  .step intentReachable (.mediated claimItem)

private theorem attemptedReachable : Reachable attemptedState :=
  .step claimedReachable (.mediated startAttempt)

theorem canonical_single_item_mediated_attempt_reachable :
    Reachable attemptedState ∧
    ∃ storedAttempt admission,
      attemptedState.effects.attempts attemptId = some storedAttempt ∧
      attemptedState.effects.admissions attemptId = some admission ∧
      storedAttempt = attempt ∧ admission = admissionFor request := by
  refine ⟨attemptedReachable, attempt, admissionFor request, ?_, ?_, rfl, rfl⟩
  · simp [attemptedState, attemptedEffects, EffectLedger.addAttempt]
  · simp [attemptedState, attemptedEffects, admittedEffects, EffectLedger.addAttempt,
      EffectLedger.recordAdmission]

theorem canonical_witness_has_guarded_admission :
    AttemptsHaveGuardedAdmission attemptedState.effects :=
  reachable_attempts_have_guarded_admission attemptedReachable

theorem canonical_witness_attempt_and_audit_are_atomic :
    ∃ storedAttempt auditEntry,
      attemptedState.effects.attempts attemptId = some storedAttempt ∧
      attemptedState.audit.entries attemptAuditId = some auditEntry ∧
      auditEntry.kind = .attempt attemptId storedAttempt.invocation ∧
      auditEntry.cause = some storedAttempt.auditCause := by
  obtain ⟨record, entry, attemptLookup, auditLookup, kind, invocation, cause⟩ :=
    first_attempt_and_exact_audit_are_one_transition startAttempt
  exact ⟨record, entry, attemptLookup, auditLookup, by simpa [invocation] using kind, cause⟩

theorem canonical_witness_reachability_preserves_exact_audit :
    AttemptsHaveExactAudit attemptedState :=
  reachable_attempts_have_exact_audits attemptedReachable

end AgentCore.CanonicalMediatedTrace
