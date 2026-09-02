import SpecCnl.Elab

/-!
# The admitted propositions of the §7.4 claims group

One declaration per corpus unit. The sentence text appears nowhere here: `cnl_unit%` reads
it from `SpecCnl.Corpus`, so a proposition cannot drift from the record that binds it to
its rule unit and its digest.
-/

namespace SpecCnl.Sentences

def cnl_C13_CLAIM_INITIAL_ATOMIC : Prop := cnl_unit% "C13_CLAIM_INITIAL_ATOMIC"

def cnl_C13_CLAIM_RECOVERY_NO_ATTEMPT : Prop := cnl_unit% "C13_CLAIM_RECOVERY_NO_ATTEMPT"

def cnl_C13_ATTEMPT_ORDINAL_AFTER_FAILURE : Prop :=
  cnl_unit% "C13_ATTEMPT_ORDINAL_AFTER_FAILURE"

def cnl_C13_EFFECT_WRITE_AHEAD : Prop := cnl_unit% "C13_EFFECT_WRITE_AHEAD"

end SpecCnl.Sentences
