/-!
# Categorial types of the controlled language

The controlled language is a lexicalised applicative categorial grammar. A category is
either an atom carrying the Lean types it ranges over, or a directional application
`A/B` (argument on the right) or `B\A` (argument on the left). Application is the only
rule: there is no composition and no type raising, so two derivations of one span are
always two readings and never one reading twice.

`Cat.interp` maps a category to the Lean type its denotation must inhabit. That map is
what makes a category a *checked* claim about the model rather than a label: the
elaborator ascribes every leaf its interpreted type, so a lexicon entry whose denotation
does not inhabit its declared category is a Lean type error.

Atoms are fixed by the shape of the model, which is a labelled transition system:

| category  | interpretation      | reads as                                    |
| --------- | ------------------- | ------------------------------------------- |
| `S`       | `Prop`              | a sentence                                  |
| `NP[t]`   | `t`                 | an individual                               |
| `CN[t]`   | `t -> Prop`         | a common noun, a one-state invariant        |
| `PR[t]`   | `t -> t -> Prop`    | a two-state relation                        |
| `TR[s,l]` | `s -> l -> s -> Prop` | a transition family                       |
| `ST[s,l]` | `s -> l -> Prop`    | a condition on source state and label       |
| `NU[s,l]` | `s -> l -> Nat`     | a quantity read off source state and label  |
| `RE[s,a,b]` | `s -> a -> b -> Prop` | a state-relative relation                 |

Nothing here is domain content. Every content word's denotation is a term over
`AgentCore` alone.
-/

namespace SpecCnl

/-- A category type argument: a named Lean type, or a slot a derivation must pin down.
A single lowercase-initial identifier with no dot is a variable; anything else is a
constant. That convention is enforced by `Ty.ofString`, not assumed. -/
inductive Ty where
  | con (name : String)
  | var (name : String)
  deriving DecidableEq, Repr, Inhabited

/-- A categorial type. `fwd r a` is `r/a` and `bwd a r` is `a\r`; in both the argument is
`a` and the result is `r`, so direction is the only difference. -/
inductive Cat where
  | s
  | np (ty : Ty)
  | cn (ty : Ty)
  | pr (ty : Ty)
  | tr (state label : Ty)
  | st (state label : Ty)
  | nu (state label : Ty)
  | re (state key value : Ty)
  | fwd (result arg : Cat)
  | bwd (arg result : Cat)
  deriving DecidableEq, Repr, Inhabited

/-- A resolution of category type variables. Extension always applies the current
resolution first, so a lookup needs no repeated substitution. -/
abbrev Subst := List (String × Ty)

namespace Ty

def isVarName (name : String) : Bool :=
  match name.toList with
  | [] => false
  | head :: rest => head.isLower && rest.all (fun c => c.isAlphanum)

def isConName (name : String) : Bool :=
  !name.isEmpty &&
    name.all (fun c => c.isAlphanum || c == '.' || c == '_') &&
    !name.startsWith "." && !name.endsWith "."

/-- Reads a category type argument. Fails closed: a name that is neither a well-formed
variable nor a well-formed constant is refused rather than defaulted. -/
def ofString (name : String) : Except String Ty :=
  if isVarName name then .ok (.var name)
  else if isConName name then .ok (.con name)
  else .error s!"malformed category type argument '{name}'"

def render : Ty → String
  | .con name => name
  | .var name => name

/-- Resolves a type argument under a substitution, following chains.

Unification records variable-to-variable bindings, so `a` may resolve to `b` while `b`
resolves to a constant. A single lookup would stop at `b` and report an unresolved slot
for a derivation that is in fact fully determined, so the chase is load-bearing rather
than defensive. The fuel bound is the substitution's own length: each step consumes one
distinct binding, so a well-formed substitution always terminates before it runs out, and
a malformed cyclic one stops with a variable that `interp` then refuses. -/
private def chase (σ : Subst) : Nat → Ty → Ty
  | 0, ty => ty
  | _ + 1, .con name => .con name
  | fuel + 1, .var name =>
      match σ.lookup name with
      | some ty => chase σ fuel ty
      | none => .var name

def apply (σ : Subst) (ty : Ty) : Ty := chase σ (σ.length + 1) ty

def freshen (tag : Nat) : Ty → Ty
  | .con name => .con name
  | .var name => .var s!"{name}#{tag}"

