import SpecCnl.Negative

/-!
# Hostile near-misses for the Protocol group (§8.1, §8.4, §8.5)

Each refusal omits a required payload lifter or uses the relation-preserving connective
where the ownership condition has the wrong category. The nearby English is deliberate:
none of these sentences may acquire a reading by guessing an ActorLabel payload.
-/

namespace SpecCnl.Adversarial.Negatives.Protocol

def cases : List Case :=
  [ { sentence := "every protocol command requires a current actor fence"
      kind := .noReading
      reason := "an unlifted command-payload condition. `a current actor fence` ranges over \
        an ActorNode and the expected fence carried by an ActorLabel.command, while \
        `requires` needs a condition on ActorLabel itself; `for the protocol command` is \
        the only reviewed binding of that payload" },
    { sentence := "every reachable protocol actor step preserves bound actor identity"
      kind := .noReading
      reason := "the wrong transition connective. `bound actor identity` is a relation \
        between the source and successor ActorNode, so it composes with `maintains`; \
        `preserves` accepts a one-state common noun and cannot silently reinterpret this \
        cross-state ownership fact as one" },
    { sentence := "every protocol request establishes a linked write audit record"
      kind := .noReading
      reason := "an unlifted request-payload postcondition. The linked record is indexed by \
        the WriteRecordId carried on DispatchLabel.process, and `establishes` needs a \
        postcondition on the whole label; `for the protocol request` supplies that binding" } ]

end SpecCnl.Adversarial.Negatives.Protocol
