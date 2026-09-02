/-
Settlement (SPEC §5.2, §5.6; `packages/agent-core/src/agents/runs/settlement.ts`).

Terminalization closes admission and captures what the Run still owes: the frontier of the
just-closed registry, which is the reserved obligations minus the completed ones. That
capture is a *finite list*, not a query, which is what makes settlement decidable at all —
`isSettled` walks exactly the captured set and the audits derived from it, and nothing else.

Three things are carried in the type rather than re-established by a reader:

* the captured set is in canonical key order. The runtime sorts it in the constructor and
  rejects duplicates separately; here order implies duplicate-freedom
  (`Text.nodup_of_strictlyOrdered`), so one field does both jobs — and, unlike the admission
  registry, the ordering *is* fixed, so this record can carry a codec whose round-trip law
  is provable;
* the required audits are derived, never supplied. An obligation that terminates in a
  Receipt, a route delivery, or a system commit implies exactly one audit, and an incomplete
  audit set is therefore not a value;
* a snapshot naming an exhausted dimension is `cancelled`. Exhaustion is not a fourth
  terminal state — it is a field on the ordinary cancellation, and the pairing is a `Prop`
  field.

The refinement is the one that matters for §5.2: `frontier_refines_outstanding` shows the
kernel's key-based frontier is the model's value-based `RunAdmissionRegistry.outstanding`,
which is what `CompleteAdmittedFrontier` quantifies over. Two divergences from the model are
recorded below rather than papered over: the epoch a TypeScript snapshot carries, and the
width of the terminal-outcome vocabulary.

