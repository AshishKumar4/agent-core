import SpecCnl.Elab

/-!
# The admitted propositions of the Auth group

One declaration per `SpecCnl.Corpus.Units.Auth` record. The sentence text lives only in
the corpus, so a proposition here cannot drift from the record binding it to its SPEC rule
unit and its digest.
-/

namespace SpecCnl.Sentences

def cnl_C13_AUTH_DENY_PRECEDENCE : Prop := cnl_unit% "C13_AUTH_DENY_PRECEDENCE"

def cnl_C13_AUTH_GUEST_ELEVATION : Prop := cnl_unit% "C13_AUTH_GUEST_ELEVATION"

def cnl_C13_AUTH_GUEST_HANDSHAKE_BOOTSTRAP : Prop :=
  cnl_unit% "C13_AUTH_GUEST_HANDSHAKE_BOOTSTRAP"

def cnl_C13_AUTH_PRINCIPAL_REF : Prop := cnl_unit% "C13_AUTH_PRINCIPAL_REF"

def cnl_C13_AUTH_PLANE : Prop := cnl_unit% "C13_AUTH_PLANE"

def cnl_C13_AUTH_ROLE_MATERIALIZATION : Prop := cnl_unit% "C13_AUTH_ROLE_MATERIALIZATION"

def cnl_C13_AUTH_BINDING_RESOLUTION : Prop := cnl_unit% "C13_AUTH_BINDING_RESOLUTION"

def cnl_C13_AUTH_MEDIATED_STALE : Prop := cnl_unit% "C13_AUTH_MEDIATED_STALE"

def cnl_C13_AUTH_RESOLUTION_LIFETIME : Prop := cnl_unit% "C13_AUTH_RESOLUTION_LIFETIME"

end SpecCnl.Sentences
