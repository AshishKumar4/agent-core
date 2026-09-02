import SpecCnl.Negative

/-!
# Hostile near-misses for the §6.3 View sentence

Each case is a real misreading of this group's own sentence: the two conditions swapped
between the connective that reads the source state and the one that may read the
successor, the two families confused with each other's label, a postcondition offered as a
two-state relation, and the three-clause coordination written with ordinary `and`.
-/

namespace SpecCnl.Adversarial.Negatives.ViewPlan

def cases : List Case :=
  [ { sentence := "every view apply establishes a matching revision"
      kind := .noReading
      reason := "`establishes` takes a postcondition and `a matching revision` is a \
        condition on the source state and the delta. The base match is what a delta needs \
        before it applies, not something applying it brings about, and stating it as a \
        postcondition would read as the revision becoming the delta's base" },
    { sentence := "every view apply requires the patched successor"
      kind := .noReading
      reason := "the converse clash on the same family. `requires` takes a condition on \
        the source state and the label, and `the patched successor` reads the state after \
        the step, so the successor claim cannot be smuggled in as a precondition" },
    { sentence := "every view apply maintains the patched successor"
      kind := .noReading
      reason := "`maintains` takes a two-state relation and `the patched successor` is a \
        postcondition that reads the delta as well as both states. The new body is a \
        function of the patch the step was handed, so the claim is not a relation between \
        the two Views alone" },
    { sentence := "every view apply establishes the counted revision"
      kind := .noReading
      reason := "the model refuses it. `the counted revision` is indexed by a delta \
        stream, because AgentCore.replay_revision counts the deltas folded in, while the \
        apply family is labelled by one AgentCore.ViewDelta. One delta has no length, and \
        the two families are kept apart by the label they range over" },
    { sentence := "every view replay requires a matching revision"
      kind := .noReading
      reason := "the same clash from the other side: the base-match condition is about one \
        delta and the replay family is labelled by the whole stream. The gate holds of \
        every step of the fold, which is a claim about each delta rather than about the \
        stream, and this vocabulary cannot form it" },
    { sentence :=
        "every view apply requires a matching revision and every view apply establishes \
         the patched successor and every view replay establishes the counted revision"
      kind := .ambiguous 2
      reason := "the View sentence with ordinary `and` where it needs the explicitly \
        delimited three-clause form. Two binary coordinations of three clauses have a left \
        and a right reading, and association is not idle here: the reviewed sentence pairs \
        the two facts about one delta and adds the fact about the stream, while the other \
        reading pairs the successor with the stream count" } ]

end SpecCnl.Adversarial.Negatives.ViewPlan
