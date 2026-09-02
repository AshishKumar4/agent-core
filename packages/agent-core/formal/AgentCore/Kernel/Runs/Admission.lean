/-
Run admission (SPEC §5.2, §5.6; `packages/agent-core/src/agents/runs/admission.ts`).

A Run's admission registry is the finite set of obligations it has taken on and the subset
it has discharged, plus the epoch that makes a reservation stale once admission closes. Four
rules carry the weight, and all four are here:

* an obligation is identified by its canonical key, and the registry never holds one twice;
* a completed obligation is always a reserved one;
* a closed registry has an advanced epoch, so a reservation taken while open is recognisably
  not current after the close;
* reserving on a closed registry is refused with `run.invalid-state`, while reserving an
  obligation already held changes nothing — delivery is at-least-once, so a repeat is the
  ordinary case rather than an error.

Uniqueness is a `Prop` field over the key list, so a registry holding one obligation twice
does not typecheck, and `reserve` appends exactly as the abstract model's `reserve` does.
The canonical *ordering* the runtime also maintains (it sorts by key in the constructor) is
not carried here, and this module ships no codec for that reason: the ordering is only
observable through the encoded bytes, and a codec whose round-trip law depends on an order
this record does not fix would be a codec that cannot prove its own law. `Text.insertBy`
and `Text.insertBy_ordered` are already proved and are what the ordered form needs.

The open-state field is spelled `«open»` because the runtime's field and its serialized key
are SPEC §5.6's `open` and `open` is a Lean keyword; the escape is the exact name, not a
rename. That spelling arrived with `run.admission-registry` major 2, which refuses a major-1
payload (whose key was `accepting`) as `codec.unknown-major` and leaves the rewrite to
MIGRATE-RUN-ADMISSION-OPEN.
-/
import AgentCore.RunGraph
import AgentCore.Kernel.Core

namespace AgentCore.Kernel

/-- One obligation a Run owes before it can settle. -/
inductive RunObligation where
  | approval (approval : TextId .approval)
  | invocationItem (invocation : TextId .invocation) (itemIndex : Nat) (itemKey : String)
  | route (reservation : TextId .routeReservation)
  | reconciliation (attempt : TextId .effectAttempt)
  | systemCommit (commit : TextId .runCommit)
  | acceptance (acceptance : TextId .acceptance)

namespace RunObligation

/-- `runObligationData`: the fields in the order the runtime writes them, which is already
canonical, so `runObligationKey`'s `JSON.stringify` and the canonical encoder agree. -/
def toJson : RunObligation → Json.JsonValue
  | .approval approvalId =>
      .obj [("approval", .str approvalId.value), ("kind", .str "approval")]
  | .invocationItem invocationId index itemKey =>
      .obj [("invocation", .str invocationId.value), ("itemIndex", .int index),
            ("itemKey", .str itemKey), ("kind", .str "invocationItem")]
  | .route reservationId =>
      .obj [("kind", .str "route"), ("reservation", .str reservationId.value)]
  | .reconciliation attemptId =>
      .obj [("attempt", .str attemptId.value), ("kind", .str "reconciliation")]
  | .systemCommit commitId =>
      .obj [("commit", .str commitId.value), ("kind", .str "systemCommit")]
  | .acceptance acceptanceId =>
      .obj [("acceptance", .str acceptanceId.value), ("kind", .str "acceptance")]

/-- `runObligationKey`: the canonical text of the obligation's data. -/
def key (obligation : RunObligation) : String :=
  String.ofList (Json.canonicalText obligation.toJson)

/-- **An obligation's canonical form is canonical**, so the key is the bytes a reader would
compare and no second normalization can disagree with it. -/
theorem canonical_toJson (obligation : RunObligation) :
    Json.canonical obligation.toJson = true := by
  cases obligation <;> simp [toJson, Json.canonical, Json.canonicalEntries] <;> decide

