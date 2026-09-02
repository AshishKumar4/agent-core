/-
The Run record and its lifecycle (SPEC §5.2, §5.6; `packages/agent-core/src/agents/runs/run.ts`,
`invocation-delivery.ts`).

`RunLifecycle` is the codebase's abstract-base-with-singletons idiom again, and it carries
exactly one fact beyond the tag: which ceiling dimension's exhaustion cancelled the Run. The
runtime does not store the tag — it derives it, because "a Run is terminal exactly when it
holds its terminal snapshot" is one question and storing a state beside the evidence would
create two ways to answer it. The kernel does the same: `lifecycle` is a function of
`terminal`, and `lifecycle_is_terminal_iff_snapshot` is that identity as a theorem.

Five constructor rules become `Prop` fields, so none of them is a check a later reader
repeats:

* the configuration history begins with the genesis snapshot and names each configuration
  once;
* the token total is a non-negative safe integer;
* every pending delivery belongs to this Run, and the outbox is in canonical id order — so
  it holds one message per identity, replayed deterministically;
* a terminal snapshot belongs to this Run.

Every transition refuses with `run.invalid-state`, which is the whole of this record's
refusal vocabulary for state: a terminal Run transitions no further, a delivery of another
Run is not this Run's to publish or acknowledge, and a currency disagreement is not a
comparison. A revision at the top of the safe range is the one refusal that is not about
state: `run.ts`'s `nextRunRevision` and `Revision.next` now report that ceiling with the same
`protocol.revision-conflict`, because SPEC §8.5 gives a revision its own rejection outcome
beside the lifecycle one. `nextRevision` below mirrors that agreement rather than recording a
divergence between two adjacent runtime paths.

Digests are not derived. `RunInvocationDelivery.id` is a SHA-256 over the record's own
preimage, and hashing is a host primitive; the kernel carries the id as data and states what
depends on it, exactly as `RunPins.digest` does. The consequence is named:
`RunInvocationDelivery.fromData` in the runtime recomputes the id and refuses a mismatch,
which no kernel decoder can do, so that check stays a host obligation.
-/
import AgentCore.RunGraph
import AgentCore.Kernel.Runs.Settlement

namespace AgentCore.Kernel

/-- Why a Run owes an Invocation owner a message: the item was admitted, or the Run ended
and the item was cancelled by the terminal commit that ended it. -/
inductive RunInvocationDeliveryCause where
  | admission
  | cancellation (terminalCommit : TextId .runCommit)
  deriving DecidableEq

namespace RunInvocationDeliveryCause

def wire : RunInvocationDeliveryCause → String
  | .admission => "admission"
  | .cancellation _ => "cancellation"

/-- The terminal commit a cancellation names, and nothing for an admission. -/
def terminalCommit : RunInvocationDeliveryCause → Option (TextId .runCommit)
  | .admission => none
  | .cancellation commit => some commit

def toJson : RunInvocationDeliveryCause → Json.JsonValue
  | .admission => .obj [("kind", .str "admission")]
  | .cancellation commit =>
      .obj [("kind", .str "cancellation"), ("terminalCommit", .str commit.value)]

def ofJson (value : Json.JsonValue) : Outcome RunInvocationDeliveryCause :=
  match Json.asObject value "Run invocation delivery cause" with
  | .error fault => .error fault
  | .ok entries =>
      match Json.field entries "kind" with
      | some (.str tag) =>
          if tag = "admission" then
            if Json.exactFields entries ["kind"] then .ok .admission
            else unshaped "Run invocation delivery cause"
          else if tag = "cancellation" then
            if Json.exactFields entries ["kind", "terminalCommit"] then
              match Json.field entries "terminalCommit" with
              | some (.str commitText) =>
                  (TextId.parse .runCommit commitText).map RunInvocationDeliveryCause.cancellation
              | _ => unshaped "Run invocation cancellation commit"
            else unshaped "Run invocation delivery cause"
          else unshaped "Run invocation delivery cause"
      | _ => unshaped "Run invocation delivery cause"

theorem ofJson_toJson (cause : RunInvocationDeliveryCause) : ofJson cause.toJson = .ok cause := by
  cases cause with
  | admission =>
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?]
  | cancellation commit =>
      have parsed : TextId.parse .runCommit commit.value = .ok commit := by
        unfold TextId.parse
        simp [commit.valid]
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        parsed, Except.map]

theorem canonical_toJson (cause : RunInvocationDeliveryCause) :
    Json.canonical cause.toJson = true := by
  cases cause <;> simp [toJson, Json.canonical, Json.canonicalEntries] <;> decide

end RunInvocationDeliveryCause

/-- `itemKey === itemKey.trim()` on a non-empty string: neither end is whitespace. Internal
whitespace is admitted, which is what the runtime's check does and does not do. -/
def canonicalItemKey (value : String) : Bool :=
  match value.toList with
  | [] => false
  | first :: rest =>
      !isTrimmedWhitespace first && !isTrimmedWhitespace (rest.reverse.headD first)

/-- One durable message a Run owes an Invocation owner (SPEC §5.6). -/
structure RunInvocationDelivery where
  id : Digest
  run : TextId .run
  invocation : TextId .invocation
  itemIndex : Nat
  itemKey : String
  attempt : TextId .effectAttempt
  cause : RunInvocationDeliveryCause
  /-- The item index is a non-negative safe integer. -/
  itemIndexValid : itemIndex ≤ maxSafeInteger
  /-- The item key is non-empty and canonical. -/
  itemKeyCanonical : canonicalItemKey itemKey = true

namespace RunInvocationDelivery

theorem eq_of_fields {left right : RunInvocationDelivery} (id : left.id = right.id)
    (run : left.run = right.run) (invocation : left.invocation = right.invocation)
    (itemIndex : left.itemIndex = right.itemIndex) (itemKey : left.itemKey = right.itemKey)
    (attempt : left.attempt = right.attempt) (cause : left.cause = right.cause) :
    left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨id, run, invocation, itemIndex, itemKey, attempt, cause⟩

