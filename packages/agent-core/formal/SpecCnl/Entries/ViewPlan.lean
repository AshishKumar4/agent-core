import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# View streaming vocabulary (§6.3)

One paradigm, in two families over the same state.

**The View.** `AgentCore.ViewState` is a revision and a body; `AgentCore.ViewDelta` is a
base revision and a patch. `AgentCore.applyDelta` is a function into `Option ViewState`,
so the transition family a sentence quantifies over is the graph of its successful
applications: `every view apply` is `applyDelta before delta = some after`. The delta is
the label itself rather than a payload inside one, so the two conditions on it —
`a matching revision` on the source, `the patched successor` on the successor — need no
lifting entry, exactly as the §9.2 admission conditions need none.

**The replay.** `AgentCore.replay` folds a whole delta stream, so its label is the stream
and its family is a second `TR` over the same state. `the counted revision` is the fold's
one non-structural fact (`AgentCore.replay_revision`, the model's only inductive View
result): a replayed View sits exactly as many revisions on as the stream it consumed is
long.

`ViewDeltaStream` below is bookkeeping, not content: a category type argument is a single
identifier and `List AgentCore.ViewDelta` is not one. It is declared in this group's own
module rather than beside `CommitTable` in `SpecCnl.Grammar` so that this group adds
nothing to a shared file beyond its one registration line.
-/

namespace SpecCnl.Entries.ViewPlan

/-- The label of a replay: the delta stream folded into a View. -/
abbrev ViewDeltaStream := List AgentCore.ViewDelta

def entries : List LexEntry :=
  [ { id := "every.view.apply"
      surface := "every view apply"
      category := "TR[AgentCore.ViewState,AgentCore.ViewDelta]"
      denotation :=
        "fun before delta after => AgentCore.applyDelta before delta = some after" },
    { id := "view.matching.revision"
      surface := "a matching revision"
      category := "ST[AgentCore.ViewState,AgentCore.ViewDelta]"
      denotation :=
        "fun before delta => AgentCore.ViewDelta.base delta = " ++
        "AgentCore.ViewState.revision before" },
    { id := "view.patched.successor"
      surface := "the patched successor"
      category := "PO[AgentCore.ViewState,AgentCore.ViewDelta]"
      denotation :=
        "fun before delta after => " ++
        "AgentCore.ViewState.revision after = AgentCore.ViewState.revision before + 1 ∧ " ++
        "AgentCore.ViewState.body after = " ++
        "AgentCore.ViewPatch.apply (AgentCore.ViewDelta.patch delta) " ++
        "(AgentCore.ViewState.body before)" },
    { id := "every.view.replay"
      surface := "every view replay"
      category := "TR[AgentCore.ViewState,SpecCnl.Entries.ViewPlan.ViewDeltaStream]"
      denotation :=
        "fun before deltas after => AgentCore.replay before deltas = some after" },
    { id := "view.counted.revision"
      surface := "the counted revision"
      category := "PO[AgentCore.ViewState,SpecCnl.Entries.ViewPlan.ViewDeltaStream]"
      denotation :=
        "fun before deltas after => AgentCore.ViewState.revision after = " ++
        "AgentCore.ViewState.revision before + List.length deltas" } ]

end SpecCnl.Entries.ViewPlan
