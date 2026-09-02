import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# NoRetry: the vocabulary of the closed Turn lifecycle

§5.6 says what the model does *not* do, so this section's whole job is to name the
strongest positive consequence of the closed label set instead of a missing constructor.

* **The families.** The append-only claim already needed a transition family with no label
  restriction at all, so `every graph step` is the corpus's existing `AgentCore.GraphStep`
  entry, reused unchanged: the non-resurrection claim quantifies over exactly the same
  family. `every turn start` is new and narrows it to `AgentCore.GraphLabel.startTurn`,
  which is the transition an "ordinary admission of another Turn" is.
* **The lifter.** `for the started turn` is the `PX \ PO` twin of the corpus's existing
  spawn and append lifters, for the one `TurnId` the `startTurn` label carries. It reads
  the successor store, because what a start brings about is a record that was not there
  before.
* **The conditions.** `terminal turn finality` is a two-state relation, not a one-state
  invariant: "a terminal Turn stays terminal" relates the stores either side of a step and
  cannot be said of one store. `an unheld initial lease` is the authority half — the
  started Turn's lease is `AgentCore.TurnLease.initial` and therefore admits no token at
  all.

Every denotation is a term over `AgentCore` alone; nothing here introduces a constant, and
this section adds no grammar entry.
-/

namespace SpecCnl.Entries.NoRetry

def entries : List LexEntry :=
  [ { id := "retry.terminal.turn.finality"
      surface := "terminal turn finality"
      category := "PR[AgentCore.GraphStore]"
      denotation :=
        "fun before after => ∀ id turn, " ++
        "AgentCore.GraphStore.turns before id = some turn → " ++
        "(AgentCore.Turn.status turn = AgentCore.TurnStatus.succeeded ∨ " ++
        "AgentCore.Turn.status turn = AgentCore.TurnStatus.failed ∨ " ++
        "AgentCore.Turn.status turn = AgentCore.TurnStatus.cancelled) → " ++
        "∃ later, AgentCore.GraphStore.turns after id = some later ∧ " ++
        "(AgentCore.Turn.status later = AgentCore.TurnStatus.succeeded ∨ " ++
        "AgentCore.Turn.status later = AgentCore.TurnStatus.failed ∨ " ++
        "AgentCore.Turn.status later = AgentCore.TurnStatus.cancelled)" },
    { id := "retry.every.turn.start"
      surface := "every turn start"
      category := "TR[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ turn, label = AgentCore.GraphLabel.startTurn turn) ∧ " ++
        "∃ effects events audit, " ++
        "AgentCore.GraphStep effects events audit before label after" },
    { id := "retry.for.the.started.turn"
      surface := "for the started turn"
      category :=
        "PX[AgentCore.GraphStore,AgentCore.TurnId]" ++
        "\\PO[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun cond before label after => ∀ turn, " ++
        "label = AgentCore.GraphLabel.startTurn turn → cond before turn after" },
    { id := "retry.an.unheld.initial.lease"
      surface := "an unheld initial lease"
      category := "PX[AgentCore.GraphStore,AgentCore.TurnId]"
      denotation :=
        "fun _ turn after => ∃ record, " ++
        "AgentCore.GraphStore.turns after turn = some record ∧ " ++
        "AgentCore.Turn.lease record = AgentCore.TurnLease.initial turn ∧ " ++
        "∀ token now, ¬ AgentCore.TurnLease.Admits " ++
        "(AgentCore.Turn.lease record) token now" } ]

end SpecCnl.Entries.NoRetry