/-- `decodeRunObligation`: the discriminant first, then exactly that tag's own fields. A
tag the union does not name, or a payload of the wrong shape, is a shape violation — the
codec boundary is what turns it into `codec.invalid`. -/
def ofJson (value : Json.JsonValue) : Outcome RunObligation :=
  match Json.asObject value "Run obligation" with
  | .error fault => .error fault
  | .ok entries =>
      match Json.field entries "kind" with
      | some (.str tag) =>
          if tag = "approval" then
            if Json.exactFields entries ["approval", "kind"] then
              match Json.field entries "approval" with
              | some (.str text) =>
                  (TextId.parse .approval text).map RunObligation.approval
              | _ => unshaped "Approval obligation"
            else unshaped "Approval obligation"
          else if tag = "invocationItem" then
            if Json.exactFields entries ["invocation", "itemIndex", "itemKey", "kind"] then
              match Json.field entries "invocation", Json.field entries "itemIndex",
                  Json.field entries "itemKey" with
              | some (.str invocationText), some (.int index), some (.str itemKey) =>
                  if index < 0 then unshaped "Invocation item obligation index"
                  else
                    (TextId.parse .invocation invocationText).map fun invocation =>
                      RunObligation.invocationItem invocation index.natAbs itemKey
              | _, _, _ => unshaped "Invocation item obligation"
            else unshaped "Invocation item obligation"
          else if tag = "route" then
            if Json.exactFields entries ["kind", "reservation"] then
              match Json.field entries "reservation" with
              | some (.str text) =>
                  (TextId.parse .routeReservation text).map RunObligation.route
              | _ => unshaped "Route obligation"
            else unshaped "Route obligation"
          else if tag = "reconciliation" then
            if Json.exactFields entries ["attempt", "kind"] then
              match Json.field entries "attempt" with
              | some (.str text) =>
                  (TextId.parse .effectAttempt text).map RunObligation.reconciliation
              | _ => unshaped "Reconciliation obligation"
            else unshaped "Reconciliation obligation"
          else if tag = "systemCommit" then
            if Json.exactFields entries ["commit", "kind"] then
              match Json.field entries "commit" with
              | some (.str text) =>
                  (TextId.parse .runCommit text).map RunObligation.systemCommit
              | _ => unshaped "System commit obligation"
            else unshaped "System commit obligation"
          else if tag = "acceptance" then
            if Json.exactFields entries ["acceptance", "kind"] then
              match Json.field entries "acceptance" with
              | some (.str text) =>
                  (TextId.parse .acceptance text).map RunObligation.acceptance
              | _ => unshaped "Acceptance obligation"
            else unshaped "Acceptance obligation"
          else unshaped "Run obligation"
      | _ => unshaped "Run obligation"

theorem ofJson_toJson (obligation : RunObligation) : ofJson obligation.toJson = .ok obligation := by
  cases obligation with
  | approval approvalId =>
      have parsed : TextId.parse .approval approvalId.value = .ok approvalId := by
        unfold TextId.parse
        simp [approvalId.valid]
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        parsed, Except.map]
  | invocationItem invocationId index itemKey =>
      have parsed : TextId.parse .invocation invocationId.value = .ok invocationId := by
        unfold TextId.parse
        simp [invocationId.valid]
      have nonneg : ¬ ((index : Int) < 0) := by omega
      have magnitude : ((index : Int)).natAbs = index := by omega
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        parsed, nonneg, magnitude, Except.map]
  | route reservationId =>
      have parsed : TextId.parse .routeReservation reservationId.value = .ok reservationId := by
        unfold TextId.parse
        simp [reservationId.valid]
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        parsed, Except.map]
  | reconciliation attemptId =>
      have parsed : TextId.parse .effectAttempt attemptId.value = .ok attemptId := by
        unfold TextId.parse
        simp [attemptId.valid]
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        parsed, Except.map]
  | systemCommit commitId =>
      have parsed : TextId.parse .runCommit commitId.value = .ok commitId := by
        unfold TextId.parse
        simp [commitId.valid]
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        parsed, Except.map]
  | acceptance acceptanceId =>
      have parsed : TextId.parse .acceptance acceptanceId.value = .ok acceptanceId := by
        unfold TextId.parse
        simp [acceptanceId.valid]
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        parsed, Except.map]

