/-
The JSON image the kernel's codecs read and write (SPEC §8.1, §8.3).

`src/core/json.ts` types `JsonValue` as JavaScript's own JSON space; `src/core/canonical.ts`
narrows it to a canonical form — object entries sorted by `compareCanonicalText`, `-0`
normalized to `0`, non-finite numbers refused — and every digest and every record equality
in the codebase is taken over those bytes.

The kernel's `JsonValue` differs from the runtime type in exactly one way, deliberately:
its numbers are integers. Every number a kernel record carries is a count, an epoch, a
revision, a codec version, or a micro-amount, and each of those is read back through a
safe-integer reader; a non-integer number is not a value any of these records can hold.
Narrowing the type is what makes this encoding provably injective, rather than injective
modulo the shortest-round-trip float algorithm the model registered as the residual half of
`ASM-CANONICAL-KEY-INJECTIVE`.

`toTree` is the bridge: it maps the kernel's value into the model's `JsonTree`, so the
canonical text a kernel codec emits *is* the text `AgentCore.encodeJson` defines, and the
model's injectivity theorem applies to it unchanged.
-/
import AgentCore.CanonicalJson
import AgentCore.Kernel.Core.Text
import AgentCore.Kernel.Error

namespace AgentCore.Kernel.Json

/-- The JSON value space the kernel's records live in. No `Repr` is derived: for a nested
inductive the derived instance is `partial`, which the normative gate refuses, and nothing in
the kernel renders a value except through the canonical encoder below. -/
inductive JsonValue where
  | null
  | bool (value : Bool)
  | int (value : Int)
  | str (value : String)
  | arr (items : List JsonValue)
  | obj (entries : List (String × JsonValue))
  deriving Inhabited

/-! ## Decimal rendering

`JSON.stringify` writes an integer as its shortest decimal form: an optional minus sign and
digits with no leading zero. The kernel renders the same form and reads it back, so the
rendering is injective by round-trip rather than by an assumption about number printing. -/

/-- One decimal digit. -/
def digitChar (value : Nat) : Char := Char.ofNat (48 + value)

/-- The digit a character denotes, if it is one. -/
def digitValue (character : Char) : Option Nat :=
  if 48 ≤ character.toNat ∧ character.toNat ≤ 57 then some (character.toNat - 48) else none

theorem digitValue_digitChar {value : Nat} (bound : value < 10) :
    digitValue (digitChar value) = some value := by
  have enumerated : value = 0 ∨ value = 1 ∨ value = 2 ∨ value = 3 ∨ value = 4 ∨ value = 5 ∨
      value = 6 ∨ value = 7 ∨ value = 8 ∨ value = 9 := by omega
  rcases enumerated with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> decide

theorem digitChar_ne_minus {value : Nat} (bound : value < 10) : digitChar value ≠ '-' := by
  have enumerated : value = 0 ∨ value = 1 ∨ value = 2 ∨ value = 3 ∨ value = 4 ∨ value = 5 ∨
      value = 6 ∨ value = 7 ∨ value = 8 ∨ value = 9 := by omega
  rcases enumerated with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> decide

/-- The decimal digits of a natural number, least significant first. -/
def natDigitsRev : Nat → List Char
  | 0 => []
  | value + 1 => digitChar ((value + 1) % 10) :: natDigitsRev ((value + 1) / 10)
decreasing_by exact Nat.div_lt_self (by omega) (by omega)

theorem natDigitsRev_succ (value : Nat) :
    natDigitsRev (value + 1) =
      digitChar ((value + 1) % 10) :: natDigitsRev ((value + 1) / 10) := by
  simp [natDigitsRev]

/-- The decimal text of a natural number, most significant first. -/
def natToken (value : Nat) : List Char :=
  if value = 0 then ['0'] else (natDigitsRev value).reverse

