import SpecCnl.Negative

/-!
# RunGraph: hostile near-misses

Each sentence below is a real misreading of one of this group's own sentences. Two defects
recur, because §5.2 is where the vocabulary is densest: dropping the lifter that ties a
condition to the append label, and reaching for the wrong connective across the
source-state/successor boundary — the graph is the one domain where the corpus now has
both a condition and a postcondition scoped by the *same surface*, `for the appended
commit`, so a sentence that picks the wrong one is refused by the category algebra rather
than silently read as the other.
-/

namespace SpecCnl.Adversarial.Negatives.RunGraph

def cases : List Case :=
  [ { sentence := "every graph append requires same run parents"
      kind := .noReading
      reason := "an unlifted payload condition. `same run parents` is a condition on a \
        RunCommit and `requires` needs one on the GraphLabel, so the append label match \
        cannot be left implicit even for a condition that reads no other payload" },
    { sentence := "every graph append establishes an owned branch for the appended commit"
      kind := .noReading
      reason := "a precondition read as a consequence. Branch ownership is what the \
        append demands of the store it lands on; scoping it with the source-state lifter \
        yields a condition on the label, and `establishes` takes a postcondition, so the \
        swap is refused rather than turning the closure premise into something appending \
        brings about" },
    { sentence := "every graph spawn establishes an unparented child root for the appended commit"
      kind := .noReading
      reason := "two lifters of one label family are not interchangeable. The \
        appended-commit lifter scopes a postcondition indexed by a RunCommit under the \
        append label; the zero-parent root clause is indexed by the CommitId a spawn label \
        names, so pairing them clashes on the payload type as well as on the constructor" },
    { sentence := "every merge append requires distinct named heads"
      kind := .noReading
      reason := "the same missing lifter on the merge family. The two named heads are read \
        off the appended commit, and without `for the appended commit` there is no path \
        from the label to the commit whose parents are being compared" },
    { sentence := "every merge append maintains equal pinned parents for the appended commit"
      kind := .noReading
      reason := "`maintains` takes a two-state relation, and a lifted commit condition is \
        a condition on a state and a label. The pins a merge's parents carry are a fact \
        about one store, not a relation between the stores either side of the append" },
    { sentence := "every merge append requires a selected effective state for the appended commit"
      kind := .noReading
      reason := "the two entries sharing the surface `for the appended commit` are kept \
        apart by their categories. `a selected effective state` reads the store after the \
        step, so only the postcondition lifter accepts it, and that lifter yields a \
        postcondition — which `requires` refuses" },
    { sentence := "every undo append establishes a selected effective state"
      kind := .noReading
      reason := "the post-state payload rule on the undo family: the effective-state clause \
        is indexed by the appended RunCommit, and `establishes` needs a postcondition on \
        the GraphLabel, so the label-to-commit binding is not optional here either" },
    { sentence := "every undo append preserves stored commits"
      kind := .noReading
      reason := "`preserves` takes a one-state invariant and `stored commits` is a \
        two-state relation. That every stored commit survives is not a property a single \
        graph can have, which is why append-only is stated with `maintains`" },
    { sentence := "every graph step maintains a selected effective state for the appended commit"
      kind := .noReading
      reason := "the converse clash on the family with no label restriction. Lifting the \
        undo postcondition under the append label yields a postcondition, and `maintains` \
        wants a relation between the two stores, which cannot see which commit was \
        appended" } ]

end SpecCnl.Adversarial.Negatives.RunGraph