instance : DecidableEq RunInvocationDelivery := fun left right =>
  if fields : left.id = right.id ∧ left.run = right.run ∧
      left.invocation = right.invocation ∧ left.itemIndex = right.itemIndex ∧
      left.itemKey = right.itemKey ∧ left.attempt = right.attempt ∧
      left.cause = right.cause then
    .isTrue (eq_of_fields fields.1 fields.2.1 fields.2.2.1 fields.2.2.2.1 fields.2.2.2.2.1
      fields.2.2.2.2.2.1 fields.2.2.2.2.2.2)
  else
    .isFalse fun equal =>
      fields ⟨by rw [equal], by rw [equal], by rw [equal], by rw [equal], by rw [equal],
        by rw [equal], by rw [equal]⟩

def toJson (delivery : RunInvocationDelivery) : Json.JsonValue :=
  .obj [("attempt", .str delivery.attempt.value),
        ("cause", delivery.cause.toJson),
        ("id", .str delivery.id.value),
        ("invocation", .str delivery.invocation.value),
        ("itemIndex", .int delivery.itemIndex),
        ("itemKey", .str delivery.itemKey),
        ("run", .str delivery.run.value)]

def ofJson (value : Json.JsonValue) : Outcome RunInvocationDelivery :=
  match Json.asObject value "Run invocation delivery" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries
          ["attempt", "cause", "id", "invocation", "itemIndex", "itemKey", "run"] then
        match Json.field entries "attempt", Json.field entries "cause",
            Json.field entries "id", Json.field entries "invocation",
            Json.field entries "itemIndex", Json.field entries "itemKey",
            Json.field entries "run" with
        | some (.str attemptText), some causeValue, some (.str idText),
            some (.str invocationText), some (.int indexValue), some (.str itemKey),
            some (.str runText) =>
            match TextId.parse .effectAttempt attemptText,
                RunInvocationDeliveryCause.ofJson causeValue, Digest.parse idText,
                TextId.parse .invocation invocationText, TextId.parse .run runText with
            | .ok attempt, .ok cause, .ok id, .ok invocation, .ok run =>
                if bound : 0 ≤ indexValue ∧ indexValue.natAbs ≤ maxSafeInteger then
                  if canonical : canonicalItemKey itemKey = true then
                    .ok ⟨id, run, invocation, indexValue.natAbs, itemKey, attempt, cause,
                          bound.2, canonical⟩
                  else unshaped "Run invocation delivery item key"
                else unshaped "Run invocation delivery item index"
            | _, _, _, _, _ => unshaped "Run invocation delivery"
        | _, _, _, _, _, _, _ => unshaped "Run invocation delivery"
      else unshaped "Run invocation delivery"

theorem ofJson_toJson (delivery : RunInvocationDelivery) : ofJson delivery.toJson = .ok delivery := by
  obtain ⟨id, run, invocation, itemIndex, itemKey, attempt, cause, itemIndexValid,
    itemKeyCanonical⟩ := delivery
  have attemptParse : TextId.parse .effectAttempt attempt.value = .ok attempt := by
    unfold TextId.parse
    simp [attempt.valid]
  have idParse : Digest.parse id.value = .ok id := by
    unfold Digest.parse
    simp [id.valid]
  have invocationParse : TextId.parse .invocation invocation.value = .ok invocation := by
    unfold TextId.parse
    simp [invocation.valid]
  have runParse : TextId.parse .run run.value = .ok run := by
    unfold TextId.parse
    simp [run.valid]
  have causeParse := RunInvocationDeliveryCause.ofJson_toJson cause
  obtain ⟨payload, encoded⟩ : ∃ payload, cause.toJson = .obj payload := by
    cases cause <;> exact ⟨_, rfl⟩
  rw [encoded] at causeParse
  have bound : 0 ≤ (itemIndex : Int) ∧ ((itemIndex : Int)).natAbs ≤ maxSafeInteger := by
    refine ⟨by omega, ?_⟩
    simpa using itemIndexValid
  have magnitude : ((itemIndex : Int)).natAbs = itemIndex := by omega
  simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
    encoded, attemptParse, causeParse, idParse, invocationParse, runParse, bound, magnitude,
    itemKeyCanonical, itemIndexValid]

theorem canonical_toJson (delivery : RunInvocationDelivery) :
    Json.canonical delivery.toJson = true := by
  have ordered : Text.strictlyOrdered
      ["attempt", "cause", "id", "invocation", "itemIndex", "itemKey", "run"] = true := by
    decide
  have inner := RunInvocationDeliveryCause.canonical_toJson delivery.cause
  simp [toJson, Json.canonical, Json.canonicalEntries, ordered, inner]

end RunInvocationDelivery

/-- `RunInvocationDeliveryCodec`. -/
def runInvocationDeliveryCodec : RecordCodec RunInvocationDelivery where
  kind := "run.invocation-delivery"
  version := ⟨1, 0⟩
  encodePayload := RunInvocationDelivery.toJson
  decodePayload := RunInvocationDelivery.ofJson
  roundTrip := RunInvocationDelivery.ofJson_toJson
  canonicalPayload := RunInvocationDelivery.canonical_toJson

/-- The identities an outbox holds, in stored order. -/
def deliveryIdentities (deliveries : List RunInvocationDelivery) : List String :=
  deliveries.map fun delivery => delivery.id.value

/-- Where a Run is in its lifecycle. The terminal variant records which ceiling dimension's
exhaustion cancelled the Run, and nothing when the Run ended for any other reason. -/
inductive RunLifecycle where
  | active
  | terminal (exhausted : Option ResourceDimension)
  deriving DecidableEq

namespace RunLifecycle

def wire : RunLifecycle → String
  | .active => "active"
  | .terminal _ => "terminal"

