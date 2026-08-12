import AgentCore.Model

/-!
# Composite key representation (SPEC §3.4, §8.1)

Every theorem elsewhere in this package reasons about identities as distinct values:
`TenantId`, `PrincipalId`, `ApprovalId` are separate structures over `Nat`, and two
identities are equal exactly when their components are. An implementation earns the right
to that reading only if the concrete key it stores and looks records up by *determines* the
identity it was built from. Where it does not, two distinct identities share a key, and a
lookup can return another identity's record — the abstract model would be describing a
system the implementation is not.

This module is the representation relation for that step. A composite key is a delimiter
join over component strings, the shape the record stores use, and the question is exactly
when that join is injective.

The answer is not "always", and the boundary is sharp. A two-component join is injective
when the components on one chosen side are delimiter-free, and is *not* injective when both
sides may contain the delimiter — `collides` exhibits the collision for any delimiter. The
prefix scan built from the same join carries a stronger obligation than the join itself:
scanning for one identifier's records selects a foreign record whenever identifiers may
contain the delimiter, even though the join that produced that foreign key was itself
unambiguous.

The obligation this puts on an implementation is concrete: for each stored key, name the
side that is delimiter-free and show its component domain excludes the delimiter. A closed
vocabulary or a decimal number discharges it; a free-form identifier that admits the
delimiter does not.

Canonical-JSON keys are a different scheme and are not modeled here. Their injectivity
rests on the escaping rules of the encoder, which this module does not reproduce — see
`ASM-CANONICAL-KEY-INJECTIVE`.
-/

namespace AgentCore

/-- A two-component composite key: the components joined by one delimiter. -/
def pairKey (delimiter : Char) (left right : List Char) : List Char :=
  left ++ delimiter :: right

/-- The prefix a record scan uses to select every key built from one identifier. -/
def keyPrefix (delimiter : Char) (identifier : List Char) : List Char :=
  identifier ++ [delimiter]

def HasPrefix (scanPrefix key : List Char) : Prop := ∃ rest, key = scanPrefix ++ rest

/-- A component domain that cannot contain the delimiter. This is the property an
implementation must establish per key, not a property of strings in general. -/
def DelimiterFree (delimiter : Char) (component : List Char) : Prop := delimiter ∉ component

instance (delimiter : Char) (component : List Char) :
    Decidable (DelimiterFree delimiter component) := by
  unfold DelimiterFree
  infer_instance

def delimiterFree (delimiter : Char) (component : List Char) : Bool :=
  !component.contains delimiter

theorem delimiterFree_iff {delimiter : Char} {component : List Char} :
    delimiterFree delimiter component = true ↔ DelimiterFree delimiter component := by
  simp [delimiterFree, DelimiterFree, List.contains_iff_mem]

/-- **A delimiter-free left component makes the join injective.** -/
theorem pair_key_injective_of_free_left {delimiter : Char} :
    ∀ {leftOne leftTwo rightOne rightTwo : List Char},
      DelimiterFree delimiter leftOne → DelimiterFree delimiter leftTwo →
      pairKey delimiter leftOne rightOne = pairKey delimiter leftTwo rightTwo →
      leftOne = leftTwo ∧ rightOne = rightTwo := by
  intro leftOne
  induction leftOne with
  | nil =>
      intro leftTwo rightOne rightTwo _ freeTwo equal
      cases leftTwo with
      | nil => exact ⟨rfl, by simpa [pairKey] using equal⟩
      | cons head tail =>
          simp only [pairKey, List.nil_append, List.cons_append, List.cons.injEq] at equal
          exact absurd (equal.1 ▸ List.mem_cons_self head tail) freeTwo
  | cons head tail ih =>
      intro leftTwo rightOne rightTwo freeOne freeTwo equal
      cases leftTwo with
      | nil =>
          simp only [pairKey, List.nil_append, List.cons_append, List.cons.injEq] at equal
          exact absurd (equal.1 ▸ List.mem_cons_self head tail) freeOne
      | cons otherHead otherTail =>
          simp only [pairKey, List.cons_append, List.cons.injEq] at equal
          obtain ⟨sameHead, sameTail⟩ := equal
          have inner := ih (leftTwo := otherTail)
            (fun member => freeOne (List.mem_cons_of_mem head member))
            (fun member => freeTwo (List.mem_cons_of_mem otherHead member)) sameTail
          exact ⟨by rw [sameHead, inner.1], inner.2⟩

/-- **A delimiter-free right component makes the join injective.** The join read backwards
is the same join, so the same argument applies to the other side. -/
theorem pair_key_injective_of_free_right {delimiter : Char}
    {leftOne leftTwo rightOne rightTwo : List Char}
    (freeOne : DelimiterFree delimiter rightOne) (freeTwo : DelimiterFree delimiter rightTwo)
    (equal : pairKey delimiter leftOne rightOne = pairKey delimiter leftTwo rightTwo) :
    leftOne = leftTwo ∧ rightOne = rightTwo := by
  have reversed : pairKey delimiter rightOne.reverse leftOne.reverse =
      pairKey delimiter rightTwo.reverse leftTwo.reverse := by
    simpa [pairKey] using congrArg List.reverse equal
  have inner := pair_key_injective_of_free_left
    (fun member => freeOne (List.mem_reverse.mp member))
    (fun member => freeTwo (List.mem_reverse.mp member)) reversed
  constructor
  · simpa using congrArg List.reverse inner.2
  · simpa using congrArg List.reverse inner.1

/-- **The join is not injective without a delimiter-free side.** The collision needs no
unusual delimiter and no unusual component: it is available for every delimiter as soon as
both sides may contain one. -/
theorem pair_key_not_injective (delimiter : Char) :
    ∃ leftOne rightOne leftTwo rightTwo : List Char,
      (leftOne, rightOne) ≠ (leftTwo, rightTwo) ∧
        pairKey delimiter leftOne rightOne = pairKey delimiter leftTwo rightTwo :=
  ⟨['a'], ['b', delimiter, 'c'], ['a', delimiter, 'b'], ['c'], by simp, rfl⟩

/-- **A prefix scan over delimiter-free identifiers selects only that identifier's keys.**
This is what a store's "every record of this identifier" query needs, and it is strictly
more than the join's injectivity: it must also exclude keys built from other identifiers. -/
theorem prefix_scan_selects_exact_identifier {delimiter : Char}
    {scanned identifier revision : List Char}
    (freeScanned : DelimiterFree delimiter scanned)
    (freeIdentifier : DelimiterFree delimiter identifier)
    (matched : HasPrefix (keyPrefix delimiter scanned) (pairKey delimiter identifier revision)) :
    scanned = identifier := by
  obtain ⟨rest, shape⟩ := matched
  have joined : pairKey delimiter identifier revision = pairKey delimiter scanned rest := by
    simpa [pairKey, keyPrefix] using shape
  exact (pair_key_injective_of_free_left freeIdentifier freeScanned joined).1.symm

/-- **A prefix scan over identifiers that may contain the delimiter selects a foreign
record.** The foreign key here is itself unambiguous — its own left component is a distinct
identifier — so no amount of care in the join rules this out. Only excluding the delimiter
from the identifier domain does. -/
theorem prefix_scan_admits_foreign_identifier (delimiter : Char) :
    ∃ scanned identifier revision : List Char,
      scanned ≠ identifier ∧
        HasPrefix (keyPrefix delimiter scanned) (pairKey delimiter identifier revision) :=
  ⟨['a'], ['a', delimiter, 'b'], ['1'], by simp, ⟨['b', delimiter, '1'], rfl⟩⟩

end AgentCore
