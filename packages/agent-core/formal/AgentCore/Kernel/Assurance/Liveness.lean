/-
Liveness: that a Run is never permanently blocked, and that every obligation it admitted is
eventually discharged or terminalized (SPEC §5.2, §5.6, §10.4).

Safety is proved against an adversary. Liveness cannot be: a transition system that never
takes a step satisfies every safety property in `Assurance.Safety` and finishes nothing, so a
progress result has to say what the world is assumed to do. This module says it in three
kinds of hypothesis, each named, none of them hidden inside a proof:

* **Fairness** (`Fairness`). Two fields, and each one is the trace-level reading of a
  *progress* premise from the closed substrate vocabulary:
  `AgentCore.Substrate.Premise.alarmEventuallyFires` for the wakeup that runs the next step,
  and `.queueAtLeastOnceDelivery` for the owed message that eventually arrives.
  `Fairness.premisesAreProgress` proves both tags are `PremiseKind.progress`, so a safety
  premise cannot have leaked into the fairness set. A third field is *not* a substrate
  premise and says so: `workEventuallyCeases`. A Run that admits a new Turn, a new
  obligation, or a new owed message forever is an infinitely long Run, and no premise about
  any substrate makes one finish.

* **Headroom** (`Headroom`). Every kernel counter is a safe integer and every transition
  refuses at the ceiling — `Revision.next` with `protocol.revision-conflict`,
  `TurnLease.nextEpoch` with `lease.invalid`. A Run that has spent 2^53 revisions genuinely
  cannot advance, so progress is stated under stated headroom rather than by pretending the
  ceiling is not there.

* **Canonical keys** (`CanonicalKeys`). The one side condition the kernel *checks* rather
  than proves. `SettlementObligation` requires its capture in canonical key order;
  `Text.before_total` needs two keys to differ as UTF-16 code-unit sequences, and
  `RunObligation.key_injective` gives only that they differ as `String`s.
  `Text.units` is nowhere proved injective in this kernel — the missing lemma is that UTF-16
  is a prefix-free code over Lean's surrogate-free `Char` — so terminalization checks the
  order of its capture and reports a shape fault when it cannot establish it, exactly as
  `Run.terminalize` checks its outbox. This hypothesis is what that check discharges, and
  `sortedByKey_ordered` is the proof that nothing else is missing.

What is proved, in order of strength:

* `forceCancel_always_available` / `terminalize_available` — the enabling results. No Turn is
  stuck: forced cancellation is admitted for every Turn in the table. No Run is stuck: once
  every Turn is retired, terminalization is admitted.
* `no_permanent_block` — from every reachable state that has not ended, some admitted step
  strictly reduces what the Run has left to close. This is deadlock freedom, and it needs no
  fairness at all: the step exists whether or not anything schedules it.
* `obligation_is_discharged_or_captured` — at any reachable state where the Run has ended,
  every obligation it ever admitted is either discharged or captured in its terminal
  snapshot. Also no fairness: it is the safety invariant read for one obligation.
* `fair_trace_ends` — under `Fairness`, `Headroom`, and `CanonicalKeys`, a trace reaches a
  state where the Run has ended.
* `fair_trace_discharges_or_terminalizes` — the two composed, which is the liveness sentence
  this module exists to prove.

What is **not** proved, and cannot be from these premises: that a Run eventually *settles*.
`isSettled` quantifies over evidence — a resolved approval, a terminal Receipt, a satisfied
acceptance — and no premise about alarms, queues, or clocks produces evidence that a
principal has to produce. `EnvironmentResponsive` names that missing hypothesis explicitly
and no theorem here assumes it; `settlement_needs_environment` states exactly what it would
buy.
-/
import AgentCore.Kernel.Assurance.Safety
import AgentCore.Substrate.Effect

namespace AgentCore.Kernel

/-! ## Constructing a canonically ordered capture

Sorted insertion produces the order `SettlementObligation` requires, given that distinct
obligations have distinct code-unit encodings. -/

/-- Distinct obligations have distinct code-unit encodings of their canonical keys.

`RunObligation.key_injective` gives distinct keys as `String`s. Canonical *order* is decided
by `Text.compareUnits` over UTF-16 code units, and `Text.before_total` — the fact that two
distinct keys are ordered one way or the other — needs them distinct as unit sequences. That
step is exactly the injectivity of `Text.units`, which the kernel does not prove: it would
need UTF-16 to be a prefix-free code over Lean's surrogate-free `Char`, which is true and
unproved here. So this is a hypothesis, and the runtime's own canonical-order check is what
discharges it. -/
def CanonicalKeys (obligations : List RunObligation) : Prop :=
  ∀ left ∈ obligations, ∀ right ∈ obligations,
    left ≠ right → Text.units left.key ≠ Text.units right.key

/-- Two elements of a key-distinct list with the same key are the same element. -/
theorem eq_of_nodup_keys {α β : Type} (key : α → β) : ∀ values : List α,
    (values.map key).Nodup → ∀ left ∈ values, ∀ right ∈ values,
      key left = key right → left = right
  | [], _, _, member, _, _, _ => absurd member (by simp)
  | value :: rest, nodup, left, leftMember, right, rightMember, same => by
      have split := List.nodup_cons.mp
        (show (key value :: rest.map key).Nodup from nodup)
      rcases List.mem_cons.mp leftMember with leftHead | leftRest
      · rcases List.mem_cons.mp rightMember with rightHead | rightRest
        · rw [leftHead, rightHead]
        · refine absurd ?_ split.1
          rw [← leftHead, same]
          exact List.mem_map.mpr ⟨right, rightRest, rfl⟩
      · rcases List.mem_cons.mp rightMember with rightHead | rightRest
        · refine absurd ?_ split.1
          rw [← rightHead, ← same]
          exact List.mem_map.mpr ⟨left, leftRest, rfl⟩
        · exact eq_of_nodup_keys key rest split.2 left leftRest right rightRest same

