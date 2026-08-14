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

/-- The target-owned immutable request from which the Tenant may issue one permit. -/
structure TargetPermitRequest where
  expectation : PermitExpectation
  nonce : PermitNonce
  expiresAt : Time
  deriving DecidableEq, Repr

/-- Tenant-issued evidence binds the exact target-owned request, without reconstructing it. -/
structure AuthorityPermit where
  request : TargetPermitRequest
  issuedAt : Time
  deriving DecidableEq, Repr

@[simp] def AuthorityPermit.expectation (permit : AuthorityPermit) : PermitExpectation :=
  permit.request.expectation

@[simp] def AuthorityPermit.nonce (permit : AuthorityPermit) : PermitNonce := permit.request.nonce

@[simp] def AuthorityPermit.expiresAt (permit : AuthorityPermit) : Time := permit.request.expiresAt

inductive IssuerPermitRecord where
  | issued (permit : AuthorityPermit)
  deriving DecidableEq, Repr

inductive PermitMessage where
  | request (request : TargetPermitRequest)
  | issued (permit : AuthorityPermit)
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
  targetRequests : ActorRef → PermitNonce → Option TargetPermitRequest
  issuerRecords : ActorRef → PermitNonce → Option IssuerPermitRecord
  transport : List PermitMessage
  authentications : ActorRef → PermitNonce → Option PermitAuthentication
  consumptions : ActorRef → PermitNonce → Option PermitConsumption
  incarnation : ActorRef → Nat
  targetFence : ActorRef → Nat

instance : Inhabited PermitProtocolState where
  default := ⟨⟨0⟩, fun _ _ => none, fun _ _ => none, [], fun _ _ => none, fun _ _ => none,
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

/-- The complete state a Tenant-local issuance decision may inspect. Target-owned
state is represented only by the authenticated immutable request payload. -/
structure TenantIssueView where
  actor : ActorRef
  authority : AuthorityLedger
  now : Time
  records : PermitNonce → Option IssuerPermitRecord

def tenantIssueView (state : DistributedSystemState) (actor : ActorRef) : TenantIssueView :=
  ⟨actor, state.core.authority, state.permits.now, state.permits.issuerRecords actor⟩

def TargetPermitRequest.AuthenticatedForTenant (request : TargetPermitRequest) : Prop :=
  request.expectation.IssuerAuthenticated ∧
  request.expectation.issuer ≠ request.expectation.target

def PermitIssueReady (tenant : TenantIssueView) (request : TargetPermitRequest) : Prop :=
  tenant.actor = request.expectation.issuer ∧
  request.AuthenticatedForTenant ∧
  request.expectation.CurrentBinding tenant.authority ∧
  ∃ resolution,
    tenant.authority.resolutions request.expectation.resolution = some resolution ∧
    tenant.authority.MediatedResolutionUsable resolution
      request.expectation.prepared.header.authority.principal
      request.expectation.prepared.header request.expectation.scope

def TargetLocalReady (state : SystemState) (request : AdmissionRequest) : Prop :=
  request.prepared.header.placement.Valid ∧
  CallerGate request.prepared.header ∧ RouteGate state request.prepared.header ∧
  effectiveTier request.prepared.header.placement.selected request.prepared.header.impact
    request.prepared.header.lease.isSome request.intercepted = .mediated ∧
  MediatedLeaseGate state request.prepared.header request.now ∧
  RunReservationGate state request

def TargetRequestReady (state : DistributedSystemState)
    (request : TargetPermitRequest) : Prop :=
  request.expectation.targetFence = state.permits.targetFence request.expectation.target ∧
  TargetLocalReady state.core (request.expectation.requestAt state.permits.now) ∧
  request.expectation.ClaimReady state.core state.permits.now

