import SpecCnl.Negative

/-!
# Hostile near-misses for the RunSettle group (§5.2)

Each case is a real misreading of one of this group's five sentences: a registry condition
without the lifter that binds it to a label's Run, a postcondition offered where a
precondition is wanted and the converse, a lifted condition standing alone as a sentence, a
bare common noun in subject position, three-way ordinary coordination where the sentence
uses two clauses, and two grammatical sentences the model refuses because the condition and
the transition family range over different ledgers.
-/

namespace SpecCnl.Adversarial.Negatives.RunSettle

def cases : List Case :=
  [ { sentence := "every obligation completion requires a reserved obligation"
      kind := .noReading
      reason := "an unlifted payload condition. `a reserved obligation` is a relation over \
        a graph, a Run, and an obligation, and `requires` needs a condition on the \
        transition's label, so the completion label match cannot be left implicit — the \
        registry a condition reads is the one the label's Run names" },
    { sentence := "every obligation reservation requires a valid admission reservation"
      kind := .noReading
      reason := "a postcondition where a precondition is wanted, and unlifted besides. \
        `a valid admission reservation` is indexed by the reservation a reserveObligation \
        label assembles and reads the state after the step, while `requires` takes a \
        condition on the source state and the label; validity in the registry the step \
        wrote cannot masquerade as an entry guard" },
    { sentence := "every run terminalization requires an exact closed frontier for the terminalized run"
      kind := .noReading
      reason := "the same clash through the lifter that does exist. `an exact closed \
        frontier` is a payload-indexed postcondition, so `for the terminalized run` lifts \
        it to a postcondition on the label; `requires` refuses it, which is what keeps the \
        captured frontier a claim about the transaction's result rather than its entry \
        condition" },
    { sentence := "every sibling cancellation requires a fenced cancelled sibling for the cancelled sibling"
      kind := .noReading
      reason := "the same defect on the cancellation label. The fence is what the \
        cancellation establishes — the sibling is cancelled and its lease holder cleared in \
        the successor state — and a condition on the source state cannot state it" },
    { sentence := "every run terminalization requires terminal unheld siblings"
      kind := .noReading
      reason := "the sibling rule without its lifter. `terminal unheld siblings` is \
        AgentCore.SiblingTurnsTerminalAndUnheld, a relation over a graph, a Run, and the \
        terminalizing Turn; both of those come off the terminalize label, so dropping `for \
        the terminalized run` leaves the relation nothing to be about" },
    { sentence := "terminal unheld siblings for the terminalized run"
      kind := .noReading
      reason := "a lifted condition is not a sentence. Scoping the sibling relation under \
        the terminalize label yields a condition on a source state and a label, and without \
        a transition family there is no quantifier for the grammar to supply" },
    { sentence := "system state refuses acceptance without a head verdict"
      kind := .noReading
      reason := "a bare common noun in subject position. A common noun is a predicate on \
        system states, not a system state, so it needs a determiner before the \
        verdict-evidence clause can apply to it" },
    { sentence :=
        "every settled system state captures a coherent terminal snapshot and every \
         settled system state discharges its captured obligations and every settled system \
         state captures a coherent terminal snapshot"
      kind := .ambiguous 2
      reason := "three-way ordinary `and` coordination. Sentence-level `and` is binary, so \
        a three-clause chain has a left and a right reading; the separately typed `and \
        additionally` form is the only three-clause shape that ships, and this sentence does \
        not use it" },
    { sentence := "every lease reclaim requires a reserved obligation for the completed obligation"
      kind := .noReading
      reason := "the model refuses a grammatical sentence. The lifted condition ranges over \
        AgentCore.GraphStore and AgentCore.GraphLabel while the transition family ranges \
        over AgentCore.TurnLease and AgentCore.LeaseLabel, so a reservation rule cannot be \
        asserted of a lease step however similar the English reads" },
    { sentence := "every obligation completion requires a reserved obligation for the resolved reference"
      kind := .noReading
      reason := "two lifters of one shape are not interchangeable. `for the resolved \
        reference` scopes a ContentRef-and-Tenant relation under a content resolve label; \
        `a reserved obligation` is a relation over a graph, a Run, and an obligation, so \
        pairing them is refused even though both lifters take a state-relative relation" },
    { sentence := "every verdict recording requires an unrecorded subject"
      kind := .noReading
      reason := "the retry rule without its lifter. `an unrecorded subject` relates a \
        graph, a criterion identity, and the verdict being recorded, and both the identity \
        and the verdict come off the recordAcceptanceVerdict label, so the label match \
        cannot be left implicit" },
    { sentence := "every verdict recording establishes an unrecorded subject for the verdict"
      kind := .noReading
      reason := "the converse clash on the same sentence. `for the verdict` lifts the \
        retry-admissibility relation to a condition on the source state and the label, and \
        `establishes` takes a postcondition, so the guard that blocks a repeated subject \
        cannot be restated as something the recording brings about" } ]

end SpecCnl.Adversarial.Negatives.RunSettle
