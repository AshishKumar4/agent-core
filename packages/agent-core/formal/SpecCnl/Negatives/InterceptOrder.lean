import SpecCnl.Negative

namespace SpecCnl.Adversarial.Negatives.InterceptOrder

def cases : List Case :=
  [ { sentence := "every foreign question admits no asserted tier"
      kind := .noReading
      reason := "the verb admits relates an InterceptionQuestion to an InterceptorContribution, while an asserted tier is a TrustTier noun; the ontology refuses the otherwise grammatical pairing" },
    { sentence := "every gate firing maintains an unchanged value"
      kind := .noReading
      reason := "an unchanged value is a postcondition over the successor state, while maintains takes a two-state relation; a postcondition cannot stand in for that relation" },
    { sentence := "every interception step maintains replay consistency"
      kind := .noReading
      reason := "replay consistency is a one-state invariant, while maintains takes a two-state relation; the category mismatch refuses the nearby connective swap" },
    { sentence := "the admitted interceptor schedule is transitive"
      kind := .noReading
      reason := "the admitted interceptor schedule is a state-relative relation over a question, candidate list, and schedule, not a binary relation over one type as is transitive requires" },
    { sentence := "every effect step preserves prepared invocation immutability"
      kind := .noReading
      reason := "prepared invocation immutability is a two-state relation, while preserves takes a one-state invariant; the nearby connective swap is refused rather than coerced" } ]

end SpecCnl.Adversarial.Negatives.InterceptOrder
