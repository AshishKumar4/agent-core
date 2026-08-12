import AgentCore.Model

/-!
# Capability matching and the delegation-never-widens decision (SPEC §3.3, §3.4 rule 2)

SPEC §3.4 rule 2 is a *semantic* obligation: "a delegated capability is equal to or
narrower than its source, at every depth of the lineage." Narrower means one thing only —
the child admits no Invocation the parent would not have admitted. The implementation
discharges that obligation with a *syntactic* decision, `CapabilitySpec.covers`, run
pairwise along the attenuation lineage.

This module supplies the missing link between the two. `Capability.Matches` is the
admission semantics; `Capability.Covers` is §3.4 rule 2 stated exactly, as containment of
admitted intents over the whole infinite intent domain; `Capability.coversBool` is the
executable decision an implementation can run. `capability_covering_is_sound` proves the
decision never admits a widening delegation, and `covering_chain_never_widens` lifts the
pairwise check to the whole lineage.

The pattern layer is where the content is. A Facet pattern is a glob over `'*'`, so
covering between two patterns is language containment over an infinite set of Facet
names — a property no finite test can establish. `glob_covering_is_sound` and
`glob_covering_is_complete` reduce it exactly to `globMatch parent child`: the parent
pattern matched against the child *pattern text*, with the child's `'*'` treated as an
ordinary character. That equivalence is the whole decision procedure, and it is what a
prefix/suffix approximation gets wrong.

## What this does and does not carry

Argument constraints are modeled by their *path projection*: an intent carries the
canonical encoding observed at each path, and a constraint is satisfied when the
projection at that path equals the constrained encoding. Nothing here derives the
projection from a JSON tree, so the model treats distinct paths as independent while a
real arguments object does not — constraining `a` also determines `a.b`.

That asymmetry is deliberate and it falls the safe way. `Capability.Covers` quantifies
over *every* projection, which is a superset of the projections real arguments induce, so
`capability_covering_is_sound` — the escalation-prevention direction — carries to the
implementation unweakened. `capability_covering_is_complete` is stated relative to the
same superset, so it establishes that the decision rejects nothing the *abstract*
semantics admits; it does not claim the decision accepts every attenuation a concrete
JSON tree would justify. A child that constrains an ancestor of a parent-constrained path
is refused by model and implementation alike. Refusal is fail-closed, so this is a
usability boundary, not a safety one.

Canonical JSON encoding, path projection, and pattern/impact validation of untrusted
input are the implementation's obligations, not results here.
-/

namespace AgentCore

/-! ## Suffixes

The star case of glob matching quantifies over suffixes of the remaining value. Making
that enumeration explicit keeps `globMatch` structurally recursive on the pattern, so it
reduces by computation — witnesses below are closed `decide` calls, not `simp` scripts.
-/

/-- Every suffix of a list, longest first: `suffixes [a, b] = [[a, b], [b], []]`. -/
def suffixes {α : Type _} : List α → List (List α)
  | [] => [[]]
  | head :: tail => (head :: tail) :: suffixes tail

theorem mem_suffixes_self {α : Type _} (value : List α) : value ∈ suffixes value := by
  cases value <;> simp [suffixes]

theorem mem_suffixes_cons {α : Type _} {suffix value : List α} (head : α)
    (member : suffix ∈ suffixes value) : suffix ∈ suffixes (head :: value) := by
  simp only [suffixes, List.mem_cons]
  exact Or.inr member

theorem mem_suffixes_cases {α : Type _} {suffix : List α} {head : α} {tail : List α}
    (member : suffix ∈ suffixes (head :: tail)) :
    suffix = head :: tail ∨ suffix ∈ suffixes tail := by
  simpa only [suffixes, List.mem_cons] using member

theorem mem_suffixes_nil {α : Type _} {suffix : List α} (member : suffix ∈ suffixes ([] : List α)) :
    suffix = [] := by
  simpa only [suffixes, List.mem_cons, List.not_mem_nil, or_false] using member

/-! ## Glob semantics

`'*'` is the only metacharacter, matching any (possibly empty) run of characters. Every
other pattern character matches itself. -/

