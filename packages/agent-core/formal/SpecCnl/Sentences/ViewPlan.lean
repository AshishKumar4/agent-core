import SpecCnl.Elab

/-!
# The admitted propositions of the ViewPlan group

One declaration per `SpecCnl.Corpus.Units.ViewPlan` record. The sentence text lives only in
the corpus, so a proposition here cannot drift from the record binding it to its SPEC rule
unit and its digest.
-/

namespace SpecCnl.Sentences

def cnl_C13_VIEW_NO_LIVE_STATE : Prop := cnl_unit% "C13_VIEW_NO_LIVE_STATE"

end SpecCnl.Sentences
