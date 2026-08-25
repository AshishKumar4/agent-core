import SpecCnl.Elab

/-!
# The admitted propositions

One declaration per corpus unit. Each is the elaboration of that unit's reviewed
controlled-language sentence, and the sentence text appears nowhere here: `cnl_unit%`
reads it from `SpecCnl.Corpus`, so a proposition cannot drift from the record that binds
it to its SPEC rule unit and its digest.

Every declaration below is a kernel-checked `Prop` over `AgentCore`. That is the whole
claim about this file. Whether the sentence means what the rule unit means is a review
question, recorded in the corpus record's `dropped` list and settled by a human.
-/

namespace SpecCnl.Sentences

def cnl_C13_RUN_ANCESTRY : Prop := cnl_unit% "C13_RUN_ANCESTRY"

def cnl_C13_SUBSCRIPTION_ACCEPTED_TIERS : Prop := cnl_unit% "C13_SUBSCRIPTION_ACCEPTED_TIERS"

def cnl_C13_TRUST_VERIFIED_INGRESS : Prop := cnl_unit% "C13_TRUST_VERIFIED_INGRESS"

def cnl_C13_TURN_LEASE_EXPIRY : Prop := cnl_unit% "C13_TURN_LEASE_EXPIRY"

def cnl_C13_EFFECT_ATTEMPT_IMMUTABLE : Prop := cnl_unit% "C13_EFFECT_ATTEMPT_IMMUTABLE"

def cnl_C13_RECEIPT_ID_NAMESPACE : Prop := cnl_unit% "C13_RECEIPT_ID_NAMESPACE"

def cnl_C13_RUN_GRAPH_ARITY : Prop := cnl_unit% "C13_RUN_GRAPH_ARITY"

def cnl_C13_RUN_UNDO_FENCE : Prop := cnl_unit% "C13_RUN_UNDO_FENCE"

def cnl_C13_AUTH_GUEST_VERIFICATION : Prop := cnl_unit% "C13_AUTH_GUEST_VERIFICATION"

def cnl_C13_CONTENT_RESOLUTION : Prop := cnl_unit% "C13_CONTENT_RESOLUTION"

def cnl_C13_RUN_ACCEPTANCE_OBLIGATION : Prop := cnl_unit% "C13_RUN_ACCEPTANCE_OBLIGATION"

end SpecCnl.Sentences
