import SpecCnl.Negative

/-!
# Hostile near-misses for the §7.4 Receipts group

Each case is a real misreading of one of this group's own sentences: the wrong connective
for a category, a payload condition with its lifter dropped, a state-relative relation read
as an order, or a common noun left without its determiner.
-/

namespace SpecCnl.Adversarial.Negatives.Receipts

def cases : List Case :=
  [ { sentence := "every effect step preserves recorded receipt immutability"
      kind := .noReading
      reason := "`preserves` takes a one-state invariant and `recorded receipt \
        immutability` is a two-state relation. Immutability of a record is a claim about \
        the pair of states either side of a step, not a property one state can have, and \
        the categories keep the two apart" },
    { sentence := "every receipt chain supersession requires an indeterminate chain head"
      kind := .noReading
      reason := "an unlifted payload condition. `an indeterminate chain head` is a \
        condition on a ReceiptId, and `requires` needs one on the transition's label, so \
        the supersession label match cannot be left implicit — that is what `for the prior \
        receipt` supplies" },
    { sentence :=
        "every pre effect receipt establishes an item without a recorded attempt"
      kind := .noReading
      reason := "the same defect for a post-state condition. `an item without a recorded \
        attempt` is indexed by the ReceiptId the pre-effect label carries, and \
        `establishes` needs a postcondition on the label, so the binding the `for the \
        recorded receipt` lifter provides is not optional" },
    { sentence :=
        "every pre effect receipt establishes an item without a recorded attempt for the \
         recorded receipt and every first attempt receipt establishes an existing attempt"
      kind := .noReading
      reason := "one clause lifted and one not. Sentence-level `and` takes a sentence on \
        each side, so the second clause's missing lifter refuses the whole conjunction \
        rather than half of it" },
    { sentence := "the derived batch outcome is transitive"
      kind := .noReading
      reason := "a state-relative relation is not a binary relation over one type. `is \
        transitive` takes `PR`, whereas the derived batch outcome relates a ledger, a \
        prepared Invocation, and an aggregate, and transitivity of it would not typecheck \
        let alone mean anything" },
    { sentence := "every derived batch outcome assigns at most one value"
      kind := .noReading
      reason := "the relation read as a common noun. `assigns at most one value` takes the \
        relation itself on its left, and `every` needs a predicate on individuals; there is \
        no common noun spelling of an aggregate, so the determiner has nothing to quantify" },
    { sentence := "every route projection bridge requires a fresh cause free bridge root"
      kind := .noReading
      reason := "`requires` takes a condition on the source state and label, and a fresh \
        cause-free bridge root is a claim about the entry the step appends. A \
        postcondition cannot be demanded of the state a step starts from, so the \
        categories refuse it" },
    { sentence := "non attempt audit kind causes no attempted outcome kind"
      kind := .noReading
      reason := "a bare common noun in subject position. A common noun is a predicate on \
        audit kinds, not an individual, so it needs its determiner before it can be the \
        subject of a transitive verb" } ]

end SpecCnl.Adversarial.Negatives.Receipts