/-- The declarative reading of a Facet pattern: which Facet names it admits. -/
inductive GlobMatches : List Char → List Char → Prop
  | nil : GlobMatches [] []
  | lit {atom rest value} : atom ≠ '*' → GlobMatches rest value →
      GlobMatches (atom :: rest) (atom :: value)
  | starSkip {rest value} : GlobMatches rest value → GlobMatches ('*' :: rest) value
  | starEat {rest head value} : GlobMatches ('*' :: rest) value →
      GlobMatches ('*' :: rest) (head :: value)

/-- The executable reading, structurally recursive on the pattern. The literal branch uses
`head?`/`tail` rather than a nested match so that one equation covers every value, which is
what lets the proofs below rewrite with it. -/
def globMatch : List Char → List Char → Bool
  | [], value => value.isEmpty
  | atom :: rest, value =>
      if atom = '*' then (suffixes value).any (globMatch rest)
      else (value.head? == some atom) && globMatch rest value.tail

theorem globMatch_star (rest value : List Char) :
    globMatch ('*' :: rest) value = (suffixes value).any (globMatch rest) := by
  simp only [globMatch, reduceIte]

theorem globMatch_lit {atom : Char} (notStar : atom ≠ '*') (rest value : List Char) :
    globMatch (atom :: rest) value = ((value.head? == some atom) && globMatch rest value.tail) := by
  simp only [globMatch, if_neg notStar]

theorem globMatches_star_intro {rest value suffix : List Char}
    (member : suffix ∈ suffixes value) (matched : GlobMatches rest suffix) :
    GlobMatches ('*' :: rest) value := by
  induction value with
  | nil => exact mem_suffixes_nil member ▸ .starSkip matched
  | cons head tail ih =>
      rcases mem_suffixes_cases member with rfl | member
      · exact .starSkip matched
      · exact .starEat (ih member)

theorem globMatches_star_elim {pattern value : List Char} (matched : GlobMatches pattern value) :
    ∀ rest, pattern = '*' :: rest → ∃ suffix ∈ suffixes value, GlobMatches rest suffix := by
  induction matched with
  | nil => intro _ shape; cases shape
  | lit notStar _ _ =>
      intro _ shape
      exact absurd (List.head_eq_of_cons_eq shape) notStar
  | @starSkip rest value inner _ =>
      intro target shape
      cases List.tail_eq_of_cons_eq shape
      exact ⟨value, mem_suffixes_self value, inner⟩
  | @starEat rest head value _ ih =>
      intro target shape
      cases List.tail_eq_of_cons_eq shape
      obtain ⟨suffix, member, matched⟩ := ih rest rfl
      exact ⟨suffix, mem_suffixes_cons head member, matched⟩

theorem globMatches_star_iff {rest value : List Char} :
    GlobMatches ('*' :: rest) value ↔ ∃ suffix ∈ suffixes value, GlobMatches rest suffix :=
  ⟨fun matched => globMatches_star_elim matched rest rfl,
   fun ⟨_, member, matched⟩ => globMatches_star_intro member matched⟩

/-- **The executable pattern decision is sound.** -/
theorem globMatch_sound : ∀ {pattern value : List Char},
    globMatch pattern value = true → GlobMatches pattern value := by
  intro pattern
  induction pattern with
  | nil =>
      intro value executed
      cases value with
      | nil => exact .nil
      | cons => simp [globMatch] at executed
  | cons atom rest ih =>
      intro value executed
      by_cases star : atom = '*'
      · subst star
        rw [globMatch_star, List.any_eq_true] at executed
        obtain ⟨suffix, member, matched⟩ := executed
        exact globMatches_star_intro member (ih matched)
      · rw [globMatch_lit star] at executed
        simp only [Bool.and_eq_true, beq_iff_eq] at executed
        obtain ⟨head, tail⟩ := executed
        cases value with
        | nil => simp at head
        | cons valueHead valueTail =>
            simp only [List.head?_cons, Option.some.injEq] at head
            simp only [List.tail_cons] at tail
            subst head
            exact .lit star (ih tail)

