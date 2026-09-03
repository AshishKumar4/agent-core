# Assurance: safety, liveness, and total correctness over the Run lifecycle

`AgentCore.Kernel.Runs` proves each record's own operation contracts. `Turn.claim` lands
running and held; `Run.terminalize` lands terminal; `RunAdmissionRegistry.close` advances the
epoch. Every one of those is a property of one operation applied to one record, and there is a
class of property they structurally cannot reach: anything about *every reachable state* of a
Run. A state is not one record — it is a Run together with its admission registry, its Turns,
and its commit log — and the failures that matter are disagreements between them. A Run that
ended while its registry stayed open. A commit whose writer is nobody's current lease. Two
records claiming one Turn identity. A Run that settles while it still owes something.

`AgentCore.Kernel.Assurance` is the layer that can state those. Five modules under
`AgentCore/Kernel/Assurance/`:

| Module | What it holds |
|---|---|
| `System` | `RunSystem`, the closed 19-move alphabet `RunEvent`, the total `step`, and `Reachable` |
| `Shape` | what each kernel transition leaves behind, and each guard read back off its success |
| `Safety` | the invariant, its induction, and the five named safety properties |
| `Liveness` | enabling results, deadlock freedom, and progress under named fairness |
| `Correctness` | total correctness of all nineteen operations and of the composite step |

Two design decisions carry the weight.

**`RunSystem` carries no `Prop` fields.** Every cross-record fact it could have asserted — the
registry belongs to this Run, no two Turns share an identity, a terminal Run's admission is
closed — is proved by induction over `step` instead. A fact carried by the type is a fact the
transition relation was never asked to establish, and an invariant that cannot fail is an
invariant that says nothing.

**The event alphabet is closed and the step is one total function.** `step` calls the kernel's
own operations and adds only the bookkeeping no single record can hold: which Turn an event
addresses, whether that identity is already taken, and whether the writer of a Turn-authored
commit holds the addressed Turn's current lease. It introduces no second decision — where a
kernel operation refuses, the step propagates that refusal unchanged. A twentieth operation
added to the kernel without an event here fails to appear in the relation rather than silently
escaping it, and cannot be admitted without extending every proof below.

## Safety: what holds in every reachable state

`RunSystem.reachable_invariant` is the induction; the seven fields of `Invariant` are what it
establishes. The five properties, and the two that are false as informally stated:

**No durable record has two owners.** True as stated. `Invariant.registryOwned`,
`turnsOwned`, and `turnsUnique`, collected with the `Run` record's own `terminalOwned` and
`deliveriesOwned` in `single_ownership`: a Run's registry, its Turns, its terminal snapshot,
and its outbox all name this Run, and no two Turn records share an identity.

**No commit violates the SPEC §5.2 writer matrix.** True as stated.
`appended_commits_obey_writer_matrix` says every commit in the log has the writer class the
matrix assigns its kind and names its subject Turn correctly.
`no_appended_commit_impersonates` states the two directions a reader reaches for: a
control-authored commit's writer is a system writer standing on control evidence, and a
Turn-authored commit's writer is a Turn token. `appended_turn_commit_is_leased` closes the
part the matrix alone cannot decide — a Turn-authored commit is appended only under the
addressed Turn's exact current lease at its exact current epoch, which is where §5.2 and §5.3
meet.

**Authority never widens.** True as stated, in the two senses the Run lifecycle has.
`step_never_widens_remainder`: no step raises a resource bound *or drops one* — dropping a
bound unbounds a dimension, which is why `CeilingAtMost` is not a pointwise `≤` on options.
`lease_authority_never_widens`: whatever token the post-state admits was either the
pre-state's own incarnation (same epoch, same holder — at most its term was extended by its
own holder) or carries a strictly later epoch, which only a claim, a reclaim, or a fence can
mint. A token retired by a fence is therefore never current again at any later state.
`step_never_reopens_admission` is the third monotonicity: a closed admission never reopens.
The §3.4 Grant plane is not modelled in this library and nothing here claims anything about
it.

