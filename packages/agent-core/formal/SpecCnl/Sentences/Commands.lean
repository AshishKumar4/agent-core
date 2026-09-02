import SpecCnl.Elab

/-!
# The admitted propositions of the Commands group (§4.3)

One declaration per corpus unit. The sentence text appears nowhere here: `cnl_unit%`
reads it from `SpecCnl.Corpus`, so a proposition cannot drift from the record that binds
it to its rule unit and its digest.
-/

namespace SpecCnl.Sentences

def cnl_C13_COMMAND_COLLISION : Prop := cnl_unit% "C13_COMMAND_COLLISION"

def cnl_C13_COMMAND_SUBSCRIPTION_DEFAULTS : Prop :=
  cnl_unit% "C13_COMMAND_SUBSCRIPTION_DEFAULTS"

def cnl_C13_COMMAND_INVOCATION_CORRELATION : Prop :=
  cnl_unit% "C13_COMMAND_INVOCATION_CORRELATION"

def cnl_C13_COMMAND_ARGUMENT_BINDING : Prop := cnl_unit% "C13_COMMAND_ARGUMENT_BINDING"

end SpecCnl.Sentences