/-- **The executable pattern decision is complete.** -/
theorem globMatch_complete : ∀ {pattern value : List Char},
    GlobMatches pattern value → globMatch pattern value = true := by
  intro pattern value matched
  induction matched with
  | nil => rfl
  | lit notStar _ ih => simp [globMatch_lit notStar, ih]
  | @starSkip rest value _ ih =>
      rw [globMatch_star, List.any_eq_true]
      exact ⟨value, mem_suffixes_self value, ih⟩
  | @starEat rest head value _ ih =>
      rw [globMatch_star, List.any_eq_true] at ih ⊢
      obtain ⟨suffix, member, matched⟩ := ih
      exact ⟨suffix, mem_suffixes_cons head member, matched⟩

theorem globMatch_iff {pattern value : List Char} :
    globMatch pattern value = true ↔ GlobMatches pattern value :=
  ⟨globMatch_sound, globMatch_complete⟩

/-! ## Pattern covering -/

theorem globMatches_lit_inv {atom : Char} {rest value : List Char} (notStar : atom ≠ '*')
    (matched : GlobMatches (atom :: rest) value) :
    ∃ tail, value = atom :: tail ∧ GlobMatches rest tail := by
  cases matched with
  | lit _ inner => exact ⟨_, rfl, inner⟩
  | starSkip => exact absurd rfl notStar
  | starEat => exact absurd rfl notStar

/-- A pattern's leading atom consumes some prefix of any value it matches, whatever that
atom is; the tail pattern matches the rest. -/
theorem globMatches_peel {pattern value : List Char} (matched : GlobMatches pattern value) :
    ∀ head tail, pattern = head :: tail →
      ∃ consumed remainder, value = consumed ++ remainder ∧ GlobMatches tail remainder := by
  induction matched with
  | nil => intro _ _ shape; cases shape
  | @lit atom rest value _ inner _ =>
      intro _ tail shape
      cases List.tail_eq_of_cons_eq shape
      exact ⟨[atom], value, rfl, inner⟩
  | @starSkip rest value inner _ =>
      intro _ tail shape
      cases List.tail_eq_of_cons_eq shape
      exact ⟨[], value, rfl, inner⟩
  | @starEat rest head value _ ih =>
      intro _ tail shape
      cases List.tail_eq_of_cons_eq shape
      obtain ⟨consumed, remainder, split, matched⟩ := ih '*' rest rfl
      exact ⟨head :: consumed, remainder, by rw [split]; rfl, matched⟩

theorem globMatches_star_prepend {rest value : List Char} (consumed : List Char)
    (matched : GlobMatches ('*' :: rest) value) :
    GlobMatches ('*' :: rest) (consumed ++ value) := by
  induction consumed with
  | nil => exact matched
  | cons _ _ ih => exact .starEat ih

/-- **Pattern covering is sound.** If the parent pattern matches the child pattern's own
text, then every Facet name the child admits, the parent admits too. This is the
escalation-prevention half of SPEC §3.4 rule 2 at the pattern layer: the decision cannot
approve a delegation that widens the admitted Facet set. -/
theorem glob_covering_is_sound {parent child : List Char} (covering : GlobMatches parent child) :
    ∀ value, GlobMatches child value → GlobMatches parent value := by
  induction covering with
  | nil =>
      intro value matched
      cases matched
      exact .nil
  | @lit atom rest childRest notStar _ ih =>
      intro value matched
      obtain ⟨tail, shape, inner⟩ := globMatches_lit_inv notStar matched
      exact shape ▸ .lit notStar (ih tail inner)
  | starSkip _ ih => intro value matched; exact .starSkip (ih value matched)
  | @starEat rest head childRest _ ih =>
      intro value matched
      obtain ⟨consumed, remainder, split, inner⟩ := globMatches_peel matched head childRest rfl
      exact split ▸ globMatches_star_prepend consumed (ih remainder inner)

/-- Replace every `'*'` by one fixed character. Applied to a pattern this yields a
concrete Facet name the pattern admits. -/
def substStar (fresh : Char) : List Char → List Char
  | [] => []
  | head :: tail => (if head = '*' then fresh else head) :: substStar fresh tail

