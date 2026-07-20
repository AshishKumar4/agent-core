import AgentCore.Events

/-!
# Actor-local typed causal audit

Each actor owns a unique increasing sequence. Local causes must be same-actor, lower
sequence, and correlation-matched. Cross-actor projection cites the authenticated
RouteReservation; it has no edge to the source AuditId. An optional cause is target-local.
-/

namespace AgentCore

inductive CommitAuditEvidence where
  | receipt (reference : ItemReceiptRef)
  | delivery (reservation : ReservationId)
  | control (receipt : ReceiptId)
  deriving DecidableEq, Repr

inductive AuditKind where
  | invocation (invocation : InvocationId)
  | approval (approval : ApprovalId) (invocation : InvocationId) (phase : ApprovalPhase)
  | attempt (attempt : AttemptId) (invocation : InvocationId)
  | preReceipt (receipt : ReceiptId) (invocation : InvocationId) (itemIndex : Nat)
      (outcome : PreEffectOutcome)
  | attemptReceipt (receipt : ReceiptId) (attempt : AttemptId) (invocation : InvocationId)
      (outcome : AttemptOutcome)
  | receiptSuperseded (previous next : ReceiptId) (attempt : AttemptId)
      (invocation : InvocationId)
  | event (event : EventId) (invocation : InvocationId)
  | routeReserved (reservation : ReservationId) (event : EventId) (invocation : InvocationId)
  | routeProjected (projection : ProjectionId) (reservation : ReservationId)
      (invocation : InvocationId)
  | delivery (reservation : ReservationId) (projection : ProjectionId)
      (invocation : InvocationId) (outcome : RouteDeliveryOutcome)
  | commit (commit : CommitId) (evidence : CommitAuditEvidence)
  deriving DecidableEq, Repr

def MayCause : AuditKind → AuditKind → Prop
  | .invocation invocation, .approval _ same _
  | .invocation invocation, .attempt _ same
  | .invocation invocation, .preReceipt _ same _ _ => invocation = same
  | .approval _ invocation .approved, .attempt _ same => invocation = same
  | .approval _ invocation .denied, .preReceipt _ same _ .denied
  | .approval _ invocation .expired, .preReceipt _ same _ .cancelled => invocation = same
  | .attempt attempt invocation, .attemptReceipt _ sameAttempt sameInvocation _ =>
      attempt = sameAttempt ∧ invocation = sameInvocation
  | .attemptReceipt previous attempt invocation .indeterminate,
      .receiptSuperseded samePrevious _ sameAttempt sameInvocation =>
      previous = samePrevious ∧ attempt = sameAttempt ∧ invocation = sameInvocation
  | .preReceipt _ invocation _ _, .event _ sameInvocation
  | .attemptReceipt _ _ invocation _, .event _ sameInvocation
  | .receiptSuperseded _ _ _ invocation, .event _ sameInvocation => invocation = sameInvocation
  | .event event invocation, .routeReserved _ sameEvent sameInvocation =>
      event = sameEvent ∧ invocation = sameInvocation
  | .routeProjected projection reservation invocation,
      .delivery sameReservation sameProjection sameInvocation _ =>
      reservation = sameReservation ∧ projection = sameProjection ∧ invocation = sameInvocation
  | .preReceipt receipt _ _ _, .commit _ (.receipt (.preEffect sameReceipt)) => receipt = sameReceipt
  | .attemptReceipt receipt _ _ _, .commit _ (.receipt (.attempt sameReceipt)) => receipt = sameReceipt
  | .receiptSuperseded _ receipt _ _, .commit _ (.receipt (.attempt sameReceipt)) =>
      receipt = sameReceipt
  | .delivery reservation _ _ _, .commit _ (.delivery sameReservation) => reservation = sameReservation
  | .attemptReceipt receipt _ _ .succeeded, .commit _ (.control sameReceipt) => receipt = sameReceipt
  | _, _ => False

def RootKindAllowed : AuditKind → Prop
  | .invocation _ => True
  | _ => False

