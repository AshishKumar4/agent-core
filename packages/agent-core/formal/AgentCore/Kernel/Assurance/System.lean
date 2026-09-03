/-
The Run lifecycle as a transition system (SPEC §5.2, §5.3, §5.6).

Every module under `AgentCore.Kernel.Runs` states its own operation's contract: `Turn.claim`
lands running and held, `Run.terminalize` lands terminal, `RunAdmissionRegistry.close`
advances the epoch. What none of them can state is a property of *every reachable state*,
because a state is not one record — it is a Run, its admission registry, its Turns, and its
commit log together, and the interesting failures are disagreements between them: a Run that
ended while its registry stayed open, a commit whose writer is nobody's current lease, two
records claiming the same Turn identity.

This module is the state and the step. `RunSystem` is the tuple, deliberately carrying **no
`Prop` fields** — every cross-record fact is proved in `Assurance.Safety` by induction over
the relation instead of being assumed by the type, which is what makes those proofs say
something. The per-record invariants stay where they are: they are already unrepresentable
otherwise, and re-proving them here would prove nothing.

`step` is one total function from a state and an event to an outcome. It calls the kernel's
own operations — `Turn.renew`, `Run.publishDelivery`, `RunAdmissionRegistry.reserve`,
`admitTurnWriter`, `admitTerminalExhaustion` — and adds exactly the bookkeeping no single
record can hold: which Turn an event addresses, whether that identity is already taken, and
that the writer of a Turn-authored commit is the addressed Turn's current lease holder. It
introduces no second decision: where a kernel operation refuses, the step propagates that
refusal unchanged.

Two things are consequences of that shape and are worth naming before the theorems arrive.
Because `step` is a function into `Outcome`, a step that refuses reaches no state, so every
theorem about reachable states is a theorem about the successful branch only. And because
the event alphabet is closed, `RunEvent.all`-style exhaustiveness is a `cases` and not an
argument: a nineteenth operation added to the kernel without an event here fails to appear
in the relation rather than silently escaping it.
-/
import AgentCore.Kernel.Runs.Commit
import AgentCore.Kernel.Runs.Lifecycle

namespace AgentCore.Kernel

/-! ## Sorting a captured set by canonical key

Terminalization has to hand `SettlementObligation` a list in canonical key order, and the
admission registry deliberately does not maintain one (`Runs.Admission`: the order is only
observable through encoded bytes, and the registry ships no codec). Sorted insertion is
therefore where the order is established, exactly as the runtime establishes it in the
settlement constructor. -/

/-- A list of obligations in canonical key order, by sorted insertion. -/
def sortedByKey (obligations : List RunObligation) : List RunObligation :=
  obligations.foldr (Text.insertBy RunObligation.key) []

/-- Sorted insertion holds the value it inserted. -/
theorem mem_insertBy_self {α : Type} (key : α → String) (value : α) :
    ∀ values : List α, value ∈ Text.insertBy key value values
  | [] => by simp [Text.insertBy]
  | head :: rest => by
      unfold Text.insertBy
      by_cases lower : Text.before (key value) (key head) = true
      · rw [if_pos lower]
        simp
      · rw [if_neg lower]
        exact List.mem_cons_of_mem head (mem_insertBy_self key value rest)

/-- Sorted insertion keeps everything it held. -/
theorem mem_insertBy_of_mem {α : Type} (key : α → String) (value : α) :
    ∀ (values : List α) (candidate : α),
      candidate ∈ values → candidate ∈ Text.insertBy key value values
  | [], _, member => by simp at member
  | head :: rest, candidate, member => by
      unfold Text.insertBy
      by_cases lower : Text.before (key value) (key head) = true
      · rw [if_pos lower]
        exact List.mem_cons_of_mem value member
      · rw [if_neg lower]
        rcases List.mem_cons.mp member with hit | tail
        · exact List.mem_cons.mpr (.inl hit)
        · exact List.mem_cons_of_mem head (mem_insertBy_of_mem key value rest candidate tail)