`SettlementAuditObligation` is a plain mirror of `settlement.ts`, whose commit case now
carries SPEC §5.6's own field name. It is *not* the full shape §5.6 declares, and the SPEC
is what says it cannot be: §5.6 declares `{ audit : AuditRecordId; evidence : … }` with the
receipt case naming a `ReceiptId`, while the same section says the captured set is "admitted
Invocation items *without* a terminal current Receipt" and that "Receipt, delivery,
projection, and Audit ids are never reserved". At capture there is therefore no Receipt to
name and no AuditRecord to point at — the obligation *is* the demand that one come to exist.
Carrying either identity would mean storing an id nobody has, so both the runtime and this
module carry the reserved identity §5.6 does hand a capture ("InvocationId plus item index
and item key") and resolve the audit against evidence when it arrives, which is what
`AgentCore.ObligationDischarged` existentially quantifies over rather than stores. This is a
SPEC defect recorded for the alignment lane, not a TypeScript one; it is also the bound on
C13-RUN-SETTLED-DERIVED.
-/
import AgentCore.RunGraph
import AgentCore.Kernel.Runs.Admission
import AgentCore.Kernel.Runs.Ceiling
import AgentCore.Kernel.Runs.Turn

namespace AgentCore.Kernel

/-- `SettlementAuditObligation`: the audit one captured obligation implies. -/
inductive SettlementAuditObligation where
  | receipt (invocation : TextId .invocation) (itemIndex : Nat) (itemKey : String)
  | delivery (reservation : TextId .routeReservation)
  | commit (id : TextId .runCommit)
  deriving DecidableEq

namespace SettlementAuditObligation

/-- The tag the runtime sorts the derived audits by. -/
def kindWire : SettlementAuditObligation → String
  | .receipt _ _ _ => "receipt"
  | .delivery _ => "delivery"
  | .commit _ => "commit"

end SettlementAuditObligation

/-- `SettlementObligation`: the captured frontier and the registry epoch it was captured at.
-/
structure SettlementObligation where
  registryEpoch : Nat
  obligations : List RunObligation
  /-- The epoch is a non-negative safe integer. -/
  epochValid : registryEpoch ≤ maxSafeInteger
  /-- The captured set is in canonical key order, which is also why it holds no obligation
  twice. -/
  ordered : Text.strictlyOrdered (obligationKeys obligations) = true

namespace SettlementObligation

/-- **A captured set holds no obligation twice.** The runtime checks uniqueness separately
after sorting; here it is a consequence of the order, so the two cannot disagree. -/
theorem obligations_nodup (obligation : SettlementObligation) :
    (obligationKeys obligation.obligations).Nodup :=
  Text.nodup_of_strictlyOrdered _ obligation.ordered

theorem eq_of_fields {left right : SettlementObligation}
    (epoch : left.registryEpoch = right.registryEpoch)
    (obligations : left.obligations = right.obligations) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨epoch, obligations⟩

/-! ### The derived audits

`deriveRequiredAudits` maps each audit-bearing obligation to one audit and then sorts the
result by tag alone with a stable sort. A stable sort by a three-valued key is exactly the
concatenation of the three filtered passes in tag order, so that is how it is written here:
the grouping is visible in the definition instead of resting on the stability of a sort. -/

def commitAudit : RunObligation → Option SettlementAuditObligation
  | .systemCommit commit => some (.commit commit)
  | _ => none

def deliveryAudit : RunObligation → Option SettlementAuditObligation
  | .route reservation => some (.delivery reservation)
  | _ => none

def receiptAudit : RunObligation → Option SettlementAuditObligation
  | .invocationItem invocation index itemKey => some (.receipt invocation index itemKey)
  | _ => none

/-- `requiredAudits`: `commit` audits, then `delivery`, then `receipt`, each group in the
captured order. -/
def requiredAudits (obligation : SettlementObligation) : List SettlementAuditObligation :=
  obligation.obligations.filterMap commitAudit ++
    obligation.obligations.filterMap deliveryAudit ++
      obligation.obligations.filterMap receiptAudit

theorem commitAudit_kind : ∀ (obligation : RunObligation) (audit : SettlementAuditObligation),
    commitAudit obligation = some audit → audit.kindWire = "commit"
  | .systemCommit _, _, mapped => by
      rw [← Option.some.inj mapped]; rfl
  | .approval _, _, mapped => by simp [commitAudit] at mapped
  | .invocationItem _ _ _, _, mapped => by simp [commitAudit] at mapped
  | .route _, _, mapped => by simp [commitAudit] at mapped
  | .reconciliation _, _, mapped => by simp [commitAudit] at mapped
  | .acceptance _, _, mapped => by simp [commitAudit] at mapped

theorem deliveryAudit_kind : ∀ (obligation : RunObligation) (audit : SettlementAuditObligation),
    deliveryAudit obligation = some audit → audit.kindWire = "delivery"
  | .route _, _, mapped => by
      rw [← Option.some.inj mapped]; rfl
  | .approval _, _, mapped => by simp [deliveryAudit] at mapped
  | .invocationItem _ _ _, _, mapped => by simp [deliveryAudit] at mapped
  | .reconciliation _, _, mapped => by simp [deliveryAudit] at mapped
  | .systemCommit _, _, mapped => by simp [deliveryAudit] at mapped
  | .acceptance _, _, mapped => by simp [deliveryAudit] at mapped

theorem receiptAudit_kind : ∀ (obligation : RunObligation) (audit : SettlementAuditObligation),
    receiptAudit obligation = some audit → audit.kindWire = "receipt"
  | .invocationItem _ _ _, _, mapped => by
      rw [← Option.some.inj mapped]; rfl
  | .approval _, _, mapped => by simp [receiptAudit] at mapped
  | .route _, _, mapped => by simp [receiptAudit] at mapped
  | .reconciliation _, _, mapped => by simp [receiptAudit] at mapped
  | .systemCommit _, _, mapped => by simp [receiptAudit] at mapped
  | .acceptance _, _, mapped => by simp [receiptAudit] at mapped

/-- **The derived audits are grouped by tag, in canonical tag order.** The runtime reaches
this grouping through a stable sort keyed on the tag alone; the kernel reaches it by
construction, so no property of the sort is assumed. -/
theorem requiredAudits_grouped (obligation : SettlementObligation) :
    (obligation.obligations.filterMap commitAudit).all
        (fun audit => audit.kindWire == "commit") = true ∧
      (obligation.obligations.filterMap deliveryAudit).all
        (fun audit => audit.kindWire == "delivery") = true ∧
      (obligation.obligations.filterMap receiptAudit).all
        (fun audit => audit.kindWire == "receipt") = true := by
  refine ⟨?_, ?_, ?_⟩ <;> refine List.all_eq_true.mpr ?_ <;> intro audit member <;>
    obtain ⟨candidate, _, mapped⟩ := List.mem_filterMap.mp member
  · simp [commitAudit_kind candidate audit mapped]
  · simp [deliveryAudit_kind candidate audit mapped]
  · simp [receiptAudit_kind candidate audit mapped]

/-- **Every system-commit obligation is audited.** The audit set is derived, so a Run cannot
settle with an audit-bearing obligation left unaudited. -/
theorem systemCommit_is_audited {obligation : SettlementObligation}
    {commit : TextId .runCommit}
    (captured : RunObligation.systemCommit commit ∈ obligation.obligations) :
    SettlementAuditObligation.commit commit ∈ obligation.requiredAudits := by
  unfold requiredAudits
  refine List.mem_append.mpr (.inl (List.mem_append.mpr (.inl ?_)))
  exact List.mem_filterMap.mpr ⟨RunObligation.systemCommit commit, captured, rfl⟩

/-- **Every route obligation is audited.** -/
theorem route_is_audited {obligation : SettlementObligation}
    {reservation : TextId .routeReservation}
    (captured : RunObligation.route reservation ∈ obligation.obligations) :
    SettlementAuditObligation.delivery reservation ∈ obligation.requiredAudits := by
  unfold requiredAudits
  refine List.mem_append.mpr (.inl (List.mem_append.mpr (.inr ?_)))
  exact List.mem_filterMap.mpr ⟨RunObligation.route reservation, captured, rfl⟩

/-- **Every published invocation item is audited.** -/
theorem invocationItem_is_audited {obligation : SettlementObligation}
    {invocation : TextId .invocation} {index : Nat} {itemKey : String}
    (captured : RunObligation.invocationItem invocation index itemKey ∈ obligation.obligations) :
    SettlementAuditObligation.receipt invocation index itemKey ∈ obligation.requiredAudits := by
  unfold requiredAudits
  refine List.mem_append.mpr (.inr ?_)
  exact List.mem_filterMap.mpr
    ⟨RunObligation.invocationItem invocation index itemKey, captured, rfl⟩

/-! ### Encoding -/

def toJson (obligation : SettlementObligation) : Json.JsonValue :=
  .obj [("obligations", .arr (obligation.obligations.map RunObligation.toJson)),
        ("registryEpoch", .int obligation.registryEpoch)]

/-- Read a captured list back, one obligation at a time. -/
def readObligations : List Json.JsonValue → Outcome (List RunObligation)
  | [] => .ok []
  | item :: rest =>
      match RunObligation.ofJson item, readObligations rest with
      | .ok obligation, .ok obligations => .ok (obligation :: obligations)
      | .error fault, _ => .error fault
      | _, .error fault => .error fault

theorem readObligations_roundTrip : ∀ obligations : List RunObligation,
    readObligations (obligations.map RunObligation.toJson) = .ok obligations
  | [] => rfl
  | obligation :: rest => by
      simp [readObligations, RunObligation.ofJson_toJson obligation,
        readObligations_roundTrip rest]

def ofJson (value : Json.JsonValue) : Outcome SettlementObligation :=
  match Json.asObject value "Settlement obligation" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries ["obligations", "registryEpoch"] then
        match Json.field entries "obligations", Json.field entries "registryEpoch" with
        | some (.arr items), some (.int epochValue) =>
            match readObligations items with
            | .error fault => .error fault
            | .ok obligations =>
                if epochBound : 0 ≤ epochValue ∧ epochValue.natAbs ≤ maxSafeInteger then
                  if ordered : Text.strictlyOrdered (obligationKeys obligations) = true then
                    .ok ⟨epochValue.natAbs, obligations, epochBound.2, ordered⟩
                  else unshaped "Settlement obligations"
                else unshaped "Settlement registry epoch"
        | _, _ => unshaped "Settlement obligation"
      else unshaped "Settlement obligation"

theorem ofJson_toJson (obligation : SettlementObligation) :
    ofJson obligation.toJson = .ok obligation := by
  obtain ⟨registryEpoch, obligations, epochValid, ordered⟩ := obligation
  have decoded := readObligations_roundTrip obligations
  have bound : 0 ≤ (registryEpoch : Int) ∧ ((registryEpoch : Int)).natAbs ≤ maxSafeInteger := by
    refine ⟨by omega, ?_⟩
    simpa using epochValid
  have magnitude : ((registryEpoch : Int)).natAbs = registryEpoch := by omega
  simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
    decoded, bound, magnitude, ordered, epochValid]

