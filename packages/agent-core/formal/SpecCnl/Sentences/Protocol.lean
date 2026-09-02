import SpecCnl.Elab

/-!
# The admitted propositions of the Protocol group (§8.1, §8.4, §8.5)

Each declaration reads its sentence from the registered corpus unit, preserving the binding
between its reviewed sentence, digest, and four audited declarations.
-/

namespace SpecCnl.Sentences

def cnl_C13_OWNERSHIP_ACTOR_CONTRACT : Prop := cnl_unit% "C13_OWNERSHIP_ACTOR_CONTRACT"

def cnl_C13_OWNERSHIP_SINGLE_OWNER : Prop := cnl_unit% "C13_OWNERSHIP_SINGLE_OWNER"

def cnl_C13_PROTOCOL_REJECTION_ROOT : Prop := cnl_unit% "C13_PROTOCOL_REJECTION_ROOT"

end SpecCnl.Sentences