/-- Unification over a flat sort: no occurs check is possible because a type argument
never contains another. -/
def unify (σ : Subst) (left right : Ty) : Except String Subst :=
  match left.apply σ, right.apply σ with
  | .con a, .con b =>
      if a == b then .ok σ else .error s!"type clash: {a} against {b}"
  | .var a, .var b => if a == b then .ok σ else .ok ((a, Ty.var b) :: σ)
  | .var a, ty => .ok ((a, ty) :: σ)
  | ty, .var b => .ok ((b, ty) :: σ)

/-- The Lean type a category type argument denotes. An unresolved variable is refused:
a derivation that leaves a slot open has no denotation to check. -/
def interp : Ty → Except String String
  | .con name => .ok name
  | .var name => .error s!"unresolved category type variable '{name}'"

end Ty

namespace Cat

def apply (σ : Subst) : Cat → Cat
  | .s => .s
  | .np ty => .np (ty.apply σ)
  | .cn ty => .cn (ty.apply σ)
  | .pr ty => .pr (ty.apply σ)
  | .tr state label => .tr (state.apply σ) (label.apply σ)
  | .st state label => .st (state.apply σ) (label.apply σ)
  | .nu state label => .nu (state.apply σ) (label.apply σ)
  | .re state key value => .re (state.apply σ) (key.apply σ) (value.apply σ)
  | .fwd result arg => .fwd (result.apply σ) (arg.apply σ)
  | .bwd arg result => .bwd (arg.apply σ) (result.apply σ)

def freshen (tag : Nat) : Cat → Cat
  | .s => .s
  | .np ty => .np (ty.freshen tag)
  | .cn ty => .cn (ty.freshen tag)
  | .pr ty => .pr (ty.freshen tag)
  | .tr state label => .tr (state.freshen tag) (label.freshen tag)
  | .st state label => .st (state.freshen tag) (label.freshen tag)
  | .nu state label => .nu (state.freshen tag) (label.freshen tag)
  | .re state key value => .re (state.freshen tag) (key.freshen tag) (value.freshen tag)
  | .fwd result arg => .fwd (result.freshen tag) (arg.freshen tag)
  | .bwd arg result => .bwd (arg.freshen tag) (result.freshen tag)

def unify (σ : Subst) : Cat → Cat → Except String Subst
  | .s, .s => .ok σ
  | .np a, .np b => Ty.unify σ a b
  | .cn a, .cn b => Ty.unify σ a b
  | .pr a, .pr b => Ty.unify σ a b
  | .tr a b, .tr c d => do Ty.unify (← Ty.unify σ a c) b d
  | .st a b, .st c d => do Ty.unify (← Ty.unify σ a c) b d
  | .nu a b, .nu c d => do Ty.unify (← Ty.unify σ a c) b d
  | .re a b c, .re d e f => do Ty.unify (← Ty.unify (← Ty.unify σ a d) b e) c f
  | .fwd r₁ a₁, .fwd r₂ a₂ => do Cat.unify (← Cat.unify σ r₁ r₂) a₁ a₂
  | .bwd a₁ r₁, .bwd a₂ r₂ => do Cat.unify (← Cat.unify σ a₁ a₂) r₁ r₂
  | left, right => .error s!"category clash: {repr left} against {repr right}"

/-- The Lean type a denotation of this category must inhabit. -/
def interp : Cat → Except String String
  | .s => .ok "Prop"
  | .np ty => ty.interp
  | .cn ty => do return s!"({← ty.interp}) → Prop"
  | .pr ty => do let t ← ty.interp; return s!"({t}) → ({t}) → Prop"
  | .tr state label => do
      let σ ← state.interp
      return s!"({σ}) → ({← label.interp}) → ({σ}) → Prop"
  | .st state label => do return s!"({← state.interp}) → ({← label.interp}) → Prop"
  | .nu state label => do return s!"({← state.interp}) → ({← label.interp}) → Nat"
  | .re state key value => do
      return s!"({← state.interp}) → ({← key.interp}) → ({← value.interp}) → Prop"
  | .fwd result arg => do return s!"({← arg.interp}) → ({← result.interp})"
  | .bwd arg result => do return s!"({← arg.interp}) → ({← result.interp})"

/-- Surface form of a category, in the notation the lexicon and the ledger use. -/
def render : Cat → String
  | .s => "S"
  | .np ty => s!"NP[{ty.render}]"
  | .cn ty => s!"CN[{ty.render}]"
  | .pr ty => s!"PR[{ty.render}]"
  | .tr state label => s!"TR[{state.render},{label.render}]"
  | .st state label => s!"ST[{state.render},{label.render}]"
  | .nu state label => s!"NU[{state.render},{label.render}]"
  | .re state key value => s!"RE[{state.render},{key.render},{value.render}]"
  | .fwd result arg => s!"({result.render}/{arg.render})"
  | .bwd arg result => s!"({arg.render}\\{result.render})"