**No Run settles with an outstanding obligation — false as stated.** If *settles* is read as
*terminalizes*, this is false, and it is false by design.
`terminalization_discharges_nothing` proves the frontier after terminalization is the frontier
before it: closing admission decides what may still be *taken on*, never what is owed.
Terminalizing with obligations outstanding is the ordinary path — SPEC §5.6 exists to describe
it and `TerminalSnapshot.obligation` is where those obligations go. The corrected statement is
`settled_discharges_every_outstanding_obligation`: because the capture covers the frontier
(`Invariant.captureCoversFrontier`, and `terminalization_captures_the_frontier` for the step
that establishes it), a Run whose own capture is `isSettled` has evidence for every obligation
it still owed. `settled_audits_every_outstanding_obligation` is the same for the derived
audits. A Run with an unanswered approval is therefore *unsettled*, not
settled-with-an-exception.

**No Turn mutates without a current lease at the exact epoch — false as stated.** False for
four of the seven Turn transitions, and again by design: `claim` mints the first token,
`reclaim` takes over an expired lease with a *new* holder, `cancelUnheld` cancels a Turn that
holds nothing, and `forceCancel` is system-authored on control evidence (SPEC §5.2 forced
cancellation). The corrected statement is `turn_mutation_is_authorized`: every Turn mutation
either

* presents the exact current token — the Turn's own lease admits it, at exactly the lease's
  epoch, for exactly this Turn — which is `renew`, `suspend`, and `complete`; or
* advances the epoch, and then one of three things was true: the Turn held nothing (`claim`,
  `cancelUnheld` — `Turn.claimable_is_unheld` proves a claimable Turn is unheld, so neither
  ever takes a lease from a holder), its term had already elapsed (`reclaim`), or the event
  named the control evidence it stands on (`forceCancel`).

The second half of the same theorem is what fencing buys: the epoch and holder move together
or the epoch strictly advances, so no step transfers a Turn to a new holder inside one
incarnation. What the informal sentence was reaching for is that no mutation *keeps* an
incarnation it was not entitled to, and that is what is proved.

Two further invariant fields are worth naming because they are the ones a per-record contract
cannot state at all: `admissionOpenIffActive` (admission is open exactly while the Run is
active, so a terminal Run reserves nothing — `terminal_run_reserves_nothing`) and
`terminalHasNoLiveTurn`, which with `Turn.terminal_is_unheld` gives SPEC §5.2's sibling
condition as a property of every reachable state: `terminal_run_is_quiesced`. There is no
reachable state in which a finished Run still has a Turn running or a branch held.

## Liveness: under which premises

Safety is proved against an adversary; liveness cannot be. A transition system that never
takes a step satisfies every safety property above and finishes nothing, so a progress result
has to say what the world is assumed to do. Three kinds of hypothesis, all named, none hidden
inside a proof.

**Fairness** (`Liveness.Fairness`, over a `Trace`). Two fields:

* `wakeupScheduled` — weak fairness of the wakeup: if a debt-reducing step is enabled at every
  state from some index on, one is taken. This is the trace-level reading of
  `Substrate.Premise.alarmEventuallyFires` for the alarm-driven steps and of
  `.queueAtLeastOnceDelivery` for the acknowledgement of an owed message.
* `workEventuallyCeases` — from some index on, no event takes on work the Run did not already
  owe. This is **not** a substrate premise and does not pretend to be: a Run that admits a new
  Turn, a new obligation, or a new owed message forever is an infinitely long Run, and no
  premise about any substrate makes one finish.

`fairnessPremises_are_progress` proves both substrate tags are `PremiseKind.progress`, and
`Substrate.Premise.progress_is_exactly_eventual` says those two are the only progress premises
in the closed vocabulary — so no safety premise leaked into the fairness set.

