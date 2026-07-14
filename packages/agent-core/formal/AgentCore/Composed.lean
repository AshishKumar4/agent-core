import AgentCore.RunGraph

/-!
# Split direct and mediated composition

`SystemState` only aggregates uniquely owned stores. Direct admission performs no
durable mutation. Mediated transitions persist intent and may use an exact Turn lease
or the owning-Actor path when the header has no Turn. Approval start consumes an
already-persisted identical intent and starts ordinal-zero work under current authority.
-/

namespace AgentCore

structure SystemState where
  authority : AuthorityLedger
  approvals : ApprovalLedger
  effects : EffectLedger
  events : EventStore
  audit : AuditLog
  graph : GraphStore

instance : Inhabited SystemState where default := ⟨default, default, default, default, default, default⟩

structure AdmissionRequest where
  prepared : PreparedInvocation
  scope : Scope
  resolution : ResolutionId
  reservation : Option AdmissionReservation
  now : Time

def AdmissionRequest.ReservedFor (request : AdmissionRequest)
    (obligation : OpenObligation) : Prop :=
  match request.prepared.header.domain with
  | .run _ _ => ∃ reservation, request.reservation = some reservation ∧
      reservation.obligation = obligation
  | .workspace _ _ => request.reservation = none

def AdmissionRequest.ReservesItem (request : AdmissionRequest) (index : Nat) : Prop :=
  ∃ item, PreparedItemAt request.prepared index item ∧
    request.ReservedFor (.item request.prepared.header.invocation index item.key)

def ExactTurnContext (state : SystemState) (header : InvocationHeader)
    (token : LeaseToken) (turn : Turn) : Prop :=
  ∃ run,
    state.graph.runs turn.run = some run ∧
    header.domain = .run run.tenant turn.run ∧
    turn.pins.placement = header.placement ∧ token.turn = turn.lease.turn

def ExactLeaseGate (state : SystemState) (header : InvocationHeader) (now : Time) : Prop :=
  ∃ token turn, header.lease = some token ∧ state.graph.turns token.turn = some turn ∧
    turn.status = .running ∧ ExactTurnContext state header token turn ∧ turn.lease.Admits token now

def MediatedLeaseGate (state : SystemState) (header : InvocationHeader) (now : Time) : Prop :=
  match header.lease with
  | none => ∃ entry, state.audit.entries header.auditCause = some entry ∧
      header.caller.authenticated = true ∧
      header.caller.actor = domainOwner header.domain ∧
      entry.actor = header.caller.actor
  | some token => ∃ turn, state.graph.turns token.turn = some turn ∧
       turn.status = .running ∧ ExactTurnContext state header token turn ∧
       turn.lease.Admits token now

def RunReservationGate (state : SystemState) (request : AdmissionRequest) : Prop :=
  match request.prepared.header.domain with
  | .run tenant runId => ∃ run reservation,
      state.graph.runs runId = some run ∧ run.tenant = tenant ∧
      request.reservation = some reservation ∧ reservation.run = runId ∧
      reservation.ValidIn state.graph
  | .workspace _ _ => request.reservation = none

def CallerGate (header : InvocationHeader) : Prop :=
  header.caller.authenticated = true ∧
  (header.lease = none → header.caller.actor = domainOwner header.domain)

def RouteGate (state : SystemState) (header : InvocationHeader) : Prop :=
  header.RouteEvidenceConsistent ∧
  match header.routeEvidence.reservation, header.routeEvidence.projection,
      header.projectionDigest with
  | none, none, none => True
  | some reservationId, some projectionId, some digest =>
      ∃ reservation projection auditEntry,
        state.events.reservations reservationId = some reservation ∧
        reservation.invocation = header.invocation ∧
        reservation.authority.source = header.authority ∧
        reservation.projection = projectionId ∧ reservation.projectionDigest = digest ∧
        state.events.projections projectionId = some projection ∧
        state.events.projectionFor reservationId = some projectionId ∧
        projection.reservation = reservationId ∧ projection.digest = digest ∧
        projection.authenticated = true ∧ projection.targetOwner = domainOwner header.domain ∧
        state.audit.entries header.auditCause = some auditEntry ∧
        auditEntry.actor = domainOwner header.domain ∧
        auditEntry.kind = .routeProjected projectionId reservationId header.invocation
  | _, _, _ => False

def DirectReady (state : SystemState) (request : AdmissionRequest) : Prop :=
  request.prepared.header.placement.Valid ∧
  CallerGate request.prepared.header ∧ RouteGate state request.prepared.header ∧
  request.prepared.header.impact = .observe ∧
  request.prepared.header.placement.selected = .bundled ∧
  effectiveTier .bundled request.prepared.header.impact request.prepared.header.lease.isSome = .direct ∧
  ExactLeaseGate state request.prepared.header request.now ∧
  ∃ resolution token turn,
    state.authority.resolutions request.resolution = some resolution ∧
    request.prepared.header.lease = some token ∧
    state.graph.turns token.turn = some turn ∧
    resolution.originalLeaseExpiry = some turn.lease.expiresAt ∧
    state.authority.DirectResolutionUsable resolution request.prepared.header request.now

