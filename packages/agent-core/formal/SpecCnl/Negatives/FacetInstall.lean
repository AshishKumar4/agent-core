import SpecCnl.Negative

/-!
# FacetInstall: hostile near-misses

Each case is a real misreading of one of this group's own sentences: the policy mistaken
for the ledger it gates, a payload condition left unlifted, an invariant offered where a
two-state relation is wanted and the converse, coordination attempted below the sentence
level, and three clauses joined by the ordinary coordinator instead of the delimited
three-clause form.
-/

namespace SpecCnl.Adversarial.Negatives.FacetInstall

def cases : List Case :=
  [ { sentence := "every slot step admits its landed contributions"
      kind := .noReading
      reason := "the contribute-authority policy is not the ledger it gates. `admits its \
        landed contributions` needs a policy as an individual on its left, and `every slot \
        step` is a transition family over a SlotLedger and a SlotLabel. The policy is a \
        parameter of AgentCore.AuthorizedSlotStep rather than a field of the ledger, which \
        is exactly why the sentence quantifies over policies instead of over steps" },
    { sentence := "every contribute authority policy determines the segments it joins"
      kind := .noReading
      reason := "the ontology refuses it. Both halves are this group's own vocabulary and \
        the sentence is well-formed English: `determines the segments it joins` is a \
        property of a separator character, and `every contribute authority policy` \
        quantifies over AgentCore.SlotContributeAuthority. Nothing but the category type \
        keeps a §1.4 naming rule and a §4.2 admission rule apart" },
    { sentence := "every slot contribution requires an unclaimed entry id"
      kind := .noReading
      reason := "an unlifted payload condition. `an unclaimed entry id` is a condition on \
        a SlotEntry and `requires` needs one on the transition's label, so the contribute \
        label match cannot be left implicit — `for the contribution` is the entry that \
        scopes it" },
    { sentence := "every slot step maintains unique contribution origins"
      kind := .noReading
      reason := "`maintains` takes a two-state relation and `unique contribution origins` \
        is a one-state invariant. Origin exclusivity is a property of one ledger that \
        every step preserves, not a relation between the ledgers either side of a step" },
    { sentence := "every environment step preserves disposed facet finality"
      kind := .noReading
      reason := "the converse clash on the disposal sentence. `preserves` takes a \
        one-state invariant and `disposed facet finality` is a two-state relation: that a \
        closed session record survives a step is not a property the source state alone \
        can have" },
    { sentence :=
        "every valid placement is declared by the manifest and is admitted by the trust set"
      kind := .noReading
      reason := "coordination below the sentence level. Sentence-level `and` takes a \
        sentence on each side, and `is admitted by the trust set` is a verb phrase; \
        conjoining two predicates of one subject would need coordination at the verb \
        phrase, which the grammar does not have. The corpus sentence repeats the subject \
        instead" },
    { sentence :=
        "every valid placement is declared by the manifest and every valid placement is \
         admitted by the trust set and every slot contribution requires a declared slot \
         for the contribution"
      kind := .ambiguous 2
      reason := "three clauses joined by the ordinary coordinator. `and` is binary and \
        conjunction is associative in meaning, so the grammar refuses rather than choose \
        an association — which is why the install-verification sentence uses the \
        explicitly delimited `and additionally` form for its third clause" } ]

end SpecCnl.Adversarial.Negatives.FacetInstall