/-- Whether the Run has ended. -/
def isTerminal : RunLifecycle → Bool
  | .active => false
  | .terminal _ => true

/-- The dimension whose exhaustion ended the Run, if one did. -/
def exhausted : RunLifecycle → Option ResourceDimension
  | .active => none
  | .terminal dimension => dimension

/-- **An active Run names no exhausted dimension.** -/
theorem active_not_exhausted : RunLifecycle.active.exhausted = none := rfl

end RunLifecycle

/-- One Run. -/
structure Run where
  id : TextId .run
  agent : TextId .agent
  configuration : Digest
  configurations : List Digest
  root : TextId .runCommit
  initialBranch : TextId .runBranch
  parent : Option (TextId .run)
  terminal : Option TerminalSnapshot
  tokensConsumed : Nat
  costConsumed : Option RealizedCost
  deliveries : List RunInvocationDelivery
  revision : Revision
  /-- The configuration history begins with the genesis snapshot. -/
  genesisFirst : configurations.head? = some configuration
  /-- No configuration is recorded twice. -/
  configurationsUnique : (configurations.map Digest.value).Nodup
  /-- The token total is a non-negative safe integer. -/
  tokensValid : tokensConsumed ≤ maxSafeInteger
  /-- Every pending message belongs to this Run. -/
  deliveriesOwned : ∀ delivery ∈ deliveries, delivery.run = id
  /-- The outbox is in canonical identity order, so it holds one message per identity and
  replays deterministically. -/
  deliveriesOrdered : Text.strictlyOrdered (deliveryIdentities deliveries) = true
  /-- A terminal snapshot belongs to this Run. -/
  terminalOwned : ∀ snapshot, terminal = some snapshot → snapshot.run = id

namespace Run

/-- The lifecycle, derived. A Run is terminal exactly when it holds its terminal snapshot,
so there is one place that answers the question. -/
def lifecycle (run : Run) : RunLifecycle :=
  match run.terminal with
  | none => .active
  | some snapshot => .terminal snapshot.exhausted

/-- **The Run is terminal exactly when it holds its snapshot.** -/
theorem lifecycle_is_terminal_iff_snapshot (run : Run) :
    run.lifecycle.isTerminal = true ↔ run.terminal.isSome = true := by
  unfold lifecycle RunLifecycle.isTerminal
  cases run.terminal <;> simp

/-- **An active Run holds no terminal snapshot.** -/
theorem active_has_no_snapshot {run : Run} (active : run.lifecycle = .active) :
    run.terminal = none := by
  unfold lifecycle at active
  cases shape : run.terminal with
  | none => rfl
  | some snapshot => rw [shape] at active; simp at active

/-- **A terminal Run's exhausted dimension is its snapshot's.** -/
theorem terminal_exhausted {run : Run} {snapshot : TerminalSnapshot}
    (ended : run.terminal = some snapshot) :
    run.lifecycle = .terminal snapshot.exhausted := by
  unfold lifecycle
  rw [ended]

/-- `nextRunRevision`: one step forward, refusing at the top of the safe range with
`protocol.revision-conflict` — the exact code `Revision.next` refuses the same ceiling with.
SPEC §8.5 gives a revision its own rejection outcome (`rejectedRevision`) beside the
lifecycle one, so a revision that cannot advance is a fact about the revision; `run.ts`'s
guard exists only to name whose revision ran out. -/
def nextRevision (revision : Revision) : Outcome Revision :=
  if revision.value = maxSafeInteger then refuse .protocolRevisionConflict
  else
    match revision.next with
    | .ok next => .ok next
    | .error fault => .error fault

/-- **A Run's revision ceiling is a revision conflict.** The guard and the revision's own
step refuse the same condition with the same code, so no caller can tell which path answered.
-/
theorem nextRevision_ceiling {revision : Revision} (ceiling : revision.value = maxSafeInteger) :
    (nextRevision revision).RefusedWith .protocolRevisionConflict := by
  unfold nextRevision
  simp [ceiling, refuse, Outcome.RefusedWith]

/-- **A Run's revision only ever moves forward, and by exactly one.** -/
theorem nextRevision_succ {revision next : Revision} (step : nextRevision revision = .ok next) :
    next.value = revision.value + 1 := by
  unfold nextRevision at step
  by_cases ceiling : revision.value = maxSafeInteger
  · rw [if_pos ceiling] at step
    simp [refuse] at step
  · rw [if_neg ceiling] at step
    cases stepped : revision.next with
    | error fault => rw [stepped] at step; simp at step
    | ok successor =>
        rw [stepped] at step
        rw [← Except.ok.inj step]
        exact Revision.next_succ stepped

/-- Whether this Run already owes a message with this identity. -/
def owes (run : Run) (delivery : RunInvocationDelivery) : Bool :=
  run.deliveries.any fun pending => pending.id == delivery.id

/-- The outbox with one identity removed. -/
def withoutDelivery (run : Run) (delivery : RunInvocationDelivery) :
    List RunInvocationDelivery :=
  run.deliveries.filter fun pending => pending.id != delivery.id