/-- **Sorting keeps exactly the obligations it was given.** The capture is the frontier
reordered, so no obligation is invented and none is dropped — which is what lets a statement
about the captured set be read as a statement about the frontier. -/
theorem mem_sortedByKey : ∀ (obligations : List RunObligation) (candidate : RunObligation),
    candidate ∈ sortedByKey obligations ↔ candidate ∈ obligations
  | [], candidate => by simp [sortedByKey]
  | value :: rest, candidate => by
      have tail := mem_sortedByKey rest candidate
      unfold sortedByKey
      simp only [List.foldr_cons]
      constructor
      · intro member
        rcases Text.mem_insertBy _ value (sortedByKey rest) candidate member with hit | deeper
        · exact List.mem_cons.mpr (.inl hit)
        · exact List.mem_cons_of_mem value (tail.mp deeper)
      · intro member
        rcases List.mem_cons.mp member with hit | deeper
        · rw [hit]
          exact mem_insertBy_self _ value (sortedByKey rest)
        · exact mem_insertBy_of_mem _ value (sortedByKey rest) candidate (tail.mpr deeper)

/-- **An empty frontier sorts to an empty capture**, which is canonically ordered by
construction: a Run that owes nothing captures nothing. -/
theorem sortedByKey_nil : sortedByKey [] = [] := rfl

/-- `terminalSnapshot`: the snapshot a terminalization records, refusing the one pairing SPEC
§5.6 forbids — a named exhausted dimension on an outcome that is not a cancellation.
Exhaustion is a field on the ordinary cancellation, so the refusal is `run.invalid-state`
rather than a shape fault: the caller asked for a state the lifecycle does not have. -/
def terminalSnapshot (run : TextId .run) (turn : TextId .turn)
    (preterminal terminalCommit : TextId .runCommit) (outcome : TerminalOutcome)
    (obligation : SettlementObligation) (recordedAt : Millis)
    (exhausted : Option ResourceDimension) : Outcome TerminalSnapshot :=
  match exhausted with
  | none =>
      .ok ⟨run, turn, preterminal, terminalCommit, outcome, obligation, recordedAt, none,
            by intro named; simp at named⟩
  | some dimension =>
      if cancelled : outcome = .cancelled then
        .ok ⟨run, turn, preterminal, terminalCommit, outcome, obligation, recordedAt,
              some dimension, fun _ => cancelled⟩
      else refuse .runInvalidState

/-- **A recorded snapshot is the one that was asked for.** -/
theorem terminalSnapshot_shape {run : TextId .run} {turn : TextId .turn}
    {preterminal terminalCommit : TextId .runCommit} {outcome : TerminalOutcome}
    {obligation : SettlementObligation} {recordedAt : Millis}
    {exhausted : Option ResourceDimension} {snapshot : TerminalSnapshot}
    (built : terminalSnapshot run turn preterminal terminalCommit outcome obligation recordedAt
      exhausted = .ok snapshot) :
    snapshot.run = run ∧ snapshot.obligation = obligation ∧ snapshot.outcome = outcome ∧
      snapshot.exhausted = exhausted ∧ snapshot.terminalCommit = terminalCommit := by
  cases exhausted with
  | none =>
      simp only [terminalSnapshot, Except.ok.injEq] at built
      rw [← built]
      exact ⟨rfl, rfl, rfl, rfl, rfl⟩
  | some dimension =>
      by_cases cancelled : outcome = .cancelled
      · simp only [terminalSnapshot, dif_pos cancelled, Except.ok.injEq] at built
        rw [← built]
        exact ⟨rfl, rfl, rfl, rfl, rfl⟩
      · simp [terminalSnapshot, dif_neg cancelled, refuse] at built

/-- **A non-cancellation cannot name an exhausted dimension.** -/
theorem terminalSnapshot_refuses_exhausted {run : TextId .run} {turn : TextId .turn}
    {preterminal terminalCommit : TextId .runCommit} {outcome : TerminalOutcome}
    {obligation : SettlementObligation} {recordedAt : Millis} {dimension : ResourceDimension}
    (live : outcome ≠ .cancelled) :
    (terminalSnapshot run turn preterminal terminalCommit outcome obligation recordedAt
      (some dimension)).RefusedWith .runInvalidState := by
  unfold terminalSnapshot
  simp [live, refuse, Outcome.RefusedWith]