theorem substStar_matches (fresh : Char) (pattern : List Char) :
    GlobMatches pattern (substStar fresh pattern) := by
  induction pattern with
  | nil => exact .nil
  | cons head tail ih =>
      by_cases star : head = '*'
      · subst star
        simpa only [substStar, if_pos rfl] using GlobMatches.starEat (.starSkip ih)
      · simpa only [substStar, if_neg star] using GlobMatches.lit star ih

theorem substStar_eq_nil {fresh : Char} {pattern : List Char}
    (empty : substStar fresh pattern = []) : pattern = [] := by
  cases pattern with
  | nil => rfl
  | cons => simp [substStar] at empty

/-- A pattern that avoids `fresh` cannot tell a substituted child pattern from the child
pattern itself: its literals never align with the substituted character, exactly as they
never align with `'*'`. -/
theorem globMatches_of_substStar {fresh : Char} {pattern value : List Char}
    (matched : GlobMatches pattern value) :
    ∀ child, value = substStar fresh child → fresh ∉ pattern → GlobMatches pattern child := by
  induction matched with
  | nil =>
      intro child shape _
      exact substStar_eq_nil shape.symm ▸ .nil
  | @lit atom rest value notStar _ ih =>
      intro child shape absent
      cases child with
      | nil => simp [substStar] at shape
      | cons childHead childTail =>
          simp only [substStar, List.cons.injEq] at shape
          have notFresh : atom ≠ fresh := fun equal =>
            absent (equal ▸ List.mem_cons_self atom rest)
          by_cases star : childHead = '*'
          · exact absurd (shape.1.trans (if_pos star)) notFresh
          · have head : atom = childHead := shape.1.trans (if_neg star)
            have inner := ih childTail shape.2 fun member => absent (List.mem_cons_of_mem atom member)
            exact head ▸ .lit (head ▸ notStar) inner
  | @starSkip rest value _ ih =>
      intro child shape absent
      exact .starSkip (ih child shape fun member => absent (List.mem_cons_of_mem '*' member))
  | @starEat rest head value _ ih =>
      intro child shape absent
      cases child with
      | nil => simp [substStar] at shape
      | cons childHead childTail =>
          simp only [substStar, List.cons.injEq] at shape
          exact .starEat (ih childTail shape.2 absent)

/-- **Pattern covering is complete.** If the child admits no Facet name outside the
parent's, the decision says so. The only thing the proof needs is one character the parent
pattern does not contain; the corollary below discharges that from the implementation's
own pattern validation. -/
theorem glob_covering_is_complete {parent child : List Char} {fresh : Char}
    (absent : fresh ∉ parent)
    (containment : ∀ value, GlobMatches child value → GlobMatches parent value) :
    GlobMatches parent child :=
  globMatches_of_substStar (containment _ (substStar_matches fresh child)) child rfl absent

/-! ## Validated patterns

A Facet pattern is canonical: `'*'` is the sole metacharacter and every other character
comes from a fixed set. `'#'` is outside that set, which is all the completeness proof
needs. -/

def patternCharAllowed (character : Char) : Bool :=
  character.isAlphanum || character = '.' || character = '_' || character = ':' ||
    character = '/' || character = '@' || character = '*' || character = '-'

def PatternValid (pattern : List Char) : Prop := ∀ character ∈ pattern, patternCharAllowed character

instance (pattern : List Char) : Decidable (PatternValid pattern) := by
  unfold PatternValid
  infer_instance

theorem fresh_not_mem_of_valid {pattern : List Char} (valid : PatternValid pattern) :
    '#' ∉ pattern := fun member => by simpa [patternCharAllowed] using valid '#' member

/-- **The executable pattern decision is exactly containment.** Both directions, over the
whole infinite space of Facet names. -/
theorem glob_covering_iff_containment {parent child : List Char} (valid : PatternValid parent) :
    globMatch parent child = true ↔ ∀ value, GlobMatches child value → GlobMatches parent value :=
  ⟨fun executed => glob_covering_is_sound (globMatch_sound executed),
   fun containment =>
     globMatch_complete (glob_covering_is_complete (fresh_not_mem_of_valid valid) containment)⟩

/-! ## Capabilities -/

