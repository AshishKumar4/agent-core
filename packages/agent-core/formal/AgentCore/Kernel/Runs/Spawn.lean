/-
Spawn reservations (SPEC §3.4, §5.2; `packages/agent-core/src/agents/runs/spawn.ts` and the
spawn path of `runtime.ts`).

A spawn reservation is the single record that binds a child Run's genesis to the parent Turn
that asked for it: the parent's lease token, the child's configuration digest and root
content, the Invocation and Receipt that carry the delegation, and the digest of the
attenuation the child runs under. Three of the runtime's constructor checks become `Prop`
fields, so a reservation that is not a coherent delegation does not typecheck:

* the token names the spawning Turn — a reservation cannot be written under some other
  Turn's lease;
* the token's epoch is a non-negative safe integer;
* the child Run is not the parent — a Run cannot spawn itself.

The runtime's fourth check, that the recorded time is a finite `Date`, is discharged by the
type: `Millis` is a `Nat`.

Two admission decisions sit on top of the record and both refuse with `authority.denied`,
which is the SPEC §3.4 answer to attenuation that does not attenuate:

* `admitSpawnGenesis` — the port verified the reservation, the reservation names exactly the
  child genesis being created, and the attenuation digest is the digest of the attenuation
  the port returned;
* `admitSpawnCeiling` — the child's declared ceiling does not widen the parent's remainder,
  and the parent's remainder is not already exhausted. The runtime checks widening first;
  both raise the same code, so a caller cannot tell the order apart, but it is stated in
  that order here anyway.

The reservation-identity conflict is the odd one out: it is `run.invalid-state`, because a
second reservation for the same identity is a state error rather than a denied authority.
-/
import AgentCore.RunGraph
import AgentCore.Kernel.Runs.Ceiling
import AgentCore.Kernel.Runs.Lease

namespace AgentCore.Kernel

/-- `SpawnReservation`: one attenuated child genesis, reserved by the spawning Turn. -/
structure SpawnReservation where
  id : TextId .spawnReservation
  parentRun : TextId .run
  parentTurn : TextId .turn
  childRun : TextId .run
  token : LeaseToken
  configuration : Digest
  rootContent : ContentRef
  invocation : TextId .invocation
  receipt : TextId .receipt
  attenuation : Digest
  recordedAt : Millis
  /-- The token names the spawning Turn. -/
  tokenNamesTurn : token.turn = parentTurn
  /-- The token's epoch is a non-negative safe integer. -/
  tokenEpochValid : token.epoch ≤ maxSafeInteger
  /-- A Run does not spawn itself. -/
  childDistinct : parentRun ≠ childRun

namespace SpawnReservation

/-- The content this record retains: `spawnReservationContentRetention`. -/
def contentRetention (reservation : SpawnReservation) : List (String × ContentRef) :=
  [("rootContent", reservation.rootContent)]

/-- **A spawn retains exactly its root content.** Content retention is what keeps a child's
genesis readable for as long as the reservation exists; naming one field is the whole of it. -/
theorem contentRetention_single (reservation : SpawnReservation) :
    reservation.contentRetention = [("rootContent", reservation.rootContent)] := rfl

/-! ### Encoding

`leaseTokenToData` writes `{epoch, holder, turn}` with the holder as `{principal, tenant}`;
both are already in canonical key order. -/

def holderJson (holder : PrincipalRef) : Json.JsonValue :=
  .obj [("principal", .str holder.principal.value), ("tenant", .str holder.tenant.value)]

def holderOfJson (value : Json.JsonValue) : Outcome PrincipalRef :=
  match Json.asObject value "Lease holder" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries ["principal", "tenant"] then
        match Json.field entries "principal", Json.field entries "tenant" with
        | some (.str principalText), some (.str tenantText) =>
            match TextId.parse .principal principalText, TextId.parse .tenant tenantText with
            | .ok principal, .ok tenant => .ok ⟨tenant, principal⟩
            | _, _ => unshaped "Lease holder"
        | _, _ => unshaped "Lease holder"
      else unshaped "Lease holder"

