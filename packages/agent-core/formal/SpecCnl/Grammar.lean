import AgentCore

/-!
# Grammar combinators

The grammar half of the lexicon: determiners, coordination, comparison, and the
connectives that relate a transition family to a condition on it. These carry no domain
knowledge. Every content word's denotation is a term over `AgentCore` alone, and nothing
in this file introduces a domain constant.

## What "before" denotes, stated plainly

The model is a labelled transition system with no temporal operator. A SPEC sentence of
the form "the host does A before doing B" therefore has exactly one faithful rendering
here: *every transition in the B family satisfies A of its source state*. `stHoldsBefore`
is that rendering, and it is definitionally `trRequires` with its arguments exchanged.
The controlled language says "before" because the SPEC says "before"; the proposition is
a precondition on the source state, and no claim of temporal expressiveness is made.
-/

namespace SpecCnl

/-! ## Determiners -/

/-- `every <CN> <VP>` -/
def qEvery {α : Type} (cn vp : α → Prop) : Prop := ∀ x, cn x → vp x

/-- In-situ object quantification, isolated in the determiner. -/
def qSomeObj {α β : Type} (cn : β → Prop) (tv : β → α → Prop) : α → Prop :=
  fun subject => ∃ y, cn y ∧ tv y subject

def qNoObj {α β : Type} (cn : β → Prop) (tv : β → α → Prop) : α → Prop :=
  fun subject => ∀ y, cn y → ¬ tv y subject

/-! ## Coordination -/

/-- `<S> and <S>`. The forward argument is the right conjunct, the backward argument the
left, so the surface order and the conjunction order agree. -/
def sAnd (right left : Prop) : Prop := left ∧ right

/-- The first half of the explicitly delimited three-clause form
`<S> and <S> and additionally <S>`. Its result has category `CJ`, not `S`, so the
ordinary coordinator cannot associate the first sentence around the final pair. -/
def sPair (right left : Prop) : Prop := left ∧ right

/-- Finishes an explicit three-clause conjunction. `additionally` is grammatical
delimitation only: it contributes conjunction, never temporal order or priority. -/
def sAdditionally (right pair : Prop) : Prop := pair ∧ right

/-- `<RE> or <RE>`, pointwise in the state and both arguments. Coordination sits at the
relation level, not at `ST`, because `(A → B) ∨ (A → C)` is strictly stronger than
`A → (B ∨ C)`: coordinating whole conditions would silently claim more than the SPEC
sentence it renders. A lifting entry then scopes the disjunction under one label match. -/
def reOr {σ κ ν : Type} (right left : σ → κ → ν → Prop) : σ → κ → ν → Prop :=
  fun state key value => left state key value ∨ right state key value

/-! ## Transition connectives

`TR[σ,λ]` is a transition family, `ST[σ,λ]` a condition on its source state and label,
`PO[σ,λ]` a condition that may also read the successor, `CN[σ]` a one-state invariant,
and `PR[σ]` a two-state relation. `PO` has the same Lean type as `TR`, but a distinct
category: that distinction prevents a transition family from standing in for the
postcondition it is meant to establish. `PX[σ,k]` is the matching payload-indexed
postcondition. A lifting entry moves it under one label constructor, so no condition
recovers a label payload by matching the label inside its own denotation. -/

/-- `<TR> requires <ST>` -/
def trRequires {σ lab : Type} (cond : σ → lab → Prop) (family : σ → lab → σ → Prop) : Prop :=
  ∀ before label after, family before label after → cond before label

/-- `<ST> holds before every <TR>` — the same proposition as `trRequires`, reached from
the SPEC's ordering wording. See the note at the head of this file. -/
def stHoldsBefore {σ lab : Type} (family : σ → lab → σ → Prop) (cond : σ → lab → Prop) : Prop :=
  ∀ before label after, family before label after → cond before label

/-- `<TR> preserves <CN>` -/
def trPreserves {σ lab : Type} (inv : σ → Prop) (family : σ → lab → σ → Prop) : Prop :=
  ∀ before label after, family before label after → inv before → inv after

