import SpecCnl.Elab

/-!
# The admitted propositions of the RunGraph group

One declaration per `SpecCnl.Corpus.Units.RunGraph` record. The sentence text lives only in
the corpus, so a proposition here cannot drift from the record binding it to its SPEC rule
unit and its digest.
-/

namespace SpecCnl.Sentences

def cnl_C13_RUN_GRAPH_CLOSED : Prop := cnl_unit% "C13_RUN_GRAPH_CLOSED"

def cnl_C13_RUN_DISTINCTION_REPRESENTABLE : Prop :=
  cnl_unit% "C13_RUN_DISTINCTION_REPRESENTABLE"

def cnl_C13_RUN_UNDO_REDO : Prop := cnl_unit% "C13_RUN_UNDO_REDO"

end SpecCnl.Sentences