/-- Dropping entries from a canonically ordered outbox leaves it canonically ordered.
Proved here because the toolchain's `List` API carries no such lemma without Mathlib, and
every acknowledgement is exactly this shape. -/
theorem filter_deliveries_ordered (target : Digest) :
    ∀ values : List RunInvocationDelivery,
      Text.strictlyOrdered (deliveryIdentities values) = true →
        Text.strictlyOrdered
          (deliveryIdentities (values.filter fun pending => pending.id != target)) = true
  | [], ordered => ordered
  | value :: rest, ordered => by
      have bound := Text.strictlyOrdered_head_bound (value.id.value)
        (deliveryIdentities rest) (by simpa [deliveryIdentities] using ordered)
      have tail : Text.strictlyOrdered (deliveryIdentities rest) = true := by
        cases rest with
        | nil => rfl
        | cons _ _ =>
            exact (Text.strictlyOrdered_cons_of (by simpa [deliveryIdentities] using ordered)).2
      have restFiltered := filter_deliveries_ordered target rest tail
      by_cases hit : (value.id != target) = true
      · simp only [deliveryIdentities, List.filter_cons, hit, if_true, List.map_cons]
        refine Text.strictlyOrdered_cons ?_ (by simpa [deliveryIdentities] using restFiltered)
        intro existing member
        obtain ⟨candidate, candidateMember, candidateValue⟩ := List.mem_map.mp member
        rw [← candidateValue]
        exact bound candidate.id.value (List.mem_map.mpr
          ⟨candidate, (List.mem_filter.mp candidateMember).1, rfl⟩)
      · simp only [Bool.not_eq_true] at hit
        simpa [deliveryIdentities, List.filter_cons, hit] using restFiltered

theorem withoutDelivery_ordered (run : Run) (delivery : RunInvocationDelivery) :
    Text.strictlyOrdered (deliveryIdentities (run.withoutDelivery delivery)) = true :=
  filter_deliveries_ordered delivery.id run.deliveries run.deliveriesOrdered

/-- The outbox with one more message, kept in canonical identity order. -/
def withDelivery (run : Run) (delivery : RunInvocationDelivery) :
    List RunInvocationDelivery :=
  Text.insertBy (fun pending => pending.id.value) delivery run.deliveries

/-- Merge the messages a terminalization takes on into the outbox, keeping it in canonical
identity order. The runtime concatenates and lets the constructor's `canonicalDeliveries`
sort and reject duplicates; sorted insertion is that sort, and the duplicate rejection is
the order check the caller performs on the result. -/
def mergeDeliveries (held incoming : List RunInvocationDelivery) :
    List RunInvocationDelivery :=
  incoming.foldl
    (fun outbox delivery => Text.insertBy (fun pending => pending.id.value) delivery outbox)
    held

theorem mem_mergeDeliveries : ∀ (incoming held : List RunInvocationDelivery)
    (candidate : RunInvocationDelivery),
    candidate ∈ mergeDeliveries held incoming → candidate ∈ held ∨ candidate ∈ incoming
  | [], _, _, member => .inl member
  | value :: rest, held, candidate, member => by
      have deeper := mem_mergeDeliveries rest
        (Text.insertBy (fun pending => pending.id.value) value held) candidate member
      rcases deeper with inserted | later
      · rcases Text.mem_insertBy _ value held candidate inserted with isValue | original
        · exact .inr (by simp [isValue])
        · exact .inl original
      · exact .inr (by simp [later])

/-- `transition`: rebuild the Run with the named changes and the next revision. Every
invariant has to be re-established, which is why each caller supplies the proofs its own
change needs. -/
def transition (run : Run) (terminal : Option TerminalSnapshot)
    (configurations : List Digest) (tokensConsumed : Nat) (costConsumed : Option RealizedCost)
    (deliveries : List RunInvocationDelivery)
    (genesisFirst : configurations.head? = some run.configuration)
    (configurationsUnique : (configurations.map Digest.value).Nodup)
    (tokensValid : tokensConsumed ≤ maxSafeInteger)
    (deliveriesOwned : ∀ delivery ∈ deliveries, delivery.run = run.id)
    (deliveriesOrdered : Text.strictlyOrdered (deliveryIdentities deliveries) = true)
    (terminalOwned : ∀ snapshot, terminal = some snapshot → snapshot.run = run.id) :
    Outcome Run :=
  match nextRevision run.revision with
  | .error fault => .error fault
  | .ok revision =>
      .ok { run with
            terminal := terminal, configurations := configurations,
            tokensConsumed := tokensConsumed, costConsumed := costConsumed,
            deliveries := deliveries, revision := revision,
            genesisFirst := genesisFirst, configurationsUnique := configurationsUnique,
            tokensValid := tokensValid, deliveriesOwned := deliveriesOwned,
            deliveriesOrdered := deliveriesOrdered, terminalOwned := terminalOwned }

/-- `revise`: an ordinary mutation, which a terminal Run rejects. -/
def revise (run : Run) : Outcome Run :=
  if run.lifecycle.isTerminal then refuse .runInvalidState
  else
    run.transition run.terminal run.configurations run.tokensConsumed run.costConsumed
      run.deliveries run.genesisFirst run.configurationsUnique run.tokensValid
      run.deliveriesOwned run.deliveriesOrdered run.terminalOwned

/-- **A terminal Run rejects ordinary mutations.** -/
theorem revise_refuses_terminal {run : Run} (ended : run.lifecycle.isTerminal = true) :
    (run.revise).RefusedWith .runInvalidState := by
  unfold revise
  simp [ended, refuse, Outcome.RefusedWith]

/-- `recordEvidence`: only a terminal Run records the evidence its capture is waiting on. -/
def recordEvidence (run : Run) : Outcome Run :=
  if run.lifecycle.isTerminal then
    run.transition run.terminal run.configurations run.tokensConsumed run.costConsumed
      run.deliveries run.genesisFirst run.configurationsUnique run.tokensValid
      run.deliveriesOwned run.deliveriesOrdered run.terminalOwned
  else refuse .runInvalidState

/-- **An active Run records no captured evidence.** There is no capture yet to record it
against, which is why this is the mirror image of `revise` rather than a second mutation. -/
theorem recordEvidence_refuses_active {run : Run} (active : run.lifecycle.isTerminal = false) :
    (run.recordEvidence).RefusedWith .runInvalidState := by
  unfold recordEvidence
  simp [active, refuse, Outcome.RefusedWith]

