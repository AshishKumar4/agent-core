import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# Isolate: lexicon entries for §4.7, §4.6, and §9.2

Two paradigms. The dynamic-isolate one already exists in `Lexicon.isolateEntries` — the
egress family, the `for the egress` lifter, the passed-destination relation, the
fresh-state family, and the host-pass condition — so this module adds only what the new
rule units need on top of it: the invoke family with its own lifter, the invariant
`AgentCore.ActionsBacked`, and the whole-family entry `every isolate step`.

The invoke lifter is a second entry rather than a match inside `a passed binding`'s own
denotation, for the reason stated at the head of `SpecCnl.Lexicon`: a condition never
recovers a label payload by matching the label it is a condition on. `for the egress`
cannot be reused for it, because that lifter scopes a Binding-and-Destination relation
under the `egress` constructor and an invocation names no destination.

The Slate record plane is a new paradigm. `AgentCore.SlateStep` is judged against an
`AgentCore.EnvironmentLedger` that hosts previews, which is not part of the transition's
own state, so the family entry quantifies over it exactly as `every merge append`
quantifies over the effect, event, and audit ledgers a graph step is judged against.
-/

namespace SpecCnl.Entries.Isolate

def entries : List LexEntry :=
  [ { id := "every.isolate.step"
      surface := "every isolate step"
      category := "TR[AgentCore.DynamicDomain,AgentCore.IsolateLabel]"
      denotation := "AgentCore.IsolateStep" },
    { id := "only.host.passed.capabilities"
      surface := "only host passed capabilities"
      category := "PO[AgentCore.DynamicDomain,AgentCore.IsolateLabel]"
      denotation :=
        "fun before label after => ∀ binding, " ++
        "AgentCore.DynamicDomain.passed after binding ≠ " ++
        "AgentCore.DynamicDomain.passed before binding → " ++
        "∃ capability, label = AgentCore.IsolateLabel.pass binding capability" },
    { id := "binding.backed.actions"
      surface := "binding backed actions"
      category := "CN[AgentCore.DynamicDomain]"
      denotation := "AgentCore.ActionsBacked" },
    { id := "every.isolate.invocation"
      surface := "every isolate invocation"
      category := "TR[AgentCore.DynamicDomain,AgentCore.IsolateLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ binding, label = AgentCore.IsolateLabel.invoke binding) ∧ " ++
        "AgentCore.IsolateStep before label after" },
    { id := "for.the.invocation"
      surface := "for the invocation"
      category :=
        "ST[AgentCore.DynamicDomain,AgentCore.BindingId]" ++
        "\\ST[AgentCore.DynamicDomain,AgentCore.IsolateLabel]"
      denotation :=
        "fun cond before label => ∀ binding, " ++
        "label = AgentCore.IsolateLabel.invoke binding → cond before binding" },
    { id := "a.passed.binding"
      surface := "a passed binding"
      category := "ST[AgentCore.DynamicDomain,AgentCore.BindingId]"
      denotation :=
        "fun domain binding => ∃ capability, " ++
        "AgentCore.DynamicDomain.passed domain binding = some capability" },
    { id := "every.slate.step"
      surface := "every slate step"
      category := "TR[AgentCore.SlateLedger,AgentCore.SlateLabel]"
      denotation :=
        "fun before label after => ∃ env, AgentCore.SlateStep env before label after" },
    { id := "a.committed.head.advance"
      surface := "a committed head advance"
      category := "PO[AgentCore.SlateLedger,AgentCore.SlateLabel]"
      denotation :=
        "fun before label after => ∀ slate record moved, " ++
        "AgentCore.SlateLedger.slates before slate = some record → " ++
        "AgentCore.SlateLedger.slates after slate = some moved → " ++
        "AgentCore.SlateRecord.head moved ≠ AgentCore.SlateRecord.head record → " ++
        "∃ version source, " ++
        "label = AgentCore.SlateLabel.commit slate version source ∧ " ++
        "AgentCore.SlateRecord.head moved = some version" },
    { id := "committed.version.immutability"
      surface := "committed version immutability"
      category := "PR[AgentCore.SlateLedger]"
      denotation :=
        "fun before after => ∀ id record, " ++
        "AgentCore.SlateLedger.versions before id = some record → " ++
        "AgentCore.SlateLedger.versions after id = some record" } ]

end SpecCnl.Entries.Isolate
