import SpecCnl.Corpus
import SpecCnl.Lexicon

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
-/

namespace SpecCnl.Adversarial

/-- How a sentence must be refused. Distinguishing the kinds is the point: "no reading"
and "two readings" are opposite defects. -/
inductive Kind where
  /-- Outside the controlled alphabet. -/
  | alphabet
  /-- No reading of the whole span is a sentence. -/
  | noReading
  /-- More than one reading is, with this many distinct readings. -/
  | ambiguous (readings : Nat)
  deriving DecidableEq, Repr, Inhabited

def Kind.render : Kind → String
  | .alphabet => "alphabet"
  | .noReading => "no-reading"
  | .ambiguous readings => s!"ambiguous({readings})"

structure Case where
  sentence : String
  kind : Kind
  /-- Why this sentence must not be admitted. -/
  reason : String
  deriving Repr, Inhabited

def cases : List Case :=
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
      reason := "three-way coordination. `or` is binary, so a three-term list has a left \
        and a right reading. The grammar has no list construct, and rather than pick one \
        association it refuses the sentence. Two-term coordination is what the corpus \
        exercises and therefore all that is shipped" },
    { sentence :=
        "every effect step preserves disjoint receipt ids and every effect step preserves \
         disjoint receipt ids and every effect step preserves disjoint receipt ids"
      kind := .ambiguous 2
      reason := "the same defect at sentence level. Conjunction is associative in meaning, \
        which is exactly why the grammar must not silently choose: an ambiguity it \
        tolerates here is one it would tolerate where association changes the reading" } ]

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