/-- **The canonical key identifies the obligation.** Two obligations with one key are one
obligation, so "the registry never holds one twice" — a statement about keys — really is a
statement about the obligations behind them, and the model's own `outstanding`, which
filters by value, agrees with the runtime's, which filters by key. -/
theorem key_injective {left right : RunObligation} (same : left.key = right.key) :
    left = right := by
  have trees : left.toJson = right.toJson :=
    Json.canonicalText_injective (String.ofList_injective same)
  have decoded := congrArg ofJson trees
  rw [ofJson_toJson, ofJson_toJson] at decoded
  exact Except.ok.inj decoded

end RunObligation

/-- The keys a list of obligations holds. -/
def obligationKeys (obligations : List RunObligation) : List String :=
  obligations.map RunObligation.key

/-- A reservation handed back to a caller: the Run, the registry epoch it was taken at, and
the obligation itself. -/
structure RunAdmissionReservation where
  run : TextId .run
  registryEpoch : Nat
  obligation : RunObligation

/-- A Run's admission registry. -/
structure RunAdmissionRegistry where
  run : TextId .run
  epoch : Nat
  «open» : Bool
  reserved : List RunObligation
  completed : List RunObligation
  /-- A closed registry has an advanced epoch, so a reservation taken while it was open is
  recognisably stale afterwards. -/
  closedAdvanced : «open» = false → 0 < epoch
  /-- No obligation is reserved twice. -/
  reservedUnique : (obligationKeys reserved).Nodup
  /-- No obligation is completed twice. -/
  completedUnique : (obligationKeys completed).Nodup
  /-- Every completed obligation was reserved. -/
  completedReserved : ∀ obligation ∈ completed,
    obligation.key ∈ obligationKeys reserved

namespace RunAdmissionRegistry

/-- `RunAdmissionRegistry.initial`. -/
def initial (run : TextId .run) : RunAdmissionRegistry where
  run := run
  epoch := 0
  «open» := true
  reserved := []
  completed := []
  closedAdvanced := by intro closed; simp at closed
  reservedUnique := by simp [obligationKeys]
  completedUnique := by simp [obligationKeys]
  completedReserved := by intro _ member; simp at member

/-- Whether an obligation with this key is already reserved. The runtime compares keys with
`===` — canonical text is what identity *is* here, and `compareCanonicalText` is used only
to sort — so this is string identity, and `RunObligation.key_injective` makes it identity of
the obligations behind the keys. -/
def holds (registry : RunAdmissionRegistry) (obligation : RunObligation) : Bool :=
  registry.reserved.any fun existing =>
    existing.key == obligation.key

/-- Whether an obligation with this key is already completed. -/
def discharged (registry : RunAdmissionRegistry) (obligation : RunObligation) : Bool :=
  registry.completed.any fun existing =>
    existing.key == obligation.key

theorem holds_of_mem {registry : RunAdmissionRegistry} {obligation : RunObligation}
    (member : obligation ∈ registry.reserved) : registry.holds obligation = true := by
  unfold holds
  refine List.any_eq_true.mpr ⟨obligation, member, ?_⟩
  simp

theorem key_fresh_of_not_holds {registry : RunAdmissionRegistry} {obligation : RunObligation}
    (fresh : registry.holds obligation = false) :
    ∀ existing ∈ registry.reserved, existing.key ≠ obligation.key := by
  intro existing member same
  have held : registry.holds obligation = true := by
    unfold holds
    refine List.any_eq_true.mpr ⟨existing, member, ?_⟩
    simp [same]
  rw [held] at fresh
  simp at fresh

