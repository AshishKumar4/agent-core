import Lean
import SpecCnl.Intent.Adversarial

/-!
# The intent elaborators

Glue, and only glue, exactly as `SpecCnl.Elab` is. Everything here starts from one call to
`readIntent` — the one grammar — and turns the term source that reading emits into a Lean
term. Nothing tokenises, unifies, checks ambiguity, or linearises on its own.

Four forms, and the reason there are four is that every statement a record makes has to be
*derived from the record's own parse* rather than written beside it:

* `intent% "<key>"` — the denotation of an atom or a record: `Lts σ lab → Prop`.
* `intent_split% "<key>"` — the same reading, split by polarity into the `Split` the
  contradiction checker reads. The safety half is the parse's own guard and condition
  sub-terms; the permission half is the permission atoms as they stand.
* `intent_claim% "<key>"` — the Prop the record's expected verdict asserts, built from the
  record's verdict and its ledger's step relation.
* `intent_at_model% "<key>"` — an atom instantiated at its ledger's step relation, which is
  the left side of the bridge to the controlled language.

A record's proof therefore cannot be a proof of something else. The claim it inhabits, the
split it reasons through, and the denotation it is about are all this file's output for that
one record key, and the shape check in `SpecCnl.Intent.Report` refuses a proof whose type is
not the claim its record owns.
-/

namespace SpecCnl.Intent

open Lean Elab Term

/-- The polarity split of a reading, as source text.

`intent.and` is flattened rather than interpreted, which is what makes an intent a *set* of
atoms. A safety atom contributes its guard and its condition as a `Guarded` record; the
guard and the condition are the parse's own sub-terms, so what the checker splits and what
the sentence says cannot differ. A permission contributes its whole denotation.

The fuel budget is what makes this total; a reading is finite, and the budget is the number
of tokens, which bounds the depth of any derivation over them. -/
private def splitSource : Nat → Item → Except String (List String × List String)
  | 0, _ => .error "the intent split exhausted its fuel budget"
  | fuel + 1, item =>
      match item.head, item.args with
      | "intent.and", [right, left] => do
          let (leftSafety, leftPermissions) ← splitSource fuel left
          let (rightSafety, rightPermissions) ← splitSource fuel right
          return (leftSafety ++ rightSafety, leftPermissions ++ rightPermissions)
      | "intent.requires", [cond, guard] => do
          let guardSource ← toLean lexicon guard
          let condSource ← toLean lexicon cond
          return ([s!"\{ guard := {guardSource}, cond := {condSource} }"], [])
      | "intent.possible", [_] => do return ([], [← toLean lexicon item])
      | "intent.possible.where", [_, _] => do return ([], [← toLean lexicon item])
      | head, args =>
          .error s!"'{head}' with {args.length} arguments is not an intent connective"

/-- The reading a key names, whether it is an atom or a record. -/
private def readingForKey (key : String) : Except String Item :=
  match atomWithKey? key with
  | some atom => readIntent atom.sentence
  | none =>
      match recordWithKey? key with
      | some record => do readIntent (← record.sentence)
      | none => .error s!"no intent atom or record '{key}'"

/-- The ledger a key's reading is over, taken from the ledger table rather than from the
reading, so a row that renamed its step relation cannot leave a claim naming the old one. -/
private def ledgerForKey (key : String) : Except String Ledger :=
  let named :=
    match atomWithKey? key with
    | some atom => some atom.ledger
    | none => (recordWithKey? key).map IntentRecord.ledger
  match named with
  | none => .error s!"no intent atom or record '{key}'"
  | some ledger =>
      match ledgerWithKey? ledger with
      | none => .error s!"'{key}' names no registered ledger '{ledger}'"
      | some row => .ok row

private def splitTermSource (item : Item) : Except String String := do
  let (state, label) ← ledgerOf item.cat
  let (safety, permissions) ← splitSource (item.heads.length + 1) item
  return s!"(\{ safety := [{String.intercalate ", " safety}], \
             permissions := [{String.intercalate ", " permissions}] } : \
             SpecCnl.Intent.Split ({state}) ({label}))"

private def claimSource (key : String) (item : Item) : Except String String := do
  let row ← ledgerForKey key
  let record ← match recordWithKey? key with
    | some record => pure record
    | none => .error s!"'{key}' is not an intent record, so it claims no verdict"
  let (state, label) ← ledgerOf item.cat
  let intent ← toLean lexicon item
  let anyBound :=
    s!"((SpecCnl.Intent.anyTransition) : SpecCnl.Intent.Lts ({state}) ({label}))"
  let atStep := s!"SpecCnl.Intent.SatAt ({row.step}) ({intent})"
  let atUniverse := s!"SpecCnl.Intent.SatAt {anyBound} ({intent})"
  match record.expected with
  | .consistent => return atStep
  | .inconsistent => return s!"¬ ({atUniverse})"
  | .outsideModel => return s!"({atUniverse}) ∧ ¬ ({atStep})"
  | .unproved =>
      .error s!"intent record '{key}' expects UNPROVED, which asserts nothing to prove"

private def atModelSource (key : String) (item : Item) : Except String String := do
  let row ← ledgerForKey key
  return s!"SpecCnl.Intent.atModel ({← toLean lexicon item}) ({row.step})"

/-- Elaborates term source the intent language produced. -/
private def elabIntentSource (reference : Syntax) (source : String) (expected : Option Expr) :
    TermElabM Expr := do
  match Parser.runParserCategory (← getEnv) `term source "<intent language>" with
  | .error message => throwErrorAt reference s!"emitted term did not parse: {message}"
  | .ok term => elabTerm term expected

private def elabFromKey (reference : Syntax) (key : String) (expected : Option Expr)
    (build : String → Item → Except String String) : TermElabM Expr := do
  match readingForKey key with
  | .error message => throwErrorAt reference message
  | .ok item =>
      match build key item with
      | .error message => throwErrorAt reference message
      | .ok source => elabIntentSource reference source expected

/-- `intent% "<key>"` — the denotation of the intent atom or record with this key. -/
elab (name := intentDenotation) "intent% " key:str : term =>
  elabFromKey key key.getString none (fun _ item => toLean lexicon item)

/-- `intent_split% "<key>"` — the same reading, split by polarity. -/
elab (name := intentSplit) "intent_split% " key:str : term =>
  elabFromKey key key.getString none (fun _ item => splitTermSource item)

/-- `intent_claim% "<key>"` — the Prop the record's expected verdict asserts. -/
elab (name := intentClaim) "intent_claim% " key:str : term =>
  elabFromKey key key.getString (some (mkSort Level.zero)) claimSource

/-- `intent_at_model% "<key>"` — the atom instantiated at its ledger's step relation. -/
elab (name := intentAtModel) "intent_at_model% " key:str : term =>
  elabFromKey key key.getString (some (mkSort Level.zero)) atModelSource

/-- `intent_text% "<sentence>"` — elaborates a literal intent sentence.

This is the hostile-corpus form, and it exists for the reason `cnl%` exists: a refusal that
only appeared in a report could be reported and ignored, while an elaboration error cannot
be. Production records use `intent% "<key>"`, so a record's sentence lives in exactly one
place. -/
elab (name := intentText) "intent_text% " sentence:str : term => do
  match readIntent sentence.getString with
  | .error message => throwErrorAt sentence message
  | .ok item =>
      match toLean lexicon item with
      | .error message => throwErrorAt sentence message
      | .ok source => elabIntentSource sentence source none

end SpecCnl.Intent
