import SpecCnl.Elab

/-!
# The admitted propositions of the §7.4 Receipts group

Each declaration elaborates the reviewed sentence its corpus record carries. The sentence
text is not repeated here: `cnl_unit%` reads it from `SpecCnl.Corpus`.
-/

namespace SpecCnl.Sentences

def cnl_C13_RECEIPT_IMMUTABLE : Prop := cnl_unit% "C13_RECEIPT_IMMUTABLE"

def cnl_C13_RECEIPT_FAILURE_ORTHOGONAL : Prop := cnl_unit% "C13_RECEIPT_FAILURE_ORTHOGONAL"

def cnl_C13_BATCH_OUTCOME_COMPLETE : Prop := cnl_unit% "C13_BATCH_OUTCOME_COMPLETE"

def cnl_C13_AUDIT_ROUTE_BRIDGE : Prop := cnl_unit% "C13_AUDIT_ROUTE_BRIDGE"

def cnl_C13_AUDIT_TELEMETRY_EXCLUDED : Prop := cnl_unit% "C13_AUDIT_TELEMETRY_EXCLUDED"

end SpecCnl.Sentences
