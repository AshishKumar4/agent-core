import AgentCore.Composed

/-!
# Distributed authority-permit protocol

This is the cross-Actor protocol that the atomic `MediatedStep` relation deliberately
cannot express. Authority is decided only by the Tenant-owned issuance transition.
Transport and authentication are separate, fallible steps. The target transaction
uses the issued decision as historical admission evidence and rechecks only exact
target-local state before it consumes the nonce and appends an EffectAttempt.
-/

namespace AgentCore

structure PermitNonce where value : Nat deriving DecidableEq, Repr

structure PermitExpectation where
  prepared : PreparedInvocation
  scope : Scope
  resolution : ResolutionId
  reservation : Option AdmissionReservation
  interceptors : List InterceptorContribution
  claim : ItemClaim
  issuer : ActorRef
  source : ActorRef
  target : ActorRef
  targetFence : Nat
  bindingGeneration : Nat
  deriving DecidableEq, Repr

def PermitExpectation.requestAt (expectation : PermitExpectation) (now : Time) : AdmissionRequest :=
  ⟨expectation.prepared, expectation.scope, expectation.resolution,
    expectation.reservation, now, expectation.interceptors⟩

def PermitExpectation.MatchesAttempt (expectation : PermitExpectation)
    (attempt : EffectAttempt) : Prop :=
  attempt.invocation = expectation.prepared.header.invocation ∧
  attempt.itemIndex = expectation.claim.itemIndex ∧
  attempt.ordinal = expectation.claim.ordinal ∧
  attempt.claim = expectation.claim.id ∧
  attempt.token = expectation.claim.owner.token ∧
  ∃ item, PreparedItemAt expectation.prepared expectation.claim.itemIndex item ∧
    attempt.key = item.key

structure AuthorityPermit where
  expectation : PermitExpectation
  nonce : PermitNonce
  issuedAt : Time
  expiresAt : Time
  deriving DecidableEq, Repr

inductive IssuerPermitRecord where
  | issued (permit : AuthorityPermit)
  | corrupt
  deriving DecidableEq, Repr

inductive PermitMessage where
  | candidate (permit : AuthorityPermit)
  | malformed
  deriving DecidableEq, Repr

structure PermitAuthentication where
  permit : AuthorityPermit
  targetIncarnation : Nat
  deriving DecidableEq, Repr

structure PermitConsumption where
  permit : AuthorityPermit
  attempt : AttemptId
  deriving DecidableEq, Repr

inductive CommitObservation where
  | acknowledged
  | unknown
  deriving DecidableEq, Repr

structure PermitProtocolState where
  now : Time
  issuerRecords : ActorRef → PermitNonce → Option IssuerPermitRecord
  transport : List PermitMessage
  authentications : ActorRef → PermitNonce → Option PermitAuthentication
  consumptions : ActorRef → PermitNonce → Option PermitConsumption
  incarnation : ActorRef → Nat
  targetFence : ActorRef → Nat

instance : Inhabited PermitProtocolState where
  default := ⟨⟨0⟩, fun _ _ => none, [], fun _ _ => none, fun _ _ => none,
    fun _ => 0, fun _ => 0⟩

structure DistributedSystemState where
  core : SystemState
  permits : PermitProtocolState

instance : Inhabited DistributedSystemState where default := ⟨default, default⟩

def tableSet2 [DecidableEq α] [DecidableEq β]
    (table : α → β → γ) (first : α) (second : β) (value : γ) : α → β → γ :=
  fun candidateFirst candidateSecond =>
    if candidateFirst = first then if candidateSecond = second then value
    else table candidateFirst candidateSecond else table candidateFirst candidateSecond

@[simp] theorem tableSet2_self [DecidableEq α] [DecidableEq β]
    (table : α → β → γ) (first : α) (second : β) (value : γ) :
    tableSet2 table first second value first second = value := by simp [tableSet2]

theorem tableSet2_other [DecidableEq α] [DecidableEq β]
    (table : α → β → γ) (first : α) (second : β) (value : γ)
    (candidateFirst : α) (candidateSecond : β)
    (different : candidateFirst ≠ first ∨ candidateSecond ≠ second) :
    tableSet2 table first second value candidateFirst candidateSecond =
      table candidateFirst candidateSecond := by
  rcases different with different | different
  · simp [tableSet2, different]
  · by_cases same : candidateFirst = first
    · simp [tableSet2, same, different]
    · simp [tableSet2, same]