structure ArgumentPath where
  segments : List String
  deriving DecidableEq, Repr

/-- An argument value as the decision actually compares it: its canonical encoding. The
implementation compares `encodeCanonicalJson` byte strings, so equality of encodings is
the comparison, not equality of some richer value. -/
structure CanonicalValue where
  encoded : String
  deriving DecidableEq, Repr

/-- One grantable authority. `operations = []` means every Operation of a matched Facet,
matching the implementation's empty-list-is-wildcard reading. -/
structure Capability where
  facetPattern : List Char
  operations : List String
  impacts : List InvocationImpact
  constraints : List (ArgumentPath × CanonicalValue)
  deriving DecidableEq, Repr

/-- What a capability is asked to admit. `arguments` is the intent's path projection: the
canonical encoding observed at each path, absent when the path does not resolve. -/
structure CapabilityIntent where
  facet : List Char
  operation : String
  impact : InvocationImpact
  arguments : List (ArgumentPath × CanonicalValue)
  deriving DecidableEq, Repr

def lookupArgument : List (ArgumentPath × CanonicalValue) → ArgumentPath → Option CanonicalValue
  | [], _ => none
  | entry :: rest, wanted => if entry.1 = wanted then some entry.2 else lookupArgument rest wanted

theorem lookupArgument_mem {table : List (ArgumentPath × CanonicalValue)}
    {path : ArgumentPath} {value : CanonicalValue} (found : lookupArgument table path = some value) :
    (path, value) ∈ table := by
  induction table with
  | nil => simp [lookupArgument] at found
  | cons entry rest ih =>
      simp only [lookupArgument] at found
      split at found
      · next same =>
          cases same
          simp only [Option.some.injEq] at found
          cases found
          simp
      · exact List.mem_cons_of_mem _ (ih found)

/-- Admission semantics: which intents a capability admits. -/
def Capability.Matches (spec : Capability) (intent : CapabilityIntent) : Prop :=
  GlobMatches spec.facetPattern intent.facet ∧
  (spec.operations = [] ∨ intent.operation ∈ spec.operations) ∧
  intent.impact ∈ spec.impacts ∧
  ∀ entry ∈ spec.constraints, lookupArgument intent.arguments entry.1 = some entry.2

/-- The executable admission decision. -/
def Capability.matchesBool (spec : Capability) (intent : CapabilityIntent) : Bool :=
  globMatch spec.facetPattern intent.facet &&
    decide (spec.operations = [] ∨ intent.operation ∈ spec.operations) &&
    decide (intent.impact ∈ spec.impacts) &&
    spec.constraints.all fun entry => lookupArgument intent.arguments entry.1 == some entry.2

/-- **The executable admission decision is sound and complete.** -/
theorem capability_matches_iff {spec : Capability} {intent : CapabilityIntent} :
    spec.matchesBool intent = true ↔ spec.Matches intent := by
  simp only [Capability.matchesBool, Capability.Matches, Bool.and_eq_true, decide_eq_true_eq,
    globMatch_iff, List.all_eq_true, beq_iff_eq]
  constructor
  · rintro ⟨⟨⟨pattern, operation⟩, impact⟩, constraints⟩
    exact ⟨pattern, operation, impact, constraints⟩
  · rintro ⟨pattern, operation, impact, constraints⟩
    exact ⟨⟨⟨pattern, operation⟩, impact⟩, constraints⟩

/-- SPEC §3.4 rule 2, stated exactly: a child is narrower than its parent when it admits
no intent the parent would refuse. -/
def Capability.Covers (parent child : Capability) : Prop :=
  ∀ intent, child.Matches intent → parent.Matches intent

/-- The executable attenuation decision. The pattern layer is `globMatch` run on the child
pattern's own text — the child's `'*'` is an ordinary character there, so a parent literal
can never absorb it. -/
def Capability.coversBool (parent child : Capability) : Bool :=
  globMatch parent.facetPattern child.facetPattern &&
    decide (parent.operations = [] ∨
      (child.operations ≠ [] ∧ ∀ operation ∈ child.operations, operation ∈ parent.operations)) &&
    decide (∀ impact ∈ child.impacts, impact ∈ parent.impacts) &&
    parent.constraints.all fun entry => lookupArgument child.constraints entry.1 == some entry.2