/-! ## The state -/

/-- One appended Run commit, in the projection SPEC §5.2's writer matrix decides over: the
kind, the writer that authored it, and the Turn it names as its subject. The commit's
identity, parents, and tree checkpoint are the Run graph's business (`AgentCore.RunGraph`
holds them, and `Runs.TreeMerge` the merge shape); what the matrix decides is exactly these
three fields, so this is what the log carries here. -/
structure AppendedCommit where
  kind : RunCommitKind
  writer : CommitWriter
  subjectTurn : Option (TextId .turn)

/-- The durable state of one Run: the Run record, its admission registry, its Turns, the
commits appended to it, the ceiling it may still spend against, and the clock the executor
reads.

No field is a `Prop`. Every cross-record fact this tuple could carry — the registry belongs
to this Run, no two Turns share an identity, a terminal Run's admission is closed — is
proved in `Assurance.Safety` by induction over `step`, because a fact carried by the type is
a fact the transition relation was never asked to establish. -/
structure RunSystem where
  run : Run
  registry : RunAdmissionRegistry
  turns : List Turn
  commits : List AppendedCommit
  remainder : Option ResourceCeiling
  now : Millis

namespace RunSystem

/-- The Turn this identity names, if the Run holds it. -/
def turnById (system : RunSystem) (id : TextId .turn) : Option Turn :=
  system.turns.find? fun turn => turn.id == id

/-- The Turn table with one Turn's record replaced by identity. -/
def replaceTurn (system : RunSystem) (turn : Turn) : List Turn :=
  system.turns.map fun existing => if existing.id = turn.id then turn else existing

/-- **A looked-up Turn is one of the Run's own, and it is the one that was asked for.** -/
theorem turnById_found {system : RunSystem} {id : TextId .turn} {turn : Turn}
    (found : system.turnById id = some turn) : turn ∈ system.turns ∧ turn.id = id := by
  unfold turnById at found
  refine ⟨List.mem_of_find?_eq_some found, ?_⟩
  simpa using List.find?_some found

/-- Replacement is pointwise, so a lookup of the replaced identity finds the replacement and
a lookup of any other identity finds what it found before. Both directions come from one
computation, because the replacement preserves every identity in the table. -/
theorem turnById_replaceTurn (system : RunSystem) (turn : Turn) (id : TextId .turn) :
    ({ system with turns := system.replaceTurn turn } : RunSystem).turnById id =
      (system.turnById id).map fun existing => if existing.id = turn.id then turn else existing := by
  unfold turnById replaceTurn
  have keys : ∀ existing : Turn,
      ((if existing.id = turn.id then turn else existing).id == id) = (existing.id == id) := by
    intro existing
    by_cases hit : existing.id = turn.id
    · rw [if_pos hit, hit]
    · rw [if_neg hit]
  simp only [List.find?_map, Function.comp_def, keys]

/-- **Replacing a Turn leaves the Run's other Turns alone.** -/
theorem turnById_replaceTurn_other {system : RunSystem} {turn : Turn} {id : TextId .turn}
    (other : id ≠ turn.id) :
    ({ system with turns := system.replaceTurn turn } : RunSystem).turnById id =
      system.turnById id := by
  rw [turnById_replaceTurn]
  cases found : system.turnById id with
  | none => rfl
  | some existing =>
      have named : existing.id = id := (turnById_found found).2
      have miss : ¬ existing.id = turn.id := by rw [named]; exact other
      simp [miss]

/-- **Replacing a Turn the Run holds installs exactly the replacement.** -/
theorem turnById_replaceTurn_hit {system : RunSystem} {turn existing : Turn}
    (found : system.turnById turn.id = some existing) :
    ({ system with turns := system.replaceTurn turn } : RunSystem).turnById turn.id =
      some turn := by
  rw [turnById_replaceTurn, found]
  have named : existing.id = turn.id := (turnById_found found).2
  simp [named]

end RunSystem

/-! ## The events