theorem canonicalItems_map : ∀ values : List RunObligation,
    Json.canonicalItems (values.map RunObligation.toJson) = true
  | [] => rfl
  | value :: rest => by
      simp [Json.canonicalItems, RunObligation.canonical_toJson value, canonicalItems_map rest]

theorem canonical_toJson (obligation : SettlementObligation) :
    Json.canonical obligation.toJson = true := by
  have ordered : Text.strictlyOrdered ["obligations", "registryEpoch"] = true := by decide
  simp [toJson, Json.canonical, Json.canonicalEntries, ordered, canonicalItems_map]

end SettlementObligation

/-- `SettlementObligationCodec`. -/
def settlementObligationCodec : RecordCodec SettlementObligation where
  kind := "run.settlement-obligation"
  version := ⟨2, 0⟩
  encodePayload := SettlementObligation.toJson
  decodePayload := SettlementObligation.ofJson
  roundTrip := SettlementObligation.ofJson_toJson
  canonicalPayload := SettlementObligation.canonical_toJson

/-- `TerminalSnapshot`: what a Run ended as, what it still owed when it ended, and — for a
cancellation caused by exhaustion — which dimension ran out. -/
structure TerminalSnapshot where
  run : TextId .run
  turn : TextId .turn
  preterminal : TextId .runCommit
  terminalCommit : TextId .runCommit
  outcome : TerminalOutcome
  obligation : SettlementObligation
  recordedAt : Millis
  exhausted : Option ResourceDimension
  /-- Resource exhaustion terminalizes a Run as cancelled; nothing else names a dimension. -/
  exhaustionCancels : exhausted.isSome = true → outcome = .cancelled