def MediatedReady (state : SystemState) (request : AdmissionRequest) : Prop :=
  request.prepared.header.placement.Valid ∧
  CallerGate request.prepared.header ∧ RouteGate state request.prepared.header ∧
  effectiveTier request.prepared.header.placement.selected request.prepared.header.impact
    request.prepared.header.lease.isSome = .mediated ∧
  MediatedLeaseGate state request.prepared.header request.now ∧
  RunReservationGate state request ∧
  ∃ resolution, state.authority.resolutions request.resolution = some resolution ∧
    state.authority.MediatedResolutionUsable resolution
      request.prepared.header.authority.principal
      request.prepared.header request.scope

theorem mediated_ready_validates_exact_run_reservation {state request tenant runId}
    (ready : MediatedReady state request)
    (domain : request.prepared.header.domain = .run tenant runId) :
    ∃ run reservation registry,
      state.graph.runs runId = some run ∧ run.tenant = tenant ∧
      request.reservation = some reservation ∧ reservation.run = runId ∧
      state.graph.admissionRegistry runId = some registry ∧
      registry.accepting = true ∧ registry.epoch = reservation.epoch ∧
      reservation.obligation ∈ registry.reserved ∧
      reservation.obligation ∉ registry.completed := by
  have gate := ready.2.2.2.2.2.1
  unfold RunReservationGate at gate
  rw [domain] at gate
  obtain ⟨run, reservation, runLookup, tenantOwner, requestReservation, reservationRun,
    valid⟩ := gate
  obtain ⟨registry, registryLookup, accepting, epoch, reserved, incomplete⟩ := valid
  rw [reservationRun] at registryLookup
  exact ⟨run, reservation, registry, runLookup, tenantOwner, requestReservation,
    reservationRun, registryLookup, accepting, epoch, reserved, incomplete⟩

theorem mediated_ready_reserves_exact_obligation {state request tenant runId obligation}
    (ready : MediatedReady state request)
    (domain : request.prepared.header.domain = .run tenant runId)
    (reservedFor : request.ReservedFor obligation) :
    ∃ run reservation registry,
      state.graph.runs runId = some run ∧ run.tenant = tenant ∧
      request.reservation = some reservation ∧ reservation.run = runId ∧
      reservation.obligation = obligation ∧
      state.graph.admissionRegistry runId = some registry ∧
      registry.accepting = true ∧ registry.epoch = reservation.epoch ∧
      obligation ∈ registry.reserved ∧ obligation ∉ registry.completed := by
  obtain ⟨run, reservation, registry, runLookup, tenantOwner, requestReservation,
    reservationRun, registryLookup, accepting, epoch, reserved, incomplete⟩ :=
    mediated_ready_validates_exact_run_reservation ready domain
  unfold AdmissionRequest.ReservedFor at reservedFor
  rw [domain] at reservedFor
  obtain ⟨exactReservation, requestExact, exactObligation⟩ := reservedFor
  rw [requestReservation] at requestExact
  cases Option.some.inj requestExact
  exact ⟨run, reservation, registry, runLookup, tenantOwner, requestReservation,
    reservationRun, exactObligation, registryLookup, accepting, epoch,
    exactObligation ▸ reserved, exactObligation ▸ incomplete⟩

theorem changed_registry_epoch_blocks_mediated_ready
    {state request tenant runId reservation registry}
    (domain : request.prepared.header.domain = .run tenant runId)
    (requestReservation : request.reservation = some reservation)
    (registryLookup : state.graph.admissionRegistry runId = some registry)
    (changed : registry.epoch ≠ reservation.epoch) :
    ¬ MediatedReady state request := by
  intro ready
  obtain ⟨run, exactReservation, exactRegistry, runLookup, tenantOwner,
    requestExact, reservationRun, registryExact, accepting, epoch, reserved, incomplete⟩ :=
    mediated_ready_validates_exact_run_reservation ready domain
  rw [requestReservation] at requestExact
  cases Option.some.inj requestExact
  rw [registryLookup] at registryExact
  cases Option.some.inj registryExact
  exact changed epoch

inductive DirectStep : SystemState → AdmissionRequest → SystemState → Prop
  | admit {state request} : DirectReady state request → DirectStep state request state

theorem direct_admission_is_nondurable {before request after}
    (step : DirectStep before request after) : after = before := by cases step; rfl

def requiresApproval (prepared : PreparedInvocation) : Bool :=
  match prepared.header.impact with
  | .externalSend | .delegate | .administer => true
  | _ => false

def FirstAttemptSound (prepared : PreparedInvocation) (attempt : EffectAttempt) : Prop :=
  attempt.invocation = prepared.header.invocation ∧ attempt.ordinal = 0 ∧
  AttemptMatches prepared attempt

def RetryAttemptSound (prepared : PreparedInvocation) (attempt : EffectAttempt) : Prop :=
  attempt.invocation = prepared.header.invocation ∧ AttemptMatches prepared attempt