**Headroom** (`Liveness.Headroom`). Every kernel counter is a safe integer and every transition
refuses at the ceiling rather than wrapping: `Revision.next` with
`protocol.revision-conflict`, `TurnLease.nextEpoch` with `lease.invalid`. A Run that has spent
2^53 revisions genuinely cannot advance, so progress is stated under stated headroom instead of
pretending the ceiling is not there.

**Canonical keys** (`Liveness.CanonicalKeys`). The one side condition the kernel *checks*
rather than proves — see the gap section below.

What is proved, in order of strength:

* `Turn.forceCancel_available` — with headroom, forced cancellation is admitted for every Turn
  in every state, whatever it holds and whoever holds it. No Turn is stuck.
* `RunSystem.step_terminalize_available` — once every Turn is retired, the whole composite
  terminalization step succeeds. No Run is stuck short of ending. The identities the step names
  (the terminal Turn, the two commits) are parameters: they are the caller's to mint, and a
  theorem that invented them would be claiming more than it can.
* `RunSystem.no_permanent_block` — **from every reachable state that still has something to
  close, some admitted step strictly reduces what is left.** No fairness is used: the step
  exists whether or not anything schedules it. This is deadlock freedom.
* `RunSystem.obligation_is_discharged_or_captured` — at any reachable state where the Run has
  ended, every obligation it ever admitted is either discharged or captured in its terminal
  snapshot. Also no fairness: it is the safety invariant read for one obligation.
* `RunSystem.fair_trace_ends` — under `Fairness`, `Headroom`, and `CanonicalKeys` at every
  state, a trace reaches a state where the Run has ended. `debt_step_le` is the bridge that
  makes the induction work: an event that takes on no new work never increases what the Run has
  left to close.
* `RunSystem.fair_trace_discharges_or_terminalizes` — the two composed. **Every admitted
  obligation is eventually discharged or terminalized.**

## Total correctness

"Total correctness" is usually two claims, and in this kernel the first one is not a theorem:
every definition is a total function, `partial` is banned, and elaboration establishes
termination. Saying only that would be saying nothing. What a total function can still get
wrong is exactly three things, and `Correctness` proves all three for all nineteen
state-machine operations — seven on `Turn`, seven on `Run`, three on the admission registry,
two on `RunBranch` — plus the composite `RunSystem.step`:

* **The outcome channel is declared.** `TotallyCorrect` carries the refusal-code list *and*
  the shape-fault subject list, so an operation that passes `[]` for the second has proved it
  never produces a shape fault. That is the real content: `Outcome` admits a `Fault.shape` at
  every type, and a caller who has to handle a `TypeError` from `Turn.claim` cannot be told it
  never happens without a proof. Seventeen of the nineteen produce no shape fault. The two that
  do are `Run.terminalize` (`"Run invocation delivery outbox"`) and `RunBranch.reserveRewrite`
  (`"Run branch rewrite"`), and `RunSystem.step_fault` shows the whole lifecycle refuses in
  exactly four codes — `run.invalid-state`, `turn.invalid-state`, `lease.invalid`,
  `protocol.revision-conflict` — and faults in exactly two shapes, both canonical-order checks.
* **The post-state satisfies the contract.** Each `.ok` carries the operation's own
  postcondition.
* **A refusal writes nothing.** `refusal_writes_nothing` states it once for the library: an
  operation returns a new value or a fault, so a refused operation cannot have written
  anything. In the TypeScript runtime that is a rule to enforce at every call site; here it is
  a property of the type and the theorem says so.

`RunSystem.step_totallyCorrect` is the composite: for every state satisfying the invariant and
every event, the step lands in an `.ok` whose state satisfies the invariant again, in one of
the four codes, or in one of the two named shape faults. `reachable_step_totallyCorrect` is the
form a reader wants — no reachable state has a step that escapes the declared channels or lands
outside the invariant.

Where an operation's precondition holds, the `.ok` branch is reached: that is the availability
side, proved in `Liveness` for the operations a progress argument needs. The two halves
together are the Hoare triple.

