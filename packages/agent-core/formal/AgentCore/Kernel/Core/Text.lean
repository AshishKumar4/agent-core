/-
Text as the runtime measures and orders it (SPEC §1.4, §8.1).

Two runtime facts about strings are load-bearing all over `src/core`, and both are about
UTF-16 rather than about scalar values:

* `TextId` bounds its value by `String.prototype.length`, which counts UTF-16 code units,
  so one astral scalar value spends two of the 256 an identifier may hold.
* `compareCanonicalText` is ECMAScript `<`, which orders by UTF-16 code unit. Canonical
  JSON sorts object keys with it, so it decides the bytes every digest is taken over.

A `Char` in Lean is a Unicode scalar value, so code-point order and code-unit order agree
below U+E000 and disagree above it: an astral scalar leads with a high surrogate (0xD800)
and therefore sorts *before* U+E000..U+FFFF, which code-point order puts first. The kernel
models the code-unit order the runtime actually uses instead of assuming the two agree.
-/

namespace AgentCore.Kernel.Text

/-- The first astral code point: the boundary where one scalar value costs two code units. -/
def astralFloor : Nat := 0x10000

/-- How many UTF-16 code units one scalar value occupies. -/
def unitWidth (character : Char) : Nat :=
  if character.toNat < astralFloor then 1 else 2

/-- The UTF-16 code units of one scalar value: itself, or its surrogate pair. -/
def unitsOf (character : Char) : List Nat :=
  if character.toNat < astralFloor then [character.toNat]
  else
    let offset := character.toNat - astralFloor
    [0xD800 + offset / 0x400, 0xDC00 + offset % 0x400]

/-- The UTF-16 code units of a string, in order. -/
def units (value : String) : List Nat := value.toList.flatMap unitsOf

/-- `String.prototype.length`. -/
def length (value : String) : Nat := (value.toList.map unitWidth).sum

theorem unitsOf_length (character : Char) : (unitsOf character).length = unitWidth character := by
  unfold unitsOf unitWidth
  split <;> rfl

/-- **The modelled length is the modelled encoding's length.** The bound `TextId` enforces
and the sequence `compareCanonicalText` orders by are two readings of one encoding. -/
theorem units_length (value : String) : (units value).length = length value := by
  unfold units length
  induction value.toList with
  | nil => rfl
  | cons character rest ih =>
      simp [List.flatMap_cons, unitsOf_length, ih, Nat.add_comm]

theorem widths_sum_of_bmp : ∀ (characters : List Char),
    (∀ character ∈ characters, character.toNat < astralFloor) →
    (characters.map unitWidth).sum = characters.length
  | [], _ => rfl
  | character :: rest, bmp => by
      have head : unitWidth character = 1 := by
        unfold unitWidth
        simp [bmp character (by simp)]
      have tail := widths_sum_of_bmp rest fun candidate mem => bmp candidate (by simp [mem])
      simp [head, tail, Nat.add_comm]

/-- **Basic Multilingual Plane text costs one unit per scalar value.** Where a string holds
no astral scalar, the runtime's `length` and Lean's code-point count agree, which is why a
fixed-width ASCII form such as a hexadecimal digest can be bounded either way. -/
theorem length_of_bmp {value : String}
    (bmp : ∀ character ∈ value.toList, character.toNat < astralFloor) :
    length value = value.toList.length :=
  widths_sum_of_bmp value.toList bmp

/-- Lexicographic order on code units: ECMAScript's `<` on strings. -/
def compareUnits : List Nat → List Nat → Ordering
  | [], [] => .eq
  | [], _ :: _ => .lt
  | _ :: _, [] => .gt
  | left :: leftRest, right :: rightRest =>
      if left < right then .lt
      else if right < left then .gt
      else compareUnits leftRest rightRest

/-- `compareCanonicalText`: -1, 0, 1 as `Ordering`. -/
def compare (left right : String) : Ordering := compareUnits (units left) (units right)

/-- Strictly before, in canonical order. -/
def before (left right : String) : Bool := compare left right == .lt

theorem compareUnits_eq_iff : ∀ (left right : List Nat),
    compareUnits left right = .eq ↔ left = right
  | [], [] => by simp [compareUnits]
  | [], _ :: _ => by simp [compareUnits]
  | _ :: _, [] => by simp [compareUnits]
  | left :: leftRest, right :: rightRest => by
      unfold compareUnits
      split
      · next lower => simp [Nat.ne_of_lt lower]
      · split
        · next _ greater => simp [Nat.ne_of_gt greater]
        · next notLower notGreater =>
            have same : left = right := Nat.le_antisymm (Nat.not_lt.mp notGreater)
              (Nat.not_lt.mp notLower)
            simp [same, compareUnits_eq_iff leftRest rightRest]

