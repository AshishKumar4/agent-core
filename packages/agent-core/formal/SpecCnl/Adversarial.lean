import SpecCnl.Corpus
import SpecCnl.Lexicon
import SpecCnl.Negative
import SpecCnl.Negatives.Auth
import SpecCnl.Negatives.Commands
import SpecCnl.Negatives.FacetInstall
import SpecCnl.Negatives.Isolate
import SpecCnl.Negatives.Placement
import SpecCnl.Negatives.RunGraph

/-!
# The adversarial corpus

Two kinds of evidence that admission is doing work, both computed by the same `compile`
that admits the corpus.

**The negative corpus.** Sentences that must be refused, each with the reviewed reason and
the refusal kind expected. A negative sentence that starts being *admitted* is a grammar
defect, and so is one refused for a different reason than the one recorded: a type clash
that degrades into "no reading" would mean the ontology stopped rejecting it.

**Scrambles.** Every adjacent-token transposition of every corpus sentence. Linearisation
recomputes surface order from each head's category rather than storing it, so if the
grammar accepted a scramble the round-trip check would be reproducing a string the parser
would have taken in any order, and would be worth nothing.

Negative cases are grouped by SPEC domain, one module per group under `SpecCnl/Negatives/`,
and `cases` below is their concatenation, exactly as the corpus is assembled.
-/

namespace SpecCnl.Adversarial