/-- What a terminalization requires before it takes on anything: an active Run, a snapshot
of this Run, and cancellation messages that all belong to this Run and all name the exact
terminal commit the Run ended on. -/
def terminalizeAdmits (run : Run) (snapshot : TerminalSnapshot)
    (cancellations : List RunInvocationDelivery) : Bool :=
  !run.lifecycle.isTerminal && snapshot.run == run.id &&
    cancellations.all (fun delivery =>
      delivery.cause.terminalCommit == some snapshot.terminalCommit) &&
    cancellations.all (fun delivery => delivery.run == run.id)

theorem terminalizeAdmits_owned {run : Run} {snapshot : TerminalSnapshot}
    {cancellations : List RunInvocationDelivery}
    (admits : run.terminalizeAdmits snapshot cancellations = true) :
    snapshot.run = run.id ∧ ∀ delivery ∈ cancellations, delivery.run = run.id := by
  unfold terminalizeAdmits at admits
  obtain ⟨front, belong⟩ := (Bool.and_eq_true _ _).mp admits
  obtain ⟨head, _⟩ := (Bool.and_eq_true _ _).mp front
  refine ⟨by simpa using ((Bool.and_eq_true _ _).mp head).2, ?_⟩
  intro delivery member
  simpa using List.all_eq_true.mp belong delivery member

/-- `terminalize`: the Run takes its terminal snapshot and, in the same step, the
cancellation messages its still-owed published items are owed. They arrive together because
a terminal Run admits no second terminalization.

The outbox check is the runtime's duplicate rejection: sorted insertion produces a strictly
ordered list exactly when no identity repeats, so a repeat fails the order check. That
failure is a shape fault, as it is at runtime — `canonicalDeliveries` raises a `TypeError`,
not an `AgentCoreError`. -/
def terminalize (run : Run) (snapshot : TerminalSnapshot)
    (cancellations : List RunInvocationDelivery) : Outcome Run :=
  if admits : run.terminalizeAdmits snapshot cancellations = true then
    if ordered :
        Text.strictlyOrdered (deliveryIdentities (mergeDeliveries run.deliveries cancellations))
          = true then
      run.transition (some snapshot) run.configurations run.tokensConsumed run.costConsumed
        (mergeDeliveries run.deliveries cancellations) run.genesisFirst
        run.configurationsUnique run.tokensValid
        (by
          intro candidate member
          rcases mem_mergeDeliveries cancellations run.deliveries candidate member with
            held | incoming
          · exact run.deliveriesOwned candidate held
          · exact (terminalizeAdmits_owned admits).2 candidate incoming)
        ordered
        (by
          intro candidate carried
          rw [← Option.some.inj carried]
          exact (terminalizeAdmits_owned admits).1)
    else unshaped "Run invocation delivery outbox"
  else refuse .runInvalidState

/-- **A terminal Run cannot terminalize again.** -/
theorem terminalize_refuses_terminal {run : Run} {snapshot : TerminalSnapshot}
    {cancellations : List RunInvocationDelivery} (ended : run.lifecycle.isTerminal = true) :
    (run.terminalize snapshot cancellations).RefusedWith .runInvalidState := by
  have closed : run.terminalizeAdmits snapshot cancellations = false := by
    unfold terminalizeAdmits
    simp [ended]
  unfold terminalize
  simp [closed, refuse, Outcome.RefusedWith]

/-- **A snapshot of another Run is refused.** -/
theorem terminalize_refuses_foreign {run : Run} {snapshot : TerminalSnapshot}
    {cancellations : List RunInvocationDelivery} (foreign : snapshot.run ≠ run.id) :
    (run.terminalize snapshot cancellations).RefusedWith .runInvalidState := by
  have closed : run.terminalizeAdmits snapshot cancellations = false := by
    unfold terminalizeAdmits
    simp [foreign]
  unfold terminalize
  simp [closed, refuse, Outcome.RefusedWith]

/-- `publishDelivery`: the Run takes on the message a published item's owner is owed.
Publishing the same handle again is the same message, so it changes nothing. -/
def publishDelivery (run : Run) (delivery : RunInvocationDelivery) : Outcome Run :=
  if run.lifecycle.isTerminal then refuse .runInvalidState
  else if owned : delivery.run = run.id then
    if admission : delivery.cause = .admission then
      if run.owes delivery then .ok run
      else if ordered :
          Text.strictlyOrdered (deliveryIdentities (run.withDelivery delivery)) = true then
        run.transition run.terminal run.configurations run.tokensConsumed run.costConsumed
          (run.withDelivery delivery) run.genesisFirst run.configurationsUnique run.tokensValid
          (by
            intro candidate member
            rcases Text.mem_insertBy _ delivery run.deliveries candidate member with
              isNew | held
            · rw [isNew]; exact owned
            · exact run.deliveriesOwned candidate held)
          ordered run.terminalOwned
      else refuse .runInvalidState
    else
      have _ := admission
      refuse .runInvalidState
  else refuse .runInvalidState

/-- **A terminal Run publishes no further admission.** -/
theorem publishDelivery_refuses_terminal {run : Run} {delivery : RunInvocationDelivery}
    (ended : run.lifecycle.isTerminal = true) :
    (run.publishDelivery delivery).RefusedWith .runInvalidState := by
  unfold publishDelivery
  simp [ended, refuse, Outcome.RefusedWith]

/-- **A message of another Run is refused.** A caller addressing state it does not hold is
not a duplicate. -/
theorem publishDelivery_refuses_foreign {run : Run} {delivery : RunInvocationDelivery}
    (foreign : delivery.run ≠ run.id) :
    (run.publishDelivery delivery).RefusedWith .runInvalidState := by
  unfold publishDelivery
  cases ended : run.lifecycle.isTerminal with
  | true => simp [refuse, Outcome.RefusedWith]
  | false => simp [foreign, refuse, Outcome.RefusedWith]