/-- Filtering a key-distinct list of obligations leaves it key-distinct. -/
theorem nodup_obligationKeys_filter (predicate : RunObligation → Bool) :
    ∀ obligations : List RunObligation, (obligationKeys obligations).Nodup →
      (obligationKeys (obligations.filter predicate)).Nodup
  | [], nodup => nodup
  | value :: rest, nodup => by
      have split := List.nodup_cons.mp
        (show (RunObligation.key value :: obligationKeys rest).Nodup from nodup)
      have tail := nodup_obligationKeys_filter predicate rest split.2
      by_cases hit : predicate value = true
      · simp only [List.filter_cons, hit, if_true, obligationKeys, List.map_cons]
        refine List.nodup_cons.mpr ⟨?_, by simpa [obligationKeys] using tail⟩
        intro member
        obtain ⟨candidate, candidateMember, candidateKey⟩ := List.mem_map.mp member
        refine absurd ?_ split.1
        rw [← candidateKey]
        exact List.mem_map.mpr ⟨candidate, (List.mem_filter.mp candidateMember).1, rfl⟩
      · simp only [Bool.not_eq_true] at hit
        simpa [List.filter_cons, hit] using tail

/-- **Sorted insertion produces the canonical order a capture requires.** Given that the
obligations are key-distinct and their keys are distinct as code-unit sequences, the sorted
capture satisfies `SettlementObligation.ordered` — so the record is constructible and the
runtime's order check cannot fail for a well-formed frontier. -/
theorem sortedByKey_ordered : ∀ obligations : List RunObligation,
    (obligationKeys obligations).Nodup → CanonicalKeys obligations →
      Text.strictlyOrdered (obligationKeys (sortedByKey obligations)) = true
  | [], _, _ => rfl
  | value :: rest, nodup, canonical => by
      have split := List.nodup_cons.mp
        (show (RunObligation.key value :: obligationKeys rest).Nodup from nodup)
      have restNodup : (obligationKeys rest).Nodup := split.2
      have restCanonical : CanonicalKeys rest := fun left leftMember right rightMember distinct =>
        canonical left (by simp [leftMember]) right (by simp [rightMember]) distinct
      have restOrdered := sortedByKey_ordered rest restNodup restCanonical
      have fresh : ∀ existing ∈ sortedByKey rest,
          Text.units (RunObligation.key existing) ≠ Text.units (RunObligation.key value) := by
        intro existing member
        have inRest : existing ∈ rest := (mem_sortedByKey rest existing).mp member
        refine canonical existing (by simp [inRest]) value (by simp) ?_
        intro same
        refine absurd ?_ split.1
        rw [← same]
        exact List.mem_map.mpr ⟨existing, inRest, rfl⟩
      have inserted := Text.insertBy_ordered RunObligation.key value (sortedByKey rest)
        (by simpa [obligationKeys] using restOrdered) fresh
      simpa [sortedByKey, obligationKeys] using inserted

/-! ## Headroom

Every counter the kernel advances is a safe integer, and every transition refuses at the
ceiling rather than wrapping. Progress therefore holds under stated headroom, and a Run that
has spent the range genuinely stops — with `protocol.revision-conflict` or `lease.invalid`,
which is the kernel telling the truth rather than a gap in this proof. -/

/-- The arithmetic headroom the transitions a progress argument uses need. -/
structure Headroom (system : RunSystem) : Prop where
  /-- The Run can take another revision. -/
  runRevision : system.run.revision.value + 1 ≤ maxSafeInteger
  /-- Admission can take another epoch. -/
  registryEpoch : system.registry.epoch < maxSafeInteger
  /-- Every Turn can take another lease epoch and another revision. -/
  turnCounters : ∀ turn ∈ system.turns,
    turn.lease.epoch < maxSafeInteger ∧ turn.revision.value + 1 ≤ maxSafeInteger

namespace TurnLease

/-- The fence a lease with headroom takes. -/
theorem fence_available {lease : TurnLease} (headroom : lease.epoch < maxSafeInteger) :
    lease.fence = .ok { turn := lease.turn, holder := none, epoch := lease.epoch + 1,
                        expiresAt := lease.expiresAt, heldHasExpiry := by simp } := by
  unfold fence nextEpoch
  rw [if_pos headroom]

end TurnLease

namespace Revision

/-- The step a revision with headroom takes. -/
theorem next_available {revision : Revision} (headroom : revision.value + 1 ≤ maxSafeInteger) :
    revision.next = .ok ⟨revision.value + 1, by unfold revisionValid; simp [headroom]⟩ := by
  unfold next
  rw [dif_pos headroom]

end Revision

namespace Turn

/-- **Forced cancellation is always admitted.** SPEC §5.2's forced cancellation is the
kernel's escape hatch, and it is a total one: with headroom, every Turn in every state admits
it, whatever it holds and whoever holds it. No Turn is stuck. -/
theorem forceCancel_available {turn : Turn} (epoch : turn.lease.epoch < maxSafeInteger)
    (revision : turn.revision.value + 1 ≤ maxSafeInteger) :
    ∃ next, turn.forceCancel = .ok next ∧ next.status.isTerminal = true := by
  cases result : turn.forceCancel with
  | ok next => exact ⟨next, rfl, forceCancel_lands_terminal result⟩
  | error fault =>
      exfalso
      unfold forceCancel at result
      split at result
      · cases result
      · split at result
        · rename_i leaseFault leaseStep
          rw [TurnLease.fence_available epoch] at leaseStep
          cases leaseStep
        · split at result
          · rename_i revisionFault revisionStep
            rw [Revision.next_available revision] at revisionStep
            cases revisionStep
          · cases result