def PermitExpectation.ClaimReady (expectation : PermitExpectation)
    (state : SystemState) (now : Time) : Prop :=
  (expectation.requestAt now).ReservesItem expectation.claim.itemIndex ∧
  expectation.claim.invocation = expectation.prepared.header.invocation ∧
  state.effects.invocations expectation.prepared.header.invocation = some expectation.prepared ∧
  state.effects.claims expectation.claim.id = some expectation.claim ∧
  state.effects.currentClaim expectation.claim.invocation expectation.claim.itemIndex =
    some expectation.claim.id ∧
  now.tick < expectation.claim.expiresAt.tick

def PermitExpectation.IssuerAuthenticated (expectation : PermitExpectation) : Prop :=
  expectation.issuer = .tenant expectation.prepared.header.domain.tenant ∧
  expectation.source = expectation.prepared.header.caller.actor ∧
  expectation.prepared.header.caller.authenticated = true ∧
  expectation.target = domainOwner expectation.prepared.header.domain

def PermitExpectation.CurrentBinding (expectation : PermitExpectation)
    (ledger : AuthorityLedger) : Prop :=
  ∃ binding, ledger.bindings expectation.prepared.header.binding = some binding ∧
    binding.generation = expectation.bindingGeneration ∧
    binding.facet = expectation.prepared.header.operation.facet

def PermitIssueReady (state : DistributedSystemState)
    (expectation : PermitExpectation) : Prop :=
  expectation.IssuerAuthenticated ∧
  expectation.targetFence = state.permits.targetFence expectation.target ∧
  expectation.CurrentBinding state.core.authority ∧
  expectation.ClaimReady state.core state.permits.now ∧
  MediatedReady state.core (expectation.requestAt state.permits.now)

def TargetLocalReady (state : SystemState) (request : AdmissionRequest) : Prop :=
  request.prepared.header.placement.Valid ∧
  CallerGate request.prepared.header ∧ RouteGate state request.prepared.header ∧
  effectiveTier request.prepared.header.placement.selected request.prepared.header.impact
    request.prepared.header.lease.isSome request.intercepted = .mediated ∧
  MediatedLeaseGate state request.prepared.header request.now ∧
  RunReservationGate state request