theorem holderOfJson_holderJson (holder : PrincipalRef) :
    holderOfJson (holderJson holder) = .ok holder := by
  obtain ⟨tenant, principal⟩ := holder
  have principalParse : TextId.parse .principal principal.value = .ok principal := by
    unfold TextId.parse
    simp [principal.valid]
  have tenantParse : TextId.parse .tenant tenant.value = .ok tenant := by
    unfold TextId.parse
    simp [tenant.valid]
  simp [holderJson, holderOfJson, Json.asObject, Json.exactFields, Json.keys, Json.field,
    List.find?, principalParse, tenantParse]

theorem canonical_holderJson (holder : PrincipalRef) :
    Json.canonical (holderJson holder) = true := by
  have ordered : Text.strictlyOrdered ["principal", "tenant"] = true := by decide
  simp [holderJson, Json.canonical, Json.canonicalEntries, ordered]

def tokenJson (token : LeaseToken) : Json.JsonValue :=
  .obj [("epoch", .int token.epoch), ("holder", holderJson token.holder),
        ("turn", .str token.turn.value)]

def toJson (reservation : SpawnReservation) : Json.JsonValue :=
  .obj [("attenuation", .str reservation.attenuation.value),
        ("childRun", .str reservation.childRun.value),
        ("configuration", .str reservation.configuration.value),
        ("id", .str reservation.id.value),
        ("invocation", .str reservation.invocation.value),
        ("parentRun", .str reservation.parentRun.value),
        ("parentTurn", .str reservation.parentTurn.value),
        ("receipt", .str reservation.receipt.value),
        ("recordedAt", .int reservation.recordedAt),
        ("rootContent", .str reservation.rootContent.value),
        ("token", tokenJson reservation.token)]

/-- Read the token back. The runtime raises `codec.invalid` here rather than a `TypeError`,
which the kernel reaches the same way: a shape fault crossing the codec boundary becomes
exactly that refusal (`throughCodec`). -/
def tokenOfJson (value : Json.JsonValue) : Outcome LeaseToken :=
  match Json.asObject value "Spawn token" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries ["epoch", "holder", "turn"] then
        match Json.field entries "epoch", Json.field entries "holder",
            Json.field entries "turn" with
        | some (.int epochValue), some holderValue, some (.str turnText) =>
            match holderOfJson holderValue, TextId.parse .turn turnText with
            | .ok holder, .ok turn =>
                if 0 ≤ epochValue then .ok ⟨turn, holder, epochValue.natAbs⟩
                else unshaped "Spawn token"
            | _, _ => unshaped "Spawn token"
        | _, _, _ => unshaped "Spawn token"
      else unshaped "Spawn token"

def ofJson (value : Json.JsonValue) : Outcome SpawnReservation :=
  match Json.asObject value "Spawn reservation" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries
          ["attenuation", "childRun", "configuration", "id", "invocation", "parentRun",
           "parentTurn", "receipt", "recordedAt", "rootContent", "token"] then
        match Json.field entries "attenuation", Json.field entries "childRun",
            Json.field entries "configuration", Json.field entries "id",
            Json.field entries "invocation", Json.field entries "parentRun",
            Json.field entries "parentTurn", Json.field entries "receipt",
            Json.field entries "recordedAt", Json.field entries "rootContent",
            Json.field entries "token" with
        | some (.str attenuationText), some (.str childText), some (.str configurationText),
            some (.str idText), some (.str invocationText), some (.str parentRunText),
            some (.str parentTurnText), some (.str receiptText), some (.int recordedValue),
            some (.str rootText), some tokenValue =>
            match Digest.parse attenuationText, TextId.parse .run childText,
                Digest.parse configurationText, TextId.parse .spawnReservation idText,
                TextId.parse .invocation invocationText, TextId.parse .run parentRunText with
            | .ok attenuation, .ok childRun, .ok configuration, .ok id, .ok invocation,
                .ok parentRun =>
                match TextId.parse .turn parentTurnText, TextId.parse .receipt receiptText,
                    ContentRef.parse rootText, tokenOfJson tokenValue with
                | .ok parentTurn, .ok receipt, .ok rootContent, .ok token =>
                    if names : token.turn = parentTurn then
                      if epochBound : token.epoch ≤ maxSafeInteger then
                        if distinct : parentRun ≠ childRun then
                          if 0 ≤ recordedValue then
                            .ok ⟨id, parentRun, parentTurn, childRun, token, configuration,
                                  rootContent, invocation, receipt, attenuation,
                                  recordedValue.natAbs, names, epochBound, distinct⟩
                          else unshaped "Spawn reservation timestamp"
                        else unshaped "Spawn child Run"
                      else unshaped "Spawn reservation token epoch"
                    else unshaped "Spawn reservation token"
                | _, _, _, _ => unshaped "Spawn reservation"
            | _, _, _, _, _, _ => unshaped "Spawn reservation"
        | _, _, _, _, _, _, _, _, _, _, _ => unshaped "Spawn reservation"
      else unshaped "Spawn reservation"