structure AuditEntry where
  actor : ActorRef
  sequence : Nat
  correlation : Nat
  cause : Option AuditId
  kind : AuditKind
  deriving DecidableEq, Repr

structure AuditLog where
  entries : AuditId → Option AuditEntry
  atSequence : ActorRef → Nat → Option AuditId

instance : Inhabited AuditLog where default := ⟨fun _ => none, fun _ _ => none⟩

def AuditLog.append (log : AuditLog) (id : AuditId) (entry : AuditEntry) : AuditLog := {
  entries := tableSet log.entries id entry
  atSequence := fun actor sequence =>
    if actor = entry.actor ∧ sequence = entry.sequence then some id else log.atSequence actor sequence
}

def LocalCauseValid (log : AuditLog) (entry : AuditEntry) : Prop :=
  match entry.cause with
  | none => RootKindAllowed entry.kind
  | some cause => ∃ parent,
      log.entries cause = some parent ∧ parent.actor = entry.actor ∧
      parent.sequence < entry.sequence ∧ parent.correlation = entry.correlation ∧
      MayCause parent.kind entry.kind

inductive CausalChain (events : EventStore) (log : AuditLog) : AuditId → Prop
  | root {id entry} :
      log.entries id = some entry → entry.cause = none → RootKindAllowed entry.kind →
      CausalChain events log id
  | bridge {id entry projectionId reservationId projection reservation} :
      log.entries id = some entry → entry.cause = none →
      events.projections projectionId = some projection → projection.authenticated = true →
      events.reservations reservationId = some reservation →
      projection.reservation = reservationId → projectionId = reservation.projection →
      projection.digest = reservation.projectionDigest →
      events.projectionFor reservationId = some projectionId →
      projection.targetOwner = reservation.targetOwner →
      entry.actor = reservation.targetOwner →
      entry.kind = .routeProjected projectionId reservationId reservation.invocation →
      CausalChain events log id
  | child {id entry parent parentEntry} :
      log.entries id = some entry → entry.cause = some parent →
      log.entries parent = some parentEntry → parentEntry.actor = entry.actor →
      parentEntry.sequence < entry.sequence → parentEntry.correlation = entry.correlation →
      MayCause parentEntry.kind entry.kind →
      CausalChain events log parent → CausalChain events log id

def CauseChainValid (events : EventStore) (log : AuditLog) (entry : AuditEntry) : Prop :=
  match entry.cause with
  | none => True
  | some cause => CausalChain events log cause

def AuditEvidenceMatches (effects : EffectLedger) (entry : AuditEntry) : Prop :=
  match entry.kind with
  | .attempt id invocation => ∃ attempt,
      effects.attempts id = some attempt ∧ attempt.invocation = invocation ∧
      entry.cause = some attempt.auditCause
  | .preReceipt id invocation itemIndex outcome => ∃ receipt,
      effects.preReceipts id = some receipt ∧ receipt.invocation = invocation ∧
      receipt.itemIndex = itemIndex ∧ receipt.outcome = outcome
  | .attemptReceipt id attempt invocation outcome => ∃ receipt record,
      effects.attemptReceipts id = some receipt ∧ receipt.attempt = attempt ∧
      effects.attempts attempt = some record ∧ record.invocation = invocation ∧
      receipt.outcome = outcome
  | _ => True

inductive AuditLabel where
  | append (id : AuditId)
  | projectBridge (id : AuditId) (projection : ProjectionId)
  deriving DecidableEq, Repr

def AuditLabel.auditId : AuditLabel → AuditId
  | .append id | .projectBridge id _ => id