/-- `<TR> maintains <PR>` -/
def trMaintains {σ lab : Type} (rel : σ → σ → Prop) (family : σ → lab → σ → Prop) : Prop :=
  ∀ before label after, family before label after → rel before after

/-- `<TR> establishes <PO>` — unlike `requires`, the postcondition may read the state
after the transition. `PO` stays distinct from `TR` even though both inhabit the same
Lean type, so the grammar cannot silently use a transition family as its own conclusion. -/
def trEstablishes {σ lab : Type} (post : σ → lab → σ → Prop)
    (family : σ → lab → σ → Prop) : Prop :=
  ∀ before label after, family before label after → post before label after

/-! ## Quantities

`NU[σ,λ]` is a quantity read off a transition's source state and label. A comparison of
two quantities is a condition on that same source state and label, so comparison lands in
`ST` and composes with every transition connective above. -/

/-- `<NU> is at most <NU>` -/
def nuAtMost {σ lab : Type} (right left : σ → lab → Nat) : σ → lab → Prop :=
  fun before label => left before label ≤ right before label

/-- `<NU> equals <NU>` -/
def nuEquals {σ lab : Type} (right left : σ → lab → Nat) : σ → lab → Prop :=
  fun before label => left before label = right before label

/-- A numeral. Constant in the state and the label. -/
def nuLiteral (value : Nat) {σ lab : Type} : σ → lab → Nat := fun _ _ => value

/-! ## State-relative relations

`RE[σ,κ,ν]` is a relation a state assigns between a key and a value. It is the shape of
`AgentCore.Ancestor` and `AgentCore.GraphStore.HeadTree`, so those bind to it directly
with no wrapper. -/

/-- `<RE> assigns at most one value` — functionality of the relation in its value
argument. This is what the SPEC means by "exactly one" wherever existence is not also
claimed: uniqueness given existence. -/
def reAtMostOneValue {σ κ ν : Type} (rel : σ → κ → ν → Prop) : Prop :=
  ∀ state key left right, rel state key left → rel state key right → left = right

/-- `<RE> depends only on <FN>` — the relation is a function of one projection of the
state alone. -/
def reDependsOnlyOn {σ γ κ ν : Type} (field : σ → γ) (rel : σ → κ → ν → Prop) : Prop :=
  ∀ left right, field left = field right → ∀ key value, rel left key value ↔ rel right key value

/-! ## Relation properties

`PR[τ]` is a binary relation over one type. The transition connectives above read it as a
two-state relation, which is the same shape as an order over a domain type, so the three
properties below apply to both without a second category.

Each one is a property *of* a relation rather than a condition on a state, so it lands at
`S` directly: `<PR> is transitive` is already a sentence. Repeated ordinary `and` remains
ambiguous at three clauses and is refused. A rule that needs exactly three sentence clauses
uses the separate, explicitly delimited `and additionally` form above; it fixes the parse
shape without adding an order claim. -/

/-- `<PR> is transitive` -/
def prTransitive {α : Type} (rel : α → α → Prop) : Prop :=
  ∀ left middle right, rel left middle → rel middle right → rel left right

/-- `<PR> is antisymmetric` — the relation has one direction: two elements that reach each
other are the same element. -/
def prAntisymmetric {α : Type} (rel : α → α → Prop) : Prop :=
  ∀ left right, rel left right → rel right left → left = right

/-- `<PR> is irreflexive` -/
def prIrreflexive {α : Type} (rel : α → α → Prop) : Prop := ∀ element, ¬ rel element element

/-! ## Lexicon type synonyms

Category type arguments are single identifiers, so a higher-order argument type needs a
name. These are bookkeeping for the lexicon, not model content. -/

abbrev CommitTable :=
  AgentCore.GraphStore → AgentCore.CommitId → Option AgentCore.RunCommit

abbrev TierPredicate := AgentCore.TrustTier → Bool

end SpecCnl