theorem ofJson_toJson (reservation : SpawnReservation) :
    ofJson reservation.toJson = .ok reservation := by
  obtain ⟨id, parentRun, parentTurn, childRun, token, configuration, rootContent, invocation,
    receipt, attenuation, recordedAt, names, epochBound, distinct⟩ := reservation
  have attenuationParse : Digest.parse attenuation.value = .ok attenuation := by
    unfold Digest.parse
    simp [attenuation.valid]
  have configurationParse : Digest.parse configuration.value = .ok configuration := by
    unfold Digest.parse
    simp [configuration.valid]
  have idParse : TextId.parse .spawnReservation id.value = .ok id := by
    unfold TextId.parse
    simp [id.valid]
  have childParse : TextId.parse .run childRun.value = .ok childRun := by
    unfold TextId.parse
    simp [childRun.valid]
  have parentRunParse : TextId.parse .run parentRun.value = .ok parentRun := by
    unfold TextId.parse
    simp [parentRun.valid]
  have parentTurnParse : TextId.parse .turn parentTurn.value = .ok parentTurn := by
    unfold TextId.parse
    simp [parentTurn.valid]
  have invocationParse : TextId.parse .invocation invocation.value = .ok invocation := by
    unfold TextId.parse
    simp [invocation.valid]
  have receiptParse : TextId.parse .receipt receipt.value = .ok receipt := by
    unfold TextId.parse
    simp [receipt.valid]
  have rootParse : ContentRef.parse rootContent.value = .ok rootContent :=
    ContentRef.parse_value rootContent
  have turnParse : TextId.parse .turn token.turn.value = .ok token.turn := by
    unfold TextId.parse
    simp [token.turn.valid]
  have holderParse := holderOfJson_holderJson token.holder
  have tokenNonneg : (0 : Int) ≤ (token.epoch : Int) := by omega
  have tokenMagnitude : ((token.epoch : Int)).natAbs = token.epoch := by omega
  have tokenParse : tokenOfJson (tokenJson token) = .ok token := by
    obtain ⟨turn, holder, epoch⟩ := token
    simp [tokenJson, tokenOfJson, Json.asObject, Json.exactFields, Json.keys, Json.field,
      List.find?, holderParse, turnParse, tokenNonneg, tokenMagnitude]
  have nonneg : (0 : Int) ≤ (recordedAt : Int) := by omega
  have magnitude : ((recordedAt : Int)).natAbs = recordedAt := by omega
  simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
    attenuationParse, configurationParse, idParse, childParse, parentRunParse,
    parentTurnParse, invocationParse, receiptParse, rootParse, tokenParse, names, epochBound,
    distinct, nonneg, magnitude]

theorem canonical_toJson (reservation : SpawnReservation) :
    Json.canonical reservation.toJson = true := by
  have ordered : Text.strictlyOrdered
      ["attenuation", "childRun", "configuration", "id", "invocation", "parentRun",
       "parentTurn", "receipt", "recordedAt", "rootContent", "token"] = true := by decide
  have tokenOrdered : Text.strictlyOrdered ["epoch", "holder", "turn"] = true := by decide
  have holder := canonical_holderJson reservation.token.holder
  simp [toJson, tokenJson, Json.canonical, Json.canonicalEntries, ordered, tokenOrdered,
    holder]

end SpawnReservation

/-- `SpawnReservationCodec`. -/
def spawnReservationCodec : RecordCodec SpawnReservation where
  kind := "run.spawn-reservation"
  version := ⟨2, 0⟩
  encodePayload := SpawnReservation.toJson
  decodePayload := SpawnReservation.ofJson
  roundTrip := SpawnReservation.ofJson_toJson
  canonicalPayload := SpawnReservation.canonical_toJson