end Turn

namespace RunAdmissionRegistry

/-- The close an open registry with headroom takes. -/
theorem close_available {registry : RunAdmissionRegistry} (open' : registry.«open» = true)
    (headroom : registry.epoch < maxSafeInteger) :
    ∃ closed, registry.close = .ok closed ∧ closed.epoch = registry.epoch + 1 ∧
      closed.«open» = false := by
  cases result : registry.close with
  | ok closed =>
      exact ⟨closed, rfl, (close_advances open' result).1, (close_advances open' result).2⟩
  | error fault =>
      exfalso
      unfold close at result
      rw [if_pos open', dif_pos headroom] at result
      cases result

end RunAdmissionRegistry

namespace Run

/-- The revision step a Run with headroom takes. -/
theorem nextRevision_available {revision : Revision}
    (headroom : revision.value + 1 ≤ maxSafeInteger) :
    ∃ next, Run.nextRevision revision = .ok next := by
  unfold nextRevision
  have distinct : revision.value ≠ maxSafeInteger := by omega
  rw [if_neg distinct, Revision.next_available headroom]
  exact ⟨_, rfl⟩

/-- **An active Run terminalizes on its own snapshot.** With headroom and no cancellation
messages to take on, the Run record's own transition succeeds: the outbox it already holds is
canonically ordered, so the shape check `Run.terminalize` performs cannot fail. -/
theorem terminalize_available {run : Run} {snapshot : TerminalSnapshot}
    (active : run.lifecycle.isTerminal = false) (owned : snapshot.run = run.id)
    (headroom : run.revision.value + 1 ≤ maxSafeInteger) :
    ∃ next, run.terminalize snapshot [] = .ok next := by
  have admits : run.terminalizeAdmits snapshot [] = true := by
    unfold terminalizeAdmits
    simp [active, owned]
  have ordered :
      Text.strictlyOrdered (deliveryIdentities (mergeDeliveries run.deliveries [])) = true :=
    run.deliveriesOrdered
  unfold terminalize
  rw [dif_pos admits, dif_pos ordered]
  unfold transition
  obtain ⟨revision, stepped⟩ := nextRevision_available headroom
  rw [stepped]
  exact ⟨_, rfl⟩

/-- The same fact as a refusal, which is the form a composite step's error branch needs: the
snapshot is then fixed by the branch rather than inferred from an existential. -/
theorem terminalize_not_error {run : Run} {snapshot : TerminalSnapshot} {fault : Fault}
    (active : run.lifecycle.isTerminal = false) (owned : snapshot.run = run.id)
    (headroom : run.revision.value + 1 ≤ maxSafeInteger) :
    run.terminalize snapshot [] ≠ .error fault := by
  obtain ⟨next, available⟩ := terminalize_available active owned headroom
  rw [available]
  simp

end Run

namespace RunSystem

/-! ## What the Run has left to close

The measure is a sum of ones rather than a filtered length, because a sum over a mapped list
compares termwise: a transition that replaces one Turn changes exactly that term, and the
comparison needs no reasoning about where in the list it sat. The four list facts this needs
are proved here — the toolchain's `List` API carries none of them without Mathlib. -/

theorem sum_map_le {α : Type} (weight measure : α → Nat) : ∀ values : List α,
    (∀ value ∈ values, measure value ≤ weight value) →
      (values.map measure).sum ≤ (values.map weight).sum
  | [], _ => by simp
  | value :: rest, bound => by
      have deeper := sum_map_le weight measure rest fun candidate member =>
        bound candidate (by simp [member])
      have head := bound value (by simp)
      simp only [List.map_cons, List.sum_cons]
      omega

theorem sum_map_lt {α : Type} (weight measure : α → Nat) : ∀ values : List α,
    (∀ value ∈ values, measure value ≤ weight value) →
    (∃ value ∈ values, measure value < weight value) →
      (values.map measure).sum < (values.map weight).sum
  | [], _, ⟨_, member, _⟩ => by simp at member
  | value :: rest, bound, ⟨witness, witnessMember, strict⟩ => by
      have deeper := sum_map_le weight measure rest fun candidate member =>
        bound candidate (by simp [member])
      have head := bound value (by simp)
      simp only [List.map_cons, List.sum_cons]
      rcases List.mem_cons.mp witnessMember with hit | tail
      · rw [hit] at strict
        omega
      · have deeperStrict := sum_map_lt weight measure rest
          (fun candidate member => bound candidate (by simp [member])) ⟨witness, tail, strict⟩
        omega

theorem eq_zero_of_sum_map_eq_zero {α : Type} (measure : α → Nat) : ∀ values : List α,
    (values.map measure).sum = 0 → ∀ value ∈ values, measure value = 0
  | [], _, _, member => by simp at member
  | value :: rest, zero, candidate, member => by
      simp only [List.map_cons, List.sum_cons] at zero
      rcases List.mem_cons.mp member with hit | tail
      · rw [hit]; omega
      · exact eq_zero_of_sum_map_eq_zero measure rest (by omega) candidate tail

theorem exists_of_sum_map_pos {α : Type} (measure : α → Nat) : ∀ values : List α,
    0 < (values.map measure).sum → ∃ value ∈ values, 0 < measure value
  | [], positive => by simp at positive
  | value :: rest, positive => by
      simp only [List.map_cons, List.sum_cons] at positive
      by_cases head : 0 < measure value
      · exact ⟨value, by simp, head⟩
      · obtain ⟨candidate, member, strict⟩ := exists_of_sum_map_pos measure rest (by omega)
        exact ⟨candidate, by simp [member], strict⟩

/-- One for every Turn that has not finished. -/
def unfinishedTurns (system : RunSystem) : Nat :=
  (system.turns.map fun turn => if turn.status.isTerminal = true then 0 else 1).sum

/-- What the Run has left to close: one for the Run itself while it is active, and one for
each unfinished Turn. Terminalization retires the first; a completion, a cancellation, or a
forced cancellation retires one of the second. Nothing else moves it, which is what makes it
a measure. -/
def closingDebt (system : RunSystem) : Nat :=
  (if system.run.terminal.isSome = true then 0 else 1) + unfinishedTurns system

/-- **Nothing left to close means the Run has ended with every Turn finished.** -/
theorem closingDebt_eq_zero {system : RunSystem} (closed : closingDebt system = 0) :
    system.run.terminal.isSome = true ∧ ∀ turn ∈ system.turns, turn.status.isTerminal = true := by
  unfold closingDebt at closed
  have ended : system.run.terminal.isSome = true := by
    by_cases held : system.run.terminal.isSome = true
    · exact held
    · rw [if_neg held] at closed
      omega
  refine ⟨ended, ?_⟩
  intro turn member
  have zero := eq_zero_of_sum_map_eq_zero _ system.turns (by
    rw [if_pos ended] at closed
    simpa [unfinishedTurns] using closed) turn member
  by_cases terminal : turn.status.isTerminal = true
  · exact terminal
  · rw [if_neg terminal] at zero
    omega

/-- **Something left to close means the Run is still active or a Turn is unfinished.** -/
theorem closingDebt_pos {system : RunSystem} (owing : 0 < closingDebt system) :
    system.run.terminal.isSome = false ∨
      ∃ turn ∈ system.turns, turn.status.isTerminal = false := by
  by_cases ended : system.run.terminal.isSome = true
  · refine .inr ?_
    unfold closingDebt at owing
    rw [if_pos ended] at owing
    obtain ⟨turn, member, positive⟩ :=
      exists_of_sum_map_pos _ system.turns (by simpa [unfinishedTurns] using owing)
    refine ⟨turn, member, ?_⟩
    by_cases terminal : turn.status.isTerminal = true
    · rw [if_pos terminal] at positive
      omega
    · simpa using terminal
  · exact .inl (by simpa using ended)

/-- A Turn the table holds is the Turn its identity looks up, because identities are
unique. -/
theorem turnById_of_mem {system : RunSystem} (unique : (system.turns.map Turn.id).Nodup)
    {turn : Turn} (member : turn ∈ system.turns) : system.turnById turn.id = some turn := by
  cases found : system.turnById turn.id with
  | none => exact absurd rfl (turnById_none found turn member)
  | some existing =>
      rw [eq_of_nodup_keys Turn.id system.turns unique existing (turnById_found found).1 turn
        member (turnById_found found).2]

/-- **Transitioning a Turn never leaves more unfinished than before**, given that the
transition either retires the Turn or found it unfinished. All seven Turn transitions satisfy
one of those: `complete`, `cancelUnheld`, and `forceCancel` retire, and `claim`, `renew`,
`reclaim`, and `suspend` act on a Turn that is claimable or running. -/
theorem unfinishedTurns_le_of_replacement {system : RunSystem}
    (unique : (system.turns.map Turn.id).Nodup) {pre next : Turn} (member : pre ∈ system.turns)
    (named : next.id = pre.id)
    (retires : next.status.isTerminal = true ∨ pre.status.isTerminal = false) :
    unfinishedTurns (system.withTurn next) ≤ unfinishedTurns system := by
  show ((system.replaceTurn next).map
    fun turn => if turn.status.isTerminal = true then 0 else 1).sum ≤ _
  unfold replaceTurn
  rw [List.map_map]
  refine sum_map_le _ _ system.turns ?_
  intro turn turnMember
  by_cases hit : turn.id = next.id
  · have same : turn = pre :=
      eq_of_nodup_keys Turn.id system.turns unique turn turnMember pre member (hit.trans named)
    simp only [Function.comp_apply, if_pos hit]
    rcases retires with retired | unfinished
    · simp [retired]
    · have live : ¬(pre.status.isTerminal = true) := by simpa using unfinished
      rw [same, if_neg live]
      by_cases terminal : next.status.isTerminal = true <;> simp [terminal]
  · simp only [Function.comp_apply, if_neg hit]
    exact Nat.le_refl _

/-- **Retiring an unfinished Turn strictly reduces what is left unfinished.** -/
theorem unfinishedTurns_lt_of_retirement {system : RunSystem} {pre next : Turn}
    (member : pre ∈ system.turns)
    (named : next.id = pre.id) (retired : next.status.isTerminal = true)
    (unfinished : pre.status.isTerminal = false) :
    unfinishedTurns (system.withTurn next) < unfinishedTurns system := by
  show ((system.replaceTurn next).map
    fun turn => if turn.status.isTerminal = true then 0 else 1).sum < _
  unfold replaceTurn
  rw [List.map_map]
  refine sum_map_lt _ _ system.turns ?_ ⟨pre, member, ?_⟩
  · intro turn turnMember
    by_cases hit : turn.id = next.id
    · simp only [Function.comp_apply, if_pos hit, if_pos retired]
      exact Nat.zero_le _
    · simp only [Function.comp_apply, if_neg hit]
      exact Nat.le_refl _
  · have hit : pre.id = next.id := named.symm
    have live : ¬(pre.status.isTerminal = true) := by simpa using unfinished
    simp only [Function.comp_apply, if_pos hit, if_pos retired, if_neg live]
    omega

end RunSystem

namespace RunSystem

/-! ## No Run is permanently blocked -/

/-- A Turn step is admitted when the Run holds the Turn and the transition succeeds. -/
theorem onTurn_available {system : RunSystem} {id : TextId .turn}
    {transition : Turn → Outcome Turn} {turn next : Turn}
    (found : system.turnById id = some turn) (moved : transition turn = .ok next) :
    system.onTurn id transition = .ok (system.withTurn next) := by
  simp only [onTurn, found, moved]

/-- **Terminalization is admitted once every Turn is retired.** With headroom, canonical
capture keys, and no cancellation messages to take on, the whole composite step succeeds — so
a Run whose Turns have all finished is never stuck short of ending. The identities the step
names (the terminal Turn and the two commits) are the caller's to mint, which is why they are
parameters rather than something this theorem invents. -/
theorem step_terminalize_available {system : RunSystem} (invariant : Invariant system)
    (headroom : Headroom system) (canonical : CanonicalKeys system.registry.frontier)
    (active : system.run.terminal = none)
    (quiesced : ∀ turn ∈ system.turns, turn.status.isTerminal = true)
    (turn : TextId .turn) (preterminal terminalCommit : TextId .runCommit)
    (outcome : TerminalOutcome) :
    ∃ after, system.step (.terminalize turn preterminal terminalCommit outcome none [])
        = .ok after ∧
      after.run.terminal.isSome = true ∧ after.turns = system.turns := by
  have quiescedBool : system.turns.all
      (fun candidate => candidate.status.isTerminal && candidate.lease.holder.isNone)
        = true := by
    refine List.all_eq_true.mpr ?_
    intro candidate member
    have terminal := quiesced candidate member
    rw [terminal, Turn.terminal_is_unheld candidate terminal]
    rfl
  have activeBool : system.run.lifecycle.isTerminal = false := by
    unfold Run.lifecycle
    rw [active]
    rfl
  obtain ⟨closed, closing, advanced, _⟩ := RunAdmissionRegistry.close_available
    (invariant.admissionOpenIffActive.mpr active) headroom.registryEpoch
  have keysNodup : (obligationKeys system.registry.frontier).Nodup :=
    nodup_obligationKeys_filter _ system.registry.reserved system.registry.reservedUnique
  have ordered := sortedByKey_ordered system.registry.frontier keysNodup canonical
  have epochValid : closed.epoch ≤ maxSafeInteger := by
    have bound := headroom.registryEpoch
    omega
  cases result : system.step (.terminalize turn preterminal terminalCommit outcome none []) with
  | ok after =>
      obtain ⟨_, snapshot, _, _, ended, _, turns, _, _, _⟩ := step_terminalize_shape result
      exact ⟨after, rfl, by rw [(Run.terminalize_shape ended).2]; rfl, turns⟩
  | error fault =>
      exfalso
      simp only [step, closing] at result
      repeat' split at result
      all_goals
        first
          | (cases result; done)
          | (rename_i wrong; exact absurd quiescedBool wrong)
          | (rename_i wrong; exact absurd ordered wrong)
          | (rename_i wrong; exact absurd epochValid wrong)
          | (rename_i value equation; cases equation; done)
          | (rename_i snapshot built _ runFault equation
             exact absurd equation
               (Run.terminalize_not_error activeBool (terminalSnapshot_shape built).1
                 headroom.runRevision))

/-- **No Run is permanently blocked.** From every reachable state that still has something to
close, some admitted step strictly reduces what is left: a live Turn is retired by forced
cancellation, or — once every Turn is retired — the Run terminalizes. No fairness is used;
the step exists whether or not anything schedules it. -/
theorem no_permanent_block {system : RunSystem} (reached : Reachable system)
    (headroom : Headroom system) (canonical : CanonicalKeys system.registry.frontier)
    (cause : SystemCause) (turn : TextId .turn)
    (preterminal terminalCommit : TextId .runCommit) (outcome : TerminalOutcome)
    (owing : 0 < closingDebt system) :
    ∃ event after, system.step event = .ok after ∧ closingDebt after < closingDebt system := by
  have invariant := reachable_invariant reached
  by_cases finished : unfinishedTurns system = 0
  · have allTerminal : ∀ candidate ∈ system.turns, candidate.status.isTerminal = true := by
      intro candidate member
      have zero := eq_zero_of_sum_map_eq_zero _ system.turns finished candidate member
      by_cases terminal : candidate.status.isTerminal = true
      · exact terminal
      · rw [if_neg terminal] at zero
        omega
    have active : system.run.terminal = none := by
      cases shape : system.run.terminal with
      | none => rfl
      | some snapshot =>
          unfold closingDebt at owing
          simp [shape, finished] at owing
    obtain ⟨after, stepped, ended, turns⟩ := step_terminalize_available invariant headroom
      canonical active allTerminal turn preterminal terminalCommit outcome
    refine ⟨.terminalize turn preterminal terminalCommit outcome none [], after, stepped, ?_⟩
    have same : unfinishedTurns after = unfinishedTurns system := by
      unfold unfinishedTurns
      rw [turns]
    have absent : ¬(system.run.terminal.isSome = true) := by rw [active]; simp
    unfold closingDebt
    rw [if_pos ended, if_neg absent, same, finished]
    omega
  · obtain ⟨candidate, member, positive⟩ :=
      exists_of_sum_map_pos _ system.turns (show 0 < unfinishedTurns system by omega)
    have live : candidate.status.isTerminal = false := by
      by_cases terminal : candidate.status.isTerminal = true
      · rw [if_pos terminal] at positive
        omega
      · simpa using terminal
    obtain ⟨next, cancelled, retired⟩ := Turn.forceCancel_available
      (headroom.turnCounters candidate member).1 (headroom.turnCounters candidate member).2
    have found : system.turnById candidate.id = some candidate :=
      turnById_of_mem invariant.turnsUnique member
    refine ⟨.forceCancelTurn candidate.id cause, system.withTurn next, ?_, ?_⟩
    · show system.onTurn candidate.id Turn.forceCancel = _
      exact onTurn_available found cancelled
    · have fewer := unfinishedTurns_lt_of_retirement member
        (Turn.forceCancel_preserves_identity cancelled).1 retired live
      show (if (system.withTurn next).run.terminal.isSome = true then 0 else 1) +
          unfinishedTurns (system.withTurn next) <
        (if system.run.terminal.isSome = true then 0 else 1) + unfinishedTurns system
      have same : (system.withTurn next).run.terminal = system.run.terminal := rfl
      rw [same]
      omega

/-! ## Every admitted obligation is discharged or terminalized -/

/-- **Every obligation a Run admitted is discharged or captured, once the Run has ended.**
No fairness: this is the safety invariant read for one obligation. An obligation is reserved
forever — nothing removes a reservation — so at a terminal state it is either in the
discharged set or in the frontier, and the frontier is what the terminal snapshot captured. -/
theorem obligation_is_discharged_or_captured {system : RunSystem} {snapshot : TerminalSnapshot}
    (reached : Reachable system) (ended : system.run.terminal = some snapshot)
    {obligation : RunObligation} (admitted : obligation ∈ system.registry.reserved) :
    system.registry.discharged obligation = true ∨
      obligation ∈ snapshot.obligation.obligations := by
  by_cases discharged : system.registry.discharged obligation = true
  · exact .inl discharged
  · refine .inr ((reachable_invariant reached).captureCoversFrontier snapshot ended obligation ?_)
    exact RunAdmissionRegistry.mem_frontier.mpr ⟨admitted, by simpa using discharged⟩

/-! ## Traces, fairness, and what fairness buys -/

/-- One run of the transition system. The event taken at each index is observable, because
fairness is a statement about which events are taken and a trace that hides them cannot carry
one. `none` is a stutter: a real system idles. -/
structure Trace where
  state : Nat → RunSystem
  event : Nat → Option RunEvent
  advance : ∀ index,
    (event index = none ∧ state (index + 1) = state index) ∨
      ∃ move, event index = some move ∧ (state index).step move = .ok (state (index + 1))

namespace Trace

/-- Every state of a trace that starts reachable is reachable. -/
theorem reachable (trace : Trace) (start : Reachable (trace.state 0)) :
    ∀ index, Reachable (trace.state index)
  | 0 => start
  | index + 1 => by
      rcases trace.advance index with ⟨_, stutter⟩ | ⟨move, _, stepped⟩
      · rw [stutter]
        exact trace.reachable start index
      · exact .step (trace.reachable start index) stepped

end Trace

/-- The substrate premises the fairness fields below are the trace-level reading of. -/
def fairnessPremises : List Substrate.Premise :=
  [.alarmEventuallyFires, .queueAtLeastOnceDelivery]

/-- **The fairness set is exactly progress premises.** Every premise the liveness results
lean on is classified `progress` in the closed substrate vocabulary, so no safety premise has
been smuggled in under a progress name — and, by
`AgentCore.Substrate.Premise.progress_is_exactly_eventual`, these two are the only progress
premises there are. -/
theorem fairnessPremises_are_progress :
    ∀ premise ∈ fairnessPremises, premise.kind = .progress := by decide

/-- The fairness hypotheses, over one trace, each named.

`wakeupScheduled` is weak fairness of the wakeup that runs the next step: this is the
trace-level reading of `Substrate.Premise.alarmEventuallyFires` for the alarm-driven steps
and of `.queueAtLeastOnceDelivery` for the acknowledgement of an owed message.
`workEventuallyCeases` is **not** a substrate premise and does not pretend to be: a Run that
admits a new Turn, a new obligation, or a new owed message forever is an infinitely long Run,
and no premise about any substrate makes one finish. -/
structure Fairness (trace : Trace) : Prop where
  /-- If a debt-reducing step is enabled at every state from some index on, one is taken. -/
  wakeupScheduled : ∀ index,
    (∀ later, index ≤ later → ∃ move after, (trace.state later).step move = .ok after ∧
        closingDebt after < closingDebt (trace.state later)) →
      ∃ later, index ≤ later ∧
        closingDebt (trace.state (later + 1)) < closingDebt (trace.state later)
  /-- From some index on, no event takes on work the Run did not already owe. -/
  workEventuallyCeases : ∃ index, ∀ later, index ≤ later →
    ∀ move, trace.event later = some move → move.admitsNewWork = false

/-- **An event that takes on no new work never increases what the Run has left to close.**
The Run's own share is monotone because the terminal snapshot is write-once; the Turn share
is monotone because every Turn transition either retires its Turn or found it unfinished. -/
theorem debt_step_le {before after : RunSystem} {event : RunEvent} (invariant : Invariant before)
    (stepped : before.step event = .ok after) (quiet : event.admitsNewWork = false) :
    closingDebt after ≤ closingDebt before := by
  have terminalPart : (if after.run.terminal.isSome = true then 0 else 1) ≤
      (if before.run.terminal.isSome = true then 0 else 1) := by
    by_cases ended : before.run.terminal.isSome = true
    · obtain ⟨snapshot, held⟩ : ∃ snapshot, before.run.terminal = some snapshot := by
        cases shape : before.run.terminal with
        | none => rw [shape] at ended; simp at ended
        | some snapshot => exact ⟨snapshot, rfl⟩
      rw [if_pos ended, if_pos (show after.run.terminal.isSome = true by
        rw [step_keeps_snapshot invariant stepped held]; rfl)]
      exact Nat.le_refl _
    · rw [if_neg ended]
      by_cases afterEnded : after.run.terminal.isSome = true
      · rw [if_pos afterEnded]
        omega
      · rw [if_neg afterEnded]
        exact Nat.le_refl _
  have turnPart : unfinishedTurns after ≤ unfinishedTurns before := by
    by_cases quietTable : event.touchesTable = false
    · unfold unfinishedTurns
      rw [step_keeps_table invariant stepped quietTable]
      exact Nat.le_refl _
    · cases event with
      | tick elapsed => simp [RunEvent.touchesTable] at quietTable
      | revise => simp [RunEvent.touchesTable] at quietTable
      | recordEvidence => simp [RunEvent.touchesTable] at quietTable
      | appendCommit commit => simp [RunEvent.touchesTable] at quietTable
      | reserveObligation obligation => simp [RunEvent.touchesTable] at quietTable
      | completeObligation reservation => simp [RunEvent.touchesTable] at quietTable
      | publishDelivery delivery => simp [RunEvent.touchesTable] at quietTable
      | acknowledgeDelivery delivery => simp [RunEvent.touchesTable] at quietTable
      | recordConfiguration configuration => simp [RunEvent.touchesTable] at quietTable
      | recordUsage usage cost lineage => simp [RunEvent.touchesTable] at quietTable
      | terminalize a b c d e f => simp [RunEvent.touchesTable] at quietTable
      | admitTurn newTurn => simp [RunEvent.admitsNewWork] at quiet
      | claimTurn target holder expiresAt =>
          simp only [step] at stepped
          obtain ⟨pre, next, found, moved, shape⟩ := onTurn_shape stepped
          subst shape
          exact unfinishedTurns_le_of_replacement invariant.turnsUnique (turnById_found found).1
            (Turn.claim_preserves_identity moved).1
            (.inr (TurnStatus.claimable_not_terminal (Turn.claim_requires_claimable moved)))
      | renewTurn token expiresAt =>
          simp only [step] at stepped
          obtain ⟨pre, next, found, moved, shape⟩ := onTurn_shape stepped
          subst shape
          exact unfinishedTurns_le_of_replacement invariant.turnsUnique (turnById_found found).1
            (Turn.renew_preserves_identity moved).1
            (.inr (Turn.requireToken_not_terminal (Turn.renew_requires_token moved)))
      | reclaimTurn target holder expiresAt =>
          simp only [step] at stepped
          obtain ⟨pre, next, found, moved, shape⟩ := onTurn_shape stepped
          subst shape
          refine unfinishedTurns_le_of_replacement invariant.turnsUnique (turnById_found found).1
            (Turn.reclaim_preserves_identity moved).1 (.inr ?_)
          rw [Turn.reclaim_requires_running moved]
          rfl
      | suspendTurn token checkpoint =>
          simp only [step] at stepped
          obtain ⟨pre, next, found, moved, shape⟩ := onTurn_shape stepped
          subst shape
          exact unfinishedTurns_le_of_replacement invariant.turnsUnique (turnById_found found).1
            (Turn.suspend_preserves_identity moved).1
            (.inr (Turn.requireToken_not_terminal (Turn.suspend_requires_token moved)))
      | completeTurn token outcome result =>
          simp only [step] at stepped
          obtain ⟨pre, next, found, moved, shape⟩ := onTurn_shape stepped
          subst shape
          exact unfinishedTurns_le_of_replacement invariant.turnsUnique (turnById_found found).1
            (Turn.complete_preserves_identity moved).1
            (.inl (Turn.complete_lands_terminal moved))
      | cancelTurn target =>
          simp only [step] at stepped
          obtain ⟨pre, next, found, moved, shape⟩ := onTurn_shape stepped
          subst shape
          exact unfinishedTurns_le_of_replacement invariant.turnsUnique (turnById_found found).1
            (Turn.cancelUnheld_preserves_identity moved).1
            (.inl (Turn.cancelUnheld_lands_terminal moved))
      | forceCancelTurn target cause =>
          simp only [step] at stepped
          obtain ⟨pre, next, found, moved, shape⟩ := onTurn_shape stepped
          subst shape
          exact unfinishedTurns_le_of_replacement invariant.turnsUnique (turnById_found found).1
            (Turn.forceCancel_preserves_identity moved).1
            (.inl (Turn.forceCancel_lands_terminal moved))
  unfold closingDebt
  omega

/-- **A fair trace ends.** Under the fairness above, with headroom and canonical capture keys
at every state, the Run reaches a state where it has ended. This is where the two progress
premises do their work: `no_permanent_block` says a debt-reducing step is always *enabled*,
and fairness is what makes one *taken*. -/
theorem fair_trace_ends (trace : Trace) (fairness : Fairness trace)
    (start : Reachable (trace.state 0)) (headroom : ∀ index, Headroom (trace.state index))
    (canonical : ∀ index, CanonicalKeys ((trace.state index).registry.frontier))
    (cause : SystemCause) (turn : TextId .turn)
    (preterminal terminalCommit : TextId .runCommit) (outcome : TerminalOutcome) :
    ∃ index, (trace.state index).run.terminal.isSome = true := by
  obtain ⟨quietFrom, quiet⟩ := fairness.workEventuallyCeases
  have monotone : ∀ index, quietFrom ≤ index →
      closingDebt (trace.state (index + 1)) ≤ closingDebt (trace.state index) := by
    intro index bound
    rcases trace.advance index with ⟨_, stutter⟩ | ⟨move, taken, stepped⟩
    · rw [stutter]
      exact Nat.le_refl _
    · exact debt_step_le (reachable_invariant (trace.reachable start index))
        stepped (quiet index bound move taken)
  have chain : ∀ index, quietFrom ≤ index → ∀ later, index ≤ later →
      closingDebt (trace.state later) ≤ closingDebt (trace.state index) := by
    intro index bound later
    induction later with
    | zero =>
        intro reach
        have same : index = 0 := by omega
        rw [same]
        exact Nat.le_refl _
    | succ later inner =>
        intro reach
        by_cases hit : index = later + 1
        · rw [hit]
          exact Nat.le_refl _
        · exact Nat.le_trans (monotone later (by omega)) (inner (by omega))
  have main : ∀ budget index, quietFrom ≤ index →
      closingDebt (trace.state index) ≤ budget →
        ∃ later, (trace.state later).run.terminal.isSome = true := by
    intro budget
    induction budget with
    | zero =>
        intro index _ bound
        exact ⟨index, (closingDebt_eq_zero (by omega)).1⟩
    | succ budget inner =>
        intro index bound debt
        by_cases settled : ∃ later, index ≤ later ∧ closingDebt (trace.state later) = 0
        · obtain ⟨later, _, zero⟩ := settled
          exact ⟨later, (closingDebt_eq_zero zero).1⟩
        · have enabled : ∀ later, index ≤ later →
              ∃ move after, (trace.state later).step move = .ok after ∧
                closingDebt after < closingDebt (trace.state later) := by
            intro later laterBound
            have positive : 0 < closingDebt (trace.state later) := by
              by_cases zero : closingDebt (trace.state later) = 0
              · exact absurd ⟨later, laterBound, zero⟩ settled
              · omega
            exact no_permanent_block (trace.reachable start later) (headroom later)
              (canonical later) cause turn preterminal terminalCommit outcome positive
          obtain ⟨later, laterBound, reduced⟩ := fairness.wakeupScheduled index enabled
          have transferred := chain index bound later laterBound
          exact inner (later + 1) (by omega) (by omega)
  exact main (closingDebt (trace.state quietFrom)) quietFrom (Nat.le_refl _) (Nat.le_refl _)

/-- **Every admitted obligation is eventually discharged or terminalized.** The liveness
sentence this module exists to prove, assembled from the two halves: fairness gets the Run to
a state where it has ended, and the safety invariant says every obligation it ever admitted is
by then discharged or captured in its terminal snapshot. -/
theorem fair_trace_discharges_or_terminalizes (trace : Trace) (fairness : Fairness trace)
    (start : Reachable (trace.state 0)) (headroom : ∀ index, Headroom (trace.state index))
    (canonical : ∀ index, CanonicalKeys ((trace.state index).registry.frontier))
    (cause : SystemCause) (turn : TextId .turn)
    (preterminal terminalCommit : TextId .runCommit) (outcome : TerminalOutcome) :
    ∃ index snapshot, (trace.state index).run.terminal = some snapshot ∧
      ∀ obligation ∈ (trace.state index).registry.reserved,
        (trace.state index).registry.discharged obligation = true ∨
          obligation ∈ snapshot.obligation.obligations := by
  obtain ⟨index, ended⟩ := fair_trace_ends trace fairness start headroom canonical cause turn
    preterminal terminalCommit outcome
  obtain ⟨snapshot, held⟩ : ∃ snapshot, (trace.state index).run.terminal = some snapshot := by
    cases shape : (trace.state index).run.terminal with
    | none => rw [shape] at ended; simp at ended
    | some snapshot => exact ⟨snapshot, rfl⟩
  exact ⟨index, snapshot, held, fun obligation admitted =>
    obligation_is_discharged_or_captured (trace.reachable start index) held admitted⟩

/-! ## What fairness does not buy

Settlement is not a progress property of the substrate. `isSettled` quantifies over evidence
— a resolved approval, a terminal Receipt, a satisfied acceptance criterion — and no premise
about alarms, queues, or clocks produces evidence that a principal has to produce. The
hypothesis that would close it is named here and assumed by nothing above. -/

/-- The hypothesis this module does not assume: the evidence port eventually answers for every
obligation the Run captured. This is a statement about principals and external systems, not
about any substrate seam, and there is no `Substrate.Premise` for it. -/
def EnvironmentResponsive (evidence : SettlementEvidence) (obligations : List RunObligation) :
    Prop :=
  ∀ obligation ∈ obligations, obligationSettled evidence obligation = true

/-- **Settlement is exactly environment responsiveness plus the derived audits.** Stated to
make the gap precise: everything else a Run needs in order to settle is proved above, and
these two hypotheses are what remains — neither of which any fairness premise in this
library supplies. -/
theorem settlement_needs_environment {snapshot : TerminalSnapshot}
    {evidence : SettlementEvidence}
    (responsive : EnvironmentResponsive evidence snapshot.obligation.obligations)
    (audited : ∀ audit ∈ snapshot.obligation.requiredAudits,
      evidence.auditSatisfied audit = true) :
    isSettled snapshot.obligation evidence = true := by
  unfold isSettled
  refine (Bool.and_eq_true _ _).mpr ⟨List.all_eq_true.mpr ?_, List.all_eq_true.mpr ?_⟩
  · intro obligation member
    exact responsive obligation member
  · intro audit member
    exact audited audit member

end RunSystem

end AgentCore.Kernel