/-- **The attenuation decision never widens authority.** Whenever it approves a
delegation, every intent the child admits, the parent admits. -/
theorem capability_covering_is_sound {parent child : Capability}
    (executed : parent.coversBool child = true) : parent.Covers child := by
  simp only [Capability.coversBool, Bool.and_eq_true, decide_eq_true_eq, globMatch_iff,
    List.all_eq_true, beq_iff_eq] at executed
  obtain ⟨⟨⟨pattern, operations⟩, impacts⟩, constraints⟩ := executed
  intro intent matched
  obtain ⟨childPattern, childOperation, childImpact, childConstraints⟩ := matched
  refine ⟨glob_covering_is_sound pattern intent.facet childPattern, ?_, impacts _ childImpact, ?_⟩
  · rcases operations with empty | ⟨_, containment⟩
    · exact Or.inl empty
    · rcases childOperation with empty | member
      · exact absurd empty (by assumption)
      · exact Or.inr (containment _ member)
  · intro entry member
    exact childConstraints _ (lookupArgument_mem (constraints entry member))

/-! ## Completeness of the attenuation decision

Completeness needs a witness intent for each way the decision can refuse, so it needs the
inputs to be the validated ones the implementation accepts: a canonical pattern, a
nonempty impact set, and constraint paths that resolve to their own declared values. Those
are exactly the constructor's validation rules. -/

/-- The implementation's constraint map is a JSON object, so every declared path resolves
to its own declared value. -/
def ConstraintsCanonical (constraints : List (ArgumentPath × CanonicalValue)) : Prop :=
  ∀ entry ∈ constraints, lookupArgument constraints entry.1 = some entry.2

instance (constraints : List (ArgumentPath × CanonicalValue)) :
    Decidable (ConstraintsCanonical constraints) := by
  unfold ConstraintsCanonical
  infer_instance

structure CapabilityValid (spec : Capability) : Prop where
  pattern : PatternValid spec.facetPattern
  impacts : spec.impacts ≠ []
  constraints : ConstraintsCanonical spec.constraints

def maxOperationLength : List String → Nat
  | [] => 0
  | operation :: rest => max operation.length (maxOperationLength rest)

theorem le_maxOperationLength {operations : List String} {operation : String}
    (member : operation ∈ operations) : operation.length ≤ maxOperationLength operations := by
  induction operations with
  | nil => cases member
  | cons head tail ih =>
      rcases List.mem_cons.mp member with rfl | member
      · exact Nat.le_max_left _ _
      · exact Nat.le_trans (ih member) (Nat.le_max_right _ _)

/-- An Operation name outside any finite set: longer than every member. -/
def freshOperation (operations : List String) : String :=
  ⟨List.replicate (maxOperationLength operations + 1) 'a'⟩

theorem freshOperation_not_mem (operations : List String) :
    freshOperation operations ∉ operations := by
  intro member
  have bound := le_maxOperationLength member
  have length : (freshOperation operations).length = maxOperationLength operations + 1 := by
    simp [freshOperation, String.length]
  rw [length] at bound
  exact Nat.not_succ_le_self _ bound

/-- The witness intent used to refute each way the decision could refuse a genuinely
narrower child: a Facet name the child pattern admits, a chosen Operation and impact, and
the child's own constraints as the argument projection. -/
def probeIntent (child : Capability) (operation : String) (impact : InvocationImpact) :
    CapabilityIntent :=
  ⟨substStar '#' child.facetPattern, operation, impact, child.constraints⟩

theorem probeIntent_matches {child : Capability} {operation : String}
    {impact : InvocationImpact} (canonical : ConstraintsCanonical child.constraints)
    (admitted : child.operations = [] ∨ operation ∈ child.operations)
    (member : impact ∈ child.impacts) : child.Matches (probeIntent child operation impact) :=
  ⟨substStar_matches '#' child.facetPattern, admitted, member, canonical⟩