/-- **Canonical comparison decides equality of the encoded text.** Object keys therefore
sort into one order, and a canonical encoder that sorts by this comparison emits one byte
string for one JSON object. -/
theorem compare_eq_iff (left right : String) :
    Text.compare left right = .eq ↔ units left = units right :=
  compareUnits_eq_iff (units left) (units right)

theorem compare_self (value : String) : Text.compare value value = .eq :=
  (compare_eq_iff value value).mpr rfl

theorem before_irrefl (value : String) : before value value = false := by
  simp [before, compare_self]

/-- Keys in strictly increasing canonical order: the shape a canonical object's entry list
has, and the shape the kernel's encoders emit by construction. -/
def strictlyOrdered : List String → Bool
  | [] => true
  | [_] => true
  | first :: second :: rest => before first second && strictlyOrdered (second :: rest)

theorem strictlyOrdered_cons_of {first second : String} {rest : List String}
    (ordered : strictlyOrdered (first :: second :: rest) = true) :
    before first second = true ∧ strictlyOrdered (second :: rest) = true := by
  simpa [strictlyOrdered] using ordered

/-! ## Canonical order is an order

Canonical ordering is load-bearing beyond object keys: the runtime sorts admission
obligations, settlement obligations, and placement entries by canonical key, and a digest
over the result is only stable if the comparison is a strict total order. These are the two
facts that make it one. -/

theorem compareUnits_lt_trans : ∀ (left mid right : List Nat),
    compareUnits left mid = .lt → compareUnits mid right = .lt → compareUnits left right = .lt
  | [], [], _, first, _ => by simp [compareUnits] at first
  | [], _ :: _, [], _, second => by simp [compareUnits] at second
  | [], _ :: _, _ :: _, _, _ => rfl
  | _ :: _, [], _, first, _ => by simp [compareUnits] at first
  | _ :: _, _ :: _, [], _, second => by simp [compareUnits] at second
  | leftHead :: leftRest, midHead :: midRest, rightHead :: rightRest, first, second => by
      unfold compareUnits at first second ⊢
      by_cases leftLower : leftHead < midHead
      · by_cases midLower : midHead < rightHead
        · simp [Nat.lt_trans leftLower midLower]
        · by_cases rightLower : rightHead < midHead
          · simp [midLower, rightLower] at second
          · have same : midHead = rightHead :=
              Nat.le_antisymm (Nat.not_lt.mp rightLower) (Nat.not_lt.mp midLower)
            simp [← same, leftLower]
      · by_cases midLower : midHead < leftHead
        · simp [leftLower, midLower] at first
        · have same : leftHead = midHead :=
            Nat.le_antisymm (Nat.not_lt.mp midLower) (Nat.not_lt.mp leftLower)
          subst same
          simp only [leftLower] at first
          by_cases rightLower : leftHead < rightHead
          · simp [rightLower]
          · by_cases lowerRight : rightHead < leftHead
            · simp [rightLower, lowerRight] at second
            · have rightSame : leftHead = rightHead :=
                Nat.le_antisymm (Nat.not_lt.mp lowerRight) (Nat.not_lt.mp rightLower)
              subst rightSame
              simp only [leftLower] at second ⊢
              exact compareUnits_lt_trans leftRest midRest rightRest first second

theorem compareUnits_total : ∀ (left right : List Nat),
    compareUnits left right = .lt ∨ compareUnits left right = .eq ∨
      compareUnits right left = .lt
  | [], [] => .inr (.inl rfl)
  | [], _ :: _ => .inl rfl
  | _ :: _, [] => .inr (.inr rfl)
  | leftHead :: leftRest, rightHead :: rightRest => by
      unfold compareUnits
      by_cases leftLower : leftHead < rightHead
      · exact .inl (by simp [leftLower])
      · by_cases rightLower : rightHead < leftHead
        · exact .inr (.inr (by simp [rightLower]))
        · have same : leftHead = rightHead :=
            Nat.le_antisymm (Nat.not_lt.mp rightLower) (Nat.not_lt.mp leftLower)
          subst same
          simp only [leftLower]
          rcases compareUnits_total leftRest rightRest with lower | equal | greater
          · exact .inl lower
          · exact .inr (.inl equal)
          · exact .inr (.inr greater)

/-- **Canonical order is transitive.** -/
theorem before_trans {left mid right : String} (first : before left mid = true)
    (second : before mid right = true) : before left right = true := by
  unfold before Text.compare at first second ⊢
  simp only [beq_iff_eq] at first second ⊢
  exact compareUnits_lt_trans _ _ _ first second