/-- Reading digits back, least significant first. -/
def natOfDigitsRev : List Char → Option Nat
  | [] => some 0
  | character :: rest =>
      match digitValue character, natOfDigitsRev rest with
      | some digit, some upper => some (digit + 10 * upper)
      | _, _ => none

/-- Reading a decimal token back. -/
def natOfToken (token : List Char) : Option Nat := natOfDigitsRev token.reverse

theorem natOfDigitsRev_natDigitsRev : ∀ value : Nat,
    natOfDigitsRev (natDigitsRev value) = some value
  | 0 => by simp [natDigitsRev, natOfDigitsRev]
  | value + 1 => by
      have lower : (value + 1) % 10 < 10 := Nat.mod_lt _ (by omega)
      have upper := natOfDigitsRev_natDigitsRev ((value + 1) / 10)
      rw [natDigitsRev_succ]
      simp only [natOfDigitsRev, digitValue_digitChar lower, upper]
      simp [Nat.mod_add_div]
decreasing_by exact Nat.div_lt_self (by omega) (by omega)

/-- **Decimal rendering round-trips.** -/
theorem natOfToken_natToken (value : Nat) : natOfToken (natToken value) = some value := by
  unfold natOfToken natToken
  by_cases zero : value = 0
  · simp [zero, natOfDigitsRev, digitValue]
  · simp [zero, natOfDigitsRev_natDigitsRev]

theorem natDigitsRev_digits : ∀ (value : Nat) (character : Char),
    character ∈ natDigitsRev value → ∃ digit, digit < 10 ∧ character = digitChar digit
  | 0, _, mem => by simp [natDigitsRev] at mem
  | value + 1, character, mem => by
      rw [natDigitsRev_succ] at mem
      rcases List.mem_cons.mp mem with head | tail
      · exact ⟨(value + 1) % 10, Nat.mod_lt _ (by omega), head⟩
      · exact natDigitsRev_digits ((value + 1) / 10) character tail
decreasing_by exact Nat.div_lt_self (by omega) (by omega)

/-- **A decimal token holds nothing but digits.** In particular it never begins with the
minus sign, which is what makes the signed reader's two branches disjoint. -/
theorem natToken_not_signed (value : Nat) (rest : List Char) : natToken value ≠ '-' :: rest := by
  intro signed
  have mem : '-' ∈ natToken value := by rw [signed]; exact List.mem_cons_self
  unfold natToken at mem
  by_cases zero : value = 0
  · simp [zero] at mem
  · simp only [zero, if_false, List.mem_reverse] at mem
    obtain ⟨digit, bound, shape⟩ := natDigitsRev_digits value '-' mem
    exact digitChar_ne_minus bound shape.symm

/-- The canonical text of an integer, as `JSON.stringify` writes it. There is no `-0`: the
runtime normalizes it to `0` before encoding, and `Int` has no such value at all. -/
def intToken (value : Int) : List Char :=
  if value < 0 then '-' :: natToken value.natAbs else natToken value.natAbs

/-- Reading an integer token back. -/
def intOfToken (token : List Char) : Option Int :=
  match token with
  | '-' :: rest => (natOfToken rest).map (fun magnitude => -(magnitude : Int))
  | _ => (natOfToken token).map (fun magnitude => (magnitude : Int))

/-- **Integer rendering round-trips, so it is injective.** Distinct integers therefore have
distinct canonical tokens, which is exactly what the model's tree injectivity asks of
numbers and what the ledger left as an assumption for floating-point renderings. -/
theorem intOfToken_intToken (value : Int) : intOfToken (intToken value) = some value := by
  by_cases negative : value < 0
  · have token : intToken value = '-' :: natToken value.natAbs := by
      simp [intToken, negative]
    have magnitude : -((value.natAbs : Int)) = value := by omega
    simp [token, intOfToken, natOfToken_natToken, magnitude]
  · have token : intToken value = natToken value.natAbs := by
      simp [intToken, negative]
    have magnitude : ((value.natAbs : Int)) = value := by omega
    rw [token]
    unfold intOfToken
    split
    · next rest signed => exact absurd signed (natToken_not_signed value.natAbs rest)
    · simp [natOfToken_natToken, magnitude]

