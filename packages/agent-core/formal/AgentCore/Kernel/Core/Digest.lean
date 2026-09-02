/-
Digests and content addresses (SPEC §1.4, §8.2).

`src/core/digest.ts` admits exactly one algorithm and exactly one textual form: 64
lowercase hexadecimal characters, rejected by `TypeError` otherwise. `src/core/content-ref.ts`
admits `sha256:<digest>` and nothing else, and exposes the digest it parsed out rather than
re-deriving it later.

Hashing itself is not modelled. `Digest.sha256` is a host primitive: the kernel names the
form a digest has and the laws its *use* obeys — that a content address determines its
digest and its algorithm — and leaves "these bytes hash to this value" to the runtime,
where it is a substrate premise rather than a kernel theorem.
-/
import AgentCore.Kernel.Core.Id

namespace AgentCore.Kernel

/-- The one digest algorithm the runtime admits. -/
inductive DigestAlgorithm where
  | sha256
  deriving DecidableEq, Repr

/-- The algorithm's wire prefix, and the `Digest.algorithm` value. -/
def DigestAlgorithm.wire : DigestAlgorithm → String
  | .sha256 => "sha256"

/-- The number of hexadecimal characters a SHA-256 digest is written with. -/
def digestLength : Nat := 64

/-- One lowercase hexadecimal character: `[a-f0-9]`. -/
def hexLowerDigit (character : Char) : Bool :=
  (48 ≤ character.toNat && character.toNat ≤ 57) ||
    (97 ≤ character.toNat && character.toNat ≤ 102)

theorem hexLowerDigit_bmp {character : Char} (hex : hexLowerDigit character = true) :
    character.toNat < Text.astralFloor := by
  unfold Text.astralFloor
  unfold hexLowerDigit at hex
  rcases Bool.or_eq_true _ _ |>.mp hex with digit | letter
  · have bound := (Bool.and_eq_true _ _).mp digit |>.2
    simp only [decide_eq_true_eq] at bound
    omega
  · have bound := (Bool.and_eq_true _ _).mp letter |>.2
    simp only [decide_eq_true_eq] at bound
    omega

/-- `^[a-f0-9]{64}$`. -/
def digestValid (value : String) : Bool :=
  value.toList.length == digestLength && value.toList.all hexLowerDigit

/-- A digest: the lowercase hexadecimal text, with its form proved. -/
structure Digest where
  value : String
  valid : digestValid value = true

namespace Digest

/-- Every digest the kernel builds is a SHA-256 digest; the field exists because the
runtime's carries it, and one algorithm is the whole domain. -/
def algorithm (_ : Digest) : DigestAlgorithm := .sha256

theorem eq_of_value {left right : Digest} (same : left.value = right.value) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact same

instance : DecidableEq Digest := fun left right =>
  if same : left.value = right.value then .isTrue (eq_of_value same)
  else .isFalse fun equal => same (equal ▸ rfl)

def parse (value : String) : Outcome Digest :=
  if valid : digestValid value = true then .ok ⟨value, valid⟩ else unshaped "Digest"

theorem parse_value {value : String} {digest : Digest} (parsed : parse value = .ok digest) :
    digest.value = value := by
  unfold parse at parsed
  by_cases valid : digestValid value = true
  · simp only [valid, dite_true, Except.ok.injEq] at parsed
    exact parsed ▸ rfl
  · simp [valid, unshaped] at parsed

/-- **A digest is a well-formed identifier.** The runtime's `Digest` extends `TextId`, so
its 64 characters have to satisfy the 1..256 bound as well; here that is a consequence of
the form rather than a second check that could disagree. -/
theorem is_textId (digest : Digest) : textIdValid digest.value = true := by
  have valid := digest.valid
  unfold digestValid at valid
  obtain ⟨count, hex⟩ := (Bool.and_eq_true _ _).mp valid
  simp only [beq_iff_eq] at count
  have bmp : ∀ character ∈ digest.value.toList, character.toNat < Text.astralFloor := by
    intro character mem
    exact hexLowerDigit_bmp (List.all_eq_true.mp hex character mem)
  have length : Text.length digest.value = digestLength := by
    rw [Text.length_of_bmp bmp, count]
  unfold textIdValid
  simp [length, digestLength, textIdMaxLength]

end Digest

/-- `sha256:<digest>`: the only content address form the runtime admits. -/
def contentRefText (digest : Digest) : String :=
  DigestAlgorithm.sha256.wire ++ ":" ++ digest.value

/-- A content address, holding the digest it was parsed from rather than re-deriving it. -/
structure ContentRef where
  digest : Digest
  deriving DecidableEq

namespace ContentRef

/-- The stored text, which is what `ContentRef.value` returns at runtime. -/
def value (reference : ContentRef) : String := contentRefText reference.digest

def algorithm (_ : ContentRef) : DigestAlgorithm := .sha256

/-- `ContentRef.fromDigest`. -/
def ofDigest (digest : Digest) : ContentRef := ⟨digest⟩

/-- Parse `sha256:<64 hex>`; anything else is a shape violation, as at runtime. The prefix
is matched on the character sequence rather than through `startsWith`/`drop`, so the reader
is the exact inverse of `contentRefText` and `parse_value` below is a proof rather than an
assumption about string slicing. -/
def parse (value : String) : Outcome ContentRef :=
  match value.toList with
  | 's' :: 'h' :: 'a' :: '2' :: '5' :: '6' :: ':' :: rest =>
      match Digest.parse (String.ofList rest) with
      | .ok digest => .ok ⟨digest⟩
      | .error _ => unshaped "Content reference"
  | _ => unshaped "Content reference"

/-- **A content address determines its digest.** Equal addresses hold one digest, so a
reader never has two answers for the content one reference names. -/
theorem digest_functional {left right : ContentRef} (same : left = right) :
    left.digest = right.digest := by rw [same]

/-- **Every content address round-trips through its text.** Building an address from a
digest and reading its text back yields exactly the runtime's `sha256:` form, so a stored
reference and a rebuilt one are the same string. -/
theorem ofDigest_value (digest : Digest) : (ofDigest digest).value = contentRefText digest :=
  rfl

theorem contentRefText_toList (digest : Digest) :
    (contentRefText digest).toList =
      's' :: 'h' :: 'a' :: '2' :: '5' :: '6' :: ':' :: digest.value.toList := by
  have algorithmText : (DigestAlgorithm.sha256.wire).toList = ['s', 'h', 'a', '2', '5', '6'] := by
    decide
  have separator : (":" : String).toList = [':'] := by decide
  unfold contentRefText
  rw [String.toList_append, String.toList_append, algorithmText, separator]
  rfl

/-- **Every content address reads back as itself.** The text form and the reader are
inverse, so a stored `sha256:` reference decodes to the exact address that wrote it and no
record carrying one needs a second normalization. -/
theorem parse_value (reference : ContentRef) : parse reference.value = .ok reference := by
  obtain ⟨digest⟩ := reference
  have digestParse : Digest.parse digest.value = .ok digest := by
    unfold Digest.parse
    simp [digest.valid]
  show parse (contentRefText digest) = _
  unfold parse
  rw [contentRefText_toList]
  simp [String.ofList_toList, digestParse]

end ContentRef

end AgentCore.Kernel