inductive AuditStep (effects : EffectLedger) (events : EventStore) :
    AuditLog → AuditLabel → AuditLog → Prop
  | append {log id entry} :
      log.entries id = none → log.atSequence entry.actor entry.sequence = none →
      LocalCauseValid log entry → CauseChainValid events log entry →
      AuditEvidenceMatches effects entry →
      AuditStep effects events log (.append id) (log.append id entry)
  | projectionBridge {log id entry projectionId projection reservation} :
      log.entries id = none → log.atSequence entry.actor entry.sequence = none →
      events.projections projectionId = some projection → projection.authenticated = true →
      events.reservations projection.reservation = some reservation →
      projectionId = reservation.projection →
      projection.digest = reservation.projectionDigest →
      events.projectionFor projection.reservation = some projectionId →
      projection.targetOwner = reservation.targetOwner →
      entry.actor = reservation.targetOwner →
      entry.kind = .routeProjected projectionId projection.reservation reservation.invocation →
      projection.targetLocalCause = none → entry.cause = none →
      AuditEvidenceMatches effects entry →
      AuditStep effects events log (.projectBridge id projectionId) (log.append id entry)

theorem audit_sequence_is_unique {effects events before label after}
    (step : AuditStep effects events before label after) :
    ∃ id entry, after.entries id = some entry ∧
      after.atSequence entry.actor entry.sequence = some id ∧
      before.atSequence entry.actor entry.sequence = none := by
  cases step with
  | append fresh sequenceFresh localEvidence chain typed =>
      exact ⟨_, _, tableSet_self .., by simp [AuditLog.append], sequenceFresh⟩
  | projectionBridge fresh sequenceFresh projectionLookup authenticated reservationLookup exactProjection
      exactDigest unique projectionTarget target kind projectionNoCause entryNoCause typed =>
      exact ⟨_, _, tableSet_self .., by simp [AuditLog.append], sequenceFresh⟩

theorem local_cause_same_actor_lower_sequence {effects events before label after}
    (step : AuditStep effects events before label after) :
    ∃ id entry, after.entries id = some entry ∧
      ∀ cause, entry.cause = some cause →
      ∃ parent, before.entries cause = some parent ∧ parent.actor = entry.actor ∧
        parent.sequence < entry.sequence ∧ parent.correlation = entry.correlation ∧
        MayCause parent.kind entry.kind := by
  cases step with
  | append fresh sequenceFresh localEvidence chain typed =>
      refine ⟨_, _, tableSet_self .., ?_⟩
      intro cause causeField
      unfold LocalCauseValid at localEvidence
      rw [causeField] at localEvidence
      exact localEvidence
  | projectionBridge fresh sequenceFresh projectionLookup authenticated reservationLookup exactProjection
      exactDigest unique projectionTarget target kind projectionNoCause entryNoCause typed =>
      refine ⟨_, _, tableSet_self .., ?_⟩
      intro cause causeField
      rw [entryNoCause] at causeField
      contradiction

theorem projection_uses_reservation_bridge_not_source_audit {effects events before after id projectionId}
    (step : AuditStep effects events before (.projectBridge id projectionId) after) :
    ∃ entry projection reservation,
      after.entries id = some entry ∧ events.projections projectionId = some projection ∧
      events.reservations projection.reservation = some reservation ∧
      entry.actor = reservation.targetOwner ∧ entry.cause = projection.targetLocalCause := by
  cases step with
  | projectionBridge fresh sequenceFresh projectionLookup authenticated reservationLookup exactProjection
      exactDigest unique projectionTarget target kind projectionNoCause entryNoCause typed =>
      exact ⟨_, _, _, tableSet_self .., projectionLookup, reservationLookup, target,
        entryNoCause.trans projectionNoCause.symm⟩

theorem audit_append_is_locally_acyclic {effects events before label after}
    (step : AuditStep effects events before label after) :
    ∃ id entry, after.entries id = some entry ∧
      ∀ cause parent, entry.cause = some cause → before.entries cause = some parent →
        parent.sequence < entry.sequence := by
  obtain ⟨id, entry, lookup, localEvidence⟩ := local_cause_same_actor_lower_sequence step
  refine ⟨id, entry, lookup, ?_⟩
  intro cause parent causeEq parentLookup
  obtain ⟨actual, lookupBefore, sameActor, lower, correlation, typed⟩ :=
    localEvidence cause causeEq
  rw [parentLookup] at lookupBefore
  cases Option.some.inj lookupBefore
  exact lower