/-- The child genesis a spawn is being admitted against: the identity the runtime is about
to create, independent of the reservation that claims it. -/
structure ChildGenesis where
  parentRun : TextId .run
  parentTurn : TextId .turn
  childRun : TextId .run
  configuration : Digest
  rootContent : ContentRef
  deriving DecidableEq

/-- Whether the reservation names exactly this genesis. -/
def SpawnReservation.matchesGenesis (reservation : SpawnReservation)
    (genesis : ChildGenesis) : Bool :=
  reservation.parentRun == genesis.parentRun && reservation.parentTurn == genesis.parentTurn &&
    reservation.childRun == genesis.childRun &&
      reservation.configuration == genesis.configuration &&
        reservation.rootContent == genesis.rootContent

/-- `RunSpawnPort`'s decision: the port verified the reservation, the reservation names
exactly the genesis being created, and the attenuation digest is the digest of the
attenuation the port returned. Anything else is `authority.denied` — an attenuation that
does not attenuate is a denied authority, not a malformed record. -/
def admitSpawnGenesis (reservation : SpawnReservation) (genesis : ChildGenesis)
    (verified : Bool) (attenuationDigest : Digest) : Outcome Unit :=
  if verified && reservation.matchesGenesis genesis &&
      reservation.attenuation == attenuationDigest then .ok ()
  else refuse .authorityDenied

/-- **An unverified reservation is denied.** -/
theorem admitSpawnGenesis_requires_verification {reservation : SpawnReservation}
    {genesis : ChildGenesis} {attenuationDigest : Digest} :
    (admitSpawnGenesis reservation genesis false attenuationDigest).RefusedWith
      .authorityDenied := by
  unfold admitSpawnGenesis
  simp [refuse, Outcome.RefusedWith]

/-- **A reservation for another genesis is denied.** -/
theorem admitSpawnGenesis_requires_exact_genesis {reservation : SpawnReservation}
    {genesis : ChildGenesis} {verified : Bool} {attenuationDigest : Digest}
    (mismatch : reservation.matchesGenesis genesis = false) :
    (admitSpawnGenesis reservation genesis verified attenuationDigest).RefusedWith
      .authorityDenied := by
  unfold admitSpawnGenesis
  simp [mismatch, refuse, Outcome.RefusedWith]

/-- **An attenuation the reservation did not commit to is denied.** The digest is what binds
the child's authority to the parent's decision; a different one is a different attenuation. -/
theorem admitSpawnGenesis_requires_committed_attenuation {reservation : SpawnReservation}
    {genesis : ChildGenesis} {verified : Bool} {attenuationDigest : Digest}
    (different : reservation.attenuation ≠ attenuationDigest) :
    (admitSpawnGenesis reservation genesis verified attenuationDigest).RefusedWith
      .authorityDenied := by
  unfold admitSpawnGenesis
  simp [different, refuse, Outcome.RefusedWith]

/-- **An admitted spawn really is the genesis it claims.** -/
theorem admitSpawnGenesis_exact {reservation : SpawnReservation} {genesis : ChildGenesis}
    {verified : Bool} {attenuationDigest : Digest}
    (admitted : admitSpawnGenesis reservation genesis verified attenuationDigest = .ok ()) :
    reservation.parentRun = genesis.parentRun ∧ reservation.parentTurn = genesis.parentTurn ∧
      reservation.childRun = genesis.childRun ∧
        reservation.configuration = genesis.configuration ∧
          reservation.rootContent = genesis.rootContent := by
  unfold admitSpawnGenesis at admitted
  by_cases guard : verified && reservation.matchesGenesis genesis &&
      reservation.attenuation == attenuationDigest
  · have agrees : reservation.matchesGenesis genesis = true := by
      have pair := (Bool.and_eq_true _ _).mp guard
      exact ((Bool.and_eq_true _ _).mp pair.1).2
    unfold SpawnReservation.matchesGenesis at agrees
    simp only [Bool.and_eq_true, beq_iff_eq] at agrees
    exact ⟨agrees.1.1.1.1, agrees.1.1.1.2, agrees.1.1.2, agrees.1.2, agrees.2⟩
  · rw [if_neg guard] at admitted
    simp [refuse] at admitted