/-- **Publishing a handle owes its owner an admission message.** A cancellation message is
not something a publish can take on. -/
theorem publishDelivery_requires_admission {run : Run} {delivery : RunInvocationDelivery}
    (notAdmission : delivery.cause ≠ .admission) :
    (run.publishDelivery delivery).RefusedWith .runInvalidState := by
  unfold publishDelivery
  cases ended : run.lifecycle.isTerminal with
  | true => simp [refuse, Outcome.RefusedWith]
  | false =>
      by_cases owned : delivery.run = run.id
      · simp [owned, notAdmission, refuse, Outcome.RefusedWith]
      · simp [owned, refuse, Outcome.RefusedWith]

/-- **Publishing the same handle twice changes nothing.** Delivery is at-least-once, so a
repeat is the ordinary case rather than an error. -/
theorem publishDelivery_idempotent {run : Run} {delivery : RunInvocationDelivery}
    (active : run.lifecycle.isTerminal = false) (owned : delivery.run = run.id)
    (admission : delivery.cause = .admission) (held : run.owes delivery = true) :
    run.publishDelivery delivery = .ok run := by
  unfold publishDelivery
  simp [active, owned, admission, held]

/-- `acknowledgeDelivery`: one message its owner has acknowledged is discharged. A repeat
finds nothing to remove and says so by changing nothing. A terminal Run accepts this, because
a discharged message changes no lifecycle and a cancellation message exists only on a Run
that has already ended. -/
def acknowledgeDelivery (run : Run) (delivery : RunInvocationDelivery) : Outcome Run :=
  if delivery.run = run.id then
    if run.owes delivery then
      run.transition run.terminal run.configurations run.tokensConsumed run.costConsumed
        (run.withoutDelivery delivery) run.genesisFirst run.configurationsUnique
        run.tokensValid
        (fun candidate member =>
          run.deliveriesOwned candidate (List.mem_filter.mp member).1)
        (run.withoutDelivery_ordered delivery) run.terminalOwned
    else .ok run
  else refuse .runInvalidState

/-- **Acknowledging a message of another Run is refused.** -/
theorem acknowledgeDelivery_refuses_foreign {run : Run} {delivery : RunInvocationDelivery}
    (foreign : delivery.run ≠ run.id) :
    (run.acknowledgeDelivery delivery).RefusedWith .runInvalidState := by
  unfold acknowledgeDelivery
  simp [foreign, refuse, Outcome.RefusedWith]

/-- **Acknowledging twice changes nothing.** -/
theorem acknowledgeDelivery_idempotent {run : Run} {delivery : RunInvocationDelivery}
    (owned : delivery.run = run.id) (absent : run.owes delivery = false) :
    run.acknowledgeDelivery delivery = .ok run := by
  unfold acknowledgeDelivery
  simp [owned, absent]

/-- **A terminal Run still acknowledges.** The one transition a terminal Run admits, because
the cancellation messages it took on at terminalization have to be dischargeable. -/
theorem acknowledgeDelivery_admits_terminal {run : Run} {delivery : RunInvocationDelivery}
    (ended : run.lifecycle.isTerminal = true) (owned : delivery.run = run.id)
    (absent : run.owes delivery = false) :
    run.acknowledgeDelivery delivery = .ok run := by
  have _ := ended
  exact acknowledgeDelivery_idempotent owned absent

/-- `recordConfiguration`: a migration's target configuration joins the history. Recording
one already in the history changes nothing. -/
def recordConfiguration (run : Run) (configuration : Digest) : Outcome Run :=
  if run.lifecycle.isTerminal then refuse .runInvalidState
  else if held : (run.configurations.map Digest.value).contains configuration.value then
    .ok run
  else
    run.transition run.terminal (run.configurations ++ [configuration]) run.tokensConsumed
      run.costConsumed run.deliveries
      (by
        have genesis := run.genesisFirst
        cases shape : run.configurations with
        | nil =>
            rw [shape] at genesis
            simp at genesis
        | cons first rest =>
            rw [shape] at genesis
            simp only [List.head?_cons, Option.some.injEq] at genesis
            simp [genesis])
      (by
        show ((run.configurations ++ [configuration]).map Digest.value).Nodup
        rw [List.map_append]
        refine RunAdmissionRegistry.nodup_append_single _ configuration.value
          run.configurationsUnique ?_
        intro member
        simp only [List.contains, List.elem_eq_mem, decide_eq_true_eq] at held
        exact held (by simpa using member))
      run.tokensValid run.deliveriesOwned run.deliveriesOrdered run.terminalOwned

/-- **A terminal Run rejects configuration migration.** -/
theorem recordConfiguration_refuses_terminal {run : Run} {configuration : Digest}
    (ended : run.lifecycle.isTerminal = true) :
    (run.recordConfiguration configuration).RefusedWith .runInvalidState := by
  unfold recordConfiguration
  simp [ended, refuse, Outcome.RefusedWith]

/-- The currencies a cost has to agree with: this Run's own, plus every one its lineage
holds. A disagreement is a comparison between amounts in two currencies, which is not a
comparison, and a ceiling is nothing but that comparison. -/
def costDisagrees (run : Run) (lineage : List Currency) (cost : RealizedCost) : Bool :=
  (match run.costConsumed with
   | none => lineage
   | some held => held.currency :: lineage).any fun currency =>
    currency.value != cost.currency.value

/-- `recordModelUsage`: one model call's consumption, accumulated where the call commits.
Both totals advance in one transition, so no reader sees a Run whose token total says a call
happened while its cost total says it did not. A refusal moves neither. -/
def recordModelUsage (run : Run) (tokens : Nat) (cost : Option RealizedCost)
    (lineage : List Currency) : Outcome Run :=
  if run.lifecycle.isTerminal then refuse .runInvalidState
  else if bound : run.tokensConsumed + tokens ≤ maxSafeInteger then
    match cost with
    | none =>
        run.transition run.terminal run.configurations (run.tokensConsumed + tokens)
          run.costConsumed run.deliveries run.genesisFirst run.configurationsUnique bound
          run.deliveriesOwned run.deliveriesOrdered run.terminalOwned
    | some realized =>
        if run.costDisagrees lineage realized then refuse .runInvalidState
        else
          match (match run.costConsumed with
                 | none => Except.ok realized
                 | some held => held.add realized : Outcome RealizedCost) with
          | .error fault => .error fault
          | .ok total =>
              run.transition run.terminal run.configurations (run.tokensConsumed + tokens)
                (some total) run.deliveries run.genesisFirst run.configurationsUnique bound
                run.deliveriesOwned run.deliveriesOrdered run.terminalOwned
  else refuse .runInvalidState