## What remains unproved, and why

**`CanonicalKeys`: distinct obligation keys differ as UTF-16 code-unit sequences.**
`SettlementObligation` requires its capture in canonical key order.
`RunObligation.key_injective` gives distinct keys as `String`s, but canonical order is decided
by `Text.compareUnits` over code units, and `Text.before_total` — that two distinct keys are
ordered one way or the other — needs them distinct *as unit sequences*. `Text.units` is nowhere
proved injective in this kernel. The missing lemma is that UTF-16 is a prefix-free code over
Lean's surrogate-free `Char`: a BMP scalar's single unit is never in `0xD800..0xDFFF` because
`Char` excludes surrogates, and an astral scalar's first unit always is. That is true and it is
provable; it is not proved here. Until it is, terminalization *checks* the order of its capture
and reports a shape fault when it cannot establish it — exactly as `Run.terminalize` checks its
outbox — and `sortedByKey_ordered` proves that this hypothesis is the only thing missing:
given it, sorted insertion produces the required order and the record is constructible.
Consequence: safety is unconditional, and only the *enabling* half of liveness carries this
hypothesis.

**`EnvironmentResponsive`: that the evidence port eventually answers.** Named in `Liveness` and
assumed by no theorem there. `isSettled` quantifies over evidence — a resolved approval, a
terminal Receipt, a satisfied acceptance criterion — and no premise about alarms, queues, or
clocks produces evidence that a principal has to produce. `settlement_needs_environment` makes
the gap exact: settlement is *precisely* environment responsiveness plus the derived audits,
and everything else a Run needs in order to settle is proved above. A Run whose captured
approval is never answered stays unsettled forever, and that is the honest answer rather than
a gap in the proof.

**Lease expiry as a clock hypothesis.** `Turn.reclaim` requires an *expired* held lease, and
what makes a held lease expire is elapsed time. The `tick` event is the environment's move and
is marked as such (`RunEvent.kernelAuthored` is false for exactly it). The progress results
above route around it: they use forced cancellation, which needs no expiry, so no theorem here
assumes an unbounded clock. The stronger property that expiry would buy — that a Turn whose
executor is *lost* is eventually taken over by a new holder rather than cancelled — is not
proved, and it would need a monotone-unbounded-clock hypothesis over the trace. Recorded, not
claimed.

**The §3.4 Grant plane.** "Authority never widens" is proved here for the two authority planes
the Run lifecycle has: the resource remainder and the Turn lease. Grants, Bindings, epochs, and
watermarks are the abstract model's (`AgentCore.Authority`, `AgentCore.Composed`) and this
library states nothing about them.

## Claim boundary

This library designates no theorem, owns no `AC-*` requirement, adds no `ASM-*` entry, and
appears in no line of `AgentCore/Axioms.lean`. Under `artifacts/traceability.yaml`'s vocabulary
every declaration here is a `component-shape-nonclaim`, for exactly the reason
`AgentCore.Substrate`'s are: the ledger's `formalScope` is `abstract-model-only`, and these
theorems are about `AgentCore.Kernel`'s executable definitions. Designating one would require
`AgentCore/Axioms.lean` — whose only import is the model root — to import the kernel, which
would put an executable definition into a designated theorem's closure and move the declared
scope. That is a Tier D change under `AGENT_OPERATING_DOCTRINE.md` §2 and nothing here asks
for it. `pnpm check:traceability` therefore needs no ledger change to accept this tree, and
does not receive one.

The axiom audit over the library is exactly `{propext, Classical.choice, Quot.sound}`, and
`artifacts/normative.lock` records the five new modules in its audited closure with every
designated declaration hash unchanged — which is the check that no designated theorem came to
depend on any of this.

There is no `axiom`, `opaque`, `partial`, `unsafe`, `sorry`, or `native_decide` in the tree.
`lake build AgentCore.Kernel` builds it.