inductive TargetAttemptStep : SystemState → PermitExpectation → Time →
    AttemptId → EffectAttempt → AuditId → SystemState → Prop
  | first {state expectation now attemptId attempt auditId effects' audit'} :
      TargetLocalReady state (expectation.requestAt now) →
      expectation.ClaimReady state now →
      requiresApproval expectation.prepared = false →
      (expectation.requestAt now).ReservedFor
        (.item expectation.prepared.header.invocation attempt.itemIndex attempt.key) →
      state.effects.invocations expectation.prepared.header.invocation =
        some expectation.prepared →
      state.effects.claims expectation.claim.id = some expectation.claim →
      expectation.MatchesAttempt attempt →
      FirstAttemptSound expectation.prepared attempt →
      EffectStep (state.effects.recordAdmission attemptId
        ⟨expectation.prepared.identity, expectation.prepared.header.authority.principal,
          expectation.scope, expectation.resolution⟩)
        (.firstAttempt attemptId) effects' →
      effects'.attempts attemptId = some attempt →
      AttemptAuditAppend effects' state.events state.audit attemptId
        expectation.prepared.header.invocation auditId audit' →
      TargetAttemptStep state expectation now attemptId attempt auditId
        { state with effects := effects', audit := audit' }
  | approvalFirst {state expectation now approvalId attemptId attempt auditId effects' audit'} :
      TargetLocalReady state (expectation.requestAt now) →
      expectation.ClaimReady state now →
      (expectation.requestAt now).ReservedFor
        (.item expectation.prepared.header.invocation attempt.itemIndex attempt.key) →
      state.effects.invocations expectation.prepared.header.invocation =
        some expectation.prepared →
      state.approvals.Available approvalId expectation.prepared now →
      state.effects.claims expectation.claim.id = some expectation.claim →
      expectation.MatchesAttempt attempt →
      FirstAttemptSound expectation.prepared attempt →
      EffectStep (state.effects.recordAdmission attemptId
        ⟨expectation.prepared.identity, expectation.prepared.header.authority.principal,
          expectation.scope, expectation.resolution⟩)
        (.firstAttempt attemptId) effects' →
      effects'.attempts attemptId = some attempt →
      AttemptAuditAppend effects' state.events state.audit attemptId
        expectation.prepared.header.invocation auditId audit' →
      TargetAttemptStep state expectation now attemptId attempt auditId {
        state with
        approvals := state.approvals.consume approvalId expectation.prepared attemptId
        effects := effects'
        audit := audit'
      }
  | approvalContinue {state expectation now approvalId attemptId attempt auditId effects' audit'
      continuation} :
      TargetLocalReady state (expectation.requestAt now) →
      expectation.ClaimReady state now →
      (expectation.requestAt now).ReservedFor
        (.item expectation.prepared.header.invocation attempt.itemIndex attempt.key) →
      state.effects.invocations expectation.prepared.header.invocation =
        some expectation.prepared →
      state.approvals.Continues approvalId expectation.prepared →
      state.approvals.continuations expectation.prepared.header.invocation = some continuation →
      continuation.ValidFirstAttempt state.effects expectation.prepared →
      attemptId ≠ continuation.firstAttempt →
      state.effects.claims expectation.claim.id = some expectation.claim →
      expectation.MatchesAttempt attempt →
      FirstAttemptSound expectation.prepared attempt →
      EffectStep (state.effects.recordAdmission attemptId
        ⟨expectation.prepared.identity, expectation.prepared.header.authority.principal,
          expectation.scope, expectation.resolution⟩)
        (.firstAttempt attemptId) effects' →
      effects'.attempts attemptId = some attempt →
      AttemptAuditAppend effects' state.events state.audit attemptId
        expectation.prepared.header.invocation auditId audit' →
      TargetAttemptStep state expectation now attemptId attempt auditId
        { state with effects := effects', audit := audit' }
  | retry {state expectation now previous next attempt auditId effects' audit'} :
      TargetLocalReady state (expectation.requestAt now) →
      expectation.ClaimReady state now →
      (expectation.requestAt now).ReservedFor
        (.item expectation.prepared.header.invocation attempt.itemIndex attempt.key) →
      state.effects.invocations expectation.prepared.header.invocation =
        some expectation.prepared →
      (requiresApproval expectation.prepared = false ∨
        ∃ approvalId, state.approvals.Continues approvalId expectation.prepared) →
      state.effects.claims expectation.claim.id = some expectation.claim →
      expectation.MatchesAttempt attempt →
      RetryAttemptSound expectation.prepared attempt →
      EffectStep (state.effects.recordAdmission next
        ⟨expectation.prepared.identity, expectation.prepared.header.authority.principal,
          expectation.scope, expectation.resolution⟩)
        (.retryAttempt previous next) effects' →
      effects'.attempts next = some attempt →
      AttemptAuditAppend effects' state.events state.audit next
        expectation.prepared.header.invocation auditId audit' →
      TargetAttemptStep state expectation now next attempt auditId
        { state with effects := effects', audit := audit' }

def exactIssued (state : PermitProtocolState) (permit : AuthorityPermit) : Prop :=
  state.issuerRecords permit.expectation.issuer permit.nonce =
    some (.issued permit)

def exactAuthenticated (state : PermitProtocolState) (permit : AuthorityPermit) : Prop :=
  state.authentications permit.expectation.target permit.nonce =
    some ⟨permit, state.incarnation permit.expectation.target⟩

inductive PermitLabel where
  | issue (issuer : ActorRef) (nonce : PermitNonce) (observation : CommitObservation)
  | issueUnknownBefore (issuer : ActorRef) (nonce : PermitNonce)
  | emit (issuer : ActorRef) (nonce : PermitNonce)
  | inject (message : PermitMessage)
  | drop (message : PermitMessage)
  | duplicate (message : PermitMessage)
  | reorder
  | authenticate (target : ActorRef) (nonce : PermitNonce)
  | consume (target : ActorRef) (nonce : PermitNonce) (attempt : AttemptId)
      (observation : CommitObservation)
  | consumeUnknownBefore (target : ActorRef) (nonce : PermitNonce)
  | restart (actor : ActorRef)
  | reset (actor : ActorRef)
  | advanceTime (now : Time)
  | advanceFence (target : ActorRef)
  deriving DecidableEq, Repr

