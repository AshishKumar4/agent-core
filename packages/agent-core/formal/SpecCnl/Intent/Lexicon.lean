import SpecCnl.Entries.Intent.Lease
import SpecCnl.Intent.Grammar
import SpecCnl.Lexicon

/-!
# The intent lexicon and intent admission

One table, extending the controlled language's own. The chart, the unification, the
deduplication by reading key, the exact linearisation round trip and the ascribed Lean
emission are all `SpecCnl.Parse`; the only difference is the target category. There is no
second parser, so there is nothing for a second parser to drift from.

Four rules govern this table, the four at the head of `SpecCnl.Lexicon`, plus one this
language needs and the controlled language does not: **no surface may carry both a `TR` and
a `GD` entry**. Were one word to carry both, a sentence could have an `S` reading and an
`IN` reading, and which one it meant would depend on which admission path a caller used. A
ratification pin names one reading of one sentence, so the sentence itself has to determine
its target category.

`three` is a domain-free numeral and belongs beside `two` in `SpecCnl.Lexicon`. It ships
here because only an intent record exercises it and the controlled-language gate refuses an
unexercised entry; it moves the moment a rule unit needs it.
-/

namespace SpecCnl.Intent

/-! ## Grammar entries

Domain-free, `SpecCnl.Grammar` style. `require` and the controlled language's `requires` are
different surfaces, and a duplicate surface is refused only for the same category, so the
two paradigms cannot collide on one word by accident.

The complete paradigm has `preserve`, `maintain`, `establish` and `are impossible` too. They
are not here: an unexercised paradigm cell is not shipped, and each lands with the first
record that needs it. -/

private def grammarEntries : List LexEntry :=
  [ { id := "intent.requires"
      surface := "require"
      category := "(GD[s,l]\\IN[s,l])/ST[s,l]"
      denotation := "SpecCnl.Intent.inRequires" },
    { id := "intent.possible"
      surface := "are possible"
      category := "GD[s,l]\\IN[s,l]"
      denotation := "SpecCnl.Intent.inPossible" },
    { id := "intent.possible.where"
      surface := "are possible where"
      category := "(GD[s,l]\\IN[s,l])/ST[s,l]"
      denotation := "SpecCnl.Intent.inPossibleWhere" },
    { id := "intent.and"
      surface := "and"
      category := "(IN[s,l]\\IN[s,l])/IN[s,l]"
      denotation := "SpecCnl.Intent.inAnd" },
    { id := "three"
      surface := "three"
      category := "NU[s,p]"
      denotation := "SpecCnl.nuLiteral 3" } ]

/-- Every entry this language adds to the controlled language's table. -/
def addedEntries : List LexEntry := grammarEntries ++ Entries.Intent.Lease.entries

/-- The table the intent language admits against. -/
def lexicon : List LexEntry := _root_.SpecCnl.lexicon ++ addedEntries

/-! ## Polarity by connective -/

/-- One intent connective, the polarity it gives an atom, and the theorem that proves the
polarity of its denotation. The theorem name is pinned, so a connective cannot acquire a
polarity by assertion. -/
structure Connective where
  entry : String
  polarity : Polarity
  polarityTheorem : String
  deriving Repr, Inhabited

def connectives : List Connective :=
  [ { entry := "intent.requires"
      polarity := .safety
      polarityTheorem := "SpecCnl.Intent.inRequires_downward" },
    { entry := "intent.possible"
      polarity := .permission
      polarityTheorem := "SpecCnl.Intent.inPossible_upward" },
    { entry := "intent.possible.where"
      polarity := .permission
      polarityTheorem := "SpecCnl.Intent.inPossibleWhere_upward" } ]

/-- The entry that joins atoms. It gives no atom a polarity of its own: a conjunction
inherits one only when both sides have it, and every stage-1 record is mixed, so the checker
flattens the conjunction into an atom set and splits that set instead of asking. The two
theorems are the inheritance rule itself. -/
structure Conjunction where
  entry : String
  polarityTheorems : List String
  deriving Repr, Inhabited