theorem numberChar_digitChar {value : Nat} (bound : value < 10) :
    AgentCore.numberChar (digitChar value) = true := by
  have enumerated : value = 0 ∨ value = 1 ∨ value = 2 ∨ value = 3 ∨ value = 4 ∨ value = 5 ∨
      value = 6 ∨ value = 7 ∨ value = 8 ∨ value = 9 := by omega
  rcases enumerated with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> decide

theorem natToken_nonempty (value : Nat) : natToken value ≠ [] := by
  unfold natToken
  by_cases zero : value = 0
  · simp [zero]
  · simp only [zero, if_false, ne_eq, List.reverse_eq_nil_iff]
    cases positive : value with
    | zero => exact absurd positive zero
    | succ predecessor => rw [natDigitsRev_succ]; simp

theorem natToken_all_numberChar (value : Nat) :
    (natToken value).all AgentCore.numberChar = true := by
  refine List.all_eq_true.mpr ?_
  intro character mem
  unfold natToken at mem
  by_cases zero : value = 0
  · simp only [zero, if_true, List.mem_singleton] at mem
    rw [mem]
    decide
  · simp only [zero, if_false, List.mem_reverse] at mem
    obtain ⟨digit, bound, shape⟩ := natDigitsRev_digits value character mem
    rw [shape]
    exact numberChar_digitChar bound

/-- **A rendered integer is a token of the model's number grammar.** -/
theorem intToken_numberToken (value : Int) :
    AgentCore.numberToken (intToken value) = true := by
  unfold AgentCore.numberToken intToken
  by_cases negative : value < 0
  · simp only [negative, if_true, List.isEmpty_cons, Bool.not_false, Bool.true_and]
    refine List.all_eq_true.mpr ?_
    intro character mem
    rcases List.mem_cons.mp mem with head | tail
    · rw [head]; decide
    · exact List.all_eq_true.mp (natToken_all_numberChar value.natAbs) character tail
  · simp only [negative, if_false]
    cases shape : natToken value.natAbs with
    | nil => exact absurd shape (natToken_nonempty value.natAbs)
    | cons leading rest =>
        have all := natToken_all_numberChar value.natAbs
        rw [shape] at all
        simp [all]

theorem intToken_injective {left right : Int} (same : intToken left = intToken right) :
    left = right := by
  have read := congrArg intOfToken same
  rw [intOfToken_intToken, intOfToken_intToken] at read
  exact Option.some.inj read

/-! ## The bridge to the model's canonical encoder -/

mutual

/-- The model's canonical tree this value encodes as. -/
def toTree : JsonValue → AgentCore.JsonTree
  | .null => .null
  | .bool value => .bool value
  | .int value => .num (intToken value)
  | .str value => .str value.toList
  | .arr items => .arr (toTreeItems items)
  | .obj entries => .obj (toTreeEntries entries)

def toTreeItems : List JsonValue → List AgentCore.JsonTree
  | [] => []
  | item :: rest => toTree item :: toTreeItems rest

def toTreeEntries : List (String × JsonValue) → List (List Char × AgentCore.JsonTree)
  | [] => []
  | entry :: rest => (entry.1.toList, toTree entry.2) :: toTreeEntries rest

end

/-- The canonical text of a kernel JSON value: the model's encoding of its tree. -/
def canonicalText (value : JsonValue) : List Char := AgentCore.encodeJson (toTree value)

mutual

/-- Reading a model tree back as a kernel value. Total: a tree whose number token is not a
canonical integer, or whose strings are not the kernel's, simply is not a kernel value. -/
def ofTree : AgentCore.JsonTree → Option JsonValue
  | .null => some .null
  | .bool value => some (.bool value)
  | .num token => (intOfToken token).map .int
  | .str value => some (.str (String.ofList value))
  | .arr items => (ofTreeItems items).map .arr
  | .obj entries => (ofTreeEntries entries).map .obj

