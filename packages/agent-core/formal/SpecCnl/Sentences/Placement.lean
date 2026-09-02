import SpecCnl.Elab

/-!
# The admitted Placement propositions

One declaration per §9.2, §7.2, and §3.5 placement unit. The sentence text lives in
`SpecCnl.Corpus.Units.Placement` and nowhere else.
-/

namespace SpecCnl.Sentences

def cnl_C13_PLACEMENT_INTERSECTION : Prop := cnl_unit% "C13_PLACEMENT_INTERSECTION"

def cnl_C13_PLACEMENT_UNTRUSTED_BUNDLED : Prop :=
  cnl_unit% "C13_PLACEMENT_UNTRUSTED_BUNDLED"

def cnl_C13_POLICY_DIRECT_COLOCATION : Prop := cnl_unit% "C13_POLICY_DIRECT_COLOCATION"

def cnl_C13_POLICY_MEDIATION_FLOOR : Prop := cnl_unit% "C13_POLICY_MEDIATION_FLOOR"

def cnl_C13_POLICY_EPOCH_RECHECK : Prop := cnl_unit% "C13_POLICY_EPOCH_RECHECK"

def cnl_C13_CONFIG_SECRET_CUSTODY : Prop := cnl_unit% "C13_CONFIG_SECRET_CUSTODY"

end SpecCnl.Sentences
