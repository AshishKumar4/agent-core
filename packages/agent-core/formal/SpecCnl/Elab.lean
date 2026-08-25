import Lean
import SpecCnl.Corpus
import SpecCnl.Lexicon

/-!
# The elaborator

Glue, and only glue. It calls `SpecCnl.compile` — the one grammar — and turns the term
source that returns into a Lean `Prop`. It performs no tokenising, no category algebra,
no ambiguity check and no linearisation of its own, so there is no second implementation
to drift from the first.

Everything that can refuse a sentence refuses it here, at elaboration time, and a refusal
is a Lean error rather than a warning:

* the sentence uses a character outside the controlled alphabet;
* no reading of it is a sentence;
* more than one reading of it is a sentence;
* the single reading linearises back to a different string;
* a reading leaves a category type slot unresolved; or
* a head's denotation does not inhabit the type its category interprets to — this last
  one is the model refusing the sentence, and it is checked by Lean rather than by the
  grammar.

`cnl_unit%` is the production form: it takes a corpus key, so the sentence text lives in
exactly one place, `SpecCnl.Corpus`. `cnl%` takes a literal sentence and exists for the
hostile corpus, where the point is that a sentence is *refused*.
-/

namespace SpecCnl

open Lean Elab Term

/-- Elaborates an admitted controlled-language sentence at `Prop`. -/
def elabAdmission (reference : Syntax) (sentence : String) : TermElabM Expr := do
  match compile lexicon sentence with
  | .error message => throwErrorAt reference message
  | .ok admission =>
      match Parser.runParserCategory (← getEnv) `term admission.lean "<controlled language>" with
      | .error message =>
          throwErrorAt reference s!"emitted term did not parse: {message}"
      | .ok term => elabTerm term (some (mkSort Level.zero))

/-- `cnl% "<sentence>"` — elaborates a literal controlled-language sentence. -/
elab (name := cnlLiteral) "cnl% " sentence:str : term =>
  elabAdmission sentence sentence.getString

/-- `cnl_unit% "<key>"` — elaborates the reviewed sentence of a corpus unit. The sentence
text is not repeated here, so a proposition cannot drift from the record that binds it to
its SPEC rule unit. -/
elab (name := cnlUnit) "cnl_unit% " key:str : term => do
  match Corpus.find? key.getString with
  | none => throwErrorAt key s!"no corpus unit '{key.getString}'"
  | some unit => elabAdmission key unit.sentence

end SpecCnl