def conjunction : Conjunction :=
  { entry := "intent.and"
    polarityTheorems :=
      ["SpecCnl.Intent.inAnd_downward", "SpecCnl.Intent.inAnd_upward"] }

/-- The polarity a head gives its atom, or `none` when the head is not a connective. -/
def polarityOf (head : String) : Option Polarity :=
  (connectives.find? (fun connective => connective.entry == head)).map Connective.polarity

/-! ## Admission -/

/-- Whether a category is an intent atom over some ledger. -/
def isIntentCat : Cat → Bool
  | .in_ _ _ => true
  | _ => false

/-- The ledger a resolved intent category names. An unresolved slot is refused: a derivation
that left the ledger open has no denotation to check and no ledger to be checked against. -/
def ledgerOf : Cat → Except String (String × String)
  | .in_ state label => do return (← state.interp, ← label.interp)
  | other => .error s!"category {other.render} is not an intent"

/-- The one `IN` reading of a sentence, or the refusal. Two readings, no reading, an inexact
round trip and an unresolved ledger are all refusals, and a two-reading refusal carries both
rendered readings, which is the counterexample a human needs to pick between them. -/
def readIntent (sentence : String) : Except String Item := do
  let item ← readingOf isIntentCat "an intent" lexicon sentence
  match ledgerOf item.cat with
  | .error message => throw s!"refused: '{sentence}' leaves its ledger unresolved: {message}"
  | .ok _ => return item

/-- Admits an intent sentence, or refuses it with the reason. -/
def compileIntent (sentence : String) : Except String Admission := do
  admissionOf lexicon sentence (← readIntent sentence)

/-! ## Refusals -/

/-- Surfaces that carry both a transition-family entry and a guard entry.

This is the one rule the controlled language does not need. A word with both would give one
sentence an `S` reading and an `IN` reading, so which proposition the sentence denoted would
depend on which admission path a caller took. A ratification pin names one reading of one
sentence; the sentence has to determine its own target category. The parameter is the table
rather than `lexicon`, so the rule can be shown to discriminate on a table built to break
it. -/
def overlapRefusals (entries : List LexEntry) : List String := Id.run do
  let mut guards : List String := []
  let mut families : List String := []
  for entry in entries do
    match Cat.ofString entry.category with
    | .error _ => pure ()
    | .ok category =>
        let atoms := category.atomNames
        if atoms.contains "GD" then guards := guards ++ [entry.surface]
        if atoms.contains "TR" then families := families ++ [entry.surface]
  let mut refusals : List String := []
  for surface in guards do
    if families.contains surface && !refusals.any (fun r => r.endsWith s!"'{surface}'") then
      refusals := refusals ++
        [s!"one surface carries both a transition family and an intent guard: '{surface}'"]
  return refusals

/-- Intent entries that produce an intent atom without a polarity theorem covering them. The
checker splits an intent by polarity, so a connective with no polarity has nothing to be
split by, and a verdict computed without it would be about a smaller intent. -/
def polarityRefusals : List String := Id.run do
  let mut refusals : List String := []
  let known := connectives.map Connective.entry
  for entry in addedEntries do
    match Cat.ofString entry.category with
    | .error _ => pure ()
    | .ok category =>
        if category.atomNames.contains "IN" && !known.contains entry.id &&
            entry.id != conjunction.entry then
          refusals := refusals ++
            [s!"intent entry '{entry.id}' produces an intent atom but no polarity theorem \
                covers it"]
  return refusals

/-- Structural refusals of this table: everything `SpecCnl.lexiconRefusalsOf` refuses of any
table, the transition-family/guard overlap rule, and the polarity-coverage rule. -/
def lexiconRefusals : List String :=
  lexiconRefusalsOf lexicon ++ overlapRefusals lexicon ++ polarityRefusals

end SpecCnl.Intent