The alphabet is the kernel's Run, Turn, and admission operations, one event each, plus the
clock. `tick` is the environment's move rather than a kernel operation and is marked as such
below (`RunEvent.kernelAuthored`): it is here because lease expiry is a fact about elapsed
time, and a transition system whose clock never advances cannot state it. -/

/-- Every move the Run lifecycle admits. -/
inductive RunEvent where
  /-- Time passes. The environment's move, not the kernel's. -/
  | tick (elapsed : Millis)
  /-- An ordinary mutation of an active Run. -/
  | revise
  /-- A terminal Run records the evidence its capture was waiting on. -/
  | recordEvidence
  /-- A queued Turn joins the Run. -/
  | admitTurn (turn : Turn)
  /-- A claimable Turn is claimed by a holder until an expiry. -/
  | claimTurn (turn : TextId .turn) (holder : PrincipalRef) (expiresAt : Millis)
  /-- A running Turn's lease is extended under its exact current token. -/
  | renewTurn (token : LeaseToken) (expiresAt : Millis)
  /-- A running Turn whose lease expired is taken over at a new epoch. -/
  | reclaimTurn (turn : TextId .turn) (holder : PrincipalRef) (expiresAt : Millis)
  /-- A running Turn suspends onto a checkpoint under its exact current token. -/
  | suspendTurn (token : LeaseToken) (checkpoint : TextId .runCheckpoint)
  /-- A running Turn completes under its exact current token. -/
  | completeTurn (token : LeaseToken) (outcome : TerminalOutcome) (result : ContentRef)
  /-- A Turn holding no token is cancelled without one. -/
  | cancelTurn (turn : TextId .turn)
  /-- A Turn is cancelled by the system on named control evidence (SPEC §5.2 forced
  cancellation). -/
  | forceCancelTurn (turn : TextId .turn) (cause : SystemCause)
  /-- A commit is appended under the §5.2 writer matrix. -/
  | appendCommit (commit : AppendedCommit)
  /-- The Run takes on an obligation. -/
  | reserveObligation (obligation : RunObligation)
  /-- A reserved obligation is discharged. -/
  | completeObligation (reservation : RunAdmissionReservation)
  /-- The Run takes on a message a published item's owner is owed. -/
  | publishDelivery (delivery : RunInvocationDelivery)
  /-- An owed message is acknowledged. -/
  | acknowledgeDelivery (delivery : RunInvocationDelivery)
  /-- A migration's target configuration joins the history. -/
  | recordConfiguration (configuration : Digest)
  /-- One model call's consumption is accumulated and the remainder renarrowed. -/
  | recordUsage (usage : ResourceUsage) (cost : Option RealizedCost) (lineage : List Currency)
  /-- The Run ends: admission closes, the frontier is captured, and the cancellation messages
  its still-owed published items are owed arrive in the same step. -/
  | terminalize (turn : TextId .turn) (preterminal terminalCommit : TextId .runCommit)
      (outcome : TerminalOutcome) (exhausted : Option ResourceDimension)
      (cancellations : List RunInvocationDelivery)

namespace RunEvent

/-- Whether the event is a kernel operation at all. Exactly one is not. -/
def kernelAuthored : RunEvent → Bool
  | .tick _ => false
  | _ => true

/-- The exact current lease token the event presents, where it presents one. These are the
executor-authored mutations: the three Turn transitions that carry a token, and a
Turn-authored commit, whose writer *is* the token. -/
def executorToken : RunEvent → Option LeaseToken
  | .renewTurn token _ => some token
  | .suspendTurn token _ => some token
  | .completeTurn token _ _ => some token
  | .appendCommit commit =>
      match commit.writer with
      | .turn token => some token
      | _ => none
  | _ => none

/-- The control evidence a system-authored event stands on. -/
def systemCause : RunEvent → Option SystemCause
  | .forceCancelTurn _ cause => some cause
  | .appendCommit commit =>
      match commit.writer with
      | .system cause => some cause
      | _ => none
  | _ => none

