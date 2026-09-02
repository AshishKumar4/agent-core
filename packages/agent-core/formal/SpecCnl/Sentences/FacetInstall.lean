import SpecCnl.Elab

/-!
# FacetInstall: the admitted propositions

One declaration per bridged unit of the group. The sentence text lives only in
`SpecCnl.Corpus.Units.FacetInstall`; `cnl_unit%` reads it from there.
-/

namespace SpecCnl.Sentences

def cnl_C13_FACET_REF_CANONICAL : Prop := cnl_unit% "C13_FACET_REF_CANONICAL"

def cnl_C13_FACET_SLOT_AUTHORITY : Prop := cnl_unit% "C13_FACET_SLOT_AUTHORITY"

def cnl_C13_FACET_DISPOSAL : Prop := cnl_unit% "C13_FACET_DISPOSAL"

def cnl_C13_FACET_INSTALL_VERIFICATION : Prop := cnl_unit% "C13_FACET_INSTALL_VERIFICATION"

def cnl_C13_FACET_CONTRIBUTION_ATTRIBUTION : Prop :=
  cnl_unit% "C13_FACET_CONTRIBUTION_ATTRIBUTION"

end SpecCnl.Sentences
