import SpecCnl.Negative

/-!
# ModelInput: hostile near-misses

Four real misreadings of this group's one sentence. The §8.2 content plane is where the
corpus now carries three disjoint clauses over one ledger, so the near-misses worth
recording are the ones that would let a retention condition drift into another clause's
frame: dropping the lifter that ties it to the resolve label, reading a precondition as a
one-state invariant, scoping it with the sibling lifter of the same ledger, and putting it
in the `holds before` frame that wants a condition on the label rather than a relation
over the payload.
-/

namespace SpecCnl.Adversarial.Negatives.ModelInput

def cases : List Case :=
  [ { sentence := "every content resolve requires retained content"
      kind := .noReading
      reason := "an unlifted payload condition. `retained content` is a relation over a \
        ContentRef and a TenantId, and `requires` needs a condition on the ContentLabel, \
        so the resolve label match cannot be left implicit even for a condition that \
        reads only one of the label's two payloads" },
    { sentence :=
        "every content resolve preserves retained content for the resolved reference"
      kind := .noReading
      reason := "a precondition read as an invariant. Lifting the retention relation \
        under the resolve constructor yields a condition on a state and a label, and \
        `preserves` takes a one-state invariant, so the clause cannot be smuggled in \
        beside owned-implies-stored — which is what C13-CONTENT-CUSTODY's `preserves` \
        sentence over the same ledger genuinely carries" },
    { sentence :=
        "every content resolve requires retained content for the collected content"
      kind := .noReading
      reason := "the two lifters of one ledger are not interchangeable. \
        `for the collected content` scopes a bare ContentRef condition under the collect \
        constructor, and `retained content` is a relation over the ref and the requester \
        the resolve constructor carries, so the pair clashes on the payload shape as well \
        as on the label constructor" },
    { sentence := "retained content holds before every content resolve"
      kind := .noReading
      reason := "the same missing lifter in the ordering frame. `holds before` takes a \
        condition on the source state and the label to its left, and an unlifted relation \
        over the ref and the requester is neither, so rewording the precondition as an \
        ordering claim does not recover the label binding" } ]

end SpecCnl.Adversarial.Negatives.ModelInput