/-- Whether the event touches the Turn table at all: the seven Turn transitions and the one
event that admits a Turn. Everything else leaves the table pointwise identical, which is why
no other event can mutate a Turn. -/
def touchesTable : RunEvent → Bool
  | .admitTurn _ => true
  | .claimTurn _ _ _ => true
  | .renewTurn _ _ => true
  | .reclaimTurn _ _ _ => true
  | .suspendTurn _ _ => true
  | .completeTurn _ _ _ => true
  | .cancelTurn _ => true
  | .forceCancelTurn _ _ => true
  | _ => false

/-- Whether the event takes on work the Run did not already owe: a new Turn, a new
obligation, or a new owed message. Liveness names this set, because a Run that admits new
work forever is a Run that never finishes, and no premise about the substrate changes
that. -/
def admitsNewWork : RunEvent → Bool
  | .admitTurn _ => true
  | .reserveObligation _ => true
  | .publishDelivery _ => true
  | _ => false

end RunEvent

namespace RunSystem

/-- What a Turn event addresses. -/
def eventTurn : RunEvent → Option (TextId .turn)
  | .claimTurn turn _ _ => some turn
  | .renewTurn token _ => some token.turn
  | .reclaimTurn turn _ _ => some turn
  | .suspendTurn token _ => some token.turn
  | .completeTurn token _ _ => some token.turn
  | .cancelTurn turn => some turn
  | .forceCancelTurn turn _ => some turn
  | _ => none

/-- Install a transitioned Turn. -/
def withTurn (system : RunSystem) (turn : Turn) : RunSystem :=
  { system with turns := system.replaceTurn turn }

/-- Address a Turn and transition it, propagating the Turn's own refusal unchanged. A Turn
this Run does not hold is `run.invalid-state`: a caller addressing state the Run does not
hold has not made a Turn error, it has named the wrong Run. -/
def onTurn (system : RunSystem) (id : TextId .turn) (transition : Turn → Outcome Turn) :
    Outcome RunSystem :=
  match system.turnById id with
  | none => refuse .runInvalidState
  | some turn =>
      match transition turn with
      | .error fault => .error fault
      | .ok next => .ok (system.withTurn next)

/-- Whether the Run admits a Turn into its table: an active Run, a Turn of this Run, an
identity nothing else holds, and a queued Turn — a Turn joins its Run unclaimed, so a
caller cannot install one that is already running under a lease nobody minted.

One guard, one code. The four conditions are the runtime's preconditions on the same
operation and it refuses all of them with `run.invalid-state`; a caller cannot tell the
branches apart, so the code is the contract and one guard makes that visible. -/
def admitsTurn (system : RunSystem) (turn : Turn) : Bool :=
  turn.run == system.run.id && (system.turnById turn.id).isNone &&
    turn.status == .queued && !system.run.lifecycle.isTerminal

/-- The lease a commit's writer has to hold. A Turn writer *is* a lease token, so the
question is whether the addressed Turn holds exactly it at exactly its epoch; the root and
system writers stand on genesis and on control evidence instead, and hold no lease. -/
def admitsWriterLease (system : RunSystem) : CommitWriter → Outcome Unit
  | .turn token =>
      match system.turnById token.turn with
      | none => refuse .runInvalidState
      | some turn => turn.requireToken token system.now
  | _ => .ok ()

/-- Whether the Run admits a commit: an active Run, the §5.2 writer matrix — kind *and*
subject Turn — and, for a Turn-authored commit, the addressed Turn's exact current lease at
its exact current epoch.

The matrix is `admitTurnWriter`'s decision and the lease is `Turn.requireToken`'s; this adds
only the join between them, which is the part no single record holds: the writer names a
token, and whether that token is current is a question about the Turn table. -/
def admitsCommit (system : RunSystem) (commit : AppendedCommit) : Outcome Unit :=
  if system.run.lifecycle.isTerminal then refuse .runInvalidState
  else
    match admitTurnWriter commit.writer commit.kind commit.subjectTurn with
    | .error fault => .error fault
    | .ok _ => system.admitsWriterLease commit.writer

/-- `step`: one event, one total function, one outcome.

