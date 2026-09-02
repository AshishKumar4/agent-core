import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# Protocol vocabulary (§8.1, §8.4, §8.5)

Actor activation and command labels each carry a payload, so their payload conditions use
separate lifters rather than matching an ActorLabel inside the condition itself. The
ownership preservation family includes source reachability: arbitrary synthetic ActorNode
values need not have an anchored pending transaction, whereas every ActorNode reached from
boot does.

DispatcherLedger is polymorphic in its domain state. Category arguments name types rather
than type applications, so ProtocolDispatcherLedger fixes that opaque parameter to Nat. The
request entry quantifies over every DispatchPolicy Nat; its discharge reads the parametric
dispatch_appends_exactly_one_linked_write_and_audit theorem.
-/

namespace SpecCnl.Entries.Protocol

abbrev ProtocolExpectedFence := Option AgentCore.ActorFence

abbrev ProtocolDispatcherLedger := AgentCore.DispatcherLedger Nat

def entries : List LexEntry :=
  [ { id := "every.protocol.activation"
      surface := "every protocol activation"
      category := "TR[AgentCore.ActorNode,AgentCore.ActorLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ actor, label = AgentCore.ActorLabel.activate actor) ∧ " ++
        "AgentCore.ActorStep before label after" },
    { id := "for.the.protocol.activation"
      surface := "for the protocol activation"
      category :=
        "PX[AgentCore.ActorNode,AgentCore.ActorRef]" ++
        "\\PO[AgentCore.ActorNode,AgentCore.ActorLabel]"
      denotation :=
        "fun cond before label after => ∀ actor, " ++
        "label = AgentCore.ActorLabel.activate actor → cond before actor after" },
    { id := "protocol.bound.actor.identity"
      surface := "a bound actor identity"
      category := "PX[AgentCore.ActorNode,AgentCore.ActorRef]"
      denotation :=
        "fun _ actor after => after.storage.identity = some actor ∧ " ++
        "∃ state, after.storage.recovery = some state ∧ state.actor = actor" },
    { id := "every.protocol.reachable.actor.step"
      surface := "every reachable protocol actor step"
      category := "TR[AgentCore.ActorNode,AgentCore.ActorLabel]"
      denotation :=
        "fun before label after => AgentCore.ActorReachable before ∧ " ++
        "AgentCore.ActorStep before label after" },
    { id := "protocol.bound.identity"
      surface := "bound actor identity"
      category := "PR[AgentCore.ActorNode]"
      denotation :=
        "fun before after => ∀ actor, before.storage.identity = some actor → " ++
        "after.storage.identity = some actor" },
    { id := "every.protocol.command"
      surface := "every protocol command"
      category := "TR[AgentCore.ActorNode,AgentCore.ActorLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ expected, label = AgentCore.ActorLabel.command expected) ∧ " ++
        "AgentCore.ActorStep before label after" },
    { id := "for.the.protocol.command"
      surface := "for the protocol command"
      category :=
        "ST[AgentCore.ActorNode,SpecCnl.Entries.Protocol.ProtocolExpectedFence]" ++
        "\\ST[AgentCore.ActorNode,AgentCore.ActorLabel]"
      denotation :=
        "fun cond before label => ∀ expected, " ++
        "label = AgentCore.ActorLabel.command expected → cond before expected" },
    { id := "protocol.current.actor.fence"
      surface := "a current actor fence"
      category := "ST[AgentCore.ActorNode,SpecCnl.Entries.Protocol.ProtocolExpectedFence]"
      denotation :=
        "fun before expected => ∃ txn self held, " ++
        "before.pending = some txn ∧ before.phase = AgentCore.ActorPhase.serving held ∧ " ++
        "txn.working.identity = some self ∧ " ++
        "AgentCore.admitsCommand self held expected txn.working.recovery = true" },
    { id := "every.protocol.request"
      surface := "every protocol request"
      category :=
        "TR[SpecCnl.Entries.Protocol.ProtocolDispatcherLedger,AgentCore.DispatchLabel]"
      denotation :=
        "fun before label after => ∃ policy, AgentCore.DispatchStep policy before label after" },
    { id := "for.the.protocol.request"
      surface := "for the protocol request"
      category :=
        "PX[SpecCnl.Entries.Protocol.ProtocolDispatcherLedger,AgentCore.WriteRecordId]" ++
        "\\PO[SpecCnl.Entries.Protocol.ProtocolDispatcherLedger,AgentCore.DispatchLabel]"
      denotation :=
        "fun cond before label after => ∀ id audit raw now, " ++
        "label = AgentCore.DispatchLabel.process id audit raw now → cond before id after" },
    { id := "protocol.linked.write.audit.record"
      surface := "a linked write audit record"
      category :=
        "PX[SpecCnl.Entries.Protocol.ProtocolDispatcherLedger,AgentCore.WriteRecordId]"
      denotation :=
        "fun before id after => ∃ record audit, " ++
        "before.writes id = none ∧ before.audits audit = none ∧ " ++
        "after.writes id = some record ∧ record.audit = audit ∧ " ++
        "after.audits audit = some id ∧ " ++
        "(∀ other, other ≠ id → after.writes other = before.writes other) ∧ " ++
        "∀ other, other ≠ audit → after.audits other = before.audits other" } ]

end SpecCnl.Entries.Protocol
