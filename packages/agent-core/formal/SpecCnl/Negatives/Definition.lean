import SpecCnl.Negative

/-!
# Definition: hostile near-misses

Each case is a real misreading of one of this group's own two sentences: the invariant
offered where a two-state relation is wanted, three clauses joined by the ordinary
coordinator, a transition family offered where an individual is wanted, a payload
condition left unlifted in both directions, coordination attempted below the sentence
level, and the group's two planes mixed — a materializer condition scoped under a
Run-graph transition.
-/

namespace SpecCnl.Adversarial.Negatives.Definition

def cases : List Case :=
  [ { sentence := "every template reconciliation preserves stored materializer records"
      kind := .noReading
      reason := "`preserves` takes a one-state invariant and `stored materializer records` \
        is a two-state relation. That reconciliation leaves the installed table and the \
        routing ledger exactly as it found them is a relation between the states either \
        side of the step, not a property the source state alone can have" },
    { sentence :=
        "every template reconciliation maintains stored materializer records and every \
         materializer step maintains installed template stability and every materializer \
         ledger installs at most one subscription per blueprint template"
      kind := .ambiguous 2
      reason := "three clauses joined by the ordinary coordinator. `and` is binary and \
        conjunction is associative in meaning, so the grammar refuses rather than choose \
        an association — which is why the convergence sentence uses the explicitly \
        delimited `and additionally` form for its third clause" },
    { sentence :=
        "every materializer step installs at most one subscription per blueprint template"
      kind := .noReading
      reason := "the at-most-one property belongs to one ledger, not to a transition. \
        `installs at most one subscription per blueprint template` needs an individual \
        MaterializerLedger on its left, and `every materializer step` is a transition \
        family over a ledger and a MaterializeLabel. This is exactly why the third clause \
        quantifies over ledgers rather than over steps" },
    { sentence := "every graph step requires a nonempty package closure"
      kind := .noReading
      reason := "an unlifted payload condition. `a nonempty package closure` is a \
        condition on a RunCommit and `requires` needs one on the transition's label, so \
        the migrate label match cannot be left implicit — `for the migrated commit` is the \
        entry that scopes it, and it is the only place this sentence names a label \
        constructor" },
    { sentence := "every graph step maintains unique package pins for the migrated commit"
      kind := .noReading
      reason := "the label match is not optional in the other direction either. Lifting a \
        migration-payload condition under the migrate label yields a condition on a source \
        state and a label, not a two-state relation, so `maintains` refuses it" },
    { sentence :=
        "every graph step requires a nonempty package closure for the migrated commit and \
         unique package pins for the migrated commit"
      kind := .noReading
      reason := "coordination below the sentence level. Sentence-level `and` takes a \
        sentence on each side, and `unique package pins for the migrated commit` is a \
        condition on a source state and a label; conjoining two conditions of one \
        transition would need coordination at that category, which the grammar has only \
        for relations. The corpus sentence repeats the transition family instead" },
    { sentence :=
        "every graph step requires an unmaterialized template for the materialization"
      kind := .noReading
      reason := "the group's two planes are kept apart by the record they range over. The \
        sentence is well-formed English and both halves are reviewed vocabulary: the \
        materialization lifter and `an unmaterialized template` range over a \
        MaterializerLedger, while `every graph step` is a transition family over a \
        GraphStore. Nothing but the category type stops a §9.3 materializer condition from \
        being asserted of a §5.2 graph step" } ]

end SpecCnl.Adversarial.Negatives.Definition