/-- The first reviewed group of negative cases: the ones written against the instrument's
own first sentences. Later groups live in `SpecCnl/Negatives/`. -/
private def coreCases : List Case :=
  [ { sentence := "Every published event has no asserted tier"
      kind := .alphabet
      reason := "capitalisation. The controlled alphabet is lowercase letters and single \
        spaces, so no normalisation step stands between the reviewed text and the parse" },
    { sentence := "every published event has no asserted tier."
      kind := .alphabet
      reason := "a full stop. Punctuation would have to be normalised away, and a \
        normalisation step is where two readings become one" },
    { sentence := "requires an unheld branch every undo append"
      kind := .noReading
      reason := "word order. `requires` takes its condition to the right and its \
        transition family to the left, and the grammar has no composition rule to \
        recover a permutation" },
    { sentence := "every lease reclaim requires an unheld branch for the appended commit"
      kind := .noReading
      reason := "the ontology refuses it. The sentence is grammatical English, and it is \
        rejected only because the condition ranges over GraphStore while the transition \
        family ranges over TurnLease. This is the model rejecting a sentence, which is \
        the property worth having" },
    { sentence := "every effect step preserves attempt immutability"
      kind := .noReading
      reason := "`preserves` takes a one-state invariant and `attempt immutability` is a \
        two-state relation. Immutability is not an invariant of a single state, and the \
        categories keep the two apart" },
    { sentence := "every effect step maintains disjoint receipt ids"
      kind := .noReading
      reason := "the converse clash: `maintains` takes a two-state relation and \
        `disjoint receipt ids` is a one-state invariant" },
    { sentence := "every tier predicate is the accepted set of subscription"
      kind := .noReading
      reason := "a bare common noun in object position. A common noun is a predicate, not \
        an individual, so it needs a determiner to become one" },
    { sentence := "published event has no asserted tier"
      kind := .noReading
      reason := "a bare common noun in subject position, for the same reason" },
    { sentence := "ancestry depends only on ancestry"
      kind := .noReading
      reason := "`depends only on` takes a state projection on the right and a \
        state-relative relation on the left. `ancestry` is a relation, not a projection, \
        so the two positions are not interchangeable" },
    { sentence := "every merge append requires the parent count equals two"
      kind := .noReading
      reason := "an unlifted payload condition. `the parent count equals two` is a \
        condition on a commit, and `requires` needs a condition on the transition's \
        label, so the label match cannot be left implicit" },
    { sentence :=
        "every content resolve requires a home tenant or a granted tenant or a home \
         tenant for the resolved reference"
      kind := .ambiguous 2
      reason := "three-way ordinary `or` coordination. `or` is binary, so a three-term \
        list has a left and a right reading. No list construct or final `or` coordinator \
        ships, so rather than pick an association the grammar refuses the sentence. The \
        separately typed `and additionally` form is available only for explicit \
        three-sentence conjunctions" },
    { sentence :=
        "every effect step preserves disjoint receipt ids and every effect step preserves \
         disjoint receipt ids and every effect step preserves disjoint receipt ids"
      kind := .ambiguous 2
      reason := "the same defect at sentence level. Conjunction is associative in meaning, \
        which is exactly why the grammar must not silently choose: an ambiguity it \
        tolerates here is one it would tolerate where association changes the reading" },
    { sentence := "every secret step maintains carrier refs only"
      kind := .noReading
      reason := "the nearby misreading of the custody sentence. `maintains` takes a \
        two-state relation and `carrier refs only` is a one-state invariant, so reading \
        the ref-only rule as a relation between the states either side of a step is \
        refused rather than silently accepted as the invariant it is not" },
    { sentence := "every content step preserves an unowned reference"
      kind := .noReading
      reason := "the converse nearby misreading. `preserves` takes a one-state invariant \
        and `an unowned reference` is a condition on a state and a payload, so a \
        precondition cannot be smuggled in as an invariant" },
    { sentence := "every secret step is transitive"
      kind := .noReading
      reason := "the ontology refuses it. `is transitive` takes a binary relation over one \
        type; a transition family is a relation over a state, a label, and a state, and \
        the two are not interchangeable however similar the English reads" },
    { sentence := "every routing step maintains an unconsumed event key for the firing"
      kind := .noReading
      reason := "the label match is not optional in the other direction either. Lifting a \
        firing-payload condition under the firing label yields a condition, not a \
        two-state relation, so `maintains` refuses it" },
    { sentence := "every isolate egress requires a passed destination"
      kind := .noReading
      reason := "an unlifted payload condition, on a second domain. `a passed destination` \
        is a relation over a Binding and a destination, and `requires` needs a condition \
        on the transition's label, so the egress label match cannot be left implicit" },
    { sentence := "every environment step requires a live current session"
      kind := .noReading
      reason := "the same defect for a session-scoped use: the condition ranges over a \
        SessionUse and the transition over an EnvironmentLabel, so the use projection \
        cannot be left implicit" },
    { sentence := "every template materialization requires an unmaterialized template"
      kind := .noReading
      reason := "the same defect once more, and the reason the lifter is a separate entry \
        rather than a match inside the condition's own denotation" },
    { sentence := "every secret resolve requires a home tenant for the resolved secret"
      kind := .noReading
      reason := "the model refuses a grammatical sentence. `a home tenant` is a relation \
        over a ContentLedger, a ContentRef, and a Tenant; the resolved-secret lifter wants \
        one over a SecretLedger, a SecretRef, and a Tenant. Two custody rules that read \
        almost identically in English are kept apart by the ledger they range over" },
    { sentence := "every content collect requires an unowned reference for the resolved reference"
      kind := .noReading
      reason := "two lifters of one domain are not interchangeable. The resolved-reference \
        lifter scopes a reference-and-Tenant relation under a resolve label; `an unowned \
        reference` is a condition on a reference alone, so pairing them is refused" },
    { sentence := "the parent count is at most two for the appended commit"
      kind := .noReading
      reason := "a lifted condition is not a sentence. Without a transition family there \
        is nothing for the bound to be a bound of, and the grammar has no way to supply \
        the missing quantifier" },
    { sentence := "interceptor ordering is at most two"
      kind := .noReading
      reason := "a relation is not a quantity. `is at most` compares two quantities read \
        off a source state and a label, and an order over contributions is neither" },
    { sentence :=
        "every audit step maintains a typed lower local cause and recorded entry immutability"
      kind := .noReading
      reason := "coordination at the wrong level. Sentence-level `and` takes a sentence on \
        each side, and `recorded entry immutability` is a two-state relation. Conjoining \
        the two invariants would need coordination at the relation level, which the \
        grammar does not have and which this corpus therefore does not report" },
    { sentence := "every fresh isolate step requires a passed destination"
      kind := .noReading
      reason := "the fresh-state family cannot recover the egress payload. `a passed \
        destination` is a Binding-and-Destination relation, while `requires` needs a \
        condition on the IsolateLabel; the egress lifter remains necessary even when the \
        source state is known exactly" },
    { sentence := "approval mapping is transitive"
      kind := .noReading
      reason := "a functional state-relative mapping is not a binary relation over one \
        domain. `is transitive` takes `PR`, whereas an approval lookup is `RE` over a \
        ledger, an InvocationId, and an ApprovalId" },
    { sentence := "every duplicate submission establishes a recorded original reply"
      kind := .noReading
      reason := "the duplicate write id cannot be left implicit. `a recorded original \
        reply` is a payload-indexed postcondition, while `establishes` needs a \
        postcondition on the SubmissionLabel; the `for the duplicate` lifter is what \
        ties that id to the resubmit label" },
    { sentence := "every session close establishes disposed child facets"
      kind := .noReading
      reason := "the same post-state payload rule on a second label family. `disposed \
        child facets` is indexed by the SessionId a close label carries; without `for \
        the closed session`, the grammar refuses the missing label-to-payload binding" },
    { sentence := "every duplicate submission establishes every duplicate submission"
      kind := .noReading
      reason := "`PO` is deliberately distinct from `TR` despite sharing its Lean type. \
        A transition family says which steps exist; a postcondition says what those steps \
        establish. Letting the former stand in for the latter would make the new grammar \
        form tautological, so the category mismatch is refused" } ]

