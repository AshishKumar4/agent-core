import SpecCnl.Category

/-!
# The grammar: chart, typed semantic AST, linearisation, and Lean emission

This module is the whole grammar. Nothing else parses the controlled language: the
elaborator in `SpecCnl.Elab` calls `compile` below and does no analysis of its own, and
the emitted ledger reports what `compile` returned. There is one implementation, so
there is nothing for a second implementation to drift from.

`Item` is simultaneously the chart entry, the derivation, and the **typed
controlled-language semantic AST**. A node is a lexical head with its arguments in
*semantic application order*; surface order is not stored anywhere. `Item.linearise`
recomputes the surface string by walking the head's own category and placing each
argument left or right according to that slash's direction, so an exact round trip is
evidence that the recorded structure determines the sentence, not a string echo.

The AST is not a first-order-logic term. Its node denotations are arbitrary Lean terms
of the type its category interprets to, which is how transition families, two-state
relations, and state-and-label conditions are expressed at all.
-/

namespace SpecCnl

/-- A reviewed weakness of a lexicon entry. These are not diagnostics: each names a way
the entry is less discriminating than its English reads, and the ledger reports them so
the weakening is visible rather than implied. -/
inductive Caveat where
  /-- The denotation is `fun _ => True`: the entry carries no restriction, so it cannot
  refuse a wrong noun. -/
  | typeAsCommonNoun
  deriving DecidableEq, Repr, Inhabited

def Caveat.render : Caveat → String
  | .typeAsCommonNoun => "type-as-common-noun"

/-- One lexicon entry. `category` and `denotation` are reviewed source text; the
elaborator ascribes the denotation the type `category` interprets to, so a mismatch is a
Lean type error rather than a lexicon comment. -/
structure LexEntry where
  id : String
  surface : String
  category : String
  denotation : String
  caveats : List Caveat := []
  deriving Repr, Inhabited

/-- Chart entry, derivation, and typed semantic AST in one structure.

* `cat` is the category of the constituent.
* `head` is the lexical head's entry id and `headCat` its own instantiated category.
* `args` are the head's arguments in semantic application order.
-/
inductive Item where
  | node (cat headCat : Cat) (head : String) (args : List Item)
  deriving Repr, Inhabited

namespace Item

def cat : Item → Cat
  | .node c _ _ _ => c

def head : Item → String
  | .node _ _ h _ => h

def headCat : Item → Cat
  | .node _ hc _ _ => hc

def args : Item → List Item
  | .node _ _ _ a => a

/-- A canonical string identifying the reading. Two items with the same key are the same
derivation; distinct keys at `S` over the whole span are distinct readings. -/
def key : Item → String
  | .node _ _ h args => s!"{h}({String.intercalate "," (args.attach.map (fun ⟨a, _⟩ => a.key))})"

def apply (σ : Subst) : Item → Item
  | .node c hc h args =>
      .node (c.apply σ) (hc.apply σ) h (args.attach.map (fun ⟨a, _⟩ => a.apply σ))

/-- Every lexical head the reading uses, in first-encounter order of the AST spine. -/
def heads : Item → List String
  | .node _ _ h args => h :: (args.attach.map (fun ⟨a, _⟩ => a.heads)).flatten

/-- Applies one argument, extending the head's category by one slash. -/
def applyArg (result : Cat) (fn arg : Item) : Item :=
  .node result fn.headCat fn.head (fn.args ++ [arg])

end Item

/-! ## Tokenising

A controlled-language sentence is lowercase words separated by single spaces. No
punctuation, no capitalisation, no digits: those would need normalisation before an
exact round trip, and a normalisation step is a place for two readings to become one.
-/

def sentenceRefusal (sentence : String) : Option String :=
  if sentence.isEmpty then some "the sentence is empty"
  else if sentence.startsWith " " || sentence.endsWith " " then
    some "the sentence has leading or trailing space"
  else if (sentence.splitOn "  ").length != 1 then some "the sentence has a double space"
  else match sentence.toList.find? (fun c => !(c.isLower || c == ' ')) with
    | some c => some s!"the sentence contains '{c}'; only lowercase letters and single spaces are admitted"
    | none => none

def tokenise (sentence : String) : List String :=
  (sentence.splitOn " ").filter (fun token => !token.isEmpty)

/-! ## The chart

Application is the only rule, so a cell holds every constituent spanning `[i, j)` and a
constituent is built exactly once per (split point, functor, argument) triple. Multiword
lexemes need no special case: a lexical entry matches whatever span joins to its surface.
-/

private def combineForward (fn arg : Item) : Option Item :=
  match fn.cat with
  | .fwd result argCat =>
      match Cat.unify [] argCat arg.cat with
      | .ok σ => some ((Item.applyArg result fn arg).apply σ)
      | .error _ => none
  | _ => none

private def combineBackward (arg fn : Item) : Option Item :=
  match fn.cat with
  | .bwd argCat result =>
      match Cat.unify [] argCat arg.cat with
      | .ok σ => some ((Item.applyArg result fn arg).apply σ)
      | .error _ => none
  | _ => none

