import SpecCnl.Negative

/-!
# Claims: hostile near-misses

Each case is a real misreading of one of this group's four sentences: a payload condition
with its label match left implicit, the wrong connective for the category, a lifter from
the wrong constructor of the same ledger, a condition from another ledger, coordination
where the grammar has none, and the three-way `and` the group's three-clause sentences
would collapse to.
-/

namespace SpecCnl.Adversarial.Negatives.Claims

def cases : List Case :=
  [ { sentence := "every claim step requires an unclaimed item"
      kind := .noReading
      reason := "an unlifted payload condition. `an unclaimed item` is a relation over an \
        EffectLedger, an InvocationId, and an item index, and `requires` needs a \
        condition on the EffectLabel, so the claim label match cannot be left implicit" },
    { sentence := "every claim step requires a future claim expiry for the claimed item"
      kind := .noReading
      reason := "`requires` takes a condition on the source state and the label, and the \
        claimed-item lifter builds a postcondition that reads the successor. The expiry \
        of a claim the step has not written yet is not a property of the state before \
        it, and the categories refuse the confusion rather than quantifying over a \
        record that does not exist" },
    { sentence := "every claim step requires a prior failed receipt for the claim"
      kind := .noReading
      reason := "two lifters of one ledger are not interchangeable. The claim lifter \
        scopes an Invocation-and-item-index relation under a claimItem label; `a prior \
        failed receipt` is a condition on one AttemptId, which is what the retry lifter \
        scopes, so pairing them is refused" },
    { sentence := "every claim recovery establishes disposed child facets for the claim recovery"
      kind := .noReading
      reason := "the model refuses a grammatical sentence. `disposed child facets` is a \
        payload-indexed postcondition over an EnvironmentLedger and a SessionId; the \
        claim-recovery lifter wants one over an EffectLedger and a claim label's \
        payload. Two post-state rules that read alike in English are kept apart by the \
        ledger they range over" },
    { sentence :=
        "every claim step requires an unclaimed item for the claim and every claim step \
         establishes a future claim expiry for the claimed item and every claim step \
         establishes an exact prepared owner for the claimed item"
      kind := .ambiguous 2
      reason := "the three-clause claim rule with ordinary `and` twice. Association is \
        immaterial to the meaning here, which is exactly why the grammar must not choose \
        it: an ambiguity tolerated where it is harmless is one tolerated where it is not. \
        The reviewed sentence uses the explicitly delimited `and additionally` form, \
        whose first half has category CJ and cannot re-associate" },
    { sentence := "every claim retry requires a prior failed receipt"
      kind := .noReading
      reason := "the same missing lifter on a second label family. `a prior failed \
        receipt` is a condition on the AttemptId a retry label names, so without `for \
        the claim retry` nothing binds it to the label and the sentence has no reading" },
    { sentence := "every attempt receipt preserves a recorded prior attempt for the attempt receipt"
      kind := .noReading
      reason := "`preserves` takes a one-state invariant, and the lifted \
        recorded-attempt condition is a postcondition relating the ledger before the \
        Receipt to the ledger after it. Write-ahead evidence is not an invariant of a \
        single state, and the categories keep the two apart" },
    { sentence :=
        "every claim retry requires a prior failed receipt and an advanced failed \
         ordinal for the claimed item"
      kind := .noReading
      reason := "coordination at the wrong level. Sentence-level `and` takes a sentence \
        on each side, and the grammar has no coordination over conditions or \
        postconditions, so two conditions cannot be conjoined inside one clause. Each \
        clause of a rule unit is a whole sentence, which is also why the left half here \
        is refused for its missing lifter" } ]

end SpecCnl.Adversarial.Negatives.Claims
