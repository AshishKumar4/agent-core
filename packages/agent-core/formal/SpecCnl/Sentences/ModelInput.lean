import SpecCnl.Elab

/-!
# ModelInput: the admitted propositions

One declaration for this group's one bridged unit. The sentence text is not repeated
here; `cnl_unit%` reads it from `SpecCnl.Corpus`.
-/

namespace SpecCnl.Sentences

def cnl_C13_TURN_MODEL_INPUT_RETENTION_LOSS : Prop :=
  cnl_unit% "C13_TURN_MODEL_INPUT_RETENTION_LOSS"

end SpecCnl.Sentences
