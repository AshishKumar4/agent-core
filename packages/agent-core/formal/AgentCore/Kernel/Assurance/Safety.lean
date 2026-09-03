/-
Safety: what holds in every reachable state of the Run lifecycle (SPEC §5.2, §5.3, §5.6).

Every property here is a property of *every reachable state*, not of one operation's result,
and that distinction is the module's whole reason to exist.
`Run.terminalize_reaches_terminal` says terminalization lands terminal; it cannot say that a
terminal Run's admission is closed, because closing is a different record's operation, and a
reader who wants that fact otherwise has to trust that no path reaches a terminal Run beside
an open registry. Here it is `Invariant.admissionOpenIffActive`, proved once by induction
over `RunSystem.step` and therefore covering all nineteen events — a twentieth event cannot
be admitted without extending this proof.

## The five properties, and the two that are false as stated

* **No durable record has two owners.** True as stated, and three fields:
  `Invariant.registryOwned`, `turnsOwned`, `turnsUnique`. A Run's registry, its Turns, and
  its snapshot all name this Run, and no two Turns share an identity.

* **No commit violates the §5.2 writer matrix.** True as stated:
  `appended_commits_obey_writer_matrix` over the whole log, and
  `appended_turn_commit_is_leased` for the part the matrix alone cannot decide — a
  Turn-authored commit is written under the addressed Turn's exact current lease.

* **Authority never widens.** True as stated, in the two senses the Run lifecycle has:
  `step_never_widens_remainder` (no step raises or drops a resource bound) and
  `lease_authority_never_widens` (no step makes a token current that was not current,
  except by advancing the epoch — which is a new incarnation, not a wider one). The §3.4
  Grant plane is not modelled here and this module claims nothing about it.

* **No Run settles with an outstanding obligation.** *False if `settles` is read as
  `terminalizes`.* Terminalizing with obligations outstanding is the ordinary path: SPEC §5.6
  exists to describe it, `TerminalSnapshot.obligation` is where those obligations go, and
  `terminalization_discharges_nothing` proves that ending a Run leaves the frontier exactly
  as it was. The corrected statement is
  `settled_discharges_every_outstanding_obligation`: because the capture covers the frontier
  (`Invariant.captureCoversFrontier`), a Run whose own capture is `isSettled` has evidence
  for every obligation it still owed. Settlement is the decision that cannot happen early;
  terminalization is not.

* **No Turn mutates without a current lease at the exact epoch.** *False for four of the
  seven Turn transitions, by design.* `claim` mints the first token, `reclaim` takes over an
  expired lease with a *new* holder, `cancelUnheld` cancels a Turn that holds nothing, and
  `forceCancel` is system-authored on control evidence (SPEC §5.2). The corrected statement is
  `turn_mutation_is_authorized`: every Turn mutation either presents the exact current token
  at the exact current epoch, or advances the epoch — and in the latter case the Turn was
  unheld, or its term had elapsed, or the event named its control evidence. What the informal
  sentence was reaching for is that no mutation *keeps* an incarnation it was not entitled
  to, and that is what this proves.
-/
import AgentCore.Kernel.Assurance.Shape

namespace AgentCore.Kernel

namespace RunSystem

/-! ## The invariant

Seven fields, none of them derivable from a single record's type. Each is established at
genesis and preserved by every event; `reachable_invariant` is the induction. -/

