import SpecCnl.Negative

/-!
# Hostile near-misses for the §9.2, §7.2, and §3.5 placement sentences

Each case is a real misreading of one of this group's own sentences: the wrong
coordination depth, a subject and a predicate that range over different model types, a
condition offered to the connective that takes a different category, and the two lifter
mistakes the secret-custody sentence invites.
-/

namespace SpecCnl.Adversarial.Negatives.Placement

def cases : List Case :=
  [ { sentence :=
        "every chosen placement selects an admissible mode and every bundled placement \
         admits no unbundled mode and every provider placement admits no dynamic mode"
      kind := .ambiguous 2
      reason := "the placement sentence with ordinary `and` where it needs the explicitly \
        delimited three-clause form. Two binary coordinations of three clauses have a \
        left and a right reading, and here association is not idle: the reviewed sentence \
        pairs the admissibility clause with the bundled exclusion and adds the provider \
        exclusion, and the other reading pairs the two exclusions instead" },
    { sentence := "every unbundled mode admits no dynamic mode"
      kind := .noReading
      reason := "subject and predicate over different model types. `admits` relates a \
        PlacementSnapshot to a mode — it reads that snapshot's four admissible-mode sets \
        — so a subject that ranges over modes has nothing for the intersection to be an \
        intersection of. The model refuses a sentence that is perfectly good English" },
    { sentence := "every bundled placement yields the mediated tier"
      kind := .noReading
      reason := "the converse type error, and the reason the escalation rule is about a \
        mode rather than about a snapshot. `yields the mediated tier` is a property of a \
        Placement alone, because AgentCore.effectiveTier takes the mode; a validated \
        snapshot is not a mode" },
    { sentence := "every direct admission requires unchanged system state"
      kind := .noReading
      reason := "`requires` takes a condition on the source state and the request, and \
        `unchanged system state` is a two-state relation. Non-durability is a relation \
        between the states either side of the admission, not a precondition of it, and \
        the categories keep the two apart" },
    { sentence := "every direct admission maintains a bundled selection"
      kind := .noReading
      reason := "the converse clash on the same family: `maintains` takes a two-state \
        relation and `a bundled selection` is a condition on the source state and the \
        request. A precondition cannot be smuggled in as something the step maintains" },
    { sentence := "every direct admission establishes an observing impact"
      kind := .noReading
      reason := "`establishes` takes a postcondition, which may read the successor state, \
        and `an observing impact` is a precondition. The floor refuses a non-observe \
        impact before the call, and stating it as something the call establishes would \
        claim the impact becomes observe rather than that it already was" },
    { sentence :=
        "every mediated effect compares the current path epochs and matches the open \
         reservation epoch"
      kind := .noReading
      reason := "coordination at the wrong level. Sentence-level `and` takes a sentence on \
        each side, and `matches the open reservation epoch` is a verb phrase awaiting its \
        subject. Coordinating the two verb phrases under one subject would need a \
        predicate-level coordinator, which the grammar does not have, so the subject is \
        repeated in the reviewed sentence" },
    { sentence :=
        "every secret resolve requires a recorded custody endpoint for the presented binding"
      kind := .noReading
      reason := "the two custody lifters are not interchangeable. `for the presented \
        binding` scopes a secret-and-Binding relation under the resolve label and `a \
        recorded custody endpoint` is a secret-and-endpoint relation, so pairing them is \
        refused — which is what keeps the two halves of the custody record from being \
        checked against each other" },
    { sentence := "every secret resolve requires a recorded custody endpoint"
      kind := .noReading
      reason := "an unlifted payload condition, on the §3.5 resolve family. `a recorded \
        custody endpoint` is a relation over a SecretRef and an endpoint, and `requires` \
        needs a condition on the transition's label, so the resolve label match cannot be \
        left implicit" } ]

end SpecCnl.Adversarial.Negatives.Placement
