/-
Revisions and secret references (SPEC §1.4, §3.5).

`src/core/revision.ts` is a non-negative safe integer that only ever moves forward by one,
and the one place it can fail is the top of the range: `next()` at `MAX_SAFE_INTEGER`
refuses with `protocol.revision-conflict` rather than wrapping or losing precision. That
refusal is a domain answer, not a shape violation, and the kernel keeps it that way.

`src/core/secret-ref.ts` names a credential in Tenant custody by three non-blank
components. Blankness is `String.prototype.trim().length === 0`, so the kernel models the
exact ECMAScript whitespace set rather than a guess at it — a component of non-breaking
spaces is blank at runtime and is blank here.
-/
import AgentCore.Kernel.Core.Text
import AgentCore.Kernel.Error

namespace AgentCore.Kernel

/-- `Number.MAX_SAFE_INTEGER`. -/
def maxSafeInteger : Nat := 9007199254740991

/-- A record revision: `Number.isSafeInteger` and non-negative. -/
def revisionValid (value : Nat) : Bool := value ≤ maxSafeInteger

structure Revision where
  value : Nat
  valid : revisionValid value = true

namespace Revision

theorem eq_of_value {left right : Revision} (same : left.value = right.value) :
    left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact same

instance : DecidableEq Revision := fun left right =>
  if same : left.value = right.value then .isTrue (eq_of_value same)
  else .isFalse fun equal => same (equal ▸ rfl)

/-- `Revision.initial()`. -/
def initial : Revision := ⟨0, by decide⟩

def parse (value : Nat) : Outcome Revision :=
  if valid : revisionValid value = true then .ok ⟨value, valid⟩
  else unshaped "Revision"

/-- `Revision.next()`: one step forward, refusing at the top of the safe range. -/
def next (revision : Revision) : Outcome Revision :=
  if bound : revision.value + 1 ≤ maxSafeInteger then .ok ⟨revision.value + 1, by
    unfold revisionValid
    simp [bound]⟩
  else refuse .protocolRevisionConflict

/-- **A revision only ever moves forward, and by exactly one.** -/
theorem next_succ {revision successor : Revision} (stepped : next revision = .ok successor) :
    successor.value = revision.value + 1 := by
  unfold next at stepped
  by_cases bound : revision.value + 1 ≤ maxSafeInteger
  · simp only [bound, dite_true, Except.ok.injEq] at stepped
    exact stepped ▸ rfl
  · simp [bound, refuse] at stepped

/-- **The top of the safe range refuses rather than wraps.** The refusal carries the stable
`protocol.revision-conflict` code, so a caller that reaches the ceiling learns which
invariant stopped it. -/
theorem next_at_ceiling {revision : Revision} (ceiling : revision.value = maxSafeInteger) :
    (next revision).RefusedWith .protocolRevisionConflict := by
  unfold next
  have bound : ¬ revision.value + 1 ≤ maxSafeInteger := by omega
  simp [bound, refuse, Outcome.RefusedWith]

/-- **Revisions are totally ordered by their value, and `next` is strictly increasing.**
This is the property optimistic concurrency rests on: a later write carries a strictly
greater revision, so a stale write is detectable by comparison alone. -/
theorem next_strictly_increasing {revision successor : Revision}
    (stepped : next revision = .ok successor) : revision.value < successor.value := by
  rw [next_succ stepped]
  omega

end Revision

/-- The ECMAScript `WhiteSpace`/`LineTerminator` set `String.prototype.trim` removes. -/
def isTrimmedWhitespace (character : Char) : Bool :=
  character.toNat == 0x09 || character.toNat == 0x0A || character.toNat == 0x0B ||
    character.toNat == 0x0C || character.toNat == 0x0D || character.toNat == 0x20 ||
    character.toNat == 0xA0 || character.toNat == 0x1680 ||
    (0x2000 ≤ character.toNat && character.toNat ≤ 0x200A) ||
    character.toNat == 0x2028 || character.toNat == 0x2029 || character.toNat == 0x202F ||
    character.toNat == 0x205F || character.toNat == 0x3000 || character.toNat == 0xFEFF

/-- `value.trim().length === 0`: nothing but whitespace. -/
def isBlank (value : String) : Bool := value.toList.all isTrimmedWhitespace

/-- The greatest length a secret-reference component may have, in UTF-16 code units. -/
def secretComponentMaxLength : Nat := 2048

def secretComponentValid (value : String) : Bool :=
  !isBlank value && Text.length value ≤ secretComponentMaxLength

/-- A credential held in Tenant custody, named and never carried (SPEC §3.5). -/
structure SecretRef where
  source : String
  provider : String
  id : String
  sourceValid : secretComponentValid source = true
  providerValid : secretComponentValid provider = true
  idValid : secretComponentValid id = true

namespace SecretRef

theorem eq_of_components {left right : SecretRef} (source : left.source = right.source)
    (provider : left.provider = right.provider) (id : left.id = right.id) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨source, provider, id⟩

def parse (source provider id : String) : Outcome SecretRef :=
  if sourceValid : secretComponentValid source = true then
    if providerValid : secretComponentValid provider = true then
      if idValid : secretComponentValid id = true then
        .ok ⟨source, provider, id, sourceValid, providerValid, idValid⟩
      else unshaped "Secret reference id"
    else unshaped "Secret reference provider"
  else unshaped "Secret reference source"

/-- **A secret reference never holds a blank component.** Custody is named by three
components that each identify something, so a reference cannot degenerate into a partially
addressed credential. -/
theorem component_nonblank {value : String} (valid : secretComponentValid value = true) :
    isBlank value = false := by
  unfold secretComponentValid at valid
  have blank := ((Bool.and_eq_true _ _).mp valid).1
  simpa using blank

theorem components_nonblank (reference : SecretRef) :
    isBlank reference.source = false ∧ isBlank reference.provider = false ∧
      isBlank reference.id = false :=
  ⟨component_nonblank reference.sourceValid, component_nonblank reference.providerValid,
   component_nonblank reference.idValid⟩

end SecretRef

end AgentCore.Kernel
