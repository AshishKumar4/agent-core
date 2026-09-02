import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# InterceptOrder vocabulary

The schedule alias is grammar bookkeeping for the list-valued key and value positions of
one existing `AgentCore.AdmittedSchedule` relation; it adds no model construct.
-/

namespace SpecCnl.Entries.InterceptOrder

abbrev InterceptorSchedule := List AgentCore.InterceptorContribution

def entries : List LexEntry :=
  [ { id := "intercept.foreign.question"
      surface := "foreign question"
      category := "CN[AgentCore.InterceptionQuestion]"
      denotation := "fun question => AgentCore.InterceptionQuestion.Foreign question" },
    { id := "intercept.contribution"
      surface := "contribution"
      category := "CN[AgentCore.InterceptorContribution]"
      denotation := "fun _ => True"
      caveats := [.typeAsCommonNoun] },
    { id := "intercept.admits"
      surface := "admits"
      category := "(NP[AgentCore.InterceptionQuestion]\\S)/NP[AgentCore.InterceptorContribution]"
      denotation :=
        "fun contribution question => question.contribution = contribution ∧ " ++
        "AgentCore.InterceptionQuestion.Admits question" },
    { id := "intercept.every.gate.firing"
      surface := "every gate firing"
      category := "TR[AgentCore.InterceptionState,AgentCore.InterceptorContribution]"
      denotation :=
        "fun before contribution after => contribution.mode = AgentCore.InterceptorMode.gate ∧ " ++
        "∃ behave rest, before.pending = contribution :: rest ∧ " ++
        "AgentCore.InterceptStep behave before after" },
    { id := "intercept.unchanged.value"
      surface := "an unchanged value"
      category := "PO[AgentCore.InterceptionState,AgentCore.InterceptorContribution]"
      denotation := "fun before _ after => after.value = before.value" },
    { id := "intercept.gate.contribution"
      surface := "gate contribution"
      category := "CN[AgentCore.InterceptorContribution]"
      denotation :=
        "fun contribution => contribution.mode = AgentCore.InterceptorMode.gate" },
    { id := "intercept.rewrite.contribution"
      surface := "rewrite contribution"
      category := "CN[AgentCore.InterceptorContribution]"
      denotation :=
        "fun contribution => contribution.mode = AgentCore.InterceptorMode.rewrite" },
    { id := "intercept.precedes"
      surface := "precedes"
      category :=
        "(NP[AgentCore.InterceptorContribution]\\S)/NP[AgentCore.InterceptorContribution]"
      denotation := "fun right left => AgentCore.InterceptorOrder left right" },
    { id := "intercept.every.step"
      surface := "every interception step"
      category := "TR[AgentCore.InterceptionState,AgentCore.InterceptorBehavior]"
      denotation := "fun before behave after => AgentCore.InterceptStep behave before after" },
    { id := "intercept.replay.consistency"
      surface := "replay consistency"
      category := "CN[AgentCore.InterceptionState]"
      denotation :=
        "fun state => AgentCore.replayInterceptions state.input state.trace = some state.value" },
    { id := "intercept.prepared.invocation.immutability"
      surface := "prepared invocation immutability"
      category := "PR[AgentCore.EffectLedger]"
      denotation :=
        "fun before after => ∀ invocation prepared, " ++
        "AgentCore.EffectLedger.invocations before invocation = some prepared → " ++
        "AgentCore.EffectLedger.invocations after invocation = some prepared" },
    { id := "intercept.admitted.schedule"
      surface := "the admitted interceptor schedule"
      category :=
        "RE[AgentCore.InterceptionQuestion,SpecCnl.Entries.InterceptOrder.InterceptorSchedule," ++
        "SpecCnl.Entries.InterceptOrder.InterceptorSchedule]"
      denotation :=
        "fun question candidates schedule => " ++
        "(∃ cut, AgentCore.AdmittedSchedule question.granted question.domainOf question.site " ++
        "cut schedule) ∧ ∀ contribution, contribution ∈ candidates ↔ contribution ∈ schedule" } ]

end SpecCnl.Entries.InterceptOrder
