import SpecCnl.Elab

/-!
# The admitted propositions of the NoRetry group

One declaration per `SpecCnl.Corpus.Units.NoRetry` record. The sentence text lives only in
the corpus, so a proposition here cannot drift from the record binding it to its SPEC rule
unit and its digest.
-/

namespace SpecCnl.Sentences

def cnl_C13_TURN_NO_RETRY : Prop := cnl_unit% "C13_TURN_NO_RETRY"

end SpecCnl.Sentences
