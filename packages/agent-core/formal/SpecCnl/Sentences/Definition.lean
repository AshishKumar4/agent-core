import SpecCnl.Elab

/-!
# Definition: the admitted propositions

One declaration per bridged unit of the group. The sentence text lives only in
`SpecCnl.Corpus.Units.Definition`; `cnl_unit%` reads it from there.
-/

namespace SpecCnl.Sentences

def cnl_C13_BLUEPRINT_CONVERGENCE : Prop := cnl_unit% "C13_BLUEPRINT_CONVERGENCE"

def cnl_C13_PACKAGE_DEPENDENCY_DECLARED : Prop :=
  cnl_unit% "C13_PACKAGE_DEPENDENCY_DECLARED"

end SpecCnl.Sentences
