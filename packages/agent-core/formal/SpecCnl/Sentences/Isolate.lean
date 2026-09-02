import SpecCnl.Elab

/-!
# Isolate: the admitted propositions

One declaration per corpus unit of this group. The sentence text is not repeated here;
`cnl_unit%` reads it from `SpecCnl.Corpus`.
-/

namespace SpecCnl.Sentences

def cnl_C13_AUTH_ISOLATE_DELEGATION : Prop := cnl_unit% "C13_AUTH_ISOLATE_DELEGATION"

def cnl_C13_AUTH_ISOLATE_NAMESPACE_CLOSED : Prop :=
  cnl_unit% "C13_AUTH_ISOLATE_NAMESPACE_CLOSED"

def cnl_C13_PLACEMENT_AUTHORED_BACKING : Prop := cnl_unit% "C13_PLACEMENT_AUTHORED_BACKING"

def cnl_C13_SLATE_SKELETON_ARTIFACT : Prop := cnl_unit% "C13_SLATE_SKELETON_ARTIFACT"

end SpecCnl.Sentences