/-- **A terminal Run consumes no further resources.** -/
theorem recordModelUsage_refuses_terminal {run : Run} {tokens : Nat}
    {cost : Option RealizedCost} {lineage : List Currency}
    (ended : run.lifecycle.isTerminal = true) :
    (run.recordModelUsage tokens cost lineage).RefusedWith .runInvalidState := by
  unfold recordModelUsage
  simp [ended, refuse, Outcome.RefusedWith]

/-- **A cost in a currency the lineage does not record is refused.** -/
theorem recordModelUsage_refuses_divergent {run : Run} {tokens : Nat}
    {realized : RealizedCost} {lineage : List Currency}
    (active : run.lifecycle.isTerminal = false)
    (bound : run.tokensConsumed + tokens ≤ maxSafeInteger)
    (divergent : run.costDisagrees lineage realized = true) :
    (run.recordModelUsage tokens (some realized) lineage).RefusedWith .runInvalidState := by
  unfold recordModelUsage
  simp [active, bound, divergent, refuse, Outcome.RefusedWith]

/-- **A lineage that holds no currency adopts the first cost's.** -/
theorem costDisagrees_empty {run : Run} {realized : RealizedCost}
    (fresh : run.costConsumed = none) : run.costDisagrees [] realized = false := by
  unfold costDisagrees
  simp [fresh]

end Run

/-- `RunBranch`: one branch of a Run's commit graph, with at most one reserved rewrite. -/
structure RunBranch where
  id : TextId .runBranch
  run : TextId .run
  name : String
  head : TextId .runCommit
  revision : Revision
  rewrite : Option (TextId .runCommit)
  /-- A branch name identifies something. -/
  nameNonblank : isBlank name = false
  /-- A branch cannot reserve a rewrite it already holds as head. -/
  rewriteNotHead : ∀ planned, rewrite = some planned → planned ≠ head

namespace RunBranch

/-- `advance`: moving onto the reserved rewrite closes the reservation, by identity. -/
def advance (branch : RunBranch) (head : TextId .runCommit) : Outcome RunBranch :=
  match Run.nextRevision branch.revision with
  | .error fault => .error fault
  | .ok revision =>
      .ok { branch with
            head := head, revision := revision,
            rewrite := if branch.rewrite = some head then none else branch.rewrite
            rewriteNotHead := by
              intro planned carried
              by_cases closed : branch.rewrite = some head
              · rw [if_pos closed] at carried
                simp at carried
              · rw [if_neg closed] at carried
                intro same
                exact closed (by rw [carried, same]) }

/-- **Advancing onto the reserved rewrite closes the reservation.** -/
theorem advance_closes_reservation {branch advanced : RunBranch} {planned : TextId .runCommit}
    (reserved : branch.rewrite = some planned)
    (step : branch.advance planned = .ok advanced) : advanced.rewrite = none := by
  unfold advance at step
  cases stepped : Run.nextRevision branch.revision with
  | error fault => rw [stepped] at step; simp at step
  | ok revision =>
      rw [stepped] at step
      simp only [Except.ok.injEq] at step
      rw [← step]
      simp [reserved]

/-- `reserveRewrite`: a branch holds at most one uncompleted rewrite, so a second attempt is
rejected rather than raced. -/
def reserveRewrite (branch : RunBranch) (planned : TextId .runCommit) : Outcome RunBranch :=
  if branch.rewrite.isSome then refuse .runInvalidState
  else if distinct : planned ≠ branch.head then
    match Run.nextRevision branch.revision with
    | .error fault => .error fault
    | .ok revision =>
        .ok { branch with
              revision := revision, rewrite := some planned,
              rewriteNotHead := by
                intro candidate carried
                rw [← Option.some.inj carried]
                exact distinct }
  else unshaped "Run branch rewrite"

/-- **A branch holds at most one uncompleted rewrite.** -/
theorem reserveRewrite_refuses_second {branch : RunBranch} {planned held : TextId .runCommit}
    (reserved : branch.rewrite = some held) :
    (branch.reserveRewrite planned).RefusedWith .runInvalidState := by
  unfold reserveRewrite
  simp [reserved, refuse, Outcome.RefusedWith]

def toJson (branch : RunBranch) : Json.JsonValue :=
  .obj [("head", .str branch.head.value),
        ("id", .str branch.id.value),
        ("name", .str branch.name),
        ("revision", .int branch.revision.value),
        ("rewrite", match branch.rewrite with
          | none => .null
          | some planned => .str planned.value),
        ("run", .str branch.run.value)]

