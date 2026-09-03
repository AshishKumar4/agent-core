import AgentCore

/-!
# The intent language: denotation, polarity, and the lattice lemma

The controlled language of `SpecCnl` renders a SPEC rule unit as a candidate theorem about
the fixed model, and admission demands a proof of it. An *intent* points the other way: it
is a constraint on what a platform may admit, so its denotation is not a `Prop` but a
predicate on transition relations of one ledger.

`Lts σ lab` is the type of those relations. An intent atom denotes `Lts σ lab → Prop`, and
the relation it quantifies over is the one the platform will actually admit. The SPEC model
is an upper bound on it — the platform must not admit what the SPEC forbids — and a ratified
permission is a lower bound: the platform must admit what the intent demands.

Every connective carries a **polarity**, and the polarity is a theorem here rather than a
comment on the lexicon entry:

* safety atoms are downward closed (`Downward`): a platform that admits less still meets
  them;
* permission atoms are upward closed (`Upward`): a platform that admits more still meets
  them.

`sat_iff_rmax` is what makes the contradiction checker exact. Under a bound `M`, an intent
whose safety atoms are pointwise and whose permissions are upward closed is satisfiable if
and only if every permission holds of one particular relation, `rmax M safety` — the
greatest relation below `M` that satisfies every safety atom. So satisfiability needs no
search over relations: it needs one witness per permission, or one refutation.

Nothing in this file introduces a model constant, exactly as `SpecCnl.Grammar` does not.
-/

namespace SpecCnl.Intent

/-! ## The ontology -/

/-- The transition relations of one ledger: what a platform may admit for it. -/
abbrev Lts (σ lab : Type) := σ → lab → σ → Prop

/-- `small` admits no transition `large` refuses. -/
def Refines {σ lab : Type} (small large : Lts σ lab) : Prop :=
  ∀ before label after, small before label after → large before label after

theorem Refines.refl {σ lab : Type} (R : Lts σ lab) : Refines R R := fun _ _ _ step => step

/-- The bound that forbids nothing.

Every relation refines it, which is why the contradiction checker asks about it first: a
permission that no relation at all realises under the intent's own safety atoms is a
contradiction *between the atoms*, not a gap between the intent and the model. -/
def anyTransition {σ lab : Type} : Lts σ lab := fun _ _ _ => True

theorem refines_anyTransition {σ lab : Type} (R : Lts σ lab) : Refines R anyTransition :=
  fun _ _ _ _ => trivial

/-- Instantiation at the ledger's designated step relation: what the intent says about the
SPEC model rather than about an arbitrary platform. This is the bridge to the controlled
language, whose sentences are all statements about exactly this relation. -/
def atModel {σ lab : Type} (intent : Lts σ lab → Prop) (step : Lts σ lab) : Prop := intent step

/-! ## Polarity -/

/-- Downward closed: a platform that admits less still meets the atom. -/
def Downward {σ lab : Type} (intent : Lts σ lab → Prop) : Prop :=
  ∀ R R' : Lts σ lab, Refines R' R → intent R → intent R'

/-- Upward closed: a platform that admits more still meets the atom. -/
def Upward {σ lab : Type} (intent : Lts σ lab → Prop) : Prop :=
  ∀ R R' : Lts σ lab, Refines R R' → intent R → intent R'

/-- The declared polarity of an atom. `safety` claims `Downward` of the atom's denotation
and `permission` claims `Upward`; each claim is a named theorem, so a declared polarity that
is not the connective's real one fails the build rather than misleading the checker. -/
inductive Polarity where
  | safety
  | permission
  deriving DecidableEq, Repr, Inhabited

def Polarity.render : Polarity → String
  | .safety => "safety"
  | .permission => "permission"

/-! ## Connectives

`GD[σ,lab]` is a family guard — which transitions the atom is about — and `ST[σ,lab]` a
condition on a transition's source state and label. A guard is kept categorially distinct
from a condition for the reason `PO` is kept distinct from `TR` in `SpecCnl.Grammar`: were
they interchangeable, `X requires X` would be a tautology the grammar admits.

Each connective carries its own quantifier, so a guard surface reads as a bare plural
rather than `every ...`: `require` is universal over the relation's transitions and
`are possible` is existential over them. -/

/-- `<GD> require <ST>` — every transition the platform admits that the guard selects
satisfies the condition. -/
def inRequires {σ lab : Type} (cond guard : σ → lab → Prop) : Lts σ lab → Prop :=
  fun R => ∀ before label after, R before label after → guard before label → cond before label