namespace TerminalSnapshot

/-- **A snapshot that names a dimension is a cancellation.** -/
theorem exhausted_is_cancelled {snapshot : TerminalSnapshot} {dimension : ResourceDimension}
    (named : snapshot.exhausted = some dimension) : snapshot.outcome = .cancelled :=
  snapshot.exhaustionCancels (by rw [named]; rfl)

/-- **A succeeded or failed Run names no exhausted dimension.** The contrapositive, stated
because it is the direction a reader uses: the exhaustion field is meaningless outside a
cancellation and cannot be set there. -/
theorem non_cancelled_not_exhausted {snapshot : TerminalSnapshot}
    (live : snapshot.outcome ≠ .cancelled) : snapshot.exhausted = none := by
  cases shape : snapshot.exhausted with
  | none => rfl
  | some dimension => exact absurd (exhausted_is_cancelled shape) live

def toJson (snapshot : TerminalSnapshot) : Json.JsonValue :=
  .obj [("exhausted",
          match snapshot.exhausted with
          | none => .null
          | some dimension => .str dimension.wire),
        ("obligation", snapshot.obligation.toJson),
        ("outcome", .str snapshot.outcome.wire),
        ("preterminal", .str snapshot.preterminal.value),
        ("recordedAt", .int snapshot.recordedAt),
        ("run", .str snapshot.run.value),
        ("terminalCommit", .str snapshot.terminalCommit.value),
        ("turn", .str snapshot.turn.value)]

/-- `requireTerminalOutcome`: only the three words, and nothing else. -/
def outcomeOfWire (value : String) : Option TerminalOutcome :=
  if value = "succeeded" then some .succeeded
  else if value = "failed" then some .failed
  else if value = "cancelled" then some .cancelled
  else none

theorem outcomeOfWire_wire (outcome : TerminalOutcome) :
    outcomeOfWire outcome.wire = some outcome := by
  cases outcome <;> rfl

