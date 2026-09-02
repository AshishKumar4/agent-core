import SpecCnl.Elab

/-!
# The admitted propositions of the RunSettle group (§5.2)

One declaration per `SpecCnl.Corpus.Units.RunSettle` record. The sentence text lives only
in the corpus, so a proposition here cannot drift from the record binding it to its SPEC
rule unit and its digest.
-/

namespace SpecCnl.Sentences

def cnl_C13_RUN_ADMISSION_REGISTRY : Prop := cnl_unit% "C13_RUN_ADMISSION_REGISTRY"

def cnl_C13_RUN_ACCEPTANCE_SUBJECT : Prop := cnl_unit% "C13_RUN_ACCEPTANCE_SUBJECT"

def cnl_C13_RUN_FORCED_CANCELLATION : Prop := cnl_unit% "C13_RUN_FORCED_CANCELLATION"

def cnl_C13_RUN_FRONTIER_COMPLETE : Prop := cnl_unit% "C13_RUN_FRONTIER_COMPLETE"

def cnl_C13_RUN_SETTLED_DERIVED : Prop := cnl_unit% "C13_RUN_SETTLED_DERIVED"

end SpecCnl.Sentences