theorem nodup_append_single : ∀ (values : List String) (value : String),
    values.Nodup → value ∉ values → (values ++ [value]).Nodup
  | [], _, _, _ => by simp
  | head :: rest, value, nodup, absent => by
      have headAbsent : head ∉ rest := (List.nodup_cons.mp nodup).1
      have restNodup : rest.Nodup := (List.nodup_cons.mp nodup).2
      have valueRest : value ∉ rest := fun member => absent (by simp [member])
      have headNe : head ≠ value := fun same => absent (by simp [same])
      refine List.nodup_cons.mpr ⟨?_, nodup_append_single rest value restNodup valueRest⟩
      intro member
      rcases List.mem_append.mp member with inRest | isValue
      · exact headAbsent inRest
      · exact headNe (by simpa using isValue)

/-- `reserve`: refuse on a closed registry, change nothing when the obligation is already
held, and otherwise append it exactly where the abstract model appends it. -/
def reserve (registry : RunAdmissionRegistry) (obligation : RunObligation) :
    Outcome (RunAdmissionRegistry × RunAdmissionReservation) :=
  if registry.«open» then
    if fresh : registry.holds obligation = false then
      .ok ({ registry with
             reserved := registry.reserved ++ [obligation]
             reservedUnique := by
               show (obligationKeys (registry.reserved ++ [obligation])).Nodup
               unfold obligationKeys
               rw [List.map_append]
               refine nodup_append_single (obligationKeys registry.reserved) obligation.key
                 registry.reservedUnique ?_
               intro member
               obtain ⟨existing, existingMember, existingKey⟩ := List.mem_map.mp member
               exact key_fresh_of_not_holds fresh existing existingMember existingKey
             completedReserved := by
               intro completed completedMember
               have reserved := registry.completedReserved completed completedMember
               unfold obligationKeys at reserved ⊢
               simp only [List.map_append]
               exact List.mem_append.mpr (.inl reserved) },
           ⟨registry.run, registry.epoch, obligation⟩)
    else .ok (registry, ⟨registry.run, registry.epoch, obligation⟩)
  else refuse .runInvalidState

/-- The epoch a reservation of this registry carries: the current one while admission is
open, and the pre-close one afterwards. -/
def reservationEpoch (registry : RunAdmissionRegistry) : Nat :=
  if registry.«open» then registry.epoch else registry.epoch - 1

/-- `accepts`: an open registry, the exact Run, the exact epoch, and a held obligation. -/
def accepts (registry : RunAdmissionRegistry) (reservation : RunAdmissionReservation) :
    Bool :=
  registry.«open» && registry.run == reservation.run &&
    registry.epoch == reservation.registryEpoch && registry.holds reservation.obligation

/-- The reserved obligation whose key this one carries, if the registry holds it. The
runtime looks the reserved instance up the same way and appends *that* instance, so a
completion never introduces a second copy of an identity the registry already holds. -/
def reservedFor (registry : RunAdmissionRegistry) (obligation : RunObligation) :
    Option RunObligation :=
  registry.reserved.find? fun existing =>
    existing.key == obligation.key

/-- `complete`: only an exact reserved obligation of this Run at this registry's reservation
epoch, and completing twice changes nothing. -/
def complete (registry : RunAdmissionRegistry) (reservation : RunAdmissionReservation) :
    Outcome RunAdmissionRegistry :=
  if registry.run == reservation.run &&
      registry.reservationEpoch == reservation.registryEpoch then
    match found : registry.reservedFor reservation.obligation with
    | none => refuse .runInvalidState
    | some held =>
        if discharged : registry.discharged held = false then
          .ok { registry with
                completed := registry.completed ++ [held]
                completedUnique := by
                  show (obligationKeys (registry.completed ++ [held])).Nodup
                  unfold obligationKeys
                  rw [List.map_append]
                  refine nodup_append_single (obligationKeys registry.completed) held.key
                    registry.completedUnique ?_
                  intro member
                  obtain ⟨existing, existingMember, existingKey⟩ := List.mem_map.mp member
                  have alreadyDone : registry.discharged held = true := by
                    unfold RunAdmissionRegistry.discharged
                    refine List.any_eq_true.mpr ⟨existing, existingMember, ?_⟩
                    simp [existingKey]
                  rw [alreadyDone] at discharged
                  simp at discharged
                completedReserved := by
                  intro completed completedMember
                  rcases List.mem_append.mp completedMember with existing | appended
                  · exact registry.completedReserved completed existing
                  · have same : completed = held := by simpa using appended
                    rw [same]
                    exact List.mem_map.mpr
                      ⟨held, List.mem_of_find?_eq_some found, rfl⟩ }
        else .ok registry
  else refuse .runInvalidState