def ofTreeItems : List AgentCore.JsonTree → Option (List JsonValue)
  | [] => some []
  | item :: rest =>
      match ofTree item, ofTreeItems rest with
      | some value, some values => some (value :: values)
      | _, _ => none

def ofTreeEntries :
    List (List Char × AgentCore.JsonTree) → Option (List (String × JsonValue))
  | [] => some []
  | entry :: rest =>
      match ofTree entry.2, ofTreeEntries rest with
      | some value, some values => some ((String.ofList entry.1, value) :: values)
      | _, _ => none

end

mutual

/-- **Every kernel value reads back from its model tree.** -/
theorem ofTree_toTree : ∀ value : JsonValue, ofTree (toTree value) = some value
  | .null => rfl
  | .bool _ => rfl
  | .int number => by simp [toTree, ofTree, intOfToken_intToken]
  | .str text => by simp [toTree, ofTree]
  | .arr items => by simp [toTree, ofTree, ofTree_toTreeItems items]
  | .obj entries => by simp [toTree, ofTree, ofTree_toTreeEntries entries]

theorem ofTree_toTreeItems : ∀ items : List JsonValue,
    ofTreeItems (toTreeItems items) = some items
  | [] => rfl
  | item :: rest => by
      simp [toTreeItems, ofTreeItems, ofTree_toTree item, ofTree_toTreeItems rest]

theorem ofTree_toTreeEntries : ∀ entries : List (String × JsonValue),
    ofTreeEntries (toTreeEntries entries) = some entries
  | [] => rfl
  | entry :: rest => by
      simp [toTreeEntries, ofTreeEntries, ofTree_toTree entry.2,
        ofTree_toTreeEntries rest]

end

/-- **The bridge is injective.** Two kernel values with one model tree are one value. -/
theorem toTree_injective {left right : JsonValue} (same : toTree left = toTree right) :
    left = right := by
  have read := congrArg ofTree same
  rw [ofTree_toTree, ofTree_toTree] at read
  exact Option.some.inj read

mutual

/-- **Kernel numbers are in the model's number grammar.** The model's injectivity theorem
applies to kernel trees without a side condition, because every token the kernel writes is
a nonempty string of JSON number characters. -/
theorem toTree_numbersValid : ∀ value : JsonValue,
    AgentCore.numbersValid (toTree value) = true
  | .null => rfl
  | .bool _ => rfl
  | .int number => by
      simp [toTree, AgentCore.numbersValid, intToken_numberToken]
  | .str _ => rfl
  | .arr items => by simp [toTree, AgentCore.numbersValid, toTree_itemsValid items]
  | .obj entries => by simp [toTree, AgentCore.numbersValid, toTree_entriesValid entries]

theorem toTree_itemsValid : ∀ items : List JsonValue,
    AgentCore.itemsValid (toTreeItems items) = true
  | [] => rfl
  | item :: rest => by
      simp [toTreeItems, AgentCore.itemsValid, toTree_numbersValid item,
        toTree_itemsValid rest]

theorem toTree_entriesValid : ∀ entries : List (String × JsonValue),
    AgentCore.entriesValid (toTreeEntries entries) = true
  | [] => rfl
  | entry :: rest => by
      simp [toTreeEntries, AgentCore.entriesValid, toTree_numbersValid entry.2,
        toTree_entriesValid rest]

end

/-- **Canonical text identifies a kernel JSON value.** Comparing encoder bytes — what the
runtime's `canonicalJsonEqual` does — decides equality of the values behind them. For
kernel values this is unconditional: the residual number-rendering assumption the model
registered does not apply, because `intToken` is proved injective. -/
theorem canonicalText_injective {left right : JsonValue}
    (same : canonicalText left = canonicalText right) : left = right :=
  toTree_injective (AgentCore.canonical_encode_injective (toTree_numbersValid left)
    (toTree_numbersValid right) same)