def ofJson (value : Json.JsonValue) : Outcome TerminalSnapshot :=
  match Json.asObject value "Terminal snapshot" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries
          ["exhausted", "obligation", "outcome", "preterminal", "recordedAt", "run",
           "terminalCommit", "turn"] then
        match Json.field entries "exhausted", Json.field entries "obligation",
            Json.field entries "outcome", Json.field entries "preterminal",
            Json.field entries "recordedAt", Json.field entries "run",
            Json.field entries "terminalCommit", Json.field entries "turn" with
        | some exhaustedValue, some obligationValue, some (.str outcomeText),
            some (.str preterminalText), some (.int recordedValue), some (.str runText),
            some (.str terminalText), some (.str turnText) =>
            match SettlementObligation.ofJson obligationValue with
            | .error fault => .error fault
            | .ok obligation =>
                match outcomeOfWire outcomeText, TextId.parse .run runText,
                    TextId.parse .turn turnText, TextId.parse .runCommit preterminalText,
                    TextId.parse .runCommit terminalText with
                | some outcome, .ok run, .ok turn, .ok preterminal, .ok terminalCommit =>
                    if recordedValue < 0 then unshaped "Terminal timestamp"
                    else
                      match exhaustedValue with
                      | .null =>
                          .ok ⟨run, turn, preterminal, terminalCommit, outcome, obligation,
                                recordedValue.natAbs, none, by intro named; simp at named⟩
                      | .str dimensionText =>
                          match ResourceDimension.ofWire dimensionText with
                          | none => unshaped "Terminal exhausted dimension"
                          | some dimension =>
                              if cancelled : outcome = .cancelled then
                                .ok ⟨run, turn, preterminal, terminalCommit, outcome,
                                      obligation, recordedValue.natAbs, some dimension,
                                      fun _ => cancelled⟩
                              else unshaped "Terminal snapshot"
                      | _ => unshaped "Terminal exhausted dimension"
                | _, _, _, _, _ => unshaped "Terminal snapshot"
        | _, _, _, _, _, _, _, _ => unshaped "Terminal snapshot"
      else unshaped "Terminal snapshot"

theorem ofJson_toJson (snapshot : TerminalSnapshot) : ofJson snapshot.toJson = .ok snapshot := by
  obtain ⟨run, turn, preterminal, terminalCommit, outcome, obligation, recordedAt, exhausted,
    exhaustionCancels⟩ := snapshot
  have runParse : TextId.parse .run run.value = .ok run := by
    unfold TextId.parse
    simp [run.valid]
  have turnParse : TextId.parse .turn turn.value = .ok turn := by
    unfold TextId.parse
    simp [turn.valid]
  have preterminalParse : TextId.parse .runCommit preterminal.value = .ok preterminal := by
    unfold TextId.parse
    simp [preterminal.valid]
  have terminalParse : TextId.parse .runCommit terminalCommit.value = .ok terminalCommit := by
    unfold TextId.parse
    simp [terminalCommit.valid]
  have obligationParse := SettlementObligation.ofJson_toJson obligation
  obtain ⟨payload, encoded⟩ : ∃ payload, obligation.toJson = .obj payload := ⟨_, rfl⟩
  rw [encoded] at obligationParse
  have outcomeParse := outcomeOfWire_wire outcome
  have nonneg : ¬ ((recordedAt : Int) < 0) := by omega
  have magnitude : ((recordedAt : Int)).natAbs = recordedAt := by omega
  cases exhausted with
  | none =>
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        encoded, obligationParse, outcomeParse, runParse, turnParse, preterminalParse,
        terminalParse, nonneg, magnitude]
  | some dimension =>
      have cancelled : outcome = .cancelled := exhaustionCancels rfl
      subst cancelled
      have dimensionParse := ResourceDimension.ofWire_wire dimension
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        encoded, obligationParse, outcomeParse, runParse, turnParse, preterminalParse,
        terminalParse, nonneg, magnitude, dimensionParse]

theorem canonical_toJson (snapshot : TerminalSnapshot) :
    Json.canonical snapshot.toJson = true := by
  have ordered : Text.strictlyOrdered
      ["exhausted", "obligation", "outcome", "preterminal", "recordedAt", "run",
       "terminalCommit", "turn"] = true := by decide
  have inner := SettlementObligation.canonical_toJson snapshot.obligation
  cases shape : snapshot.exhausted <;>
    simp [toJson, Json.canonical, Json.canonicalEntries, ordered, inner, shape]

end TerminalSnapshot

/-- `TerminalSnapshotCodec`. -/
def terminalSnapshotCodec : RecordCodec TerminalSnapshot where
  kind := "run.terminal-snapshot"
  version := ⟨3, 0⟩
  encodePayload := TerminalSnapshot.toJson
  decodePayload := TerminalSnapshot.ofJson
  roundTrip := TerminalSnapshot.ofJson_toJson
  canonicalPayload := TerminalSnapshot.canonical_toJson