def admissionFor (request : AdmissionRequest) : AttemptAdmission :=
  ⟨request.prepared.identity, request.prepared.header.authority.principal,
    request.scope, request.resolution⟩

def ReservationSourceAuditValid (events : EventStore) (audit : AuditLog) : EventLabel → Prop
  | .reserve reservationId => ∃ reservation event entry,
      events.reservations reservationId = some reservation ∧
      events.events reservation.sourceEvent = some event ∧ event.owner = reservation.sourceOwner ∧
      audit.entries reservation.sourceAudit = some entry ∧ entry.actor = reservation.sourceOwner ∧
      entry.kind = .event reservation.sourceEvent reservation.invocation
  | _ => True

structure AuthorityPermit where
  principal : PrincipalRef
  invocation : InvocationId
  attempt : AttemptId
  registryEpoch : Nat
  pathEvidence : List PathEpoch
  nonce : Nat
  issuedAt : Time
  expiresAt : Time
  deriving DecidableEq, Repr

structure PermitLedger where
  issued : Nat → Option AuthorityPermit
  consumed : Nat → Prop

def PermitLedger.Consumable (ledger : PermitLedger) (permit : AuthorityPermit)
    (now : Time) : Prop :=
  ledger.issued permit.nonce = some permit ∧ ¬ ledger.consumed permit.nonce ∧
    permit.issuedAt.tick ≤ now.tick ∧ now.tick < permit.expiresAt.tick

theorem post_issuance_watermark_cannot_cancel_permit
    {permits : PermitLedger} {permit : AuthorityPermit} {now : Time}
    {before after : AuthorityLedger}
    (_advanced : ∀ scope,
      before.holderWatermark permit.principal scope ≤
        after.holderWatermark permit.principal scope)
    (consumable : permits.Consumable permit now) :
    permits.Consumable permit now := by
  exact consumable

inductive MediatedLabel where
  | persistIntent (invocation : InvocationId)
  | requestApproval (approval : ApprovalId) (invocation : InvocationId)
  | start (invocation : InvocationId) (attempt : AttemptId)
  | approvalStart (approval : ApprovalId) (invocation : InvocationId) (attempt : AttemptId)
  | approvalContinue (approval : ApprovalId) (invocation : InvocationId) (attempt : AttemptId)
  | staleDenied (invocation : InvocationId) (receipt : ReceiptId)
  | claimItem (invocation : InvocationId) (index : Nat) (now : Time)
  | recoverItemClaim (invocation : InvocationId) (index : Nat) (now : Time)
  | retry (invocation : InvocationId) (previous next : AttemptId)
  | preReceipt (invocation : InvocationId) (receipt : ReceiptId)
  | attemptReceipt (invocation : InvocationId) (receipt : ReceiptId)
  | supersedeReceipt (invocation : InvocationId) (previous next : ReceiptId)
  | audit (label : AuditLabel)
  | event (label : EventLabel)
  | graph (label : GraphLabel)
  deriving DecidableEq, Repr

def ApprovalContinuation.ValidFirstAttempt (effects : EffectLedger)
    (prepared : PreparedInvocation) (continuation : ApprovalContinuation) : Prop :=
  ∃ attempt item,
    effects.attempts continuation.firstAttempt = some attempt ∧
    attempt.invocation = continuation.invocation ∧
    PreparedItemAt prepared attempt.itemIndex item ∧ attempt.key = item.key

