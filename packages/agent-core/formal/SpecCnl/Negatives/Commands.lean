import SpecCnl.Negative

/-!
# Hostile near-misses for the Commands group (§4.3)

Each case is a real misreading of one of this group's four sentences: a payload condition
without its lifter, a lifted condition offered where a two-state relation is wanted, a
postcondition offered where a source-state condition is wanted, a bare common noun in
subject position, three-way ordinary coordination, and one grammatical sentence the model
refuses because the relation ranges over the wrong ledger.
-/

namespace SpecCnl.Adversarial.Negatives.Commands

def cases : List Case :=
  [ { sentence := "every command install requires an unregistered surface name"
      kind := .noReading
      reason := "an unlifted payload condition. `an unregistered surface name` is a \
        relation over a Scope and a declaration, and `requires` needs a condition on the \
        transition's label, so the install label match cannot be left implicit" },
    { sentence :=
        "every command step maintains an unregistered surface name for the installed command"
      kind := .noReading
      reason := "the lifter does not produce a two-state relation. Scoping the \
        Scope-and-declaration condition under the install label yields a condition on the \
        source state and the label, and `maintains` takes a relation between the two \
        states, so the two are kept apart" },
    { sentence := "every command install requires the derived route defaults"
      kind := .noReading
      reason := "the converse clash on the same ledger. `the derived route defaults` \
        relates the registry before an installation to the registry after it, and \
        `requires` takes a condition on the source state alone, so a claim about the \
        stored record cannot be read as a precondition" },
    { sentence := "command declaration derives an exact subscription"
      kind := .noReading
      reason := "a bare common noun in subject position. A common noun is a predicate on \
        declarations, not a declaration, so it needs a determiner before the derivation \
        clause can apply to it" },
    { sentence :=
        "every command install maintains an exactly derived stored route and every \
         command declaration derives an exact subscription and every command install \
         maintains the derived route defaults"
      kind := .ambiguous 2
      reason := "three-way ordinary `and` coordination. Sentence-level `and` is binary, \
        so a three-clause chain has a left and a right reading; the separately typed `and \
        additionally` form is the only three-clause shape that ships, and it is not what \
        this sentence uses" },
    { sentence := "every command invocation requires a validated operation input"
      kind := .noReading
      reason := "a postcondition where a precondition is wanted. `a validated operation \
        input` reads the state after the invocation — that is where the appended record \
        is — and `requires` takes a condition on the source state and the label, so the \
        execution-time guarantee cannot masquerade as an entry guard" },
    { sentence := "every command install requires a passed destination for the installed command"
      kind := .noReading
      reason := "the model refuses a grammatical sentence. `a passed destination` is a \
        relation over a DynamicDomain, a Binding, and a destination, while the \
        installed-command lifter wants one over a CommandRegistry, a Scope, and a \
        declaration. Two payload relations that compose in English are kept apart by the \
        ledger they range over" } ]

end SpecCnl.Adversarial.Negatives.Commands
