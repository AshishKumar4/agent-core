import SpecCnl.Negative

/-!
# NoRetry: hostile near-misses

Each sentence below is a real misreading of this group's own sentence. Two defects recur.

The first is the connective a claim about *two* stores needs. That a terminal Turn stays
terminal is a relation between the store before a step and the store after it, so it lands
at `PR` and only `maintains` takes it; a reader who hears "the terminal statuses are
final" as a property one graph has reaches for `preserves`, and the category algebra
refuses that rather than silently reading a two-state relation as an invariant.

The second is the lifter that ties the initial-lease clause to the `startTurn` label. The
clause is indexed by the `TurnId` the label carries, so leaving the lifter out, using the
`for the appended commit` lifter of the neighbouring append family, or scoping the result
with `requires` instead of `establishes` are all refused — the last because the lifter
yields a postcondition and a precondition is not one.
-/

namespace SpecCnl.Adversarial.Negatives.NoRetry

def cases : List Case :=
  [ { sentence := "every graph step preserves terminal turn finality"
      kind := .noReading
      reason := "`preserves` takes a one-state invariant and `terminal turn finality` is a \
        two-state relation. That a Turn recorded terminal is still recorded terminal is \
        not a property a single GraphStore can have — it needs both stores of the step — \
        which is why non-resurrection is stated with `maintains`" },
    { sentence := "every turn start establishes an unheld initial lease"
      kind := .noReading
      reason := "an unlifted payload postcondition. `an unheld initial lease` is indexed \
        by the TurnId the startTurn label carries and `establishes` needs a postcondition \
        on the GraphLabel, so the label-to-turn binding cannot be left implicit even \
        though the label carries exactly one payload" },
    { sentence := "every turn start requires an unheld initial lease for the started turn"
      kind := .noReading
      reason := "a consequence read as a precondition. The started-turn lifter is the \
        PX-to-PO twin, so it yields a postcondition that reads the successor store — which \
        is the only place the new Turn's record exists — and `requires` takes a condition \
        on the source state and label, so the swap is refused rather than asserting the \
        record was already there before the start" },
    { sentence := "every graph step maintains an unheld initial lease for the started turn"
      kind := .noReading
      reason := "the converse clash on the family with no label restriction. Lifting the \
        initial-lease clause under the startTurn label yields a postcondition, and \
        `maintains` wants a relation between the two stores, which cannot see which Turn \
        the label started" },
    { sentence := "every turn start establishes an unheld initial lease for the appended commit"
      kind := .noReading
      reason := "two lifters of one label family are not interchangeable. The \
        appended-commit lifter scopes a postcondition indexed by a RunCommit under the \
        append label; the initial-lease clause is indexed by the TurnId a startTurn label \
        names, so pairing them clashes on the payload type as well as on the constructor" } ]

end SpecCnl.Adversarial.Negatives.NoRetry