/-- `<GD> are possible` — the platform admits at least one transition the guard selects.
This is the form the controlled language has no way to say, and the reason a set of its
sentences can never contradict itself. -/
def inPossible {σ lab : Type} (guard : σ → lab → Prop) : Lts σ lab → Prop :=
  fun R => ∃ before label after, R before label after ∧ guard before label

/-- `<GD> are possible where <ST>` — the platform admits at least one transition the guard
selects that also satisfies the condition. -/
def inPossibleWhere {σ lab : Type} (cond guard : σ → lab → Prop) : Lts σ lab → Prop :=
  fun R => ∃ before label after, R before label after ∧ guard before label ∧ cond before label

/-- `<IN> and <IN>`. The forward argument is the right conjunct and the backward argument
the left, so surface order and conjunction order agree, exactly as `SpecCnl.sAnd`. -/
def inAnd {σ lab : Type} (right left : Lts σ lab → Prop) : Lts σ lab → Prop :=
  fun R => left R ∧ right R

/-! ## Polarity theorems

These are what the checker's soundness rests on. `sat_iff_rmax` takes upward closure of
every permission as a hypothesis, so a connective whose polarity were merely declared could
not be used at all: the record's own proof has to name the theorem. -/

theorem inRequires_downward {σ lab : Type} (cond guard : σ → lab → Prop) :
    Downward (inRequires cond guard) :=
  fun _ _ smaller holds before label after step selected =>
    holds before label after (smaller before label after step) selected

theorem inPossible_upward {σ lab : Type} (guard : σ → lab → Prop) :
    Upward (inPossible guard) := by
  rintro R R' larger ⟨before, label, after, step, selected⟩
  exact ⟨before, label, after, larger before label after step, selected⟩

theorem inPossibleWhere_upward {σ lab : Type} (cond guard : σ → lab → Prop) :
    Upward (inPossibleWhere cond guard) := by
  rintro R R' larger ⟨before, label, after, step, selected, satisfied⟩
  exact ⟨before, label, after, larger before label after step, selected, satisfied⟩

/-- A conjunction inherits a polarity only when both sides have it. A mixed conjunction has
neither, which is why the checker flattens `and` into an atom set and splits that set by
polarity instead of asking for the polarity of the whole sentence. -/
theorem inAnd_downward {σ lab : Type} {right left : Lts σ lab → Prop}
    (downLeft : Downward left) (downRight : Downward right) : Downward (inAnd right left) :=
  fun R R' smaller holds => ⟨downLeft R R' smaller holds.1, downRight R R' smaller holds.2⟩

theorem inAnd_upward {σ lab : Type} {right left : Lts σ lab → Prop}
    (upLeft : Upward left) (upRight : Upward right) : Upward (inAnd right left) :=
  fun R R' larger holds => ⟨upLeft R R' larger holds.1, upRight R R' larger holds.2⟩

/-! ## The polarity split

An intent is a finite set of atoms, so the checker works with the set rather than with the
nested conjunction the sentence produces. `Split` is that set, already divided by polarity.

`Guarded` is a pointwise safety atom in the form the lattice lemma needs. Stage 1's only
safety connective is `require`, whose condition is an `ST` and therefore reads the source
state and the label; `Guarded.holds` is a condition on `(before, label)` for that reason.
When `establishes` lands, `cond` gains the successor state and nothing in `sat_iff_rmax`
changes, because that proof never looks inside `holds`. -/

/-- A pointwise safety atom: the guard that selects the transitions it is about, and the
condition it demands of them. -/
structure Guarded (σ lab : Type) where
  guard : σ → lab → Prop
  cond : σ → lab → Prop

/-- What one safety atom demands of one transition. -/
def Guarded.holds {σ lab : Type} (atom : Guarded σ lab) (before : σ) (label : lab) : Prop :=
  atom.guard before label → atom.cond before label

/-- An intent over one ledger, as the checker reads it: pointwise safety atoms and
permissions. Structural atoms — the controlled language's `PR`, `RE` and `qEvery` sentences,
constant in the relation — have no stage-1 connective that can produce them, so there is no
field for them here; adding one adds a conjunct that does not mention the relation and
leaves every theorem below untouched. -/
structure Split (σ lab : Type) where
  safety : List (Guarded σ lab)
  permissions : List (Lts σ lab → Prop)