inductive PermitStep : DistributedSystemState → PermitLabel → DistributedSystemState → Prop
  | issue {state expectation nonce expiresAt observation} :
      PermitIssueReady state expectation →
      state.permits.issuerRecords expectation.issuer nonce = none →
      state.permits.now.tick < expiresAt.tick →
      PermitStep state (.issue expectation.issuer nonce observation) {
        state with permits := { state.permits with
          issuerRecords := tableSet2 state.permits.issuerRecords expectation.issuer nonce
            (some (.issued ⟨expectation, nonce, state.permits.now, expiresAt⟩)) } }
  | issueUnknownBefore {state issuer nonce} :
      PermitStep state (.issueUnknownBefore issuer nonce) state
  | emit {state permit} :
      exactIssued state.permits permit →
      PermitStep state (.emit permit.expectation.issuer permit.nonce) {
        state with permits := { state.permits with
          transport := state.permits.transport ++ [.candidate permit] } }
  | inject {state message} :
      PermitStep state (.inject message) { state with permits := { state.permits with
        transport := state.permits.transport ++ [message] } }
  | drop {state message beforeMessages afterMessages} :
      state.permits.transport = beforeMessages ++ message :: afterMessages →
      PermitStep state (.drop message) { state with permits := { state.permits with
        transport := beforeMessages ++ afterMessages } }
  | duplicate {state message} :
      message ∈ state.permits.transport →
      PermitStep state (.duplicate message) { state with permits := { state.permits with
        transport := state.permits.transport ++ [message] } }
  | reorder {state reordered} :
      state.permits.transport.Perm reordered →
      PermitStep state .reorder { state with permits := { state.permits with
        transport := reordered } }
  | authenticate {state permit} :
      .candidate permit ∈ state.permits.transport →
      exactIssued state.permits permit →
      permit.expectation.targetFence = state.permits.targetFence permit.expectation.target →
      PermitStep state (.authenticate permit.expectation.target permit.nonce) {
        state with permits := { state.permits with
          authentications := tableSet2 state.permits.authentications
            permit.expectation.target permit.nonce
            (some ⟨permit, state.permits.incarnation permit.expectation.target⟩) } }
  | consume {state permit attemptId attempt auditId core' observation} :
      exactIssued state.permits permit → exactAuthenticated state.permits permit →
      permit.expectation.targetFence = state.permits.targetFence permit.expectation.target →
      permit.issuedAt.tick ≤ state.permits.now.tick →
      state.permits.now.tick < permit.expiresAt.tick →
      state.permits.consumptions permit.expectation.target permit.nonce = none →
      TargetAttemptStep state.core permit.expectation state.permits.now
        attemptId attempt auditId core' →
      PermitStep state
        (.consume permit.expectation.target permit.nonce attemptId observation) {
          core := core'
          permits := { state.permits with consumptions :=
            (tableSet2 state.permits.consumptions permit.expectation.target permit.nonce
              (some (PermitConsumption.mk permit attemptId))) }
        }
  | consumeUnknownBefore {state target nonce} :
      PermitStep state (.consumeUnknownBefore target nonce) state
  | restart {state actor} :
      PermitStep state (.restart actor) { state with permits := { state.permits with
        incarnation := fun candidate =>
          if candidate = actor then state.permits.incarnation candidate + 1
          else state.permits.incarnation candidate } }
  | reset {state actor} :
      PermitStep state (.reset actor) { state with permits := { state.permits with
        incarnation := fun candidate =>
          if candidate = actor then state.permits.incarnation candidate + 1
          else state.permits.incarnation candidate } }
  | advanceTime {state now} :
      state.permits.now.tick ≤ now.tick →
      PermitStep state (.advanceTime now) { state with permits := { state.permits with now := now } }
  | advanceFence {state target} :
      PermitStep state (.advanceFence target) { state with permits := { state.permits with
        targetFence := fun candidate =>
          if candidate = target then state.permits.targetFence candidate + 1
          else state.permits.targetFence candidate } }

theorem authentication_requires_exact_issued_record {before after target nonce}
    (step : PermitStep before (.authenticate target nonce) after) :
    ∃ permit, target = permit.expectation.target ∧ nonce = permit.nonce ∧
      exactIssued before.permits permit ∧
      exactAuthenticated after.permits permit := by
  cases step with
  | authenticate message issued fence =>
      refine ⟨_, rfl, rfl, issued, ?_⟩
      simp [exactAuthenticated]

theorem permit_issue_requires_exact_authenticated_binding
    {before after issuer nonce observation}
    (step : PermitStep before (.issue issuer nonce observation) after) :
    ∃ (permit : AuthorityPermit) (binding : Binding),
      issuer = permit.expectation.issuer ∧ nonce = permit.nonce ∧
      permit.expectation.issuer = .tenant permit.expectation.prepared.header.domain.tenant ∧
      permit.expectation.source = permit.expectation.prepared.header.caller.actor ∧
      permit.expectation.target = domainOwner permit.expectation.prepared.header.domain ∧
      before.core.authority.bindings permit.expectation.prepared.header.binding = some binding ∧
      binding.generation = permit.expectation.bindingGeneration ∧
      binding.facet = permit.expectation.prepared.header.operation.facet := by
  cases step with
  | @issue issuedExpectation issuedNonce expiresAt issuedObservation ready fresh expiry =>
      obtain ⟨authenticatedIssuer, fence, currentBinding, claimReady, mediatedReady⟩ := ready
      obtain ⟨binding, lookup, generation, facet⟩ := currentBinding
      exact ⟨⟨issuedExpectation, nonce, before.permits.now, expiresAt⟩,
        binding, rfl, rfl, authenticatedIssuer.1, authenticatedIssuer.2.1,
        authenticatedIssuer.2.2.2, lookup, generation, facet⟩

theorem exact_issued_permit_substitution_resistant
    {state : PermitProtocolState} {left right : AuthorityPermit}
    (leftIssued : exactIssued state left) (rightIssued : exactIssued state right)
    (sameIssuer : left.expectation.issuer = right.expectation.issuer)
    (sameNonce : left.nonce = right.nonce) : left = right := by
  unfold exactIssued at leftIssued rightIssued
  rw [sameIssuer, sameNonce, rightIssued] at leftIssued
  cases Option.some.inj leftIssued
  rfl

theorem missing_or_corrupt_issuer_record_cannot_authenticate
    {before after target nonce}
    (unavailable : ∀ permit, target = permit.expectation.target → nonce = permit.nonce →
      before.permits.issuerRecords permit.expectation.issuer permit.nonce ≠
        some (.issued permit)) :
    ¬ PermitStep before (.authenticate target nonce) after := by
  intro step
  obtain ⟨permit, targetEq, nonceEq, issued, _⟩ :=
    authentication_requires_exact_issued_record step
  exact unavailable permit targetEq nonceEq issued

theorem restart_invalidates_volatile_authentication {before after actor}
    (step : PermitStep before (.restart actor) after)
    {permit : AuthorityPermit} (target : permit.expectation.target = actor)
    (authenticated : exactAuthenticated before.permits permit) :
    ¬ exactAuthenticated after.permits permit := by
  cases step
  subst actor
  simp only [exactAuthenticated] at authenticated ⊢
  simp [authenticated]

theorem reset_preserves_durable_permit_state {before after actor}
    (step : PermitStep before (.reset actor) after) :
    after.permits.issuerRecords = before.permits.issuerRecords ∧
    after.permits.consumptions = before.permits.consumptions := by
  cases step
  exact ⟨rfl, rfl⟩

theorem target_attempt_step_stores_exact_attempt
    {before expectation now attemptId attempt auditId after}
    (step : TargetAttemptStep before expectation now attemptId attempt auditId after) :
    after.effects.attempts attemptId = some attempt ∧
    expectation.MatchesAttempt attempt := by
  cases step with
  | first localReady claimReady noApproval reserved persisted claimStored exactMatch sound effect stored audit =>
      exact ⟨stored, exactMatch⟩
  | approvalFirst localReady claimReady reserved persisted available claimStored exactMatch sound effect stored audit =>
      exact ⟨stored, exactMatch⟩
  | approvalContinue localReady claimReady reserved persisted continues continuationLookup valid different
      claimStored exactMatch sound effect stored audit =>
      exact ⟨stored, exactMatch⟩
  | retry localReady claimReady reserved persisted approval claimStored exactMatch sound effect stored audit =>
      exact ⟨stored, exactMatch⟩

theorem target_attempt_step_updates_only_exact_attempt
    {before expectation now attemptId attempt auditId after}
    (step : TargetAttemptStep before expectation now attemptId attempt auditId after) :
    after.effects.attempts = tableSet before.effects.attempts attemptId attempt := by
  cases step with
  | first localReady claimReady noApproval reserved persisted claimStored exactMatch sound effect stored audit =>
      cases effect
      simp [EffectLedger.addAttempt] at stored
      subst attempt
      rfl
  | approvalFirst localReady claimReady reserved persisted available claimStored exactMatch sound effect stored audit =>
      cases effect
      simp [EffectLedger.addAttempt] at stored
      subst attempt
      rfl
  | approvalContinue localReady claimReady reserved persisted continues continuationLookup valid different
      claimStored exactMatch sound effect stored audit =>
      cases effect
      simp [EffectLedger.addAttempt] at stored
      subst attempt
      rfl
  | retry localReady claimReady reserved persisted approval claimStored exactMatch sound effect stored audit =>
      cases effect
      simp [EffectLedger.addRetryAttempt, EffectLedger.addAttempt] at stored
      subst attempt
      rfl

private theorem target_attempt_step_requires_claim_ready
    {before expectation now attemptId attempt auditId after}
    (step : TargetAttemptStep before expectation now attemptId attempt auditId after) :
    expectation.ClaimReady before now := by
  cases step <;> assumption

theorem consume_is_exact_issued_authenticated_and_atomic
    {before after target nonce attemptId observation}
    (step : PermitStep before (.consume target nonce attemptId observation) after) :
    ∃ permit attempt,
      exactIssued before.permits permit ∧ exactAuthenticated before.permits permit ∧
      permit.expectation.ClaimReady before.core before.permits.now ∧
      target = permit.expectation.target ∧ nonce = permit.nonce ∧
      after.core.effects.attempts attemptId = some attempt ∧
      after.permits.consumptions target nonce =
        some (PermitConsumption.mk permit attemptId) ∧
      permit.expectation.MatchesAttempt attempt := by
  cases step with
  | consume issued authenticated fence issuedAt expires unused localStep =>
      obtain ⟨stored, exactMatch⟩ := target_attempt_step_stores_exact_attempt localStep
      have claimReady := target_attempt_step_requires_claim_ready localStep
      refine ⟨_, _, issued, authenticated, claimReady, rfl, rfl, stored, ?_, exactMatch⟩
      simp

theorem consumed_nonce_identifies_at_most_one_attempt
    {state : DistributedSystemState} {target : ActorRef} {nonce : PermitNonce}
    {left right : PermitConsumption}
    (leftLookup : state.permits.consumptions target nonce = some left)
    (rightLookup : state.permits.consumptions target nonce = some right) :
    left.attempt = right.attempt := by
  rw [leftLookup] at rightLookup
  cases Option.some.inj rightLookup
  rfl

theorem consumed_nonce_cannot_be_consumed_again
    {state after : DistributedSystemState} {target : ActorRef} {nonce : PermitNonce}
    {attempt : AttemptId} {observation : CommitObservation}
    (consumed : state.permits.consumptions target nonce ≠ none) :
    ¬ PermitStep state (.consume target nonce attempt observation) after := by
  intro step
  cases step with
  | consume issued authenticated fence issuedAt expiry unused localStep =>
      exact consumed unused

theorem revoked_current_binding_blocks_preissuance
    {state : DistributedSystemState} {expectation : PermitExpectation} {binding : Binding}
    (bindingLookup : state.core.authority.bindings
      expectation.prepared.header.binding = some binding)
    (revoked : state.core.authority.revoked binding.grant) :
    ¬ PermitIssueReady state expectation := by
  intro ready
  obtain ⟨_, _, _, _, mediatedReady⟩ := ready
  obtain ⟨_, _, _, _, _, _, resolution, _, usable⟩ := mediatedReady
  obtain ⟨_, _, authorized, _⟩ := usable
  obtain ⟨authorizedBinding, allow, authorizedLookup, _, _, _, _, live, _⟩ := authorized
  change state.core.authority.bindings expectation.prepared.header.binding =
    some authorizedBinding at authorizedLookup
  rw [bindingLookup] at authorizedLookup
  cases Option.some.inj authorizedLookup
  cases live with
  | root grantLookup parent notRevoked => exact notRevoked revoked
  | child grantLookup parent notRevoked parentLive => exact notRevoked revoked

end AgentCore