Every domain decision here belongs to a kernel operation this calls. What the step itself
decides is only what no single record can: that an admitted Turn is this Run's and its
identity is free, that a Turn-authored commit's writer holds the addressed Turn's current
lease, and that terminalization happens over a quiesced Turn table. -/
def step (system : RunSystem) : RunEvent → Outcome RunSystem
  | .tick elapsed => .ok { system with now := system.now + elapsed }
  | .revise =>
      match system.run.revise with
      | .error fault => .error fault
      | .ok run => .ok { system with run := run }
  | .recordEvidence =>
      match system.run.recordEvidence with
      | .error fault => .error fault
      | .ok run => .ok { system with run := run }
  | .admitTurn turn =>
      if system.admitsTurn turn then .ok { system with turns := turn :: system.turns }
      else refuse .runInvalidState
  | .claimTurn id holder expiresAt =>
      system.onTurn id fun turn => turn.claim holder system.now expiresAt
  | .renewTurn token expiresAt =>
      system.onTurn token.turn fun turn => turn.renew token system.now expiresAt
  | .reclaimTurn id holder expiresAt =>
      system.onTurn id fun turn => turn.reclaim holder system.now expiresAt
  | .suspendTurn token checkpoint =>
      system.onTurn token.turn fun turn => turn.suspend token checkpoint system.now
  | .completeTurn token outcome result =>
      system.onTurn token.turn fun turn => turn.complete token outcome result system.now
  | .cancelTurn id => system.onTurn id Turn.cancelUnheld
  | .forceCancelTurn id _ => system.onTurn id Turn.forceCancel
  | .appendCommit commit =>
      match system.admitsCommit commit with
      | .error fault => .error fault
      | .ok _ => .ok { system with commits := commit :: system.commits }
  | .reserveObligation obligation =>
      match system.registry.reserve obligation with
      | .error fault => .error fault
      | .ok (registry, _) => .ok { system with registry := registry }
  | .completeObligation reservation =>
      match system.registry.complete reservation with
      | .error fault => .error fault
      | .ok registry => .ok { system with registry := registry }
  | .publishDelivery delivery =>
      match system.run.publishDelivery delivery with
      | .error fault => .error fault
      | .ok run => .ok { system with run := run }
  | .acknowledgeDelivery delivery =>
      match system.run.acknowledgeDelivery delivery with
      | .error fault => .error fault
      | .ok run => .ok { system with run := run }
  | .recordConfiguration configuration =>
      match system.run.recordConfiguration configuration with
      | .error fault => .error fault
      | .ok run => .ok { system with run := run }
  | .recordUsage usage cost lineage =>
      match system.run.recordModelUsage usage.tokens cost lineage with
      | .error fault => .error fault
      | .ok run =>
          .ok { system with
                run := run, remainder := narrowResources none system.remainder usage }
  | .terminalize turn preterminal terminalCommit outcome exhausted cancellations =>
      if system.turns.all (fun candidate =>
          candidate.status.isTerminal && candidate.lease.holder.isNone) then
        match admitTerminalExhaustion system.remainder exhausted with
        | .error fault => .error fault
        | .ok _ =>
            match system.registry.close with
            | .error fault => .error fault
            | .ok closed =>
                if ordered : Text.strictlyOrdered
                    (obligationKeys (sortedByKey system.registry.frontier)) = true then
                  if epochValid : closed.epoch ≤ maxSafeInteger then
                    match terminalSnapshot system.run.id turn preterminal terminalCommit outcome
                        ⟨closed.epoch, sortedByKey system.registry.frontier, epochValid,
                          ordered⟩
                        system.now exhausted with
                    | .error fault => .error fault
                    | .ok snapshot =>
                        match system.run.terminalize snapshot cancellations with
                        | .error fault => .error fault
                        | .ok run => .ok { system with run := run, registry := closed }
                  else refuse .runInvalidState
                else unshaped "Run settlement capture"
      else refuse .runInvalidState

/-! ### The two step-level guards, read back off the decision -/