/-- The whole negative corpus: every reviewed group, concatenated. A group is appended
here and nowhere else. -/
def cases : List Case :=
  coreCases ++ Negatives.Auth.cases ++ Negatives.Isolate.cases ++ Negatives.Commands.cases ++
    Negatives.FacetInstall.cases ++ Negatives.Placement.cases ++ Negatives.RunGraph.cases

/-- Adjacent-token transpositions of a sentence, dropping any that reproduce the input. -/
def scrambles (sentence : String) : List String :=
  let tokens := tokenise sentence
  let swapped := (List.range (tokens.length - 1)).map (fun index =>
    String.intercalate " "
      (tokens.take index ++
        [tokens.getD (index + 1) "", tokens.getD index ""] ++
        tokens.drop (index + 2)))
  swapped.filter (fun candidate => candidate != sentence)

/-- Every scramble of every corpus sentence. -/
def allScrambles : List String := Corpus.units.flatMap (fun unit => scrambles unit.sentence)

/-- How `compile` actually refused a sentence, or `none` when it admitted it. -/
def observedKind (sentence : String) : Option Kind :=
  if (sentenceRefusal sentence).isSome then some .alphabet
  else
    match readings lexicon (tokenise sentence).toArray with
    | .error _ => some .noReading
    | .ok [] => some .noReading
    | .ok [_] => none
    | .ok found => some (.ambiguous found.length)

/-- Negative cases whose refusal is absent or is not the recorded kind. Both are defects:
an admitted negative sentence, and one refused for the wrong reason. -/
def negativeFailures : List String :=
  cases.filterMap (fun case =>
    match observedKind case.sentence with
    | none => some s!"'{case.sentence}' was admitted; it must be refused as {case.kind.render}"
    | some observed =>
        if observed == case.kind then none
        else some
          s!"'{case.sentence}' was refused as {observed.render}, not {case.kind.render}")

/-- Scrambles the grammar admitted. Every one is a defect. -/
def admittedScrambles : List String :=
  allScrambles.filter (fun sentence => (compile lexicon sentence).toOption.isSome)

/-- Corpus sentences whose single reading does not linearise back to the sentence. `compile`
already refuses those, so this recomputes the evidence rather than trusting it. -/
def roundTripFailures : List String :=
  Corpus.units.filterMap (fun unit =>
    match readings lexicon (tokenise unit.sentence).toArray with
    | .ok [item] =>
        match linearise lexicon item with
        | .ok words =>
            let rebuilt := String.intercalate " " words
            if rebuilt == unit.sentence then none
            else some s!"'{unit.sentence}' linearises as '{rebuilt}'"
        | .error message => some s!"'{unit.sentence}' does not linearise: {message}"
    | _ => some s!"'{unit.sentence}' does not have exactly one reading")

end SpecCnl.Adversarial