/-- **Canonical order is total on distinct text.** Two keys that are not equal as encoded
text are ordered one way or the other, so a sort by this comparison is deterministic. -/
theorem before_total {left right : String} (different : units left ≠ units right) :
    before left right = true ∨ before right left = true := by
  unfold before Text.compare
  simp only [beq_iff_eq]
  rcases compareUnits_total (units left) (units right) with lower | equal | greater
  · exact .inl lower
  · exact absurd ((compareUnits_eq_iff _ _).mp equal) different
  · exact .inr greater
theorem strictlyOrdered_cons {value : String} {values : List String}
    (head : ∀ existing ∈ values, before value existing = true)
    (ordered : strictlyOrdered values = true) : strictlyOrdered (value :: values) = true := by
  cases values with
  | nil => rfl
  | cons first rest => simpa [strictlyOrdered] using ⟨head first (by simp), ordered⟩

/-- **A sorted list's head precedes every later element**, not merely the next one. This is
transitivity applied along the chain, and it is what makes `strictlyOrdered` a statement
about the whole list rather than about adjacent pairs. -/
theorem strictlyOrdered_head_bound : ∀ (value : String) (values : List String),
    strictlyOrdered (value :: values) = true →
      ∀ existing ∈ values, before value existing = true
  | _, [], _, _, member => by simp at member
  | value, first :: rest, ordered, existing, member => by
      have chain := strictlyOrdered_cons_of ordered
      rcases List.mem_cons.mp member with hit | deeper
      · rw [hit]
        exact chain.1
      · exact before_trans chain.1
          (strictlyOrdered_head_bound first rest chain.2 existing deeper)

/-- Insert one value into a list kept in canonical key order. -/
def insertBy {α : Type} (key : α → String) (value : α) : List α → List α
  | [] => [value]
  | head :: rest =>
      if before (key value) (key head) then value :: head :: rest
      else head :: insertBy key value rest

theorem mem_insertBy {α : Type} (key : α → String) (value : α) :
    ∀ (values : List α) (candidate : α),
      candidate ∈ insertBy key value values → candidate = value ∨ candidate ∈ values
  | [], candidate, member => .inl (by simpa [insertBy] using member)
  | head :: rest, candidate, member => by
      unfold insertBy at member
      by_cases lower : before (key value) (key head) = true
      · rw [if_pos lower] at member
        rcases List.mem_cons.mp member with hit | tail
        · exact .inl hit
        · exact .inr tail
      · rw [if_neg lower] at member
        rcases List.mem_cons.mp member with hit | tail
        · exact .inr (by simp [hit])
        · rcases mem_insertBy key value rest candidate tail with isValue | inRest
          · exact .inl isValue
          · exact .inr (by simp [inRest])

/-- **Sorted insertion keeps the list sorted**, given that the inserted key is new. This is
what makes "canonical order" an invariant a record can carry instead of a normalization step
every reader has to repeat. -/
theorem insertBy_ordered {α : Type} (key : α → String) (value : α) :
    ∀ (values : List α), strictlyOrdered (values.map key) = true →
      (∀ existing ∈ values, units (key existing) ≠ units (key value)) →
      strictlyOrdered ((insertBy key value values).map key) = true
  | [], _, _ => rfl
  | head :: rest, ordered, fresh => by
      unfold insertBy
      by_cases lower : before (key value) (key head) = true
      · rw [if_pos lower]
        refine strictlyOrdered_cons ?_ ordered
        intro existing member
        rcases List.mem_cons.mp member with first | tail
        · rw [first]
          exact lower
        · exact before_trans lower (strictlyOrdered_head_bound (key head) (rest.map key)
            (by simpa using ordered) existing tail)
      · rw [if_neg lower]
        have keyDiffers : units (key head) ≠ units (key value) := fresh head (by simp)
        have headBefore : before (key head) (key value) = true := by
          rcases before_total (left := key value) (right := key head)
              (fun same => keyDiffers same.symm) with valueFirst | headFirst
          · exact absurd valueFirst lower
          · exact headFirst
        have tailOrdered : strictlyOrdered (rest.map key) = true := by
          cases rest with
          | nil => rfl
          | cons second tail =>
              exact (strictlyOrdered_cons_of (by simpa using ordered)).2
        refine strictlyOrdered_cons ?_ (insertBy_ordered key value rest tailOrdered
          (fun existing member => fresh existing (by simp [member])))
        intro existing member
        obtain ⟨candidate, candidateMember, candidateKey⟩ := List.mem_map.mp
          (by simpa using member)
        rw [← candidateKey]
        rcases mem_insertBy key value rest candidate candidateMember with isValue | inRest
        · rw [isValue]
          exact headBefore
        · exact strictlyOrdered_head_bound (key head) (rest.map key) (by simpa using ordered)
            (key candidate) (List.mem_map.mpr ⟨candidate, inRest, rfl⟩)

end AgentCore.Kernel.Text