theorem every_audited_effect_evidence_matches {effects events before after id}
    (step : AuditStep effects events before (.append id) after) :
    ∃ entry, after.entries id = some entry ∧ AuditEvidenceMatches effects entry := by
  cases step with
  | append fresh sequenceFresh localEvidence chain typed =>
      exact ⟨_, tableSet_self .., typed⟩

theorem audit_step_preserves_existing_entry {effects events before label after id entry}
    (step : AuditStep effects events before label after)
    (lookup : before.entries id = some entry) : after.entries id = some entry := by
  cases step with
  | append fresh sequenceFresh localEvidence chain typed =>
      change tableSet before.entries _ _ id = some entry
      rw [tableSet_other]
      · exact lookup
      · intro same
        subst id
        rw [lookup] at fresh
        contradiction
  | projectionBridge fresh sequenceFresh projectionLookup authenticated reservationLookup
      exactProjection exactDigest unique projectionTarget target kind projectionNoCause
      entryNoCause typed =>
      change tableSet before.entries _ _ id = some entry
      rw [tableSet_other]
      · exact lookup
      · intro same
        subst id
        rw [lookup] at fresh
        contradiction

theorem delivery_audit_can_cause_commit_locally {log : AuditLog} {deliveryId : AuditId}
    {deliveryEntry commitEntry : AuditEntry} {reservation : ReservationId}
    {projection : ProjectionId} {invocation : InvocationId}
    {outcome : RouteDeliveryOutcome} {commit : CommitId} :
    log.entries deliveryId = some deliveryEntry →
    deliveryEntry.kind = .delivery reservation projection invocation outcome →
    commitEntry.kind = .commit commit (.delivery reservation) → commitEntry.cause = some deliveryId →
    deliveryEntry.actor = commitEntry.actor → deliveryEntry.sequence < commitEntry.sequence →
    commitEntry.correlation = deliveryEntry.correlation →
    LocalCauseValid log commitEntry := by
  intro deliveryLookup deliveryKind commitKind cause actor lower correlation
  unfold LocalCauseValid
  rw [cause]
  refine ⟨deliveryEntry, deliveryLookup, actor, lower, correlation.symm, ?_⟩
  rw [deliveryKind, commitKind]
  trivial

theorem local_cause_edge_is_typed {effects events before label after}
    (step : AuditStep effects events before label after) :
    ∃ id entry, after.entries id = some entry ∧
      ∀ cause, entry.cause = some cause →
      ∃ parent, before.entries cause = some parent ∧
        MayCause parent.kind entry.kind := by
  obtain ⟨id, entry, lookup, localEvidence⟩ := local_cause_same_actor_lower_sequence step
  refine ⟨id, entry, lookup, ?_⟩
  intro cause causeEq
  obtain ⟨parent, parentLookup, actor, lower, correlation, typed⟩ :=
    localEvidence cause causeEq
  exact ⟨parent, parentLookup, typed⟩

private theorem causalChain_append_mono {events : EventStore} {log : AuditLog}
    {newId : AuditId} {newEntry : AuditEntry}
    (fresh : log.entries newId = none) {id} (chain : CausalChain events log id) :
    CausalChain events (log.append newId newEntry) id := by
  induction chain with
  | root lookup cause rootKind =>
      apply CausalChain.root
      · change tableSet log.entries newId newEntry _ = some _
        rw [tableSet_other]
        · exact lookup
        · intro same; rw [same] at lookup; rw [lookup] at fresh; contradiction
      · exact cause
      · exact rootKind
  | bridge lookup cause projectionLookup authenticated reservationLookup paired exactProjection exactDigest unique
      target actor kind =>
      apply CausalChain.bridge
      · change tableSet log.entries newId newEntry _ = some _
        rw [tableSet_other]
        · exact lookup
        · intro same; rw [same] at lookup; rw [lookup] at fresh; contradiction
      · exact cause
      · exact projectionLookup
      · exact authenticated
      · exact reservationLookup
      · exact paired
      · exact exactProjection
      · exact exactDigest
      · exact unique
      · exact target
      · exact actor
      · exact kind
  | child lookup cause parentLookup actor lower correlation typed parentChain ih =>
      apply CausalChain.child
      · change tableSet log.entries newId newEntry _ = some _
        rw [tableSet_other]
        · exact lookup
        · intro same; rw [same] at lookup; rw [lookup] at fresh; contradiction
      · exact cause
      · change tableSet log.entries newId newEntry _ = some _
        rw [tableSet_other]
        · exact parentLookup
        · intro same; rw [same] at parentLookup; rw [parentLookup] at fresh; contradiction
      · exact actor
      · exact lower
      · exact correlation
      · exact typed
      · exact ih