/-- **The attenuation decision refuses nothing the semantics admits.** Under the
implementation's own validation of both capabilities, semantic containment and the
executable decision agree. The abstraction boundary this is relative to is stated at the
top of the module: intents range over every argument projection, not only those a JSON
tree induces. -/
theorem capability_covering_is_complete {parent child : Capability}
    (validParent : CapabilityValid parent) (validChild : CapabilityValid child)
    (covers : parent.Covers child) : parent.coversBool child = true := by
  obtain ⟨childImpact, childImpactMember⟩ : ∃ impact, impact ∈ child.impacts := by
    cases hypothesis : child.impacts with
    | nil => exact absurd hypothesis validChild.impacts
    | cons head _ => exact ⟨head, List.mem_cons_self _ _⟩
  have defaultOperation : child.operations = [] ∨
      (child.operations.headD "") ∈ child.operations := by
    cases child.operations with
    | nil => exact Or.inl rfl
    | cons head _ => exact Or.inr (by simp)
  have probe : ∀ operation impact, (child.operations = [] ∨ operation ∈ child.operations) →
      impact ∈ child.impacts → parent.Matches (probeIntent child operation impact) :=
    fun operation impact admitted member =>
      covers _ (probeIntent_matches validChild.constraints admitted member)
  have patternProbe :=
    probe (child.operations.headD "") childImpact defaultOperation childImpactMember
  have pattern : globMatch parent.facetPattern child.facetPattern = true :=
    globMatch_complete
      (globMatches_of_substStar patternProbe.1 child.facetPattern rfl
        (fresh_not_mem_of_valid validParent.pattern))
  have operations : parent.operations = [] ∨
      (child.operations ≠ [] ∧ ∀ operation ∈ child.operations, operation ∈ parent.operations) := by
    by_cases parentEmpty : parent.operations = []
    · exact Or.inl parentEmpty
    refine Or.inr ⟨?_, ?_⟩
    · intro childEmpty
      have escape :=
        probe (freshOperation parent.operations) childImpact (Or.inl childEmpty) childImpactMember
      rcases escape.2.1 with empty | member
      · exact parentEmpty empty
      · exact freshOperation_not_mem parent.operations member
    · intro operation member
      rcases (probe operation childImpact (Or.inr member) childImpactMember).2.1 with empty | inside
      · exact absurd empty parentEmpty
      · exact inside
  have impacts : ∀ impact ∈ child.impacts, impact ∈ parent.impacts := fun impact member =>
    (probe (child.operations.headD "") impact defaultOperation member).2.2.1
  have constraints : ∀ entry ∈ parent.constraints,
      lookupArgument child.constraints entry.1 = some entry.2 := fun entry member =>
    patternProbe.2.2.2 entry member
  simp only [Capability.coversBool, Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true,
    beq_iff_eq]
  exact ⟨⟨⟨pattern, operations⟩, impacts⟩, constraints⟩

/-! ## Lineage

`validateLineage` checks covering pairwise, parent to child, along the attenuation chain.
SPEC §3.4 rule 2 demands the property "at every depth", which is a statement about the
root and every descendant, not about adjacent pairs. -/

/-- Every adjacent pair in an attenuation chain passes the executable decision. -/
def CoveringChain : List Capability → Prop
  | [] => True
  | [_] => True
  | parent :: child :: rest => parent.coversBool child = true ∧ CoveringChain (child :: rest)

/-- **Pairwise checks give root containment at every depth.** No capability anywhere in a
checked attenuation chain admits an intent the root would refuse — which is SPEC §3.4
rule 2 in full, from the pairwise check the resolver actually runs. -/
theorem covering_chain_never_widens {root : Capability} {chain : List Capability}
    (checked : CoveringChain (root :: chain)) :
    ∀ descendant ∈ root :: chain, root.Covers descendant := by
  induction chain generalizing root with
  | nil =>
      intro descendant member
      cases List.mem_singleton.mp member
      exact fun _ matched => matched
  | cons next rest ih =>
      obtain ⟨step, tail⟩ := checked
      have covers := capability_covering_is_sound step
      intro descendant member
      rcases List.mem_cons.mp member with rfl | member
      · exact fun _ matched => matched
      · exact fun intent matched => covers intent (ih tail descendant member intent matched)

end AgentCore
