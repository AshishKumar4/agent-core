import SpecCnl.Sentences.Protocol

/-!
# Hand propositions and bridges for the Protocol group (§8.1, §8.4, §8.5)

The first two propositions read one ActorNode transition at a time. The activation and
reachable-step clauses are the two local facts from which the model's trace theorem
one_storage_serves_one_actor obtains same-Actor activation. The dispatcher proposition
uses its Nat domain instantiation only because a grammar category cannot quantify the
model's opaque domain parameter.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §8.1 C13-OWNERSHIP-ACTOR-CONTRACT -/

def hand_C13_OWNERSHIP_ACTOR_CONTRACT : Prop :=
  ∀ (before : ActorNode) (label : ActorLabel) (after : ActorNode),
    ((∃ expected, label = ActorLabel.command expected) ∧ ActorStep before label after) →
    ∀ expected, label = ActorLabel.command expected →
      ∃ txn self held, before.pending = some txn ∧ before.phase = ActorPhase.serving held ∧
        txn.working.identity = some self ∧
        admitsCommand self held expected txn.working.recovery = true

theorem bridge_C13_OWNERSHIP_ACTOR_CONTRACT :
    Sentences.cnl_C13_OWNERSHIP_ACTOR_CONTRACT ↔
      hand_C13_OWNERSHIP_ACTOR_CONTRACT := Iff.rfl

/-! ## §8.4 C13-OWNERSHIP-SINGLE-OWNER -/

def hand_C13_OWNERSHIP_SINGLE_OWNER : Prop :=
  (∀ (before : ActorNode) (label : ActorLabel) (after : ActorNode),
      ((∃ actor, label = ActorLabel.activate actor) ∧ ActorStep before label after) →
      ∀ actor, label = ActorLabel.activate actor →
        after.storage.identity = some actor ∧
          ∃ state, after.storage.recovery = some state ∧ state.actor = actor) ∧
    ∀ (before : ActorNode) (label : ActorLabel) (after : ActorNode),
      (ActorReachable before ∧ ActorStep before label after) →
      ∀ actor, before.storage.identity = some actor → after.storage.identity = some actor

theorem bridge_C13_OWNERSHIP_SINGLE_OWNER :
    Sentences.cnl_C13_OWNERSHIP_SINGLE_OWNER ↔ hand_C13_OWNERSHIP_SINGLE_OWNER := Iff.rfl

/-! ## §8.5 C13-PROTOCOL-REJECTION-ROOT -/

def hand_C13_PROTOCOL_REJECTION_ROOT : Prop :=
  ∀ (before : Entries.Protocol.ProtocolDispatcherLedger) (label : DispatchLabel)
      (after : Entries.Protocol.ProtocolDispatcherLedger),
    (∃ policy, DispatchStep policy before label after) →
    ∀ id requestAudit raw now, label = DispatchLabel.process id requestAudit raw now →
      ∃ record audit, before.writes id = none ∧ before.audits audit = none ∧
        after.writes id = some record ∧ record.audit = audit ∧
          after.audits audit = some id ∧
            (∀ other, other ≠ id → after.writes other = before.writes other) ∧
              ∀ other, other ≠ audit → after.audits other = before.audits other

theorem bridge_C13_PROTOCOL_REJECTION_ROOT :
    Sentences.cnl_C13_PROTOCOL_REJECTION_ROOT ↔
      hand_C13_PROTOCOL_REJECTION_ROOT := Iff.rfl

end SpecCnl.Bridge