/-- Terminalization's exhaustion check: a snapshot may name a dimension only where that
dimension really has nothing left. Naming one with allowance left is `run.invalid-state`. -/
def admitTerminalExhaustion (remainder : Option ResourceCeiling)
    (exhausted : Option ResourceDimension) : Outcome Unit :=
  match exhausted with
  | none => .ok ()
  | some dimension =>
      if ceilingAllowance remainder dimension == some 0 then .ok () else refuse .runInvalidState

/-- **A Run with allowance left cannot be terminalized as exhausted.** -/
theorem admitTerminalExhaustion_refuses {remainder : Option ResourceCeiling}
    {dimension : ResourceDimension} {allowance : Nat}
    (left : ceilingAllowance remainder dimension = some allowance) (positive : allowance ≠ 0) :
    (admitTerminalExhaustion remainder (some dimension)).RefusedWith .runInvalidState := by
  unfold admitTerminalExhaustion
  simp [left, positive, refuse, Outcome.RefusedWith]

/-- **An unbounded Run cannot be terminalized as exhausted at all.** -/
theorem admitTerminalExhaustion_unbounded (dimension : ResourceDimension) :
    (admitTerminalExhaustion none (some dimension)).RefusedWith .runInvalidState := by
  unfold admitTerminalExhaustion ceilingAllowance
  simp [refuse, Outcome.RefusedWith]

/-! ## Deciding settlement

`isSettled` is a pure predicate over the captured set and the derived audits. It carries no
registry, no outcome, and no epoch: whether a Run has settled is a question about what it
owed, answered by evidence, and the runtime's port is the evidence. -/

/-- The evidence a settlement decision consults, one answer per obligation kind plus the
audits. The runtime's `SettlementEvidencePort` is this record of decisions; its
"synchronous result" requirement is discharged by the type, because a `Bool` is not a
promise. -/
structure SettlementEvidence where
  approvalResolved : TextId .approval → Bool
  invocationItemTerminal : TextId .invocation → Nat → String → Bool
  routeTerminal : TextId .routeReservation → Bool
  reconciliationSuperseded : TextId .effectAttempt → Bool
  commitExists : TextId .runCommit → Bool
  acceptanceSatisfied : TextId .acceptance → Bool
  auditSatisfied : SettlementAuditObligation → Bool

/-- Whether one captured obligation is discharged by the evidence. -/
def obligationSettled (evidence : SettlementEvidence) : RunObligation → Bool
  | .approval approval => evidence.approvalResolved approval
  | .invocationItem invocation index itemKey =>
      evidence.invocationItemTerminal invocation index itemKey
  | .route reservation => evidence.routeTerminal reservation
  | .reconciliation attempt => evidence.reconciliationSuperseded attempt
  | .systemCommit commit => evidence.commitExists commit
  | .acceptance acceptance => evidence.acceptanceSatisfied acceptance

/-- `isSettled`: every captured obligation, then every derived audit. -/
def isSettled (obligation : SettlementObligation) (evidence : SettlementEvidence) : Bool :=
  obligation.obligations.all (obligationSettled evidence) &&
    obligation.requiredAudits.all evidence.auditSatisfied

/-- **A settled Run has discharged every obligation it captured.** -/
theorem isSettled_obligation {obligation : SettlementObligation}
    {evidence : SettlementEvidence} {captured : RunObligation}
    (settled : isSettled obligation evidence = true)
    (member : captured ∈ obligation.obligations) :
    obligationSettled evidence captured = true := by
  unfold isSettled at settled
  exact List.all_eq_true.mp ((Bool.and_eq_true _ _).mp settled).1 captured member

/-- **A settled Run has satisfied every audit its capture implied.** -/
theorem isSettled_audit {obligation : SettlementObligation} {evidence : SettlementEvidence}
    {audit : SettlementAuditObligation} (settled : isSettled obligation evidence = true)
    (member : audit ∈ obligation.requiredAudits) : evidence.auditSatisfied audit = true := by
  unfold isSettled at settled
  exact List.all_eq_true.mp ((Bool.and_eq_true _ _).mp settled).2 audit member