/-- `close`: closing an open registry advances its epoch; a closed one is already there. -/
def close (registry : RunAdmissionRegistry) : Outcome RunAdmissionRegistry :=
  if registry.«open» then
    if bound : registry.epoch < maxSafeInteger then
      .ok { registry with
            epoch := registry.epoch + 1
            «open» := false
            closedAdvanced := by
              intro _
              omega }
    else refuse .runInvalidState
  else .ok registry

/-- `frontier`: the obligations still outstanding. -/
def frontier (registry : RunAdmissionRegistry) : List RunObligation :=
  registry.reserved.filter fun obligation => !registry.discharged obligation

/-- **Reserving on a closed registry is refused.** Terminalization closes admission, and a
closed registry takes on nothing further. -/
theorem reserve_refuses_closed {registry : RunAdmissionRegistry} {obligation : RunObligation}
    (closed : registry.«open» = false) :
    (registry.reserve obligation).RefusedWith .runInvalidState := by
  unfold reserve
  simp [closed, refuse, Outcome.RefusedWith]

/-- **Reserving an obligation already held changes nothing.** At-least-once delivery makes a
repeat the ordinary case, so it is idempotent rather than an error. -/
theorem reserve_idempotent {registry : RunAdmissionRegistry} {obligation : RunObligation}
    (open' : registry.«open» = true) (held : registry.holds obligation = true) :
    registry.reserve obligation =
      .ok (registry, ⟨registry.run, registry.epoch, obligation⟩) := by
  unfold reserve
  simp [open', held]

/-- **Closing advances the epoch and stops accepting.** -/
theorem close_advances {registry closed : RunAdmissionRegistry}
    (open' : registry.«open» = true) (step : registry.close = .ok closed) :
    closed.epoch = registry.epoch + 1 ∧ closed.«open» = false := by
  unfold close at step
  rw [if_pos open'] at step
  by_cases bound : registry.epoch < maxSafeInteger
  · rw [dif_pos bound] at step
    simp only [Except.ok.injEq] at step
    rw [← step]
    exact ⟨rfl, rfl⟩
  · rw [dif_neg bound] at step
    simp [refuse] at step

/-- **A closed registry is idempotent under closing.** -/
theorem close_closed {registry : RunAdmissionRegistry} (closed : registry.«open» = false) :
    registry.close = .ok registry := by
  unfold close
  simp [closed]

/-- **A reservation taken while open is not accepted after the close.** The epoch is what
makes a stale reservation recognisable, and closing moves it. -/
theorem closed_rejects_open_reservation {registry closed : RunAdmissionRegistry}
    {reservation : RunAdmissionReservation} (open' : registry.«open» = true)
    (step : registry.close = .ok closed) :
    closed.accepts reservation = false := by
  have shape := close_advances open' step
  unfold accepts
  simp [shape.2]

/-- **The frontier is the reserved obligations that are not discharged.** -/
theorem mem_frontier {registry : RunAdmissionRegistry} {obligation : RunObligation} :
    obligation ∈ registry.frontier ↔
      (obligation ∈ registry.reserved ∧ registry.discharged obligation = false) := by
  unfold frontier
  simp [List.mem_filter]

/-! ## Refinement against the model's registry -/

/-- The model's obligation for this one, under an explicit identifier abstraction. -/
def obligationToModel (obligation : RunObligation) (idOf : String → Nat)
    (itemKeyOf : String → AgentCore.ItemKey) : AgentCore.OpenObligation :=
  match obligation with
  | .approval approvalId => .approval ⟨idOf approvalId.value⟩
  | .invocationItem invocationId index itemKey =>
      .item ⟨idOf invocationId.value⟩ index (itemKeyOf itemKey)
  | .route reservationId => .route ⟨idOf reservationId.value⟩
  | .reconciliation attemptId => .reconciliation ⟨idOf attemptId.value⟩
  | .systemCommit commitId => .systemCommit ⟨idOf commitId.value⟩
  | .acceptance acceptanceId => .acceptance ⟨idOf acceptanceId.value⟩

/-- The model's registry for this one. -/
def toModel (registry : RunAdmissionRegistry) (idOf : String → Nat)
    (itemKeyOf : String → AgentCore.ItemKey) : AgentCore.RunAdmissionRegistry where
  epoch := registry.epoch
  -- The model still calls this flag `accepting`; the runtime and this module call it `open`
  -- after SPEC §5.6. Same boolean, and the bridge is where the two spellings meet.
  accepting := registry.«open»
  reserved := registry.reserved.map fun obligation =>
    obligationToModel obligation idOf itemKeyOf
  completed := registry.completed.map fun obligation =>
    obligationToModel obligation idOf itemKeyOf

/-- **A fresh reserve is the model's reserve.** The kernel appends exactly where
`AgentCore.RunAdmissionRegistry.reserve` appends, so the executable step and the abstract
one produce the same registry. -/
theorem reserve_refines_model {registry next : RunAdmissionRegistry}
    {reservation : RunAdmissionReservation} {obligation : RunObligation}
    (idOf : String → Nat) (itemKeyOf : String → AgentCore.ItemKey)
    (open' : registry.«open» = true) (fresh : registry.holds obligation = false)
    (step : registry.reserve obligation = .ok (next, reservation)) :
    next.toModel idOf itemKeyOf =
      (registry.toModel idOf itemKeyOf).reserve
        (obligationToModel obligation idOf itemKeyOf) := by
  unfold reserve at step
  rw [if_pos open', dif_pos fresh] at step
  simp only [Except.ok.injEq, Prod.mk.injEq] at step
  have shape : next.reserved = registry.reserved ++ [obligation] := by rw [← step.1]
  unfold toModel AgentCore.RunAdmissionRegistry.reserve
  rw [shape]
  have unchangedEpoch : next.epoch = registry.epoch := by rw [← step.1]
  have unchangedOpen : next.«open» = registry.«open» := by rw [← step.1]
  have unchangedCompleted : next.completed = registry.completed := by rw [← step.1]
  rw [unchangedEpoch, unchangedOpen, unchangedCompleted]
  simp

/-- **Closing is the model's close.** -/
theorem close_refines_model {registry closed : RunAdmissionRegistry}
    (idOf : String → Nat) (itemKeyOf : String → AgentCore.ItemKey)
    (open' : registry.«open» = true) (step : registry.close = .ok closed) :
    closed.toModel idOf itemKeyOf = (registry.toModel idOf itemKeyOf).close := by
  have shape := close_advances open' step
  unfold close at step
  rw [if_pos open'] at step
  by_cases bound : registry.epoch < maxSafeInteger
  · rw [dif_pos bound] at step
    simp only [Except.ok.injEq] at step
    unfold toModel AgentCore.RunAdmissionRegistry.close
    rw [shape.1, shape.2]
    have unchangedReserved : closed.reserved = registry.reserved := by rw [← step]
    have unchangedCompleted : closed.completed = registry.completed := by rw [← step]
    rw [unchangedReserved, unchangedCompleted]
  · rw [dif_neg bound] at step
    simp [refuse] at step

end RunAdmissionRegistry

end AgentCore.Kernel