/-! ### Reading a category from its surface notation

The lexicon and the emitted ledger both carry categories as text, so the text is the
interchange form and `Cat.ofString` is its only reader. `/` and `\` are left associative
at one precedence, matching the notation used in the categorial-grammar literature;
parentheses disambiguate. Recursion is bounded by an explicit fuel budget, so every
reader below is total. -/

private def isNameChar (c : Char) : Bool :=
  c.isAlphanum || c == '.' || c == '_' || c == '#'

private def takeName (input : List Char) : String × List Char :=
  (String.ofList (input.takeWhile isNameChar), input.dropWhile isNameChar)

private def expect (c : Char) (input : List Char) : Except String (List Char) :=
  match input with
  | head :: rest => if head == c then .ok rest else .error s!"expected '{c}', found '{head}'"
  | [] => .error s!"expected '{c}', found the end of the category"

private def readTy (input : List Char) : Except String (Ty × List Char) := do
  let (name, rest) := takeName input
  return (← Ty.ofString name, rest)

private def binaryAtom (name : String) (state label : Ty) : Except String Cat :=
  match name with
  | "TR" => .ok (.tr state label)
  | "ST" => .ok (.st state label)
  | "NU" => .ok (.nu state label)
  | _ => .error s!"unknown two-argument category atom '{name}'"

private def ternaryAtom (name : String) (state key value : Ty) : Except String Cat :=
  match name with
  | "RE" => .ok (.re state key value)
  | _ => .error s!"unknown three-argument category atom '{name}'"

private def unaryAtom (name : String) (ty : Ty) : Except String Cat :=
  match name with
  | "NP" => .ok (.np ty)
  | "CN" => .ok (.cn ty)
  | "PR" => .ok (.pr ty)
  | _ => .error s!"unknown one-argument category atom '{name}'"

mutual

private def readAtom : Nat → List Char → Except String (Cat × List Char)
  | 0, _ => .error "category notation exhausted its fuel budget"
  | fuel + 1, input =>
      match input with
      | '(' :: rest => do
          let (inner, rest) ← readCat fuel rest
          return (inner, ← expect ')' rest)
      | _ => do
          let (name, rest) := takeName input
          if name == "S" then return (.s, rest)
          if name == "NP" || name == "CN" || name == "PR" then
            let rest ← expect '[' rest
            let (ty, rest) ← readTy rest
            return (← unaryAtom name ty, ← expect ']' rest)
          if name == "TR" || name == "ST" || name == "NU" then
            let rest ← expect '[' rest
            let (state, rest) ← readTy rest
            let rest ← expect ',' rest
            let (label, rest) ← readTy rest
            return (← binaryAtom name state label, ← expect ']' rest)
          if name == "RE" then
            let rest ← expect '[' rest
            let (state, rest) ← readTy rest
            let rest ← expect ',' rest
            let (key, rest) ← readTy rest
            let rest ← expect ',' rest
            let (value, rest) ← readTy rest
            return (← ternaryAtom name state key value, ← expect ']' rest)
          .error s!"unknown category atom '{name}'"

private def readChain : Nat → Cat → List Char → Except String (Cat × List Char)
  | 0, _, _ => .error "category notation exhausted its fuel budget"
  | fuel + 1, left, input =>
      match input with
      | '/' :: rest => do
          let (arg, rest) ← readAtom fuel rest
          readChain fuel (.fwd left arg) rest
      | '\\' :: rest => do
          let (result, rest) ← readAtom fuel rest
          readChain fuel (.bwd left result) rest
      | rest => .ok (left, rest)

private def readCat : Nat → List Char → Except String (Cat × List Char)
  | 0, _ => .error "category notation exhausted its fuel budget"
  | fuel + 1, input => do
      let (head, rest) ← readAtom fuel input
      readChain fuel head rest

end

/-- Reads a category from the notation `render` emits. -/
def ofString (text : String) : Except String Cat := do
  let input := text.toList.filter (fun c => !c.isWhitespace)
  let (category, rest) ← readCat (input.length + 1) input
  if rest.isEmpty then return category
  else .error s!"trailing category notation '{String.ofList rest}'"

end Cat

end SpecCnl