/-- What holds in every reachable state of one Run. -/
structure Invariant (system : RunSystem) : Prop where
  /-- The admission registry belongs to this Run. -/
  registryOwned : system.registry.run = system.run.id
  /-- Every Turn in the table belongs to this Run. -/
  turnsOwned : ∀ turn ∈ system.turns, turn.run = system.run.id
  /-- No two Turns share an identity, so no durable Turn record has two owners. -/
  turnsUnique : (system.turns.map Turn.id).Nodup
  /-- Admission is open exactly while the Run is active. -/
  admissionOpenIffActive : system.registry.«open» = true ↔ system.run.terminal = none
  /-- A Run that has ended captured everything it still owed. -/
  captureCoversFrontier : ∀ snapshot, system.run.terminal = some snapshot →
    ∀ obligation ∈ system.registry.frontier,
      obligation ∈ snapshot.obligation.obligations
  /-- A Run that has ended holds no live Turn (SPEC §5.2's sibling condition). -/
  terminalHasNoLiveTurn : system.run.terminal.isSome = true →
    ∀ turn ∈ system.turns, turn.status.isTerminal = true
  /-- Every commit in the log was admitted by the §5.2 matrix, on kind and on subject. -/
  commitsAdmitted : ∀ commit ∈ system.commits,
    commit.writer.admits commit.kind = true ∧
      subjectAdmits commit.writer commit.subjectTurn = true

/-- **A terminal Run holds no lease anywhere.** The record's own `restingUnheld` turns the
invariant's terminality into unheldness, so the two halves of §5.2's sibling condition —
terminal *and* unheld — are one fact and a reachable state satisfies both. -/
theorem Invariant.terminalHoldsNoLease {system : RunSystem} (invariant : Invariant system)
    (ended : system.run.terminal.isSome = true) :
    ∀ turn ∈ system.turns, turn.status.isTerminal = true ∧ turn.lease.holder = none := by
  intro turn member
  have terminal := invariant.terminalHasNoLiveTurn ended turn member
  exact ⟨terminal, Turn.terminal_is_unheld turn terminal⟩

/-- The invariant transfers across a step that moves only the Run record, keeping its
identity and its terminal snapshot. Seven of the nineteen events are exactly this. -/
theorem Invariant.ofRunMutation {before after : RunSystem} (invariant : Invariant before)
    (registry : after.registry = before.registry) (turns : after.turns = before.turns)
    (commits : after.commits = before.commits) (id : after.run.id = before.run.id)
    (terminal : after.run.terminal = before.run.terminal) : Invariant after where
  registryOwned := by rw [registry, id]; exact invariant.registryOwned
  turnsOwned := by rw [turns, id]; exact invariant.turnsOwned
  turnsUnique := by rw [turns]; exact invariant.turnsUnique
  admissionOpenIffActive := by rw [registry, terminal]; exact invariant.admissionOpenIffActive
  captureCoversFrontier := by rw [registry, terminal]; exact invariant.captureCoversFrontier
  terminalHasNoLiveTurn := by rw [turns, terminal]; exact invariant.terminalHasNoLiveTurn
  commitsAdmitted := by rw [commits]; exact invariant.commitsAdmitted

/-- The invariant transfers across a Turn transition, given the two facts every Turn
transition has: it re-parents nothing, and it cannot revive a Turn that has ended. -/
theorem Invariant.ofTurnTransition {before after : RunSystem} {id : TextId .turn}
    {transition : Turn → Outcome Turn} (invariant : Invariant before)
    (identity : ∀ turn next, transition turn = .ok next → next.run = turn.run)
    (terminality : ∀ turn next, transition turn = .ok next →
      turn.status.isTerminal = true → next.status.isTerminal = true)
    (stepped : before.onTurn id transition = .ok after) : Invariant after := by
  obtain ⟨turn, next, found, moved, shape⟩ := onTurn_shape stepped
  have held : turn ∈ before.turns := (turnById_found found).1
  have owned : next.run = before.run.id := by
    rw [identity turn next moved]
    exact invariant.turnsOwned turn held
  subst shape
  refine
    { registryOwned := invariant.registryOwned
      turnsOwned := ?_
      turnsUnique := ?_
      admissionOpenIffActive := invariant.admissionOpenIffActive
      captureCoversFrontier := invariant.captureCoversFrontier
      terminalHasNoLiveTurn := ?_
      commitsAdmitted := invariant.commitsAdmitted }
  · intro candidate member
    rcases mem_replaceTurn member with replacement | existing
    · rw [replacement]; exact owned
    · exact invariant.turnsOwned candidate existing
  · show ((before.replaceTurn next).map Turn.id).Nodup
    rw [replaceTurn_ids]
    exact invariant.turnsUnique
  · intro ended candidate member
    rcases mem_replaceTurn member with replacement | existing
    · rw [replacement]
      exact terminality turn next moved (invariant.terminalHasNoLiveTurn ended turn held)
    · exact invariant.terminalHasNoLiveTurn ended candidate existing

/-! ## Terminalization, decomposed

The one event built out of several kernel operations. Everything the induction needs from it
is here, so the case below reads as an application rather than as a second proof. -/

/-- **A terminalization closes admission, captures the frontier, quiesces the Turn table, and
leaves everything else alone.** -/
theorem step_terminalize_shape {before after : RunSystem} {turn : TextId .turn}
    {preterminal terminalCommit : TextId .runCommit} {outcome : TerminalOutcome}
    {exhausted : Option ResourceDimension} {cancellations : List RunInvocationDelivery}
    (stepped : before.step (.terminalize turn preterminal terminalCommit outcome exhausted
      cancellations) = .ok after) :
    ∃ closed snapshot, before.registry.close = .ok closed ∧
      snapshot.obligation.obligations = sortedByKey before.registry.frontier ∧
      before.run.terminalize snapshot cancellations = .ok after.run ∧
      after.registry = closed ∧ after.turns = before.turns ∧ after.commits = before.commits ∧
      after.remainder = before.remainder ∧
      ∀ candidate ∈ before.turns,
        candidate.status.isTerminal = true ∧ candidate.lease.holder.isNone = true := by
  simp only [step] at stepped
  split at stepped
  · rename_i quiesced
    split at stepped
    · cases stepped
    · split at stepped
      · cases stepped
      · rename_i closed closing
        split at stepped
        · split at stepped
          · split at stepped
            · cases stepped
            · rename_i snapshot built
              split at stepped
              · cases stepped
              · rename_i run ended
                simp only [Except.ok.injEq] at stepped
                subst stepped
                refine ⟨closed, snapshot, closing, ?_, ended, rfl, rfl, rfl, rfl, ?_⟩
                · rw [(terminalSnapshot_shape built).2.1]
                · intro candidate member
                  exact (Bool.and_eq_true _ _).mp
                    (List.all_eq_true.mp quiesced candidate member)
          · cases stepped
        · cases stepped
  · cases stepped

/-! ## The induction

`Invariant` holds at genesis and is preserved by every one of the nineteen events, so it
holds in every reachable state. The case analysis below is exhaustive by construction: an
event added to `RunEvent` without a case here fails to elaborate. -/

/-- **The invariant holds where a Run begins.** -/
theorem invariant_genesis {system : RunSystem} (start : Genesis system) : Invariant system where
  registryOwned := by rw [start.registryInitial]; rfl
  turnsOwned := by rw [start.noTurns]; intro turn member; simp at member
  turnsUnique := by rw [start.noTurns]; simp
  admissionOpenIffActive := by
    rw [start.registryInitial, start.active]
    simp [RunAdmissionRegistry.initial]
  captureCoversFrontier := by
    intro snapshot ended
    exact absurd (start.active.symm.trans ended) (by simp)
  terminalHasNoLiveTurn := by
    intro ended
    exact absurd (start.active ▸ ended) (by simp)
  commitsAdmitted := by rw [start.noCommits]; intro commit member; simp at member

/-- **Every event preserves the invariant.** -/
theorem invariant_step {before after : RunSystem} (invariant : Invariant before)
    {event : RunEvent} (stepped : before.step event = .ok after) : Invariant after := by
  cases event with
  | tick elapsed =>
      simp only [step, Except.ok.injEq] at stepped
      subst stepped
      exact invariant.ofRunMutation rfl rfl rfl rfl rfl
  | revise =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.revise_shape moved
        exact invariant.ofRunMutation rfl rfl rfl id terminal
  | recordEvidence =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.recordEvidence_shape moved
        exact invariant.ofRunMutation rfl rfl rfl id terminal
  | admitTurn turn =>
      simp only [step] at stepped
      split at stepped
      · rename_i admits
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨owned, fresh, _, active⟩ := admitsTurn_shape admits
        have noSnapshot : before.run.terminal = none := Run.active_of_not_terminal active
        refine
          { registryOwned := invariant.registryOwned
            turnsOwned := ?_
            turnsUnique := ?_
            admissionOpenIffActive := invariant.admissionOpenIffActive
            captureCoversFrontier := invariant.captureCoversFrontier
            terminalHasNoLiveTurn := ?_
            commitsAdmitted := invariant.commitsAdmitted }
        · intro candidate member
          rcases List.mem_cons.mp member with hit | existing
          · rw [hit]; exact owned
          · exact invariant.turnsOwned candidate existing
        · show ((turn :: before.turns).map Turn.id).Nodup
          refine List.nodup_cons.mpr ⟨?_, invariant.turnsUnique⟩
          intro member
          obtain ⟨candidate, candidateMember, candidateId⟩ := List.mem_map.mp member
          exact turnById_none fresh candidate candidateMember candidateId
        · intro ended
          exact absurd (noSnapshot ▸ ended) (by simp)
      · cases stepped
  | claimTurn id holder expiresAt =>
      simp only [step] at stepped
      refine invariant.ofTurnTransition ?_ ?_ stepped
      · intro turn next moved
        exact (Turn.claim_preserves_identity moved).2
      · intro turn next moved ended
        rw [TurnStatus.claimable_not_terminal (Turn.claim_requires_claimable moved)] at ended
        exact absurd ended (by simp)
  | renewTurn token expiresAt =>
      simp only [step] at stepped
      refine invariant.ofTurnTransition ?_ ?_ stepped
      · intro turn next moved
        exact (Turn.renew_preserves_identity moved).2
      · intro turn next moved ended
        rw [Turn.requireToken_not_terminal (Turn.renew_requires_token moved)] at ended
        exact absurd ended (by simp)
  | reclaimTurn id holder expiresAt =>
      simp only [step] at stepped
      refine invariant.ofTurnTransition ?_ ?_ stepped
      · intro turn next moved
        exact (Turn.reclaim_preserves_identity moved).2
      · intro turn next moved ended
        rw [Turn.reclaim_requires_running moved] at ended
        exact absurd ended (by decide)
  | suspendTurn token checkpoint =>
      simp only [step] at stepped
      refine invariant.ofTurnTransition ?_ ?_ stepped
      · intro turn next moved
        exact (Turn.suspend_preserves_identity moved).2
      · intro turn next moved ended
        rw [Turn.requireToken_not_terminal (Turn.suspend_requires_token moved)] at ended
        exact absurd ended (by simp)
  | completeTurn token outcome result =>
      simp only [step] at stepped
      refine invariant.ofTurnTransition ?_ ?_ stepped
      · intro turn next moved
        exact (Turn.complete_preserves_identity moved).2
      · intro turn next moved ended
        rw [Turn.requireToken_not_terminal (Turn.complete_requires_token moved)] at ended
        exact absurd ended (by simp)
  | cancelTurn id =>
      simp only [step] at stepped
      refine invariant.ofTurnTransition ?_ ?_ stepped
      · intro turn next moved
        exact (Turn.cancelUnheld_preserves_identity moved).2
      · intro turn next moved ended
        rw [TurnStatus.claimable_not_terminal
          (Turn.cancelUnheld_requires_claimable moved)] at ended
        exact absurd ended (by simp)
  | forceCancelTurn id cause =>
      simp only [step] at stepped
      refine invariant.ofTurnTransition ?_ ?_ stepped
      · intro turn next moved
        exact (Turn.forceCancel_preserves_identity moved).2
      · intro turn next moved _
        exact Turn.forceCancel_lands_terminal moved
  | appendCommit commit =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i value admitted
        cases value
        simp only [Except.ok.injEq] at stepped
        subst stepped
        refine
          { registryOwned := invariant.registryOwned
            turnsOwned := invariant.turnsOwned
            turnsUnique := invariant.turnsUnique
            admissionOpenIffActive := invariant.admissionOpenIffActive
            captureCoversFrontier := invariant.captureCoversFrontier
            terminalHasNoLiveTurn := invariant.terminalHasNoLiveTurn
            commitsAdmitted := ?_ }
        intro candidate member
        rcases List.mem_cons.mp member with hit | existing
        · rw [hit]
          exact admitsCommit_matrix admitted
        · exact invariant.commitsAdmitted candidate existing
  | reserveObligation obligation =>
      simp only [step] at stepped
      cases reserved : before.registry.reserve obligation with
      | error fault => rw [reserved] at stepped; cases stepped
      | ok pair =>
          obtain ⟨registry, reservation⟩ := pair
          rw [reserved] at stepped
          simp only [Except.ok.injEq] at stepped
          subst stepped
          obtain ⟨owned, open', _⟩ := RunAdmissionRegistry.reserve_shape reserved
          refine
            { registryOwned := ?_
              turnsOwned := invariant.turnsOwned
              turnsUnique := invariant.turnsUnique
              admissionOpenIffActive := ?_
              captureCoversFrontier := ?_
              terminalHasNoLiveTurn := invariant.terminalHasNoLiveTurn
              commitsAdmitted := invariant.commitsAdmitted }
          · show registry.run = before.run.id
            rw [owned]
            exact invariant.registryOwned
          · show registry.«open» = true ↔ before.run.terminal = none
            rw [open']
            exact invariant.admissionOpenIffActive
          · intro snapshot ended
            have active := invariant.admissionOpenIffActive.mp
              (RunAdmissionRegistry.reserve_requires_open reserved)
            exact absurd (active.symm.trans ended) (by simp)
  | completeObligation reservation =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i registry completed
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨owned, open', _, _⟩ := RunAdmissionRegistry.complete_shape completed
        refine
          { registryOwned := ?_
            turnsOwned := invariant.turnsOwned
            turnsUnique := invariant.turnsUnique
            admissionOpenIffActive := ?_
            captureCoversFrontier := ?_
            terminalHasNoLiveTurn := invariant.terminalHasNoLiveTurn
            commitsAdmitted := invariant.commitsAdmitted }
        · show registry.run = before.run.id
          rw [owned]
          exact invariant.registryOwned
        · show registry.«open» = true ↔ before.run.terminal = none
          rw [open']
          exact invariant.admissionOpenIffActive
        · intro snapshot ended obligation member
          exact invariant.captureCoversFrontier snapshot ended obligation
            (RunAdmissionRegistry.complete_frontier_subset completed member)
  | publishDelivery delivery =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.publishDelivery_shape moved
        exact invariant.ofRunMutation rfl rfl rfl id terminal
  | acknowledgeDelivery delivery =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.acknowledgeDelivery_shape moved
        exact invariant.ofRunMutation rfl rfl rfl id terminal
  | recordConfiguration configuration =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.recordConfiguration_shape moved
        exact invariant.ofRunMutation rfl rfl rfl id terminal
  | recordUsage usage cost lineage =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.recordModelUsage_shape moved
        exact invariant.ofRunMutation rfl rfl rfl id terminal
  | terminalize turn preterminal terminalCommit outcome exhausted cancellations =>
      obtain ⟨closed, snapshot, closing, capture, ended, registry, turns, commits, _, quiesced⟩ :=
        step_terminalize_shape stepped
      have runShape := Run.terminalize_shape ended
      have active : before.run.terminal = none := Run.terminalize_requires_active ended
      have openBefore : before.registry.«open» = true :=
        invariant.admissionOpenIffActive.mpr active
      have closedShape := RunAdmissionRegistry.close_advances openBefore closing
      have frontier := RunAdmissionRegistry.close_frontier closing
      refine
        { registryOwned := ?_
          turnsOwned := ?_
          turnsUnique := ?_
          admissionOpenIffActive := ?_
          captureCoversFrontier := ?_
          terminalHasNoLiveTurn := ?_
          commitsAdmitted := ?_ }
      · rw [registry, runShape.1, (RunAdmissionRegistry.close_shape closing).1]
        exact invariant.registryOwned
      · rw [turns, runShape.1]
        exact invariant.turnsOwned
      · rw [turns]
        exact invariant.turnsUnique
      · rw [registry, closedShape.2, runShape.2]
        simp
      · rw [registry, runShape.2]
        intro candidate held obligation member
        have same : candidate = snapshot := (Option.some.inj held).symm
        rw [same, capture]
        rw [frontier] at member
        exact (mem_sortedByKey before.registry.frontier obligation).mpr member
      · rw [turns]
        intro _ candidate member
        exact (quiesced candidate member).1
      · rw [commits]
        exact invariant.commitsAdmitted

/-- **Every reachable state satisfies the invariant.** The one theorem the rest of this
module reads: genesis establishes it, every event preserves it, so no path reaches a state
that breaks it. -/
theorem reachable_invariant {system : RunSystem} (reached : Reachable system) :
    Invariant system := by
  induction reached with
  | genesis start => exact invariant_genesis start
  | step _ stepped invariant => exact invariant_step invariant stepped

/-! ## Single ownership

Three of the invariant's fields plus the two the `Run` record carries in its own type. A
Run's registry, its Turns, its snapshot, and its outbox all name this Run, and no two Turn
records share an identity — so there is no durable record of a Run with two owners, and no
identity a second record could claim. -/

/-- **No durable record of a Run has two owners.** -/
theorem single_ownership {system : RunSystem} (reached : Reachable system) :
    system.registry.run = system.run.id ∧
      (∀ turn ∈ system.turns, turn.run = system.run.id) ∧
      (system.turns.map Turn.id).Nodup ∧
      (∀ snapshot, system.run.terminal = some snapshot → snapshot.run = system.run.id) ∧
      (∀ delivery ∈ system.run.deliveries, delivery.run = system.run.id) := by
  have invariant := reachable_invariant reached
  exact ⟨invariant.registryOwned, invariant.turnsOwned, invariant.turnsUnique,
    system.run.terminalOwned, system.run.deliveriesOwned⟩

/-- **A Run that has ended holds no live Turn and no lease.** SPEC §5.2's sibling
condition, as a property of every reachable state rather than of the terminalizing step:
there is no reachable state in which a finished Run still has a Turn running or a branch
held. -/
theorem terminal_run_is_quiesced {system : RunSystem} (reached : Reachable system)
    (ended : system.run.terminal.isSome = true) :
    ∀ turn ∈ system.turns, turn.status.isTerminal = true ∧ turn.lease.holder = none :=
  (reachable_invariant reached).terminalHoldsNoLease ended

/-- **Admission is open exactly while the Run is active.** -/
theorem admission_open_iff_active {system : RunSystem} (reached : Reachable system) :
    system.registry.«open» = true ↔ system.run.terminal = none :=
  (reachable_invariant reached).admissionOpenIffActive

/-- **A Run that has ended takes on no further obligation.** The registry is closed, and a
closed registry refuses every reservation, so what a Run owes is fixed at the moment it
ends. -/
theorem terminal_run_reserves_nothing {system : RunSystem} {snapshot : TerminalSnapshot}
    {obligation : RunObligation} (reached : Reachable system)
    (ended : system.run.terminal = some snapshot) :
    (system.registry.reserve obligation).RefusedWith .runInvalidState := by
  refine RunAdmissionRegistry.reserve_refuses_closed ?_
  cases open' : system.registry.«open» with
  | false => rfl
  | true =>
      exact absurd (((reachable_invariant reached).admissionOpenIffActive.mp open').symm.trans
        ended) (by simp)

/-! ## Settlement, and the sentence that is false

`terminalization_discharges_nothing` is the refutation: ending a Run leaves its frontier
exactly as it was, so "terminalizes" and "discharges" are different verbs and no amount of
terminalizing settles anything. `settled_discharges_every_outstanding_obligation` is the
corrected property, and it is the one that matters: settlement is the decision that cannot
happen early. -/

/-- **Ending a Run discharges nothing.** The frontier after terminalization is the frontier
before it — closing admission decides what may still be taken on, never what is owed. This
is why "no Run *settles* with an outstanding obligation" is the only true reading of the
property: a Run that has ended may owe a great deal. -/
theorem terminalization_discharges_nothing {before after : RunSystem} {turn : TextId .turn}
    {preterminal terminalCommit : TextId .runCommit} {outcome : TerminalOutcome}
    {exhausted : Option ResourceDimension} {cancellations : List RunInvocationDelivery}
    (stepped : before.step (.terminalize turn preterminal terminalCommit outcome exhausted
      cancellations) = .ok after) :
    after.registry.frontier = before.registry.frontier := by
  obtain ⟨_, _, closing, _, _, registry, _, _, _, _⟩ := step_terminalize_shape stepped
  rw [registry]
  exact RunAdmissionRegistry.close_frontier closing

/-- **Ending a Run captures everything it owed.** Nothing outstanding is dropped: the
snapshot's obligation set holds every frontier obligation, which is what makes settlement
decidable from the capture alone. -/
theorem terminalization_captures_the_frontier {before after : RunSystem} {turn : TextId .turn}
    {preterminal terminalCommit : TextId .runCommit} {outcome : TerminalOutcome}
    {exhausted : Option ResourceDimension} {cancellations : List RunInvocationDelivery}
    (stepped : before.step (.terminalize turn preterminal terminalCommit outcome exhausted
      cancellations) = .ok after) :
    ∀ snapshot, after.run.terminal = some snapshot →
      ∀ obligation ∈ before.registry.frontier,
        obligation ∈ snapshot.obligation.obligations := by
  obtain ⟨_, snapshot, _, capture, ended, _, _, _, _, _⟩ := step_terminalize_shape stepped
  intro candidate held obligation member
  have same : candidate = snapshot :=
    (Option.some.inj ((Run.terminalize_shape ended).2.symm.trans held)).symm
  rw [same, capture]
  exact (mem_sortedByKey before.registry.frontier obligation).mpr member

/-- **A settled Run has discharged every obligation it still owed.** The corrected form of
"no Run settles with an outstanding obligation": `isSettled` quantifies over the capture, the
capture covers the frontier, so a Run whose capture is settled has evidence for every
outstanding obligation. A Run with an unanswered approval is therefore *unsettled*, not
settled-with-an-exception. -/
theorem settled_discharges_every_outstanding_obligation {system : RunSystem}
    {snapshot : TerminalSnapshot} {evidence : SettlementEvidence}
    (reached : Reachable system) (ended : system.run.terminal = some snapshot)
    (settled : isSettled snapshot.obligation evidence = true) :
    ∀ obligation ∈ system.registry.frontier, obligationSettled evidence obligation = true := by
  intro obligation member
  exact isSettled_obligation settled
    ((reachable_invariant reached).captureCoversFrontier snapshot ended obligation member)

/-- **A settled Run has an audit for every audit-bearing obligation it still owed.** The
audit set is derived from the capture, so a Run cannot settle on evidence it captured and
never audited. -/
theorem settled_audits_every_outstanding_obligation {system : RunSystem}
    {snapshot : TerminalSnapshot} {evidence : SettlementEvidence}
    (reached : Reachable system) (ended : system.run.terminal = some snapshot)
    (settled : isSettled snapshot.obligation evidence = true) :
    (∀ commit, RunObligation.systemCommit commit ∈ system.registry.frontier →
        evidence.auditSatisfied (.commit commit) = true) ∧
      (∀ reservation, RunObligation.route reservation ∈ system.registry.frontier →
        evidence.auditSatisfied (.delivery reservation) = true) ∧
      (∀ invocation index itemKey,
        RunObligation.invocationItem invocation index itemKey ∈ system.registry.frontier →
          evidence.auditSatisfied (.receipt invocation index itemKey) = true) := by
  have capture := (reachable_invariant reached).captureCoversFrontier snapshot ended
  refine ⟨?_, ?_, ?_⟩
  · intro commit member
    exact isSettled_audit settled
      (SettlementObligation.systemCommit_is_audited (capture _ member))
  · intro reservation member
    exact isSettled_audit settled (SettlementObligation.route_is_audited (capture _ member))
  · intro invocation index itemKey member
    exact isSettled_audit settled
      (SettlementObligation.invocationItem_is_audited (capture _ member))

/-! ## The §5.2 writer matrix -/

/-- **Every commit in the log obeys the §5.2 writer matrix.** The writer's class is the class
the matrix assigns its kind, and a Turn writer's commit names that Turn as its subject. -/
theorem appended_commits_obey_writer_matrix {system : RunSystem} (reached : Reachable system) :
    ∀ commit ∈ system.commits,
      commit.writer.class' = writerClassFor commit.kind ∧
        subjectAdmits commit.writer commit.subjectTurn = true := by
  intro commit member
  obtain ⟨admitted, subject⟩ := (reachable_invariant reached).commitsAdmitted commit member
  exact ⟨admits_determines_class admitted, subject⟩

/-- **No commit in the log has a writer of the wrong class.** Stated as the refusal a reader
reaches for: a Turn never authored a control commit, and system evidence never impersonated a
Turn. -/
theorem no_appended_commit_impersonates {system : RunSystem} (reached : Reachable system) :
    ∀ commit ∈ system.commits,
      (RunCommitKind.controlAuthored commit.kind = true →
          ∃ audit receipt, commit.writer = .system (.control audit receipt)) ∧
        (RunCommitKind.turnAuthored commit.kind = true →
          ∃ token, commit.writer = .turn token) := by
  intro commit member
  obtain ⟨admitted, _⟩ := (reachable_invariant reached).commitsAdmitted commit member
  refine ⟨?_, ?_⟩
  · intro control
    cases writer : commit.writer with
    | root =>
        rw [writer] at admitted
        simp only [CommitWriter.admits, beq_iff_eq] at admitted
        rw [admitted] at control
        exact absurd control (by decide)
    | turn token =>
        rw [writer] at admitted
        simp only [CommitWriter.admits] at admitted
        exact absurd control (by
          intro _
          exact absurd (RunCommitKind.authored_disjoint commit.kind) (by
            simp [admitted, control]))
    | system cause =>
        cases cause with
        | receipt audit receipt =>
            rw [writer] at admitted
            simp only [CommitWriter.admits, CommitWriter.causeAdmits, beq_iff_eq] at admitted
            rw [admitted] at control
            exact absurd control (by decide)
        | delivery audit reservation =>
            rw [writer] at admitted
            simp only [CommitWriter.admits, CommitWriter.causeAdmits, beq_iff_eq] at admitted
            rw [admitted] at control
            exact absurd control (by decide)
        | control audit receipt => exact ⟨audit, receipt, rfl⟩
  · intro turnKind
    cases writer : commit.writer with
    | root =>
        rw [writer] at admitted
        simp only [CommitWriter.admits, beq_iff_eq] at admitted
        rw [admitted] at turnKind
        exact absurd turnKind (by decide)
    | turn token => exact ⟨token, rfl⟩
    | system cause =>
        rw [writer] at admitted
        have systemClass : writerClassFor commit.kind = .systemWriter := by
          rw [← admits_determines_class admitted]
          rfl
        rw [(turnAuthored_iff commit.kind).mp turnKind] at systemClass
        exact absurd systemClass (by simp)

/-- **A Turn-authored commit is appended under the addressed Turn's exact current lease at
its exact current epoch.** The matrix decides which kinds a Turn may author; this is the
part the matrix cannot decide, and it is where §5.2 and §5.3 meet. -/
theorem appended_turn_commit_is_leased {before after : RunSystem} {commit : AppendedCommit}
    {token : LeaseToken} (stepped : before.step (.appendCommit commit) = .ok after)
    (writer : commit.writer = .turn token) :
    ∃ turn, before.turnById token.turn = some turn ∧ turn.status = .running ∧
      turn.lease.admits token before.now = true ∧
      turn.lease.epoch = token.epoch ∧ commit.subjectTurn = some token.turn := by
  simp only [step] at stepped
  split at stepped
  · cases stepped
  · rename_i value admitted
    cases value
    obtain ⟨turn, found, gate⟩ := admitsCommit_leased writer admitted
    have admits := Turn.requireToken_admits gate
    obtain ⟨_, _, epoch⟩ := TurnLease.admits_exact admits
    refine ⟨turn, found, Turn.requireToken_running gate, admits, epoch, ?_⟩
    have subject := (admitsCommit_matrix admitted).2
    rw [writer] at subject
    simpa [subjectAdmits] using subject

/-! ## Authority never widens

Two planes have an authority the Run lifecycle can widen, and neither of them does. The
resource remainder is one: a step may narrow a bound and may never raise one or drop one,
because dropping a bound is unbounding a dimension. The lease is the other: a step may mint a
new incarnation and may never make a retired token current again.

The §3.4 Grant plane is not modelled in this library and nothing here claims anything about
it; `AgentCore.Authority` and `AgentCore.Composed` are where that lives. -/

/-- One remainder is at most another: every bound the looser one sets, the tighter one still
sets, and no larger. Dropping a bound *is* widening, so a tighter remainder may not drop
one — which is why this is not simply a pointwise `≤` on options. -/
def CeilingAtMost (tighter looser : Option ResourceCeiling) : Prop :=
  ∀ dimension bound, ceilingAllowance looser dimension = some bound →
    ∃ narrowed, ceilingAllowance tighter dimension = some narrowed ∧ narrowed ≤ bound

theorem CeilingAtMost.refl (ceiling : Option ResourceCeiling) : CeilingAtMost ceiling ceiling :=
  fun _ bound declared => ⟨bound, declared, Nat.le_refl bound⟩

/-- **Renarrowing a remainder by what a Run spent never widens it.** Every bound the
remainder set is still set, reduced by this Run's own spending — and `depth` is untouched,
because a Run spends none of its own depth declaration. -/
theorem narrowResources_never_widens (remainder : Option ResourceCeiling)
    (usage : ResourceUsage) : CeilingAtMost (narrowResources none remainder usage) remainder := by
  intro dimension bound declared
  have narrowed : narrowedLimit none remainder usage dimension
      = some (bound - spent usage dimension false) := by
    unfold narrowedLimit
    rw [declared]
    simp [ceilingAllowance, narrowLimit]
  refine ⟨bound - spent usage dimension false, ?_, by omega⟩
  cases shape : narrowResources none remainder usage with
  | none =>
      unfold narrowResources at shape
      split at shape
      · cases shape
      · rename_i unbounded
        have present : (narrowedLimit none remainder usage dimension).isSome = true := by
          rw [narrowed]; rfl
        cases dimension <;> simp_all
  | some ceiling =>
      show ceiling.limit dimension = some (bound - spent usage dimension false)
      rw [narrowResources_limit dimension shape, narrowed]

/-! ## The frame: what one step can move

One case analysis over the nineteen events, reported as the five facts every remaining
theorem reads. Paying for the analysis once is the point: a twentieth event has to answer all
five here, and no later theorem repeats the enumeration. -/

/-- **What a step can move.** A Run's identity never moves; its terminal snapshot is
write-once; the Turn table changes only under an event that says it touches it; the resource
remainder never widens; and a closed admission never reopens. -/
theorem step_frame {before after : RunSystem} {event : RunEvent} (invariant : Invariant before)
    (stepped : before.step event = .ok after) :
    after.run.id = before.run.id ∧
      (∀ snapshot, before.run.terminal = some snapshot → after.run.terminal = some snapshot) ∧
      (event.touchesTable = false → after.turns = before.turns) ∧
      CeilingAtMost after.remainder before.remainder ∧
      (before.registry.«open» = false → after.registry.«open» = false) := by
  cases event with
  | tick elapsed =>
      simp only [step, Except.ok.injEq] at stepped
      subst stepped
      exact ⟨rfl, fun _ ended => ended, fun _ => rfl, CeilingAtMost.refl _, fun closed => closed⟩
  | revise =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.revise_shape moved
        exact ⟨id, fun _ ended => terminal.trans ended, fun _ => rfl, CeilingAtMost.refl _,
          fun closed => closed⟩
  | recordEvidence =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.recordEvidence_shape moved
        exact ⟨id, fun _ ended => terminal.trans ended, fun _ => rfl, CeilingAtMost.refl _,
          fun closed => closed⟩
  | admitTurn turn =>
      simp only [step] at stepped
      split at stepped
      · simp only [Except.ok.injEq] at stepped
        subst stepped
        exact ⟨rfl, fun _ ended => ended, fun quiet => absurd quiet (by simp [RunEvent.touchesTable]),
          CeilingAtMost.refl _, fun closed => closed⟩
      · cases stepped
  | claimTurn id holder expiresAt =>
      simp only [step] at stepped
      obtain ⟨_, next, _, _, shape⟩ := onTurn_shape stepped
      subst shape
      exact ⟨rfl, fun _ ended => ended, fun quiet => absurd quiet (by simp [RunEvent.touchesTable]),
        CeilingAtMost.refl _, fun closed => closed⟩
  | renewTurn token expiresAt =>
      simp only [step] at stepped
      obtain ⟨_, next, _, _, shape⟩ := onTurn_shape stepped
      subst shape
      exact ⟨rfl, fun _ ended => ended, fun quiet => absurd quiet (by simp [RunEvent.touchesTable]),
        CeilingAtMost.refl _, fun closed => closed⟩
  | reclaimTurn id holder expiresAt =>
      simp only [step] at stepped
      obtain ⟨_, next, _, _, shape⟩ := onTurn_shape stepped
      subst shape
      exact ⟨rfl, fun _ ended => ended, fun quiet => absurd quiet (by simp [RunEvent.touchesTable]),
        CeilingAtMost.refl _, fun closed => closed⟩
  | suspendTurn token checkpoint =>
      simp only [step] at stepped
      obtain ⟨_, next, _, _, shape⟩ := onTurn_shape stepped
      subst shape
      exact ⟨rfl, fun _ ended => ended, fun quiet => absurd quiet (by simp [RunEvent.touchesTable]),
        CeilingAtMost.refl _, fun closed => closed⟩
  | completeTurn token outcome result =>
      simp only [step] at stepped
      obtain ⟨_, next, _, _, shape⟩ := onTurn_shape stepped
      subst shape
      exact ⟨rfl, fun _ ended => ended, fun quiet => absurd quiet (by simp [RunEvent.touchesTable]),
        CeilingAtMost.refl _, fun closed => closed⟩
  | cancelTurn id =>
      simp only [step] at stepped
      obtain ⟨_, next, _, _, shape⟩ := onTurn_shape stepped
      subst shape
      exact ⟨rfl, fun _ ended => ended, fun quiet => absurd quiet (by simp [RunEvent.touchesTable]),
        CeilingAtMost.refl _, fun closed => closed⟩
  | forceCancelTurn id cause =>
      simp only [step] at stepped
      obtain ⟨_, next, _, _, shape⟩ := onTurn_shape stepped
      subst shape
      exact ⟨rfl, fun _ ended => ended, fun quiet => absurd quiet (by simp [RunEvent.touchesTable]),
        CeilingAtMost.refl _, fun closed => closed⟩
  | appendCommit commit =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · simp only [Except.ok.injEq] at stepped
        subst stepped
        exact ⟨rfl, fun _ ended => ended, fun _ => rfl, CeilingAtMost.refl _,
          fun closed => closed⟩
  | reserveObligation obligation =>
      simp only [step] at stepped
      cases reserved : before.registry.reserve obligation with
      | error fault => rw [reserved] at stepped; cases stepped
      | ok pair =>
          obtain ⟨registry, reservation⟩ := pair
          rw [reserved] at stepped
          simp only [Except.ok.injEq] at stepped
          subst stepped
          refine ⟨rfl, fun _ ended => ended, fun _ => rfl, CeilingAtMost.refl _, ?_⟩
          intro closed
          rw [RunAdmissionRegistry.reserve_requires_open reserved] at closed
          exact absurd closed (by simp)
  | completeObligation reservation =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i registry completed
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨_, open', _, _⟩ := RunAdmissionRegistry.complete_shape completed
        refine ⟨rfl, fun _ ended => ended, fun _ => rfl, CeilingAtMost.refl _, ?_⟩
        intro closed
        show registry.«open» = false
        rw [open']
        exact closed
  | publishDelivery delivery =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.publishDelivery_shape moved
        exact ⟨id, fun _ ended => terminal.trans ended, fun _ => rfl, CeilingAtMost.refl _,
          fun closed => closed⟩
  | acknowledgeDelivery delivery =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.acknowledgeDelivery_shape moved
        exact ⟨id, fun _ ended => terminal.trans ended, fun _ => rfl, CeilingAtMost.refl _,
          fun closed => closed⟩
  | recordConfiguration configuration =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.recordConfiguration_shape moved
        exact ⟨id, fun _ ended => terminal.trans ended, fun _ => rfl, CeilingAtMost.refl _,
          fun closed => closed⟩
  | recordUsage usage cost lineage =>
      simp only [step] at stepped
      split at stepped
      · cases stepped
      · rename_i run moved
        simp only [Except.ok.injEq] at stepped
        subst stepped
        obtain ⟨id, terminal⟩ := Run.recordModelUsage_shape moved
        exact ⟨id, fun _ ended => terminal.trans ended, fun _ => rfl,
          narrowResources_never_widens before.remainder usage, fun closed => closed⟩
  | terminalize turn preterminal terminalCommit outcome exhausted cancellations =>
      obtain ⟨_, _, closing, _, ended, _, turns, _, remainder, _⟩ :=
        step_terminalize_shape stepped
      have active : before.run.terminal = none := Run.terminalize_requires_active ended
      refine ⟨(Run.terminalize_shape ended).1, ?_, fun _ => turns, ?_, ?_⟩
      · intro snapshot held
        exact absurd (active.symm.trans held) (by simp)
      · rw [remainder]
        exact CeilingAtMost.refl _
      · intro closed
        rw [invariant.admissionOpenIffActive.mpr active] at closed
        exact absurd closed (by simp)

/-- **A Run's terminal snapshot is write-once.** Nothing clears it and nothing replaces it,
so a Run that has ended stays ended with the snapshot it ended on. -/
theorem step_keeps_snapshot {before after : RunSystem} {event : RunEvent}
    {snapshot : TerminalSnapshot} (invariant : Invariant before)
    (stepped : before.step event = .ok after) (ended : before.run.terminal = some snapshot) :
    after.run.terminal = some snapshot :=
  (step_frame invariant stepped).2.1 snapshot ended

/-- **No step widens the resource remainder.** -/
theorem step_never_widens_remainder {before after : RunSystem} {event : RunEvent}
    (invariant : Invariant before) (stepped : before.step event = .ok after) :
    CeilingAtMost after.remainder before.remainder :=
  (step_frame invariant stepped).2.2.2.1

/-- **A closed admission never reopens.** -/
theorem step_never_reopens_admission {before after : RunSystem} {event : RunEvent}
    (invariant : Invariant before) (stepped : before.step event = .ok after)
    (closed : before.registry.«open» = false) : after.registry.«open» = false :=
  (step_frame invariant stepped).2.2.2.2 closed

/-- **An event that does not touch the Turn table mutates no Turn.** -/
theorem step_keeps_table {before after : RunSystem} {event : RunEvent}
    (invariant : Invariant before) (stepped : before.step event = .ok after)
    (quiet : event.touchesTable = false) : after.turns = before.turns :=
  (step_frame invariant stepped).2.2.1 quiet

/-! ## §5.3 fencing: which mutations are authorized, and what they do to the incarnation

The property the informal sentence reaches for — "no Turn mutates without a current lease at
the exact epoch" — is false for four of the seven Turn transitions, and the corrected one is
below. Both halves come out of one case analysis over the alphabet, because a second
enumeration is a second place a twentieth event could hide. -/

/-- **A Turn step's effect is the transition applied to the Turn it addressed.** Every other
identity in the table is untouched, so a step that changed the Turn under some identity
changed exactly the addressed one. -/
theorem onTurn_mutation {before after : RunSystem} {target id : TextId .turn}
    {transition : Turn → Outcome Turn} {pre post : Turn}
    (stepped : before.onTurn target transition = .ok after)
    (identity : ∀ turn next, transition turn = .ok next → next.id = turn.id)
    (held : before.turnById id = some pre) (kept : after.turnById id = some post)
    (changed : post ≠ pre) : transition pre = .ok post := by
  obtain ⟨turn, next, found, moved, shape⟩ := onTurn_shape stepped
  subst shape
  simp only [withTurn] at kept
  have named : next.id = turn.id := identity turn next moved
  have addressed : turn.id = target := (turnById_found found).2
  by_cases hit : id = next.id
  · have lookup : before.turnById id = some turn := by
      rw [hit, named, addressed]
      exact found
    have preSame : pre = turn := (Option.some.inj (lookup.symm.trans held)).symm
    have installed : ({ before with turns := before.replaceTurn next } : RunSystem).turnById id
        = some next := by
      rw [hit]
      exact turnById_replaceTurn_hit (by rw [named, addressed]; exact found)
    have postSame : post = next := (Option.some.inj (installed.symm.trans kept)).symm
    rw [preSame, postSame]
    exact moved
  · rw [turnById_replaceTurn_other hit, held] at kept
    exact absurd (Option.some.inj kept).symm changed

/-- **Every Turn mutation is authorized, and every one either keeps the incarnation or
advances it.**

The first half is the corrected form of "no Turn mutates without a current lease at the exact
epoch". A mutation either

* presents the exact current token — the Turn's own lease admits it, at exactly the lease's
  epoch and for exactly this Turn — which is `renew`, `suspend`, and `complete`; or
* advances the epoch, and then one of three things was true: the Turn held nothing
  (`claim`, `cancelUnheld`), its term had already elapsed (`reclaim`), or the event named the
  control evidence it stands on (`forceCancel`, SPEC §5.2 forced cancellation).

The second half is what fencing buys: the epoch and holder move together or the epoch
strictly advances, so no step transfers a Turn to a new holder inside one incarnation and no
retired token is ever current again. -/
theorem turn_mutation_is_authorized {before after : RunSystem} {event : RunEvent}
    {id : TextId .turn} {pre post : Turn} (invariant : Invariant before)
    (stepped : before.step event = .ok after)
    (held : before.turnById id = some pre) (kept : after.turnById id = some post)
    (changed : post ≠ pre) :
    ((∃ token, event.executorToken = some token ∧
          pre.lease.admits token before.now = true ∧
          pre.lease.epoch = token.epoch ∧ pre.lease.turn = token.turn) ∨
        (pre.lease.epoch < post.lease.epoch ∧
          (pre.lease.holder = none ∨ pre.lease.expiredHeld before.now = true ∨
            event.systemCause.isSome = true))) ∧
      ((post.lease.epoch = pre.lease.epoch ∧ post.lease.holder = pre.lease.holder) ∨
        pre.lease.epoch < post.lease.epoch) := by
  by_cases quiet : event.touchesTable = false
  · have lookup : after.turnById id = some pre :=
      (turnById_congr (step_keeps_table invariant stepped quiet) id).trans held
    exact absurd (Option.some.inj (kept.symm.trans lookup)) changed
  · cases event with
    | tick elapsed => simp [RunEvent.touchesTable] at quiet
    | revise => simp [RunEvent.touchesTable] at quiet
    | recordEvidence => simp [RunEvent.touchesTable] at quiet
    | appendCommit commit => simp [RunEvent.touchesTable] at quiet
    | reserveObligation obligation => simp [RunEvent.touchesTable] at quiet
    | completeObligation reservation => simp [RunEvent.touchesTable] at quiet
    | publishDelivery delivery => simp [RunEvent.touchesTable] at quiet
    | acknowledgeDelivery delivery => simp [RunEvent.touchesTable] at quiet
    | recordConfiguration configuration => simp [RunEvent.touchesTable] at quiet
    | recordUsage usage cost lineage => simp [RunEvent.touchesTable] at quiet
    | terminalize turn preterminal terminalCommit outcome exhausted cancellations =>
        simp [RunEvent.touchesTable] at quiet
    | admitTurn turn =>
        simp only [step] at stepped
        split at stepped
        · rename_i admits
          simp only [Except.ok.injEq] at stepped
          subst stepped
          obtain ⟨_, fresh, _, _⟩ := admitsTurn_shape admits
          have other : turn.id ≠ id := by
            intro same
            rw [same] at fresh
            rw [fresh] at held
            cases held
          rw [turnById_cons_of_ne other, held] at kept
          exact absurd (Option.some.inj kept).symm changed
        · cases stepped
    | claimTurn target holder expiresAt =>
        simp only [step] at stepped
        have moved := onTurn_mutation stepped
          (fun _ _ transitioned => (Turn.claim_preserves_identity transitioned).1) held kept
          changed
        have advanced := Turn.claim_advances_epoch moved
        exact ⟨.inr ⟨advanced,
          .inl (Turn.claimable_is_unheld (Turn.claim_requires_claimable moved))⟩, .inr advanced⟩
    | renewTurn token expiresAt =>
        simp only [step] at stepped
        have moved := onTurn_mutation stepped
          (fun _ _ transitioned => (Turn.renew_preserves_identity transitioned).1) held kept
          changed
        have admits := Turn.requireToken_admits (Turn.renew_requires_token moved)
        obtain ⟨turnSame, _, epochSame⟩ := TurnLease.admits_exact admits
        exact ⟨.inl ⟨token, rfl, admits, epochSame, turnSame⟩,
          .inl (Turn.renew_keeps_incarnation moved)⟩
    | reclaimTurn target holder expiresAt =>
        simp only [step] at stepped
        have moved := onTurn_mutation stepped
          (fun _ _ transitioned => (Turn.reclaim_preserves_identity transitioned).1) held kept
          changed
        have advanced := Turn.reclaim_advances_epoch moved
        exact ⟨.inr ⟨advanced, .inr (.inl (Turn.reclaim_requires_expired moved))⟩, .inr advanced⟩
    | suspendTurn token checkpoint =>
        simp only [step] at stepped
        have moved := onTurn_mutation stepped
          (fun _ _ transitioned => (Turn.suspend_preserves_identity transitioned).1) held kept
          changed
        have admits := Turn.requireToken_admits (Turn.suspend_requires_token moved)
        obtain ⟨turnSame, _, epochSame⟩ := TurnLease.admits_exact admits
        exact ⟨.inl ⟨token, rfl, admits, epochSame, turnSame⟩,
          .inr (Turn.suspend_advances_epoch moved)⟩
    | completeTurn token outcome result =>
        simp only [step] at stepped
        have moved := onTurn_mutation stepped
          (fun _ _ transitioned => (Turn.complete_preserves_identity transitioned).1) held kept
          changed
        have admits := Turn.requireToken_admits (Turn.complete_requires_token moved)
        obtain ⟨turnSame, _, epochSame⟩ := TurnLease.admits_exact admits
        exact ⟨.inl ⟨token, rfl, admits, epochSame, turnSame⟩,
          .inr (Turn.complete_advances_epoch moved)⟩
    | cancelTurn target =>
        simp only [step] at stepped
        have moved := onTurn_mutation stepped
          (fun _ _ transitioned => (Turn.cancelUnheld_preserves_identity transitioned).1) held
          kept changed
        have advanced := Turn.cancelUnheld_advances_epoch moved
        exact ⟨.inr ⟨advanced,
          .inl (Turn.claimable_is_unheld (Turn.cancelUnheld_requires_claimable moved))⟩,
          .inr advanced⟩
    | forceCancelTurn target cause =>
        simp only [step] at stepped
        have moved := onTurn_mutation stepped
          (fun _ _ transitioned => (Turn.forceCancel_preserves_identity transitioned).1) held
          kept changed
        rcases Turn.forceCancel_incarnation moved with same | advanced
        · exact absurd same changed
        · exact ⟨.inr ⟨advanced, .inr (.inr rfl)⟩, .inr advanced⟩

/-- **A step keeps a Turn's incarnation or advances its epoch.** -/
theorem step_lease_incarnation {before after : RunSystem} {event : RunEvent}
    {id : TextId .turn} {pre post : Turn} (invariant : Invariant before)
    (stepped : before.step event = .ok after)
    (held : before.turnById id = some pre) (kept : after.turnById id = some post) :
    (post.lease.epoch = pre.lease.epoch ∧ post.lease.holder = pre.lease.holder) ∨
      pre.lease.epoch < post.lease.epoch := by
  by_cases changed : post = pre
  · exact .inl ⟨by rw [changed], by rw [changed]⟩
  · exact (turn_mutation_is_authorized invariant stepped held kept changed).2

/-- **No step widens a Turn's lease authority.** Whatever token the post-state admits, either
it was the pre-state's own incarnation — same epoch, same holder, so at most the term was
extended by its own holder — or its epoch is strictly beyond the pre-state's, which only a
`claim`, a `reclaim`, or a fence can mint. A token retired by a fence is therefore never
current again, at any later state. -/
theorem lease_authority_never_widens {before after : RunSystem} {event : RunEvent}
    {id : TextId .turn} {pre post : Turn} {token : LeaseToken} {now : Millis}
    (invariant : Invariant before) (stepped : before.step event = .ok after)
    (held : before.turnById id = some pre) (kept : after.turnById id = some post)
    (admitted : post.lease.admits token now = true) :
    (pre.lease.epoch = token.epoch ∧ pre.lease.holder = some token.holder) ∨
      pre.lease.epoch < token.epoch := by
  obtain ⟨_, holder, epoch⟩ := TurnLease.admits_exact admitted
  rcases step_lease_incarnation invariant stepped held kept with ⟨epochSame, holderSame⟩ | advanced
  · exact .inl ⟨epochSame.symm.trans epoch, holderSame.symm.trans holder⟩
  · exact .inr (epoch ▸ advanced)

end RunSystem

end AgentCore.Kernel