/-- Every transition the relation admits satisfies every safety atom. -/
def Pointwise {σ lab : Type} (safety : List (Guarded σ lab)) (R : Lts σ lab) : Prop :=
  ∀ before label after, R before label after → ∀ atom ∈ safety, atom.holds before label

/-- What the split says about a relation. A record's own `splits_` theorem proves this is
the sentence's denotation, so the checker and the proofs cannot be about different intents. -/
def Split.denote {σ lab : Type} (split : Split σ lab) : Lts σ lab → Prop :=
  fun R => Pointwise split.safety R ∧ ∀ permission ∈ split.permissions, permission R

/-! ## The lattice lemma -/

/-- The greatest relation below `bound` that satisfies every safety atom pointwise. -/
def rmax {σ lab : Type} (bound : Lts σ lab) (safety : List (Guarded σ lab)) : Lts σ lab :=
  fun before label after =>
    bound before label after ∧ ∀ atom ∈ safety, atom.holds before label

theorem rmax_refines {σ lab : Type} (bound : Lts σ lab) (safety : List (Guarded σ lab)) :
    Refines (rmax bound safety) bound := fun _ _ _ inside => inside.1

theorem rmax_pointwise {σ lab : Type} (bound : Lts σ lab) (safety : List (Guarded σ lab)) :
    Pointwise safety (rmax bound safety) := fun _ _ _ inside => inside.2

/-- Satisfiability of an intent under a bound: some relation the bound admits meets it. -/
def SatAt {σ lab : Type} (bound : Lts σ lab) (intent : Lts σ lab → Prop) : Prop :=
  ∃ R, Refines R bound ∧ intent R

/-- **The lemma that makes the contradiction check exact.**

For pointwise safety atoms and upward-closed permissions, satisfiability under a bound is
equivalent to every permission holding of one particular relation. So the checker never
searches over relations: it searches for one transition per permission inside
`rmax bound safety`, and a verdict either exhibits those transitions or refutes one
universally. Soundness and completeness of the algorithm are this equivalence, not a
property of the search. -/
theorem sat_iff_rmax {σ lab : Type} (bound : Lts σ lab) (split : Split σ lab)
    (upward : ∀ permission ∈ split.permissions, Upward permission) :
    SatAt bound split.denote ↔
      ∀ permission ∈ split.permissions, permission (rmax bound split.safety) := by
  constructor
  · rintro ⟨R, smaller, pointwise, permitted⟩ permission member
    refine upward permission member R (rmax bound split.safety) ?_ (permitted permission member)
    intro before label after step
    exact ⟨smaller before label after step, pointwise before label after step⟩
  · intro permitted
    exact ⟨rmax bound split.safety, rmax_refines bound split.safety,
      rmax_pointwise bound split.safety, permitted⟩

/-- Dropping safety atoms only widens the greatest satisfying relation. -/
theorem rmax_refines_of_subset {σ lab : Type} (bound : Lts σ lab)
    {safety core : List (Guarded σ lab)} (subset : ∀ atom ∈ core, atom ∈ safety) :
    Refines (rmax bound safety) (rmax bound core) :=
  fun _ _ _ inside => ⟨inside.1, fun atom member => inside.2 atom (subset atom member)⟩

/-- **Core transfer.** A permission refuted at a core is refuted at every superset of that
core, so the minimal unsat core the search finds by deletion needs exactly one refutation
proof and it carries to the whole intent. -/
theorem not_permission_of_core {σ lab : Type} (bound : Lts σ lab)
    {safety core : List (Guarded σ lab)} {permission : Lts σ lab → Prop}
    (upward : Upward permission) (subset : ∀ atom ∈ core, atom ∈ safety)
    (refuted : ¬ permission (rmax bound core)) : ¬ permission (rmax bound safety) :=
  fun holds =>
    refuted (upward (rmax bound safety) (rmax bound core)
      (rmax_refines_of_subset bound subset) holds)

/-- Satisfiability only reads the intent pointwise, so a proved denotational equality
transfers it. This is how a record's verdict is stated about its *sentence* while being
proved about its polarity split. -/
theorem satAt_congr {σ lab : Type} (bound : Lts σ lab) {intent other : Lts σ lab → Prop}
    (same : ∀ R, intent R ↔ other R) : SatAt bound intent ↔ SatAt bound other := by
  constructor
  · rintro ⟨R, smaller, holds⟩
    exact ⟨R, smaller, (same R).mp holds⟩
  · rintro ⟨R, smaller, holds⟩
    exact ⟨R, smaller, (same R).mpr holds⟩

end SpecCnl.Intent
