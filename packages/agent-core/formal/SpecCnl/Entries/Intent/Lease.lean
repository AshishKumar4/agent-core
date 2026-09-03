import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# The Turn-lease ledger: content entries for the intent language

Two entries, and the paradigm rule at the head of `SpecCnl.Lexicon` is why there are only
two. The §5.3 lease section already ships the lifter that scopes a time condition under the
reclaim constructor (`for the reclaim`) and the two quantities it compares
(`the recorded expiry`, `the stated time`), so an intent about lease reclaims costs one
guard and one state condition and no new paradigm.

`lease reclaims` is a **guard**, category `GD`, not a transition family. That is the whole
difference between this language and the controlled one. `every lease reclaim` denotes
`... ∧ AgentCore.LeaseStep before label after`: it names the model's own step relation, so a
sentence built on it is a candidate theorem about the fixed model. A guard names only the
label shape, and the connective quantifies over whatever relation the platform admits. So
`lease reclaims require ...` constrains a platform, and `lease reclaims are possible` demands
that a platform admit something — which is the half the controlled language cannot state.

The surface is a bare plural because an intent connective carries its own quantifier
(`require` is universal, `are possible` existential), unlike the `TR` surfaces that must
read `every ...` because every connective over them is universal. No surface may carry both
a `TR` and a `GD` entry; `SpecCnl.Intent.lexiconRefusals` refuses that, so one word can
never give a sentence both a controlled-language and an intent reading.
-/

namespace SpecCnl.Entries.Intent.Lease

def entries : List LexEntry :=
  [ { id := "lease.reclaims"
      surface := "lease reclaims"
      category := "GD[AgentCore.TurnLease,AgentCore.LeaseLabel]"
      denotation :=
        "fun _ label => ∃ holder now expiresAt, " ++
        "label = AgentCore.LeaseLabel.reclaim holder now expiresAt" },
    { id := "an.unheld.lease"
      surface := "an unheld lease"
      category := "ST[AgentCore.TurnLease,AgentCore.LeaseLabel]"
      denotation := "fun lease _ => AgentCore.TurnLease.holder lease = none" } ]

end SpecCnl.Entries.Intent.Lease