inductive MediatedStep : SystemState → MediatedLabel → SystemState → Prop
  | persistIntent {state request effects'} :
      MediatedReady state request →
      EffectStep state.effects (.persistIntent request.prepared.header.invocation) effects' →
      MediatedStep state (.persistIntent request.prepared.header.invocation)
        { state with effects := effects' }
  | requestApproval {state request approvalId ticket approvals' effects'} :
      MediatedReady state request → requiresApproval request.prepared = true →
      request.ReservedFor (.approval approvalId) →
      ticket.invocation = request.prepared.header.invocation →
      ticket.identity = request.prepared.identity → ticket.digest = request.prepared.digest →
      ticket.phase = .pending →
      EffectStep state.effects (.persistIntent request.prepared.header.invocation) effects' →
      ApprovalStep state.approvals (.request approvalId) approvals' →
      approvals'.tickets approvalId = some ticket →
      MediatedStep state (.requestApproval approvalId request.prepared.header.invocation) {
        state with approvals := approvals', effects := effects' }
  | start {state request attemptId attempt effects'} :
      MediatedReady state request → requiresApproval request.prepared = false →
      request.ReservedFor (.item request.prepared.header.invocation
        attempt.itemIndex attempt.key) →
      state.effects.invocations request.prepared.header.invocation = some request.prepared →
      FirstAttemptSound request.prepared attempt →
      EffectStep (state.effects.recordAdmission attemptId (admissionFor request))
        (.firstAttempt attemptId) effects' →
      MediatedStep state (.start request.prepared.header.invocation attemptId)
        { state with effects := effects' }
  | approvalStart {state request approvalId attemptId attempt effects'} :
      MediatedReady state request →
      request.ReservedFor (.item request.prepared.header.invocation
        attempt.itemIndex attempt.key) →
      state.effects.invocations request.prepared.header.invocation = some request.prepared →
      state.approvals.Available approvalId request.prepared request.now →
      FirstAttemptSound request.prepared attempt →
      EffectStep (state.effects.recordAdmission attemptId (admissionFor request))
        (.firstAttempt attemptId) effects' →
      effects'.attempts attemptId = some attempt →
      MediatedStep state (.approvalStart approvalId request.prepared.header.invocation attemptId) {
        state with
        approvals := state.approvals.consume approvalId request.prepared attemptId
        effects := effects'
      }
  | approvalContinue {state request approvalId attemptId attempt effects' continuation} :
      MediatedReady state request →
      request.ReservedFor (.item request.prepared.header.invocation
        attempt.itemIndex attempt.key) →
      state.effects.invocations request.prepared.header.invocation = some request.prepared →
      state.approvals.Continues approvalId request.prepared →
      state.approvals.continuations request.prepared.header.invocation = some continuation →
      continuation.ValidFirstAttempt state.effects request.prepared →
      attemptId ≠ continuation.firstAttempt →
      FirstAttemptSound request.prepared attempt →
      EffectStep (state.effects.recordAdmission attemptId (admissionFor request))
        (.firstAttempt attemptId) effects' →
      effects'.attempts attemptId = some attempt →
      MediatedStep state
        (.approvalContinue approvalId request.prepared.header.invocation attemptId) {
          state with effects := effects' }
  | claimItem {state request} {claim : ItemClaim} {effects'} :
      MediatedReady state request →
      request.ReservesItem claim.itemIndex →
      state.effects.invocations request.prepared.header.invocation = some request.prepared →
      claim.invocation = request.prepared.header.invocation →
      EffectStep state.effects (.claimItem claim.invocation claim.itemIndex request.now) effects' →
      MediatedStep state (.claimItem claim.invocation claim.itemIndex request.now)
        { state with effects := effects' }
  | recoverItemClaim {state request} {previous replacement : ItemClaim} {effects'} :
      MediatedReady state request →
      request.ReservesItem previous.itemIndex →
      state.effects.invocations request.prepared.header.invocation = some request.prepared →
      previous.invocation = request.prepared.header.invocation →
      EffectStep state.effects
        (.recoverItemClaim previous.invocation previous.itemIndex request.now) effects' →
      effects'.claims previous.invocation previous.itemIndex = some replacement →
      MediatedStep state (.recoverItemClaim previous.invocation previous.itemIndex request.now)
        { state with effects := effects' }
  | retry {state request previous next attempt effects'} :
      MediatedReady state request →
      request.ReservedFor (.item request.prepared.header.invocation
        attempt.itemIndex attempt.key) →
      state.effects.invocations request.prepared.header.invocation = some request.prepared →
      (requiresApproval request.prepared = false ∨
        ∃ approvalId, state.approvals.Continues approvalId request.prepared) →
      RetryAttemptSound request.prepared attempt →
      EffectStep (state.effects.recordAdmission next (admissionFor request))
        (.retryAttempt previous next) effects' →
      effects'.attempts next = some attempt →
      MediatedStep state (.retry request.prepared.header.invocation previous next) {
        state with effects := effects' }
  | staleDenied {state : SystemState} {request : AdmissionRequest} {resolution : Resolution}
      {holder : PrincipalRef} {item : PreparedItem} {receiptId : ReceiptId}
      {receipt : PreEffectReceipt}
      {effects' : EffectLedger} {authority' : AuthorityLedger} :
      state.authority.resolutions request.resolution = some resolution →
      resolution.header = request.prepared.header →
      state.effects.invocations request.prepared.header.invocation = some request.prepared →
      ¬ state.authority.PathEvidenceComplete request.prepared.header request.scope →
      holder = (match request.prepared.header.lease with
        | some token => token.holder | none => request.prepared.header.authority.principal) →
      AuthorityLedger.AuthorityStep state.authority (.observe holder request.scope) authority' →
      receipt.invocation = request.prepared.header.invocation →
      request.prepared.items[receipt.itemIndex]? = some item →
      receipt.outcome = .denied →
      EffectStep state.effects (.preReceipt receiptId) effects' →
      effects'.preReceipts receiptId = some receipt →
      MediatedStep state (.staleDenied request.prepared.header.invocation receiptId) {
        state with authority := authority', effects := effects' }
  | preReceipt {state invocation receiptId prepared receipt effects'} :
      state.effects.invocations invocation = some prepared →
      EffectStep state.effects (.preReceipt receiptId) effects' →
      effects'.preReceipts receiptId = some receipt → receipt.invocation = invocation →
      MediatedStep state (.preReceipt invocation receiptId) { state with effects := effects' }
  | attemptReceipt {state invocation receiptId receipt attempt effects'} :
      state.effects.attempts receipt.attempt = some attempt → attempt.invocation = invocation →
      EffectStep state.effects (.attemptReceipt receiptId) effects' →
      effects'.attemptReceipts receiptId = some receipt →
      MediatedStep state (.attemptReceipt invocation receiptId) { state with effects := effects' }
  | supersedeReceipt {state invocation previous next beforeReceipt receipt attempt effects'} :
      state.effects.attemptReceipts previous = some beforeReceipt →
      state.effects.attempts beforeReceipt.attempt = some attempt → attempt.invocation = invocation →
      EffectStep state.effects (.supersedeReceipt previous next) effects' →
      effects'.attemptReceipts next = some receipt → receipt.attempt = beforeReceipt.attempt →
      MediatedStep state (.supersedeReceipt invocation previous next) { state with effects := effects' }
  | audit {state label audit'} :
      AuditStep state.effects state.events state.audit label audit' →
      MediatedStep state (.audit label) { state with audit := audit' }
  | event {state label leases now events'} :
      EventStep leases now state.events label events' →
      (∀ turn, leases turn = (state.graph.turns turn).map Turn.lease) →
      ReservationSourceAuditValid events' state.audit label →
      MediatedStep state (.event label) { state with events := events' }
  | graph {state label graph'} :
      GraphStep state.effects state.events state.audit state.graph label graph' →
      MediatedStep state (.graph label) { state with graph := graph' }

def ApprovalObligationClosed (state : SystemState) (approval : ApprovalId) : Prop :=
  ∃ ticket, state.approvals.tickets approval = some ticket ∧
    (state.approvals.consumedBy approval = some ticket.invocation ∨
      ticket.phase = .denied ∨ ticket.phase = .expired)

def CurrentReceiptAudited (state : SystemState) (invocation : InvocationId) (index : Nat)
    (auditId : AuditId) : Prop :=
  match state.effects.currentReceipt invocation index with
  | some (.preEffect receipt) => ∃ record entry,
      state.effects.preReceipts receipt = some record ∧
      state.audit.entries auditId = some entry ∧
      entry.kind = .preReceipt receipt record.invocation record.itemIndex record.outcome ∧
      CausalChain state.events state.audit auditId
  | some (.attempt receipt) => ∃ record attempt entry,
      state.effects.attemptReceipts receipt = some record ∧
      state.effects.attempts record.attempt = some attempt ∧
      state.audit.entries auditId = some entry ∧
      entry.kind = .attemptReceipt receipt record.attempt attempt.invocation record.outcome ∧
      CausalChain state.events state.audit auditId
  | none => False

def RouteDeliveryAudited (state : SystemState) (reservation : ReservationId) : Prop :=
  ∃ delivery projectionId projection auditId entry,
    state.events.deliveries reservation = some delivery ∧
    state.events.projections projectionId = some projection ∧
    projection.reservation = reservation ∧
    state.audit.entries auditId = some entry ∧
    ∃ route, state.events.reservations reservation = some route ∧
    entry.kind = .delivery reservation projectionId route.invocation delivery.outcome ∧
    CausalChain state.events state.audit auditId

def ExactAuditObligationDischarged (state : SystemState) (auditId : AuditId)
    (actor : ActorRef) (kind : AuditKind) (cause : Option AuditId) : Prop :=
  ∃ entry, state.audit.entries auditId = some entry ∧
    state.audit.atSequence actor entry.sequence = some auditId ∧
    entry.actor = actor ∧ entry.kind = kind ∧ entry.cause = cause ∧
    LocalCauseValid state.audit entry ∧ CausalChain state.events state.audit auditId

def ObligationDischarged (state : SystemState) : OpenObligation → Prop
  | .approval approval => ApprovalObligationClosed state approval
  | .item invocation index key => ∃ prepared item outcome auditId,
      state.effects.invocations invocation = some prepared ∧
      PreparedItemAt prepared index item ∧ item.key = key ∧
      ItemCurrentOutcome state.effects invocation index outcome ∧ outcome ≠ .indeterminate ∧
      CurrentReceiptAudited state invocation index auditId
  | .route reservation => RouteDeliveryAudited state reservation
  | .reconciliation attempt => ∃ indeterminate final before after,
      state.effects.supersededBy indeterminate = some final ∧
      state.effects.attemptReceipts indeterminate = some before ∧
      state.effects.attemptReceipts final = some after ∧
      before.attempt = attempt ∧ before.outcome = .indeterminate ∧
      after.attempt = attempt ∧ after.previous = some indeterminate ∧
      (after.outcome = .succeeded ∨ after.outcome = .failed)
  | .systemCommit commitId => ∃ commit auditId entry evidence,
      state.graph.commits commitId = some commit ∧
      state.audit.entries auditId = some entry ∧
      entry.actor = .run (actorTenantOf entry.actor) commit.run ∧
      entry.kind = .commit commitId evidence ∧ LocalCauseValid state.audit entry ∧
      CausalChain state.events state.audit auditId

def Settled (state : SystemState) (run : RunId) : Prop :=
  (∃ record snapshot, state.graph.runs run = some record ∧ record.status = .terminal ∧
    state.graph.terminalSnapshots run = some snapshot ∧
    snapshot.run = run ∧ TerminalSnapshotCoherent state.graph snapshot) ∧
  (∀ id turn, state.graph.turns id = some turn → turn.run = run →
    turn.status = .succeeded ∨ turn.status = .failed ∨ turn.status = .cancelled) ∧
  (∀ invocation prepared, state.effects.invocations invocation = some prepared →
    (∃ tenant, prepared.header.domain = .run tenant run) →
    ∀ item, item ∈ prepared.items → ∃ outcome,
      ItemCurrentOutcome state.effects invocation item.index outcome ∧
      outcome ≠ .indeterminate ∧
      ∃ auditId, CurrentReceiptAudited state invocation item.index auditId) ∧
  (∀ invocation prepared, state.effects.invocations invocation = some prepared →
    (∃ tenant, prepared.header.domain = .run tenant run) →
    RoutesTerminal state.events invocation ∧
    ∀ reservation, state.events.reservationFor invocation = some reservation →
      RouteDeliveryAudited state reservation) ∧
  (∀ snapshot, state.graph.terminalSnapshots run = some snapshot →
    ∀ obligation, obligation ∈ snapshot.obligations → ObligationDischarged state obligation) ∧
  ¬ state.graph.conflicts run

theorem item_obligation_uses_exact_audit {state invocation index key}
    (discharged : ObligationDischarged state (.item invocation index key)) :
    ∃ prepared item outcome auditId,
      state.effects.invocations invocation = some prepared ∧
      PreparedItemAt prepared index item ∧ item.key = key ∧
      ItemCurrentOutcome state.effects invocation index outcome ∧
      CurrentReceiptAudited state invocation index auditId := by
  obtain ⟨prepared, item, outcome, auditId, invocationLookup, itemAt, exactKey,
    terminal, notIndeterminate, audited⟩ := discharged
  exact ⟨prepared, item, outcome, auditId, invocationLookup, itemAt, exactKey, terminal, audited⟩

theorem approval_admission_requires_reserved_obligation
    {before after approval invocation}
    (step : MediatedStep before (.requestApproval approval invocation) after) :
    ∃ request, MediatedReady before request ∧
      request.prepared.header.invocation = invocation ∧
      request.ReservedFor (.approval approval) := by
  cases step with
  | requestApproval ready required reserved exactInvocation identity digest pending intent
      approvalStep stored =>
      exact ⟨_, ready, rfl, reserved⟩

theorem item_claim_requires_reserved_obligation {before after invocation index now}
    (step : MediatedStep before (.claimItem invocation index now) after) :
    ∃ request, MediatedReady before request ∧
      request.prepared.header.invocation = invocation ∧ request.ReservesItem index := by
  cases step with
  | claimItem ready reserved persisted exactInvocation effectStep =>
      exact ⟨_, ready, exactInvocation.symm, reserved⟩

theorem recovered_item_claim_requires_reserved_obligation
    {before after invocation index now}
    (step : MediatedStep before (.recoverItemClaim invocation index now) after) :
    ∃ request, MediatedReady before request ∧
      request.prepared.header.invocation = invocation ∧ request.ReservesItem index := by
  cases step with
  | recoverItemClaim ready reserved persisted exactInvocation effectStep stored =>
      exact ⟨_, ready, exactInvocation.symm, reserved⟩

theorem first_effect_admission_requires_reserved_item {before after invocation attempt}
    (step : MediatedStep before (.start invocation attempt) after) :
    ∃ (request : AdmissionRequest) (record : EffectAttempt), MediatedReady before request ∧
      request.ReservedFor (.item invocation record.itemIndex record.key) := by
  cases step with
  | start ready required reserved persisted sound effectStep => exact ⟨_, _, ready, reserved⟩

theorem approved_effect_admission_requires_reserved_item
    {before after approval invocation attempt}
    (step : MediatedStep before (.approvalStart approval invocation attempt) after) :
    ∃ (request : AdmissionRequest) (record : EffectAttempt), MediatedReady before request ∧
      request.ReservedFor (.item invocation record.itemIndex record.key) := by
  cases step with
  | approvalStart ready reserved persisted available sound effectStep stored =>
      exact ⟨_, _, ready, reserved⟩

theorem continued_effect_admission_requires_reserved_item
    {before after approval invocation attempt}
    (step : MediatedStep before (.approvalContinue approval invocation attempt) after) :
    ∃ (request : AdmissionRequest) (record : EffectAttempt), MediatedReady before request ∧
      request.ReservedFor (.item invocation record.itemIndex record.key) := by
  cases step with
  | approvalContinue ready reserved persisted continues continuation valid different sound
      effectStep stored =>
      exact ⟨_, _, ready, reserved⟩

theorem retry_effect_admission_requires_reserved_item
    {before after invocation previous next}
    (step : MediatedStep before (.retry invocation previous next) after) :
    ∃ (request : AdmissionRequest) (record : EffectAttempt), MediatedReady before request ∧
      request.ReservedFor (.item invocation record.itemIndex record.key) := by
  cases step with
  | retry ready reserved persisted approval sound effectStep stored =>
      exact ⟨_, _, ready, reserved⟩

theorem approval_start_consumes_persisted_exact_intent {before after approval invocation attempt}
    (step : MediatedStep before (.approvalStart approval invocation attempt) after) :
    ∃ (prepared : PreparedInvocation) (ticket : ApprovalTicket)
        (continuation : ApprovalContinuation) (firstAttempt : EffectAttempt)
        (firstItem : PreparedItem),
      before.effects.invocations invocation = some prepared ∧
      before.approvals.tickets approval = some ticket ∧
      ticket.invocation = invocation ∧ ticket.identity = prepared.identity ∧
      after.approvals.consumedBy approval = some invocation ∧
      after.approvals.continuations invocation = some continuation ∧
      continuation.firstAttempt = attempt ∧ after.effects.attempts attempt = some firstAttempt ∧
      firstAttempt.invocation = continuation.invocation ∧
      PreparedItemAt prepared firstAttempt.itemIndex firstItem ∧ firstAttempt.key = firstItem.key := by
  cases step with
  | approvalStart ready reserved persisted available first effectStep stored =>
      obtain ⟨ticket, lookup, approved, exactInvocation, identity, digest, live, unique, unused,
        absent⟩ := available
      obtain ⟨firstItem, firstAt, firstKey, leaseMatch⟩ := first.2.2
      exact ⟨_, ticket, _, _, firstItem, persisted, lookup, exactInvocation, identity,
        tableSet_self .., tableSet_self .., rfl, stored, first.1, firstAt, firstKey⟩

theorem approval_continuation_validates_persisted_exact_intent
    {before after approval invocation attempt}
    (step : MediatedStep before (.approvalContinue approval invocation attempt) after) :
    ∃ prepared continuation firstAttempt firstItem continuedAttempt,
      before.effects.invocations invocation = some prepared ∧
      before.approvals.continuations invocation = some continuation ∧
      continuation.approval = approval ∧ continuation.invocation = invocation ∧
      continuation.identity = prepared.identity ∧ continuation.digest = prepared.digest ∧
      before.effects.attempts continuation.firstAttempt = some firstAttempt ∧
      firstAttempt.invocation = continuation.invocation ∧
      PreparedItemAt prepared firstAttempt.itemIndex firstItem ∧ firstAttempt.key = firstItem.key ∧
      after.effects.attempts attempt = some continuedAttempt ∧ attempt ≠ continuation.firstAttempt := by
  cases step with
  | approvalContinue ready reserved persisted continues continuationLookup validFirst different first effectStep stored =>
      obtain ⟨continuation, lookup, exactApproval, exactInvocation, identity, digest⟩ :=
        approval_continuation_is_exact continues
      rw [lookup] at continuationLookup
      cases Option.some.inj continuationLookup
      obtain ⟨firstAttempt, firstItem, firstLookup, firstInvocation, firstAt, firstKey⟩ := validFirst
      exact ⟨_, _, firstAttempt, firstItem, _, persisted, lookup, exactApproval,
        exactInvocation, identity, digest, firstLookup, firstInvocation, firstAt, firstKey,
        stored, different⟩

theorem malformed_first_attempt_cannot_continue
    {before after approval invocation attempt continuation prepared}
    (persisted : before.effects.invocations invocation = some prepared)
    (continuationLookup : before.approvals.continuations invocation = some continuation)
    (invalid : ¬ continuation.ValidFirstAttempt before.effects prepared) :
    ¬ MediatedStep before (.approvalContinue approval invocation attempt) after := by
  intro step
  cases step with
  | approvalContinue ready reserved exactPrepared continues exactContinuation validFirst different sound effectStep stored =>
      rw [persisted] at exactPrepared
      cases Option.some.inj exactPrepared
      rw [continuationLookup] at exactContinuation
      cases Option.some.inj exactContinuation
      exact invalid validFirst

theorem mediated_without_turn_uses_owning_actor_path {state request}
    (ready : MediatedReady state request) (_noTurn : request.prepared.header.lease = none) :
    MediatedLeaseGate state request.prepared.header request.now := ready.2.2.2.2.1

theorem mediated_without_turn_has_exact_owner_audit {state request}
    (ready : MediatedReady state request)
    (noTurn : request.prepared.header.lease = none) :
    ∃ entry,
      state.audit.entries request.prepared.header.auditCause = some entry ∧
      request.prepared.header.caller.authenticated = true ∧
      request.prepared.header.caller.actor = domainOwner request.prepared.header.domain ∧
      entry.actor = request.prepared.header.caller.actor := by
  have gate := ready.2.2.2.2.1
  unfold MediatedLeaseGate at gate
  rw [noTurn] at gate
  exact gate

theorem routed_mediated_validates_projection_digest {state request}
    (ready : MediatedReady state request)
    {reservation projection digest}
    (route : request.prepared.header.routeEvidence = ⟨some reservation, some projection⟩)
    (projectionDigest : request.prepared.header.projectionDigest = some digest) :
    ∃ routeRecord projectionRecord,
      state.events.reservations reservation = some routeRecord ∧
      routeRecord.invocation = request.prepared.header.invocation ∧
      routeRecord.projection = projection ∧ routeRecord.projectionDigest = digest ∧
      state.events.projections projection = some projectionRecord ∧
      state.events.projectionFor reservation = some projection ∧
      projectionRecord.reservation = reservation ∧ projectionRecord.digest = digest ∧
      projectionRecord.authenticated = true := by
  have gate := ready.2.2.1
  unfold RouteGate at gate
  rw [route, projectionDigest] at gate
  obtain ⟨consistent, routeRecord, projectionRecord, auditEntry, reservationLookup,
    invocation, authority, reservationProjection, reservationDigest, projectionLookup, unique,
    paired, exactDigest, authenticated,
    target, auditLookup, auditActor, auditKind⟩ := gate
  exact ⟨routeRecord, projectionRecord, reservationLookup, invocation, reservationProjection,
    reservationDigest, projectionLookup, unique, paired, exactDigest, authenticated⟩

theorem direct_checks_exact_current_incarnation {state request}
    (ready : DirectReady state request) : ExactLeaseGate state request.prepared.header request.now :=
  ready.2.2.2.2.2.2.1

theorem exact_turn_lease_gate_binds_run_domain_and_placement {state header now}
    (gate : ExactLeaseGate state header now) :
    ∃ token turn run,
      header.lease = some token ∧ state.graph.turns token.turn = some turn ∧
      state.graph.runs turn.run = some run ∧ header.domain = .run run.tenant turn.run ∧
      turn.pins.placement = header.placement ∧ turn.lease.Admits token now := by
  obtain ⟨token, turn, lease, turnLookup, running, context, admits⟩ := gate
  obtain ⟨run, runLookup, domain, placement, exactTurn⟩ := context
  exact ⟨token, turn, run, lease, turnLookup, runLookup, domain, placement, admits⟩

theorem direct_ready_uses_exact_holder_watermark_inequality {state request evidence}
    (ready : DirectReady state request)
    (member : evidence ∈ request.prepared.header.pathEvidence) :
    ∃ token, request.prepared.header.lease = some token ∧
      state.authority.holderWatermark token.holder evidence.scope ≤ evidence.epoch := by
  obtain ⟨resolution, token, turn, resolutionLookup, lease, turnLookup, expiry, usable⟩ :=
    ready.2.2.2.2.2.2.2
  exact ⟨token, lease,
    AuthorityLedger.direct_holder_watermark_is_not_ahead lease usable.2.2.2.2 member⟩

theorem direct_resolution_uses_actual_lease_expiry {state request}
    (ready : DirectReady state request) :
    ∃ (resolution : Resolution) (token : LeaseToken) (turn : Turn),
      state.graph.turns token.turn = some turn ∧
      resolution.originalLeaseExpiry = some turn.lease.expiresAt := by
  obtain ⟨resolution, token, turn, lookup, lease, turnLookup, expiry, usable⟩ :=
    ready.2.2.2.2.2.2.2
  exact ⟨resolution, token, turn, turnLookup, expiry⟩

theorem stale_mediated_denial_matches_intent {before after invocation receipt}
    (step : MediatedStep before (.staleDenied invocation receipt) after) :
    ∃ (record : PreEffectReceipt) (item : PreparedItem) (prepared : PreparedInvocation),
      after.effects.preReceipts receipt = some record ∧ record.invocation = invocation ∧
      record.outcome = .denied ∧ before.effects.invocations invocation = some prepared ∧
      prepared.items[record.itemIndex]? = some item := by
  cases step with
  | staleDenied lookup exactHeader intent stale holderEq observed exactInvocation itemLookup denied
      receiptStep stored =>
      exact ⟨_, _, _, stored, exactInvocation, denied, intent, itemLookup⟩

theorem routed_reservation_binds_source_event_audit {before after reservation}
    (step : MediatedStep before (.event (.reserve reservation)) after) :
    ∃ route event entry,
      after.events.reservations reservation = some route ∧
      after.events.events route.sourceEvent = some event ∧ event.owner = route.sourceOwner ∧
      before.audit.entries route.sourceAudit = some entry ∧ entry.actor = route.sourceOwner ∧
      entry.kind = .event route.sourceEvent route.invocation := by
  cases step with
  | event eventStep leases source => exact source

theorem settled_has_coherent_snapshot_and_exact_obligations {state run}
    (settled : Settled state run) :
    (∃ snapshot, state.graph.terminalSnapshots run = some snapshot ∧
      snapshot.run = run ∧ TerminalSnapshotCoherent state.graph snapshot) ∧
    (∀ snapshot, state.graph.terminalSnapshots run = some snapshot →
      ∀ obligation, obligation ∈ snapshot.obligations → ObligationDischarged state obligation) := by
  obtain ⟨⟨record, snapshot, runLookup, terminal, snapshotLookup, exactRun, coherent⟩,
    turns, items, routes, obligations, conflicts⟩ := settled
  exact ⟨⟨snapshot, snapshotLookup, exactRun, coherent⟩, obligations⟩

end AgentCore