def ofJson (value : Json.JsonValue) : Outcome RunBranch :=
  match Json.asObject value "Run branch" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries ["head", "id", "name", "revision", "rewrite", "run"] then
        match Json.field entries "head", Json.field entries "id", Json.field entries "name",
            Json.field entries "revision", Json.field entries "rewrite",
            Json.field entries "run" with
        | some (.str headText), some (.str idText), some (.str name),
            some (.int revisionValue), some rewriteValue, some (.str runText) =>
            match TextId.parse .runCommit headText, TextId.parse .runBranch idText,
                TextId.parse .run runText with
            | .ok head, .ok id, .ok run =>
                if nameNonblank : isBlank name = false then
                  if revisionValue < 0 then unshaped "Run branch revision"
                  else
                    match Revision.parse revisionValue.natAbs with
                    | .error fault => .error fault
                    | .ok revision =>
                        match rewriteValue with
                        | .null =>
                            .ok ⟨id, run, name, head, revision, none, nameNonblank, by
                              intro planned carried; simp at carried⟩
                        | .str rewriteText =>
                            match TextId.parse .runCommit rewriteText with
                            | .error fault => .error fault
                            | .ok planned =>
                                if distinct : planned ≠ head then
                                  .ok ⟨id, run, name, head, revision, some planned,
                                        nameNonblank, by
                                          intro candidate carried
                                          rw [← Option.some.inj carried]
                                          exact distinct⟩
                                else unshaped "Run branch rewrite"
                        | _ => unshaped "Run branch rewrite"
                else unshaped "Run branch name"
            | _, _, _ => unshaped "Run branch"
        | _, _, _, _, _, _ => unshaped "Run branch"
      else unshaped "Run branch"

theorem ofJson_toJson (branch : RunBranch) : ofJson branch.toJson = .ok branch := by
  obtain ⟨id, run, name, head, revision, rewrite, nameNonblank, rewriteNotHead⟩ := branch
  have headParse : TextId.parse .runCommit head.value = .ok head := by
    unfold TextId.parse
    simp [head.valid]
  have idParse : TextId.parse .runBranch id.value = .ok id := by
    unfold TextId.parse
    simp [id.valid]
  have runParse : TextId.parse .run run.value = .ok run := by
    unfold TextId.parse
    simp [run.valid]
  have revisionParse : Revision.parse revision.value = .ok revision := by
    unfold Revision.parse
    simp [revision.valid]
  have nonneg : ¬ ((revision.value : Int) < 0) := by omega
  have magnitude : ((revision.value : Int)).natAbs = revision.value := by omega
  cases rewrite with
  | none =>
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        headParse, idParse, runParse, nameNonblank, nonneg, magnitude, revisionParse]
  | some planned =>
      have plannedParse : TextId.parse .runCommit planned.value = .ok planned := by
        unfold TextId.parse
        simp [planned.valid]
      have distinct : planned ≠ head := rewriteNotHead planned rfl
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        headParse, idParse, runParse, nameNonblank, nonneg, magnitude, revisionParse,
        plannedParse, distinct]

theorem canonical_toJson (branch : RunBranch) : Json.canonical branch.toJson = true := by
  have ordered : Text.strictlyOrdered ["head", "id", "name", "revision", "rewrite", "run"]
      = true := by decide
  cases shape : branch.rewrite <;>
    simp [toJson, Json.canonical, Json.canonicalEntries, ordered, shape]

end RunBranch

/-- `RunBranchCodec`. -/
def runBranchCodec : RecordCodec RunBranch where
  kind := "run.branch"
  version := ⟨2, 0⟩
  encodePayload := RunBranch.toJson
  decodePayload := RunBranch.ofJson
  roundTrip := RunBranch.ofJson_toJson
  canonicalPayload := RunBranch.canonical_toJson

/-! ## Refinement against the model's Run

`AgentCore.Run` carries the Tenant, workspace, pins, and declared acceptance criteria that
the executable record keeps elsewhere — a Run's pins live on its configuration snapshot, and
its criteria on the admission registry — so the bridge takes them as parameters rather than
inventing them. What the bridge *decides* is the status, and that decision is the one this
module is responsible for. -/

namespace Run

/-- The model's status for this Run. -/
def statusToModel (run : Run) : AgentCore.RunStatus :=
  if run.lifecycle.isTerminal then .terminal else .active

/-- The model's Run for this one. -/
def toModel (run : Run) (idOf : String → Nat) (tenant : AgentCore.TenantId)
    (workspace : AgentCore.WorkspaceId) (pins : AgentCore.RunPins)
    (acceptance : List AgentCore.AcceptanceCriterion) : AgentCore.Run where
  tenant := tenant
  workspace := workspace
  agent := ⟨idOf run.agent.value⟩
  pins := pins
  root := ⟨idOf run.root.value⟩
  rootBranch := ⟨idOf run.initialBranch.value⟩
  parent := run.parent.map fun parentRun => ⟨idOf parentRun.value⟩
  status := run.statusToModel
  acceptance := acceptance

/-- **A Run is terminal in the model exactly when it holds its snapshot.** The runtime's
derived lifecycle and the model's stored `RunStatus` are the same fact, so no Run can be
terminal in one and active in the other. -/
theorem toModel_status {run : Run} (idOf : String → Nat) (tenant : AgentCore.TenantId)
    (workspace : AgentCore.WorkspaceId) (pins : AgentCore.RunPins)
    (acceptance : List AgentCore.AcceptanceCriterion) :
    (run.toModel idOf tenant workspace pins acceptance).status = .terminal ↔
      run.terminal.isSome = true := by
  unfold toModel statusToModel
  rw [← lifecycle_is_terminal_iff_snapshot]
  cases ended : run.lifecycle.isTerminal <;> simp

/-- **A terminalized Run holds exactly the snapshot it was terminalized with**, and is
therefore terminal in the model's sense. -/
theorem terminalize_reaches_terminal {run terminalized : Run} {snapshot : TerminalSnapshot}
    {cancellations : List RunInvocationDelivery}
    (step : run.terminalize snapshot cancellations = .ok terminalized) :
    terminalized.terminal = some snapshot ∧ terminalized.statusToModel = .terminal := by
  unfold terminalize at step
  split at step
  · split at step
    · unfold transition at step
      split at step
      · simp at step
      · simp only [Except.ok.injEq] at step
        have carried : terminalized.terminal = some snapshot := by rw [← step]
        refine ⟨carried, ?_⟩
        unfold statusToModel
        rw [(lifecycle_is_terminal_iff_snapshot terminalized).mpr (by rw [carried]; rfl)]
        rfl
    · simp [unshaped] at step
  · simp [refuse] at step

end Run

end AgentCore.Kernel