/-- **One outstanding obligation is enough to keep a Run unsettled.** -/
theorem not_settled_of_open {obligation : SettlementObligation}
    {evidence : SettlementEvidence} {captured : RunObligation}
    (member : captured ∈ obligation.obligations)
    (open' : obligationSettled evidence captured = false) :
    isSettled obligation evidence = false := by
  by_cases settled : isSettled obligation evidence = true
  · rw [isSettled_obligation settled member] at open'
    simp at open'
  · simpa using settled

/-- **One unsatisfied audit is enough.** A Run cannot settle on evidence it captured but
never audited, which is the property the derived audit set exists to guarantee. -/
theorem not_settled_of_unaudited {obligation : SettlementObligation}
    {evidence : SettlementEvidence} {audit : SettlementAuditObligation}
    (member : audit ∈ obligation.requiredAudits)
    (unsatisfied : evidence.auditSatisfied audit = false) :
    isSettled obligation evidence = false := by
  by_cases settled : isSettled obligation evidence = true
  · rw [isSettled_audit settled member] at unsatisfied
    simp at unsatisfied
  · simpa using settled

/-- **An empty capture settles.** A Run that owed nothing when it ended is settled the
moment it ends, which is what makes settlement reachable at all. -/
theorem isSettled_of_empty {obligation : SettlementObligation}
    {evidence : SettlementEvidence} (empty : obligation.obligations = []) :
    isSettled obligation evidence = true := by
  unfold isSettled SettlementObligation.requiredAudits
  simp [empty]

/-! ## Refinement against the model's settlement

The bridge takes the same explicit identifier abstraction the other kernel modules take.
Two divergences are recorded rather than hidden:

* **The captured epoch.** The runtime builds the snapshot from the *closed* registry, so
  `registryEpoch` is the post-close epoch; `AgentCore.CompleteAdmittedFrontier` reads the
  pre-close registry and so quantifies over the pre-close epoch. The two differ by exactly
  the increment `close` performs. `toModel` therefore takes the epoch it should report as a
  parameter rather than silently choosing one.
* **The outcome vocabulary.** The model's `ReceiptOutcome` has five members; a Turn and a
  Run have three. `denied` and `indeterminate` are Receipt outcomes with no terminal-Run
  counterpart, so `toReceiptOutcome` is injective but not surjective, and nothing here
  claims otherwise. -/

/-- The model's Receipt outcome for a terminal one. -/
def TerminalOutcome.toReceiptOutcome : TerminalOutcome → AgentCore.ReceiptOutcome
  | .succeeded => .succeeded
  | .failed => .failed
  | .cancelled => .cancelled

theorem TerminalOutcome.toReceiptOutcome_injective {left right : TerminalOutcome}
    (same : left.toReceiptOutcome = right.toReceiptOutcome) : left = right := by
  cases left <;> cases right <;> simp_all [TerminalOutcome.toReceiptOutcome]

namespace TerminalSnapshot

/-- The model's snapshot for this one, reporting the registry epoch the caller names. -/
def toModel (snapshot : TerminalSnapshot) (idOf : String → Nat)
    (itemKeyOf : String → AgentCore.ItemKey) (registryEpoch : Nat) :
    AgentCore.TerminalSnapshot where
  run := ⟨idOf snapshot.run.value⟩
  turn := ⟨idOf snapshot.turn.value⟩
  preterminal := ⟨idOf snapshot.preterminal.value⟩
  terminalCommit := ⟨idOf snapshot.terminalCommit.value⟩
  outcome := snapshot.outcome.toReceiptOutcome
  registryEpoch := registryEpoch
  obligations := snapshot.obligation.obligations.map fun obligation =>
    RunAdmissionRegistry.obligationToModel obligation idOf itemKeyOf

end TerminalSnapshot

/-- **The kernel's obligation bridge is injective**, given injective identifier and item-key
abstractions. This is what lets a key-based frontier and the model's value-based
`outstanding` be the same list rather than merely the same size. -/
theorem obligationToModel_injective {left right : RunObligation} {idOf : String → Nat}
    {itemKeyOf : String → AgentCore.ItemKey}
    (idInjective : ∀ first second, idOf first = idOf second → first = second)
    (keyInjective : ∀ first second, itemKeyOf first = itemKeyOf second → first = second)
    (same : RunAdmissionRegistry.obligationToModel left idOf itemKeyOf =
      RunAdmissionRegistry.obligationToModel right idOf itemKeyOf) : left = right := by
  cases left <;> cases right <;>
    simp_all [RunAdmissionRegistry.obligationToModel]
  · exact TextId.eq_of_value (idInjective _ _ same)
  · exact ⟨TextId.eq_of_value (idInjective _ _ same.1), keyInjective _ _ same.2.2⟩
  · exact TextId.eq_of_value (idInjective _ _ same)
  · exact TextId.eq_of_value (idInjective _ _ same)
  · exact TextId.eq_of_value (idInjective _ _ same)
  · exact TextId.eq_of_value (idInjective _ _ same)

namespace RunAdmissionRegistry

/-- **A registry's key-based `discharged` is membership in `completed`.** The runtime
compares canonical keys and the model compares obligations; `RunObligation.key_injective`
is what makes those the same question. -/
theorem discharged_iff_mem {registry : RunAdmissionRegistry} {obligation : RunObligation} :
    registry.discharged obligation = true ↔ obligation ∈ registry.completed := by
  constructor
  · intro held
    obtain ⟨existing, member, same⟩ := List.any_eq_true.mp held
    have keys : existing.key = obligation.key := by simpa using same
    rw [← RunObligation.key_injective keys]
    exact member
  · intro member
    exact List.any_eq_true.mpr ⟨obligation, member, by simp⟩

/-- Filtering a mapped list is mapping the filtered one, for an injectively mapped
predicate. Proved here because the toolchain's `List` API carries no such lemma without
Mathlib and the frontier refinement is exactly this shape. -/
theorem filter_map_comm {α β : Type} (f : α → β) (p : α → Bool) (q : β → Bool)
    (agree : ∀ value, q (f value) = p value) : ∀ values : List α,
    (values.map f).filter q = (values.filter p).map f
  | [] => rfl
  | value :: rest => by
      by_cases hit : p value = true
      · simp [agree value, hit, filter_map_comm f p q agree rest]
      · simp only [Bool.not_eq_true] at hit
        simp [agree value, hit, filter_map_comm f p q agree rest]

/-- **The kernel's frontier is the model's `outstanding`.** The runtime filters the reserved
list by canonical key and the model filters it by value; under the identifier abstraction
these produce the same list, so `CompleteAdmittedFrontier` — which the model's
terminalization step establishes — is a statement about exactly what the kernel captures. -/
theorem frontier_refines_outstanding (registry : RunAdmissionRegistry) (idOf : String → Nat)
    (itemKeyOf : String → AgentCore.ItemKey)
    (idInjective : ∀ first second, idOf first = idOf second → first = second)
    (keyInjective : ∀ first second, itemKeyOf first = itemKeyOf second → first = second) :
    registry.frontier.map (fun obligation =>
        RunAdmissionRegistry.obligationToModel obligation idOf itemKeyOf) =
      (registry.toModel idOf itemKeyOf).outstanding := by
  have agree : ∀ obligation : RunObligation,
      (decide (RunAdmissionRegistry.obligationToModel obligation idOf itemKeyOf ∉
          (registry.toModel idOf itemKeyOf).completed)) =
        !registry.discharged obligation := by
    intro obligation
    have mapped : RunAdmissionRegistry.obligationToModel obligation idOf itemKeyOf ∈
        (registry.toModel idOf itemKeyOf).completed ↔ obligation ∈ registry.completed := by
      unfold RunAdmissionRegistry.toModel
      simp only [List.mem_map]
      constructor
      · intro ⟨candidate, member, same⟩
        rw [← obligationToModel_injective idInjective keyInjective same]
        exact member
      · intro member
        exact ⟨obligation, member, rfl⟩
    cases held : registry.discharged obligation with
    | true => simp [mapped.mpr (discharged_iff_mem.mp held)]
    | false =>
        have absent : obligation ∉ registry.completed := by
          intro member
          rw [discharged_iff_mem.mpr member] at held
          simp at held
        simp [mapped, absent]
  unfold frontier AgentCore.RunAdmissionRegistry.outstanding RunAdmissionRegistry.toModel
  exact (filter_map_comm _ _ _ agree registry.reserved).symm

end RunAdmissionRegistry

end AgentCore.Kernel