/-- **An admitted Turn belongs to this Run, holds a free identity, is queued, and joins an
active Run.** -/
theorem admitsTurn_shape {system : RunSystem} {turn : Turn}
    (admits : system.admitsTurn turn = true) :
    turn.run = system.run.id ∧ system.turnById turn.id = none ∧ turn.status = .queued ∧
      system.run.lifecycle.isTerminal = false := by
  unfold admitsTurn at admits
  simp only [Bool.and_eq_true, beq_iff_eq, Bool.not_eq_true', Option.isNone_iff_eq_none]
    at admits
  exact ⟨admits.1.1.1, admits.1.1.2, admits.1.2, admits.2⟩

/-- **The writer matrix decision, read back.** -/
theorem admitTurnWriter_admits {writer : CommitWriter} {kind : RunCommitKind}
    {subjectTurn : Option (TextId .turn)}
    (admitted : admitTurnWriter writer kind subjectTurn = .ok ()) :
    writer.admits kind = true ∧ subjectAdmits writer subjectTurn = true := by
  unfold admitTurnWriter at admitted
  by_cases guard : writer.admits kind && subjectAdmits writer subjectTurn
  · exact (Bool.and_eq_true _ _).mp guard
  · rw [if_neg guard] at admitted
    cases admitted

/-- **An admitted commit passes the §5.2 matrix on both kind and subject Turn.** -/
theorem admitsCommit_matrix {system : RunSystem} {commit : AppendedCommit}
    (admits : system.admitsCommit commit = .ok ()) :
    commit.writer.admits commit.kind = true ∧
      subjectAdmits commit.writer commit.subjectTurn = true := by
  unfold admitsCommit at admits
  split at admits
  · cases admits
  · split at admits
    · cases admits
    · rename_i value admitted
      cases value
      exact admitTurnWriter_admits admitted

/-- **An admitted commit is appended to an active Run.** -/
theorem admitsCommit_active {system : RunSystem} {commit : AppendedCommit}
    (admits : system.admitsCommit commit = .ok ()) :
    system.run.lifecycle.isTerminal = false := by
  unfold admitsCommit at admits
  by_cases ended : system.run.lifecycle.isTerminal = true
  · rw [if_pos ended] at admits
    cases admits
  · simpa using ended

/-- **A Turn-authored commit is written by the addressed Turn's exact current lease.** The
writer *is* the token, so this is where the matrix and §5.3 fencing meet: a commit whose
writer holds a superseded epoch is not appended. -/
theorem admitsCommit_leased {system : RunSystem} {commit : AppendedCommit} {token : LeaseToken}
    (writer : commit.writer = .turn token) (admits : system.admitsCommit commit = .ok ()) :
    ∃ turn, system.turnById token.turn = some turn ∧
      turn.requireToken token system.now = .ok () := by
  unfold admitsCommit at admits
  split at admits
  · cases admits
  · split at admits
    · cases admits
    · rw [writer] at admits
      simp only [admitsWriterLease] at admits
      split at admits
      · cases admits
      · rename_i turn found
        exact ⟨turn, found, admits⟩

/-- The transition relation: one admitted event from one state to the next. -/
def Step (before after : RunSystem) : Prop := ∃ event, before.step event = .ok after

/-- The state a Run begins in: an active Run, its initial registry, no Turns, and an empty
commit log. The root commit is not built in — it arrives through `appendCommit` under the
root writer, which is the only writer the matrix admits for it. -/
structure Genesis (system : RunSystem) : Prop where
  active : system.run.terminal = none
  registryInitial : system.registry = RunAdmissionRegistry.initial system.run.id
  noTurns : system.turns = []
  noCommits : system.commits = []

/-- Reachability: genesis, then admitted steps. Every safety property in
`Assurance.Safety` is proved by induction over exactly this. -/
inductive Reachable : RunSystem → Prop where
  | genesis {system : RunSystem} (start : Genesis system) : Reachable system
  | step {before after : RunSystem} (reached : Reachable before) {event : RunEvent}
      (stepped : before.step event = .ok after) : Reachable after

/-- **A reached state is one admitted step from a reached state, or genesis.** -/
theorem Reachable.of_step {before after : RunSystem} (reached : Reachable before)
    (stepped : Step before after) : Reachable after := by
  obtain ⟨event, moved⟩ := stepped
  exact .step reached moved

end RunSystem

end AgentCore.Kernel