/-- `requireNarrowingCeiling`: a child ceiling never widens the parent's remainder, and a
parent with nothing left in some dimension has nothing to hand a child. Both refusals carry
`authority.denied`, so a caller cannot tell them apart by code; the widening check runs
first, as it does in the runtime. -/
def admitSpawnCeiling (parentRemainder : Option ResourceCeiling)
    (declared : Option ResourceCeiling) : Outcome Unit :=
  match declared with
  | some child =>
      if widensResourceCeiling parentRemainder child then refuse .authorityDenied
      else if (exhaustedResource parentRemainder).isSome then refuse .authorityDenied
      else .ok ()
  | none =>
      if (exhaustedResource parentRemainder).isSome then refuse .authorityDenied else .ok ()

/-- **A wider child ceiling is denied.** SPEC §3.4 rule 2 for resources: delegation
attenuates, so the child's declaration cannot exceed what the parent has left. -/
theorem admitSpawnCeiling_refuses_widening {parentRemainder : Option ResourceCeiling}
    {child : ResourceCeiling} (widens : widensResourceCeiling parentRemainder child = true) :
    (admitSpawnCeiling parentRemainder (some child)).RefusedWith .authorityDenied := by
  unfold admitSpawnCeiling
  simp [widens, refuse, Outcome.RefusedWith]

/-- **An exhausted parent spawns nothing.** Fan-out narrows downward, so a lineage stops
rather than growing a Run that is born with nothing to spend. -/
theorem admitSpawnCeiling_refuses_exhausted {parentRemainder : Option ResourceCeiling}
    {declared : Option ResourceCeiling} {dimension : ResourceDimension}
    (exhausted : exhaustedResource parentRemainder = some dimension) :
    (admitSpawnCeiling parentRemainder declared).RefusedWith .authorityDenied := by
  unfold admitSpawnCeiling
  cases declared with
  | none => simp [exhausted, refuse, Outcome.RefusedWith]
  | some child =>
      by_cases widens : widensResourceCeiling parentRemainder child = true
      · simp [widens, refuse, Outcome.RefusedWith]
      · simp only [Bool.not_eq_true] at widens
        simp [widens, exhausted, refuse, Outcome.RefusedWith]

/-- **An unbounded parent admits any child ceiling.** A parent that bounds nothing has
nothing for a child to widen and nothing that can be exhausted. -/
theorem admitSpawnCeiling_unbounded (declared : Option ResourceCeiling) :
    admitSpawnCeiling none declared = .ok () := by
  unfold admitSpawnCeiling
  cases declared with
  | none => rfl
  | some child => simp [widensResourceCeiling_unbounded child, exhaustedResource]

/-- A second reservation for an identity the store already holds. This is the one spawn
refusal that is not `authority.denied`: the caller's authority is fine and the state is not.
-/
def admitSpawnIdentity (conflicts : Bool) : Outcome Unit :=
  if conflicts then refuse .runInvalidState else .ok ()

theorem admitSpawnIdentity_refuses :
    (admitSpawnIdentity true).RefusedWith .runInvalidState := rfl

/-! ## Refinement against the model's spawn step

`AgentCore.GraphStep.spawnChild` requires a fresh child Run, a fresh root branch, and a
fresh root commit — facts about the store, which no record carries. What the *reservation*
carries is the identity relation the step also requires: the child is a different Run from
its parent. That is the part a record can be responsible for, and it is a field here. -/

/-- The model's Run identities this reservation names. -/
def SpawnReservation.toModelRuns (reservation : SpawnReservation) (idOf : String → Nat) :
    AgentCore.RunId × AgentCore.RunId :=
  (⟨idOf reservation.parentRun.value⟩, ⟨idOf reservation.childRun.value⟩)

/-- **A spawned child is a different Run in the model too.** Under the identifier
abstraction the record's own distinctness field is exactly the model's: a `spawnChild` step
whose child is its own parent is not a step, and a reservation claiming one is not a value. -/
theorem SpawnReservation.toModelRuns_distinct (reservation : SpawnReservation)
    (idOf : String → Nat) (injective : ∀ first second, idOf first = idOf second → first = second) :
    (reservation.toModelRuns idOf).1 ≠ (reservation.toModelRuns idOf).2 := by
  intro same
  unfold toModelRuns at same
  simp only [AgentCore.RunId.mk.injEq] at same
  exact reservation.childDistinct (TextId.eq_of_value (injective _ _ same))

end AgentCore.Kernel