theorem audit_step_establishes_causal_chain {effects events before label after}
    (step : AuditStep effects events before label after) :
    CausalChain events after label.auditId := by
  cases step with
  | append fresh sequenceFresh localEvidence chain typed =>
      cases causeEq : ‹AuditEntry›.cause with
      | none =>
          apply CausalChain.root (events := events) (entry := ‹AuditEntry›)
          · exact tableSet_self ..
          · exact causeEq
          · unfold LocalCauseValid at localEvidence
            rw [causeEq] at localEvidence
            exact localEvidence
      | some parent =>
          unfold LocalCauseValid at localEvidence
          rw [causeEq] at localEvidence
          obtain ⟨parentEntry, parentLookup, actor, lower, correlation, edge⟩ := localEvidence
          unfold CauseChainValid at chain
          rw [causeEq] at chain
          apply CausalChain.child (parentEntry := parentEntry)
          · exact tableSet_self ..
          · exact causeEq
          · change tableSet before.entries _ _ parent = some parentEntry
            rw [tableSet_other]
            · exact parentLookup
            · intro same; subst parent; rw [parentLookup] at fresh; contradiction
          · exact actor
          · exact lower
          · exact correlation
          · exact edge
          · exact causalChain_append_mono fresh chain
  | projectionBridge fresh sequenceFresh projectionLookup authenticated reservationLookup exactProjection
      exactDigest unique projectionTarget target kind projectionNoCause entryNoCause typed =>
      apply CausalChain.bridge (entry := ‹AuditEntry›) (projection := ‹RouteProjection›)
        (reservation := ‹RouteReservation›)
      · exact tableSet_self ..
      · exact entryNoCause
      · exact projectionLookup
      · exact authenticated
      · exact reservationLookup
      · rfl
      · exact exactProjection
      · exact exactDigest
      · exact unique
      · exact projectionTarget
      · exact target
      · exact kind

theorem causal_chain_preserved_by_step {effects events before label after id}
    (step : AuditStep effects events before label after)
    (chain : CausalChain events before id) : CausalChain events after id := by
  cases step with
  | append fresh sequenceFresh localEvidence causeChain typed
  | projectionBridge fresh sequenceFresh projectionLookup authenticated reservationLookup exactProjection
      exactDigest unique projectionTarget target kind projectionNoCause entryNoCause typed =>
      exact causalChain_append_mono fresh chain

theorem nonroot_cannot_append_without_cause {effects : EffectLedger} {events : EventStore}
    {log : AuditLog} {id : AuditId} {entry : AuditEntry} {after : AuditLog}
    (stored : after.entries id = some entry)
    (notRoot : ¬ RootKindAllowed entry.kind) (noCause : entry.cause = none) :
    ¬ AuditStep effects events log (.append id) after := by
  intro step
  cases step with
  | append fresh sequenceFresh localEvidence chain typed =>
      change tableSet log.entries id _ id = some entry at stored
      rw [tableSet_self] at stored
      cases Option.some.inj stored
      unfold LocalCauseValid at localEvidence
      rw [noCause] at localEvidence
      exact notRoot localEvidence

end AgentCore