/-- Every reading of `tokens` under `lex`, as chart cells indexed by `i * width + j`. -/
def chart (lex : List LexEntry) (tokens : Array String) :
    Except String (Array (List Item)) := do
  let size := tokens.size
  let width := size + 1
  let mut cells : Array (List Item) := Array.replicate (width * width) []
  for length in [1 : size + 1] do
    for start in [0 : size + 1 - length] do
      let stop := start + length
      let surface := String.intercalate " " (tokens.extract start stop).toList
      let tag := start * width + stop
      let mut items : List Item := []
      for entry in lex do
        if entry.surface == surface then
          match Cat.ofString entry.category with
          | .error message =>
              throw s!"lexicon entry '{entry.id}' has a malformed category: {message}"
          | .ok category =>
              let category := category.freshen tag
              items := .node category category entry.id [] :: items
      for split in [start + 1 : stop] do
        let left := cells[start * width + split]?.getD []
        let right := cells[split * width + stop]?.getD []
        for fn in left do
          for arg in right do
            if let some built := combineForward fn arg then items := built :: items
        for arg in left do
          for fn in right do
            if let some built := combineBackward arg fn then items := built :: items
      cells := cells.setIfInBounds tag items
  return cells

/-- The distinct sentence readings of the whole span, deduplicated by reading rather than
by construction: two chart entries with the same AST are one reading. -/
def readings (lex : List LexEntry) (tokens : Array String) : Except String (List Item) := do
  let cells ← chart lex tokens
  let whole := cells[tokens.size]?.getD []
  let mut seen : List String := []
  let mut distinct : List Item := []
  for item in whole do
    if item.cat == Cat.s then
      let identity := item.key
      if !seen.contains identity then
        seen := identity :: seen
        distinct := distinct ++ [item]
  return distinct

/-! ## Linearisation and Lean emission

Both walk the same AST. Nothing stores surface order: `linearise` derives it from each
head's own category, so the recorded structure is what determines the sentence.
-/

private def lookupEntry (lex : List LexEntry) (id : String) : Except String LexEntry :=
  match lex.find? (fun entry => entry.id == id) with
  | some entry => .ok entry
  | none => .error s!"no lexicon entry '{id}'"

private structure Placement where
  before : List String := []
  after : List String := []
  remaining : Cat

private def place (state : Placement) (words : List String) : Except String Placement :=
  match state.remaining with
  | .fwd result _ => .ok { state with after := state.after ++ words, remaining := result }
  | .bwd _ result => .ok { state with before := words ++ state.before, remaining := result }
  | other =>
      .error s!"head category {other.render} takes no further argument"

/-- Recomputes the surface word sequence from the AST. -/
def linearise (lex : List LexEntry) : Item → Except String (List String)
  | .node _ headCat head args => do
      let entry ← lookupEntry lex head
      let mut state : Placement := { remaining := headCat }
      for ⟨arg, _⟩ in args.attach do
        state ← place state (← linearise lex arg)
      return state.before ++ tokenise entry.surface ++ state.after

/-- Emits the Lean term. Every head is ascribed the type its category interprets to, so
the model, not the grammar, decides whether the reading denotes anything. -/
def toLean (lex : List LexEntry) : Item → Except String String
  | .node _ headCat head args => do
      let entry ← lookupEntry lex head
      let mut term := s!"(({entry.denotation}) : {← headCat.interp})"
      for ⟨arg, _⟩ in args.attach do
        term := s!"({term} {← toLean lex arg})"
      return term

/-- The AST in reviewable form: head, category, and arguments in application order. -/
def renderAst (lex : List LexEntry) : Item → Except String String
  | .node cat _ head args => do
      let _ ← lookupEntry lex head
      let rendered ← args.attach.mapM (fun ⟨arg, _⟩ => renderAst lex arg)
      let arguments := if rendered.isEmpty then "" else s!"({String.intercalate ", " rendered})"
      return s!"{head}{arguments} : {cat.render}"

/-! ## Admission -/

/-- What an admitted sentence yields. `lean` is the emitted term source; `ast` is the
reviewable semantic AST; `heads` is every lexicon entry the reading used. -/
structure Admission where
  sentence : String
  lean : String
  ast : String
  heads : List String
  deriving Repr, Inhabited

/-- Admits a controlled-language sentence, or refuses it with the reason.

A sentence is admitted only when it has **exactly one** reading of category `S`, that
reading linearises back to the sentence **exactly**, and every head's denotation
inhabits the type its category interprets to. Two readings, no reading, an unresolved
category slot, or a linearisation that differs by one word are all refusals. -/
def compile (lex : List LexEntry) (sentence : String) : Except String Admission := do
  if let some reason := sentenceRefusal sentence then
    throw s!"refused: {reason}"
  let tokens := (tokenise sentence).toArray
  let parses ← readings lex tokens
  match parses with
  | [] => throw s!"refused: no reading of '{sentence}' as a sentence"
  | [item] =>
      let relinearised := String.intercalate " " (← linearise lex item)
      if relinearised != sentence then
        throw s!"refused: '{sentence}' linearises back as '{relinearised}'"
      return {
        sentence,
        lean := ← toLean lex item,
        ast := ← renderAst lex item,
        heads := item.heads
      }
  | _ =>
      let rendered ← parses.mapM (fun item => renderAst lex item)
      throw s!"refused: '{sentence}' has {parses.length} readings: {String.intercalate " | " rendered}"

end SpecCnl