/-! ## Canonical shape

A canonical object's entries are strictly ordered by key, which is what `canonicalString`
achieves by sorting before it writes. The kernel's encoders emit entries already ordered, so
canonicality is a property each codec's output has by construction and each record proves. -/

mutual

/-- Entries strictly ordered by canonical key order, at every depth. -/
def canonical : JsonValue → Bool
  | .null | .bool _ | .int _ | .str _ => true
  | .arr items => canonicalItems items
  | .obj entries => Text.strictlyOrdered (entries.map Prod.fst) && canonicalEntries entries

def canonicalItems : List JsonValue → Bool
  | [] => true
  | item :: rest => canonical item && canonicalItems rest

def canonicalEntries : List (String × JsonValue) → Bool
  | [] => true
  | entry :: rest => canonical entry.2 && canonicalEntries rest

end

/-! ## Reading fields

The runtime's readers throw `TypeError` on a shape they cannot use, and `RecordCodec.decode`
turns that into a `codec.invalid` refusal. The kernel keeps the two apart the same way: a
field reader answers with a shape fault naming the field, and the codec boundary is the one
place that converts it. -/

/-- The value stored under a key, if any. -/
def field (entries : List (String × JsonValue)) (key : String) : Option JsonValue :=
  match entries.find? (fun entry => entry.1 == key) with
  | some entry => some entry.2
  | none => none

/-- The object's keys, in stored order. -/
def keys (entries : List (String × JsonValue)) : List String := entries.map Prod.fst

/-- `requireObject`. -/
def asObject (value : JsonValue) (subject : String) : Outcome (List (String × JsonValue)) :=
  match value with
  | .obj entries => .ok entries
  | _ => unshaped subject

/-- `requireArray`. -/
def asArray (value : JsonValue) (subject : String) : Outcome (List JsonValue) :=
  match value with
  | .arr items => .ok items
  | _ => unshaped subject

/-- `requireString`. -/
def asString (value : JsonValue) (subject : String) : Outcome String :=
  match value with
  | .str text => .ok text
  | _ => unshaped subject

/-- `requireInteger`. -/
def asInt (value : JsonValue) (subject : String) : Outcome Int :=
  match value with
  | .int number => .ok number
  | _ => unshaped subject

/-- `requireBoolean`. -/
def asBool (value : JsonValue) (subject : String) : Outcome Bool :=
  match value with
  | .bool flag => .ok flag
  | _ => unshaped subject

/-- A non-negative count: the shape every epoch, ordinal, and total is read at. -/
def asNat (value : JsonValue) (subject : String) : Outcome Nat :=
  match value with
  | .int number => if number < 0 then unshaped subject else .ok number.natAbs
  | _ => unshaped subject

/-- `requireExactFields`: exactly these keys, in canonical order, no more and no fewer. -/
def exactFields (entries : List (String × JsonValue)) (expected : List String) : Bool :=
  keys entries == expected

/-- A field the record requires. -/
def required (entries : List (String × JsonValue)) (key : String) (subject : String) :
    Outcome JsonValue :=
  match field entries key with
  | some value => .ok value
  | none => unshaped subject

/-- An optional field, written as `null` when absent. -/
def optional (value : JsonValue) : Option JsonValue :=
  match value with
  | .null => none
  | present => some present

theorem asString_str (text : String) (subject : String) :
    asString (.str text) subject = .ok text := rfl

theorem asNat_int {number : Int} (subject : String) (nonneg : ¬ number < 0) :
    asNat (.int number) subject = .ok number.natAbs := by simp [asNat, nonneg]

theorem field_cons_hit (key : String) (value : JsonValue)
    (rest : List (String × JsonValue)) : field ((key, value) :: rest) key = some value := by
  simp [field, List.find?]

end AgentCore.Kernel.Json
