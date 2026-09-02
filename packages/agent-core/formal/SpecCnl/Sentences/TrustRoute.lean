import SpecCnl.Elab

/-!
# TrustRoute: the admitted propositions

One declaration per unit of the group. The sentence text lives only in
`SpecCnl.Corpus.Units.TrustRoute`; `cnl_unit%` reads it from there.
-/

namespace SpecCnl.Sentences

def cnl_C13_TRUST_HOST_DERIVED : Prop := cnl_unit% "C13_TRUST_HOST_DERIVED"

def cnl_C13_TRUST_ASSERTION_REJECTION : Prop := cnl_unit% "C13_TRUST_ASSERTION_REJECTION"

def cnl_C13_SUBSCRIPTION_AUTHORITY : Prop := cnl_unit% "C13_SUBSCRIPTION_AUTHORITY"

def cnl_C13_ROUTE_SOURCE_OWNED : Prop := cnl_unit% "C13_ROUTE_SOURCE_OWNED"

def cnl_C13_ROUTE_STABLE_INVOCATION : Prop := cnl_unit% "C13_ROUTE_STABLE_INVOCATION"

end SpecCnl.Sentences