def exactRequested (state : PermitProtocolState) (request : TargetPermitRequest) : Prop :=
  state.targetRequests request.expectation.target request.nonce = some request

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
  | request (target : ActorRef) (nonce : PermitNonce) (observation : CommitObservation)
  | forwardRequest (target : ActorRef) (nonce : PermitNonce)
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
  | request {state request observation} :
      TargetRequestReady state request →
      state.permits.targetRequests request.expectation.target request.nonce = none →
      PermitStep state (.request request.expectation.target request.nonce observation) {
        state with permits := { state.permits with
          targetRequests := tableSet2 state.permits.targetRequests
            request.expectation.target request.nonce (some request) } }
  | forwardRequest {state request} :
      exactRequested state.permits request →
      PermitStep state (.forwardRequest request.expectation.target request.nonce) {
        state with permits := { state.permits with
          transport := state.permits.transport ++ [.request request] } }
  | issue {state request observation} :
      .request request ∈ state.permits.transport →
      PermitIssueReady (tenantIssueView state request.expectation.issuer) request →
      (tenantIssueView state request.expectation.issuer).records request.nonce = none →
      (tenantIssueView state request.expectation.issuer).now.tick < request.expiresAt.tick →
      PermitStep state (.issue request.expectation.issuer request.nonce observation) {
        state with permits := { state.permits with
          issuerRecords := tableSet2 state.permits.issuerRecords
            request.expectation.issuer request.nonce
            (some (.issued ⟨request,
              (tenantIssueView state request.expectation.issuer).now⟩)) } }
  | issueUnknownBefore {state issuer nonce} :
      PermitStep state (.issueUnknownBefore issuer nonce) state
  | emit {state permit} :
      exactIssued state.permits permit →
      PermitStep state (.emit permit.expectation.issuer permit.nonce) {
        state with permits := { state.permits with
          transport := state.permits.transport ++ [.issued permit] } }
  | injectMalformed {state} :
      PermitStep state (.inject .malformed) { state with permits := { state.permits with
        transport := state.permits.transport ++ [.malformed] } }
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
      .issued permit ∈ state.permits.transport →
      exactRequested state.permits permit.request →
      permit.expectation.targetFence = state.permits.targetFence permit.expectation.target →
      PermitStep state (.authenticate permit.expectation.target permit.nonce) {
        state with permits := { state.permits with
          authentications := tableSet2 state.permits.authentications
            permit.expectation.target permit.nonce
            (some ⟨permit, state.permits.incarnation permit.expectation.target⟩) } }
  | consume {state permit attemptId attempt auditId core' observation} :
      exactAuthenticated state.permits permit →
      exactRequested state.permits permit.request →
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

theorem authentication_requires_exact_target_request {before after target nonce}
    (step : PermitStep before (.authenticate target nonce) after) :
    ∃ permit, target = permit.expectation.target ∧ nonce = permit.nonce ∧
      .issued permit ∈ before.permits.transport ∧
      exactRequested before.permits permit.request ∧
      exactAuthenticated after.permits permit := by
  cases step with
  | authenticate message requested fence =>
      refine ⟨_, rfl, rfl, message, requested, ?_⟩
      simp [exactAuthenticated]

theorem permit_issue_requires_exact_authenticated_binding
    {before after issuer nonce observation}
    (step : PermitStep before (.issue issuer nonce observation) after) :
    ∃ (request : TargetPermitRequest) (permit : AuthorityPermit) (binding : Binding),
      .request request ∈ before.permits.transport ∧
      issuer = permit.expectation.issuer ∧ nonce = permit.nonce ∧
      permit.expectation.issuer = .tenant permit.expectation.prepared.header.domain.tenant ∧
      permit.expectation.source = permit.expectation.prepared.header.caller.actor ∧
      permit.expectation.prepared.header.caller.authenticated = true ∧
      permit.expectation.target = domainOwner permit.expectation.prepared.header.domain ∧
      permit.expectation.issuer ≠ permit.expectation.target ∧
      before.core.authority.bindings permit.expectation.prepared.header.binding = some binding ∧
      binding.generation = permit.expectation.bindingGeneration ∧
      binding.facet = permit.expectation.prepared.header.operation.facet := by
  cases step with
  | @issue issuedRequest issuedObservation transported ready fresh expiry =>
      obtain ⟨actor, authenticated, currentBinding, mediatedReady⟩ := ready
      obtain ⟨binding, lookup, generation, facet⟩ := currentBinding
      exact ⟨issuedRequest,
        ⟨issuedRequest, before.permits.now⟩,
        binding, transported, rfl, rfl, authenticated.1.1, authenticated.1.2.1,
        authenticated.1.2.2.1, authenticated.1.2.2.2, authenticated.2,
        lookup, generation, facet⟩

theorem exact_issued_permit_substitution_resistant
    {state : PermitProtocolState} {left right : AuthorityPermit}
    (leftIssued : exactIssued state left) (rightIssued : exactIssued state right)
    (sameIssuer : left.expectation.issuer = right.expectation.issuer)
    (sameNonce : left.nonce = right.nonce) : left = right := by
  unfold exactIssued at leftIssued rightIssued
  rw [sameIssuer, sameNonce, rightIssued] at leftIssued
  cases Option.some.inj leftIssued
  rfl

theorem missing_target_request_cannot_authenticate
    {before after target nonce}
    (unavailable : ∀ permit : AuthorityPermit,
      target = permit.expectation.target → nonce = permit.nonce →
      ¬ exactRequested before.permits permit.request) :
    ¬ PermitStep before (.authenticate target nonce) after := by
  intro step
  obtain ⟨permit, targetEq, nonceEq, _, requested, _⟩ :=
    authentication_requires_exact_target_request step
  exact unavailable permit targetEq nonceEq requested

theorem restart_invalidates_volatile_authentication {before after actor}
    (step : PermitStep before (.restart actor) after)
    {permit : AuthorityPermit} (target : permit.expectation.target = actor)
    (authenticated : exactAuthenticated before.permits permit) :
    ¬ exactAuthenticated after.permits permit := by
  cases step
  subst actor
  simp only [exactAuthenticated, AuthorityPermit.expectation,
    AuthorityPermit.nonce] at authenticated ⊢
  simp [authenticated]

theorem reset_invalidates_volatile_authentication {before after actor}
    (step : PermitStep before (.reset actor) after)
    {permit : AuthorityPermit} (target : permit.expectation.target = actor)
    (authenticated : exactAuthenticated before.permits permit) :
    ¬ exactAuthenticated after.permits permit := by
  cases step
  subst actor
  simp only [exactAuthenticated, AuthorityPermit.expectation,
    AuthorityPermit.nonce] at authenticated ⊢
  simp [authenticated]

theorem reset_preserves_durable_permit_state {before after actor}
    (step : PermitStep before (.reset actor) after) :
    after.permits.targetRequests = before.permits.targetRequests ∧
    after.permits.issuerRecords = before.permits.issuerRecords ∧
    after.permits.consumptions = before.permits.consumptions := by
  cases step
  exact ⟨rfl, rfl, rfl⟩

theorem commit_unknown_before_issue_preserves_state {before after issuer nonce}
    (step : PermitStep before (.issueUnknownBefore issuer nonce) after) :
    after = before := by
  cases step
  rfl

theorem commit_unknown_after_issue_persists_exact_record {before after issuer nonce}
    (step : PermitStep before (.issue issuer nonce .unknown) after) :
    ∃ permit, exactIssued after.permits permit ∧
      permit.expectation.issuer = issuer ∧ permit.nonce = nonce := by
  cases step with
  | @issue request observation transported ready fresh expiry =>
      refine ⟨⟨request,
        (tenantIssueView before request.expectation.issuer).now⟩, ?_, rfl, rfl⟩
      simp [exactIssued, AuthorityPermit.expectation, AuthorityPermit.nonce]

theorem commit_unknown_before_consume_preserves_state {before after target nonce}
    (step : PermitStep before (.consumeUnknownBefore target nonce) after) :
    after = before := by
  cases step
  rfl

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

theorem consume_is_exact_requested_authenticated_and_atomic
    {before after target nonce attemptId observation}
    (step : PermitStep before (.consume target nonce attemptId observation) after) :
    ∃ permit attempt,
      exactAuthenticated before.permits permit ∧
      exactRequested before.permits permit.request ∧
      permit.expectation.ClaimReady before.core before.permits.now ∧
      target = permit.expectation.target ∧ nonce = permit.nonce ∧
      after.core.effects.attempts attemptId = some attempt ∧
      after.permits.consumptions target nonce =
        some (PermitConsumption.mk permit attemptId) ∧
      permit.expectation.MatchesAttempt attempt := by
  cases step with
  | consume authenticated requested fence issuedAt expires unused localStep =>
      obtain ⟨stored, exactMatch⟩ := target_attempt_step_stores_exact_attempt localStep
      have claimReady := target_attempt_step_requires_claim_ready localStep
      refine ⟨_, _, authenticated, requested, claimReady, rfl, rfl, stored, ?_, exactMatch⟩
      simp

theorem commit_unknown_after_consume_persists_attempt_and_consumption
    {before after target nonce attemptId}
    (step : PermitStep before (.consume target nonce attemptId .unknown) after) :
    ∃ permit attempt,
      exactAuthenticated before.permits permit ∧
      exactRequested before.permits permit.request ∧
      after.core.effects.attempts attemptId = some attempt ∧
      after.permits.consumptions target nonce = some ⟨permit, attemptId⟩ ∧
      permit.expectation.MatchesAttempt attempt := by
  obtain ⟨permit, attempt, authenticated, requested, claimReady, targetEq, nonceEq,
    stored, consumed, exactMatch⟩ :=
    consume_is_exact_requested_authenticated_and_atomic step
  exact ⟨permit, attempt, authenticated, requested, stored, consumed, exactMatch⟩

theorem exact_authenticated_permit_substitution_resistant
    {state : PermitProtocolState} {left right : AuthorityPermit}
    (leftAuthenticated : exactAuthenticated state left)
    (rightAuthenticated : exactAuthenticated state right)
    (sameTarget : left.expectation.target = right.expectation.target)
    (sameNonce : left.nonce = right.nonce) : left = right := by
  unfold exactAuthenticated at leftAuthenticated rightAuthenticated
  rw [sameTarget, sameNonce, rightAuthenticated] at leftAuthenticated
  cases Option.some.inj leftAuthenticated
  rfl

theorem consume_requires_current_fence_and_unexpired
    {before after target nonce attempt observation}
    (step : PermitStep before (.consume target nonce attempt observation) after) :
    ∃ permit,
      exactAuthenticated before.permits permit ∧
      target = permit.expectation.target ∧ nonce = permit.nonce ∧
      permit.expectation.targetFence =
        before.permits.targetFence permit.expectation.target ∧
      before.permits.now.tick < permit.expiresAt.tick := by
  cases step with
  | consume authenticated requested fence issuedAt unexpired unused localStep =>
      exact ⟨_, authenticated, rfl, rfl, fence, unexpired⟩

theorem expired_permit_cannot_consume
    {before after : DistributedSystemState} {permit : AuthorityPermit}
    {attempt : AttemptId} {observation : CommitObservation}
    (authenticated : exactAuthenticated before.permits permit)
    (expired : permit.expiresAt.tick ≤ before.permits.now.tick) :
    ¬ PermitStep before
      (.consume permit.expectation.target permit.nonce attempt observation) after := by
  intro step
  obtain ⟨candidate, candidateAuthenticated, targetEq, nonceEq, _, unexpired⟩ :=
    consume_requires_current_fence_and_unexpired step
  have same : candidate = permit :=
    exact_authenticated_permit_substitution_resistant candidateAuthenticated authenticated
      targetEq.symm nonceEq.symm
  subst candidate
  omega

theorem changed_target_fence_cannot_consume
    {before after : DistributedSystemState} {permit : AuthorityPermit}
    {attempt : AttemptId} {observation : CommitObservation}
    (authenticated : exactAuthenticated before.permits permit)
    (changed : permit.expectation.targetFence ≠
      before.permits.targetFence permit.expectation.target) :
    ¬ PermitStep before
      (.consume permit.expectation.target permit.nonce attempt observation) after := by
  intro step
  obtain ⟨candidate, candidateAuthenticated, targetEq, nonceEq, fence, _⟩ :=
    consume_requires_current_fence_and_unexpired step
  have same : candidate = permit :=
    exact_authenticated_permit_substitution_resistant candidateAuthenticated authenticated
      targetEq.symm nonceEq.symm
  subst candidate
  exact changed fence

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
  | consume authenticated requested fence issuedAt expiry unused localStep =>
      exact consumed unused

theorem revoked_current_binding_blocks_preissuance
    {tenant : TenantIssueView} {request : TargetPermitRequest} {binding : Binding}
    (bindingLookup : tenant.authority.bindings
      request.expectation.prepared.header.binding = some binding)
    (revoked : tenant.authority.revoked binding.grant) :
    ¬ PermitIssueReady tenant request := by
  intro ready
  obtain ⟨_, _, _, resolution, _, usable⟩ := ready
  obtain ⟨_, _, authorized, _⟩ := usable
  obtain ⟨authorizedBinding, allow, authorizedLookup, _, _, _, _, live, _⟩ := authorized
  change tenant.authority.bindings request.expectation.prepared.header.binding =
    some authorizedBinding at authorizedLookup
  rw [bindingLookup] at authorizedLookup
  cases Option.some.inj authorizedLookup
  cases live with
  | root grantLookup parent notRevoked => exact notRevoked revoked
  | child grantLookup parent notRevoked parentLive => exact notRevoked revoked

end AgentCore
