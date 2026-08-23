import AgentCore.Model

/-!
# Canonical JSON as a representation relation (SPEC §3.4, §8.1)

`encodeCanonicalJson` is the bottom of the identity stack. Composite keys are built from it —
`authorityKey` joins a scheme tag, a kind, and a component tuple into one string — digests
are taken over it, and record equality is decided by comparing its bytes. Every theorem in
this package that reasons about a Scope, a Subject, or a Grant as a *value* describes the
implementation only if that encoding determines the value it came from.

`ASM-CANONICAL-KEY-INJECTIVE` has stood as a registered assumption for exactly that step:
"composite keys built by canonical-JSON encoding a component tuple are injective on that
tuple", with the note that the encoder's quoting and escaping rules were not modeled. This
module models them, and for every key the authority plane builds the assumption becomes a
theorem.

`AC-KEY-001`'s delimiter join is the contrasting scheme: injective only when one side is
proved delimiter-free, which is an obligation an implementation must discharge per key.
Canonical JSON carries no such obligation. `authorityKey_injective` holds for arbitrary
identifier text — including the U+0000 that makes the delimiter join collide — because the
encoder escapes instead of trusting the component domain.

## The encoding

`canonicalString` is `JSON.stringify` restricted to a canonical form: object entries sorted
by key, `-0` normalized, non-finite numbers refused. This module reproduces its grammar:
`null`, `true`/`false`, a number token, a quoted string under `JSON.stringify`'s escape
rules, a bracketed comma-separated array, and a braced comma-separated object of
`"key":value` pairs.

## What this does and does not carry

Numbers are modeled by their *rendered token* rather than by a numeric value, constrained to
the digits, sign, point, and exponent characters a JSON number can use. Tree injectivity
therefore holds given that distinct JavaScript numbers render to distinct tokens — a
property of the shortest-round-trip algorithm behind `Number.prototype.toString`, not proved
here, and what remains of `ASM-CANONICAL-KEY-INJECTIVE`. Nothing in the authority key scheme
depends on it: every component of a Scope or Subject key is a string or `null`, so
`scope_key_injective` and `subject_key_injective` are unconditional.

Strings are modeled as sequences of code points. `isJsonValue` rejects lone surrogates
before `encodeCanonicalJson` runs, so the surrogate branch of the escape table is
unreachable and is not modeled. UTF-8 byte encoding is not modeled either: the
implementation compares encoder bytes, and `TextEncoder` injectivity on scalar-value
sequences stays an implementation obligation.

Object key *ordering* is not what injectivity rests on — two entry lists differing in order
already encode differently. Sortedness is what makes the encoding canonical, that is, what
gives one JSON object one encoding. That is a different property and is not claimed here.
-/

namespace AgentCore

/-! ## Escaping

`JSON.stringify` escapes `"` and `\` with a backslash, uses the five short escapes, and
renders every other control point as `\u00XX` in lowercase hexadecimal. -/

def hexDigit (value : Nat) : Char :=
  if value < 10 then Char.ofNat (48 + value) else Char.ofNat (87 + value)

def hexValue (character : Char) : Option Nat :=
  if 48 ≤ character.toNat ∧ character.toNat ≤ 57 then some (character.toNat - 48)
  else if 97 ≤ character.toNat ∧ character.toNat ≤ 102 then some (character.toNat - 87)
  else none

theorem hexValue_hexDigit {value : Nat} (bound : value < 16) :
    hexValue (hexDigit value) = some value := by
  have enumerated : value = 0 ∨ value = 1 ∨ value = 2 ∨ value = 3 ∨ value = 4 ∨ value = 5 ∨
      value = 6 ∨ value = 7 ∨ value = 8 ∨ value = 9 ∨ value = 10 ∨ value = 11 ∨ value = 12 ∨
      value = 13 ∨ value = 14 ∨ value = 15 := by omega
  rcases enumerated with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl |
    rfl | rfl | rfl | rfl <;> decide

/-- One code point as `JSON.stringify` writes it. -/
def escapeChar (character : Char) : List Char :=
  if character = '"' then ['\\', '"']
  else if character = '\\' then ['\\', '\\']
  else if character.toNat = 8 then ['\\', 'b']
  else if character.toNat = 12 then ['\\', 'f']
  else if character.toNat = 10 then ['\\', 'n']
  else if character.toNat = 13 then ['\\', 'r']
  else if character.toNat = 9 then ['\\', 't']
  else if character.toNat < 32 then
    ['\\', 'u', '0', '0', hexDigit (character.toNat / 16), hexDigit (character.toNat % 16)]
  else [character]

/-- Reading one escape back. This exists to prove the escape code is prefix-free: an escaped
run splits into its code points in exactly one way, which is what makes the closing quote
unambiguous. -/
def unescapeOne : List Char → Option (Char × List Char)
  | [] => none
  | first :: rest =>
      if first ≠ '\\' then some (first, rest)
      else
        match rest with
        | [] => none
        | second :: tail =>
            if second = '"' then some ('"', tail)
            else if second = '\\' then some ('\\', tail)
            else if second = 'b' then some (Char.ofNat 8, tail)
            else if second = 'f' then some (Char.ofNat 12, tail)
            else if second = 'n' then some (Char.ofNat 10, tail)
            else if second = 'r' then some (Char.ofNat 13, tail)
            else if second = 't' then some (Char.ofNat 9, tail)
            else if second = 'u' then
              match tail with
              | '0' :: '0' :: high :: low :: remainder =>
                  match hexValue high, hexValue low with
                  | some upper, some lower =>
                      some (Char.ofNat (upper * 16 + lower), remainder)
                  | _, _ => none
              | _ => none
            else none

theorem char_of_toNat {character : Char} {value : Nat} (code : character.toNat = value) :
    Char.ofNat value = character := by rw [← code, Char.ofNat_toNat]

/-- **The escape code is prefix-free.** One escape sequence reads back as exactly the code
point that produced it, whatever follows it. -/
theorem unescapeOne_escapeChar (character : Char) (rest : List Char) :
    unescapeOne (escapeChar character ++ rest) = some (character, rest) := by
  unfold escapeChar
  split
  · next quote => subst quote; rfl
  · split
    · next _ backslash => subst backslash; rfl
    · split
      · next _ _ code =>
                    simp only [List.cons_append, List.nil_append]
                    simp [unescapeOne]
                    exact char_of_toNat code
      · split
        · next _ _ _ code =>
                    simp only [List.cons_append, List.nil_append]
                    simp [unescapeOne]
                    exact char_of_toNat code
        · split
          · next _ _ _ _ code =>
                    simp only [List.cons_append, List.nil_append]
                    simp [unescapeOne]
                    exact char_of_toNat code
          · split
            · next _ _ _ _ _ code =>
                    simp only [List.cons_append, List.nil_append]
                    simp [unescapeOne]
                    exact char_of_toNat code
            · split
              · next _ _ _ _ _ _ code =>
                    simp only [List.cons_append, List.nil_append]
                    simp [unescapeOne]
                    exact char_of_toNat code
              · split
                · next _ _ _ _ _ _ _ control =>
                    have upper : character.toNat / 16 < 16 := by omega
                    have lower : character.toNat % 16 < 16 := by omega
                    simp only [List.cons_append, List.nil_append]
                    simp [unescapeOne, hexValue_hexDigit upper, hexValue_hexDigit lower]
                    have recombine :
                        character.toNat / 16 * 16 + character.toNat % 16 = character.toNat := by
                      omega
                    exact char_of_toNat recombine.symm
                · next quote backslash _ _ _ _ _ _ =>
                    simp [unescapeOne, backslash]

def escapeString : List Char → List Char
  | [] => []
  | character :: rest => escapeChar character ++ escapeString rest

/-- A JSON string literal: the escaped code points between two quotes. -/
def quoted (value : List Char) : List Char := '"' :: (escapeString value ++ ['"'])

theorem escapeChar_cons (character : Char) :
    ∃ head tail, escapeChar character = head :: tail ∧ head ≠ '"' := by
  unfold escapeChar
  split
  · exact ⟨'\\', ['"'], rfl, by decide⟩
  · split
    · exact ⟨'\\', ['\\'], rfl, by decide⟩
    · split
      · exact ⟨'\\', ['b'], rfl, by decide⟩
      · split
        · exact ⟨'\\', ['f'], rfl, by decide⟩
        · split
          · exact ⟨'\\', ['n'], rfl, by decide⟩
          · split
            · exact ⟨'\\', ['r'], rfl, by decide⟩
            · split
              · exact ⟨'\\', ['t'], rfl, by decide⟩
              · split
                · exact ⟨'\\', _, rfl, by decide⟩
                · next quote _ _ _ _ _ _ _ => exact ⟨character, [], rfl, quote⟩

theorem escapeString_quote_delimited : ∀ {left right suffixLeft suffixRight : List Char},
    escapeString left ++ '"' :: suffixLeft = escapeString right ++ '"' :: suffixRight →
    left = right ∧ suffixLeft = suffixRight := by
  intro left
  induction left with
  | nil =>
      intro right suffixLeft suffixRight equal
      cases right with
      | nil => exact ⟨rfl, by simpa [escapeString] using equal⟩
      | cons head tail =>
          obtain ⟨first, escaped, shape, notQuote⟩ := escapeChar_cons head
          simp only [escapeString, shape, List.nil_append, List.cons_append,
            List.cons.injEq] at equal
          exact absurd equal.1.symm notQuote
  | cons head tail ih =>
      intro right suffixLeft suffixRight equal
      cases right with
      | nil =>
          obtain ⟨first, escaped, shape, notQuote⟩ := escapeChar_cons head
          simp only [escapeString, shape, List.nil_append, List.cons_append,
            List.cons.injEq] at equal
          exact absurd equal.1 notQuote
      | cons otherHead otherTail =>
          have peeled : escapeChar head ++ (escapeString tail ++ '"' :: suffixLeft) =
              escapeChar otherHead ++ (escapeString otherTail ++ '"' :: suffixRight) := by
            simpa [escapeString, List.append_assoc] using equal
          have read := congrArg unescapeOne peeled
          rw [unescapeOne_escapeChar, unescapeOne_escapeChar] at read
          simp only [Option.some.injEq, Prod.mk.injEq] at read
          obtain ⟨same, inner⟩ := ih read.2
          exact ⟨by rw [read.1, same], inner⟩

/-- **A JSON string literal determines its contents and what follows it.** -/
theorem quoted_prefix_free {left right suffixLeft suffixRight : List Char}
    (equal : quoted left ++ suffixLeft = quoted right ++ suffixRight) :
    left = right ∧ suffixLeft = suffixRight := by
  simp only [quoted, List.cons_append, List.append_assoc, List.cons_append,
    List.nil_append, List.cons.injEq, true_and] at equal
  exact escapeString_quote_delimited equal

/-! ## The canonical JSON tree -/

/-- A number as the encoder writes it. That distinct JavaScript numbers render to distinct
tokens is the residual half of `ASM-CANONICAL-KEY-INJECTIVE`; that the token is nonempty and
drawn from the JSON number alphabet is all the grammar itself needs. -/
def numberChar (character : Char) : Bool :=
  (48 ≤ character.toNat && character.toNat ≤ 57) || character = '-' || character = '+' ||
    character = '.' || character = 'e' || character = 'E'

def numberToken (token : List Char) : Bool := !token.isEmpty && token.all numberChar

inductive JsonTree where
  | null
  | bool (value : Bool)
  | num (token : List Char)
  | str (value : List Char)
  | arr (items : List JsonTree)
  | obj (entries : List (List Char × JsonTree))

mutual

/-- The canonical encoding, mirroring `canonicalString`. -/
def encodeJson : JsonTree → List Char
  | .null => ['n', 'u', 'l', 'l']
  | .bool true => ['t', 'r', 'u', 'e']
  | .bool false => ['f', 'a', 'l', 's', 'e']
  | .num token => token
  | .str value => quoted value
  | .arr items => '[' :: encodeItems items
  | .obj entries => '{' :: encodeEntries entries

/-- Array items, closing bracket included so the recursion stays one function. -/
def encodeItems : List JsonTree → List Char
  | [] => [']']
  | [item] => encodeJson item ++ [']']
  | item :: rest => encodeJson item ++ ',' :: encodeItems rest

/-- Object entries, closing brace included. -/
def encodeEntries : List (List Char × JsonTree) → List Char
  | [] => ['}']
  | [(key, value)] => quoted key ++ ':' :: encodeJson value ++ ['}']
  | (key, value) :: rest => quoted key ++ ':' :: encodeJson value ++ ',' :: encodeEntries rest

end

mutual

def numbersValid : JsonTree → Bool
  | .null | .bool _ | .str _ => true
  | .num token => numberToken token
  | .arr items => itemsValid items
  | .obj entries => entriesValid entries

def itemsValid : List JsonTree → Bool
  | [] => true
  | item :: rest => numbersValid item && itemsValid rest

def entriesValid : List (List Char × JsonTree) → Bool
  | [] => true
  | (_, value) :: rest => numbersValid value && entriesValid rest

end

theorem itemsValid_cons {item : JsonTree} {rest : List JsonTree}
    (valid : itemsValid (item :: rest) = true) :
    numbersValid item = true ∧ itemsValid rest = true := by simpa [itemsValid] using valid

theorem entriesValid_cons {key : List Char} {value : JsonTree} {rest : List (List Char × JsonTree)}
    (valid : entriesValid ((key, value) :: rest) = true) :
    numbersValid value = true ∧ entriesValid rest = true := by simpa [entriesValid] using valid

/-- A continuation that begins with a structural delimiter, or ends the encoding. This is
what pins a number token: the number alphabet excludes every delimiter, so a token cannot
absorb one. -/
def Delimited : List Char → Prop
  | [] => True
  | character :: _ => character = ',' ∨ character = ']' ∨ character = '}'

/-! ## Constructor separation

Every encoding begins with a character its constructor determines, and none of those is a
delimiter. That is what closes the cross-constructor cases below and what makes a `]` or `}`
unambiguously the end of a list. -/

theorem numberToken_head {token : List Char} (valid : numberToken token = true) :
    ∃ head tail, token = head :: tail ∧ numberChar head = true := by
  cases token with
  | nil => simp [numberToken] at valid
  | cons head tail =>
      simp only [numberToken, Bool.and_eq_true, List.all_eq_true] at valid
      exact ⟨head, tail, rfl, valid.2 head (List.mem_cons_self)⟩

theorem numberToken_chars {token : List Char} (valid : numberToken token = true) :
    ∀ character ∈ token, numberChar character = true := by
  intro character member
  simp only [numberToken, Bool.and_eq_true, List.all_eq_true] at valid
  exact valid.2 character member

/-! ## Size accounting

The three encoders recur into one another, so the induction below runs on one size bound
rather than on any single argument's structure. -/

theorem sizeOf_arr_items (items : List JsonTree) : sizeOf items < sizeOf (JsonTree.arr items) := by
  simp only [JsonTree.arr.sizeOf_spec]; omega

theorem sizeOf_obj_entries (entries : List (List Char × JsonTree)) :
    sizeOf entries < sizeOf (JsonTree.obj entries) := by
  simp only [JsonTree.obj.sizeOf_spec]; omega

theorem sizeOf_item (item : JsonTree) (rest : List JsonTree) : sizeOf item < sizeOf (item :: rest) := by
  simp only [List.cons.sizeOf_spec]; omega

theorem sizeOf_items_rest (item : JsonTree) (rest : List JsonTree) :
    sizeOf rest < sizeOf (item :: rest) := by
  simp only [List.cons.sizeOf_spec]; omega

theorem sizeOf_entry_value (key : List Char) (value : JsonTree) (rest : List (List Char × JsonTree)) :
    sizeOf value < sizeOf ((key, value) :: rest) := by
  simp only [List.cons.sizeOf_spec, Prod.mk.sizeOf_spec]; omega

theorem sizeOf_entries_rest (key : List Char) (value : JsonTree) (rest : List (List Char × JsonTree)) :
    sizeOf rest < sizeOf ((key, value) :: rest) := by
  simp only [List.cons.sizeOf_spec, Prod.mk.sizeOf_spec]; omega

/-- No encoding starts with a delimiter, so a delimiter always closes the value before it. -/
theorem encodeJson_not_delimited {value : JsonTree} (valid : numbersValid value = true)
    (rest : List Char) : ¬ Delimited (encodeJson value ++ rest) := by
  cases value with
  | null => simp [encodeJson, Delimited]
  | bool flag => cases flag <;> simp [encodeJson, Delimited]
  | num token =>
      obtain ⟨head, tail, shape, isNumber⟩ :=
        numberToken_head (by simpa [numbersValid] using valid)
      subst shape
      simp only [encodeJson, List.cons_append, Delimited]
      rintro (rfl | rfl | rfl) <;> simp [numberChar] at isNumber
  | str => simp [encodeJson, quoted, Delimited]
  | arr => simp [encodeJson, Delimited]
  | obj => simp [encodeJson, Delimited]

/-- A number token never collides with any other constructor's encoding: the other seven
opening characters are outside the number alphabet. -/
theorem num_never_collides {token : List Char} {other : JsonTree}
    {suffixLeft suffixRight : List Char} (valid : numberToken token = true)
    (notNumber : ∀ inner, other ≠ .num inner) :
    token ++ suffixLeft ≠ encodeJson other ++ suffixRight := by
  obtain ⟨head, tail, shape, isNumber⟩ := numberToken_head valid
  subst shape
  intro equal
  cases other with
  | null =>
      simp only [encodeJson, List.cons_append, List.cons.injEq] at equal
      rw [equal.1] at isNumber
      simp [numberChar] at isNumber
  | bool flag =>
      cases flag <;>
        · simp only [encodeJson, List.cons_append, List.cons.injEq] at equal
          rw [equal.1] at isNumber
          simp [numberChar] at isNumber
  | num inner => exact notNumber inner rfl
  | str value =>
      simp only [encodeJson, quoted, List.cons_append, List.cons.injEq] at equal
      rw [equal.1] at isNumber
      simp [numberChar] at isNumber
  | arr =>
      simp only [encodeJson, List.cons_append, List.cons.injEq] at equal
      rw [equal.1] at isNumber
      simp [numberChar] at isNumber
  | obj =>
      simp only [encodeJson, List.cons_append, List.cons.injEq] at equal
      rw [equal.1] at isNumber
      simp [numberChar] at isNumber

theorem encodeItems_cons_shape (item : JsonTree) (rest : List JsonTree) (suffix : List Char) :
    ∃ tail, encodeItems (item :: rest) ++ suffix = encodeJson item ++ tail := by
  cases rest with
  | nil => exact ⟨']' :: suffix, by simp [encodeItems]⟩
  | cons next more =>
      exact ⟨',' :: (encodeItems (next :: more) ++ suffix), by
        simp [encodeItems, List.append_assoc]⟩

theorem encodeEntries_cons_shape (key : List Char) (value : JsonTree)
    (rest : List (List Char × JsonTree)) (suffix : List Char) :
    ∃ tail, encodeEntries ((key, value) :: rest) ++ suffix = quoted key ++ tail := by
  cases rest with
  | nil => exact ⟨':' :: (encodeJson value ++ ['}'] ++ suffix), by
      simp [encodeEntries, List.append_assoc]⟩
  | cons next more =>
      exact ⟨':' :: (encodeJson value ++ ',' :: (encodeEntries (next :: more) ++ suffix)), by
        simp [encodeEntries, List.append_assoc]⟩

/-- Two number tokens closed by delimiters are the same token. -/
theorem numberToken_delimited : ∀ {left right suffixLeft suffixRight : List Char},
    (∀ character ∈ left, numberChar character = true) →
    (∀ character ∈ right, numberChar character = true) →
    Delimited suffixLeft → Delimited suffixRight →
    left ++ suffixLeft = right ++ suffixRight → left = right ∧ suffixLeft = suffixRight := by
  intro left
  induction left with
  | nil =>
      intro right suffixLeft suffixRight _ numbersRight delimitedLeft _ equal
      cases right with
      | nil => exact ⟨rfl, by simpa using equal⟩
      | cons head tail =>
          simp only [List.nil_append, List.cons_append] at equal
          subst equal
          have isNumber := numbersRight head (List.mem_cons_self)
          simp only [Delimited] at delimitedLeft
          rcases delimitedLeft with rfl | rfl | rfl <;> simp [numberChar] at isNumber
  | cons head tail ih =>
      intro right suffixLeft suffixRight numbersLeft numbersRight
        delimitedLeft delimitedRight equal
      cases right with
      | nil =>
          simp only [List.nil_append, List.cons_append] at equal
          have isNumber := numbersLeft head (List.mem_cons_self)
          rw [← equal] at delimitedRight
          simp only [Delimited] at delimitedRight
          rcases delimitedRight with rfl | rfl | rfl <;> simp [numberChar] at isNumber
      | cons otherHead otherTail =>
          simp only [List.cons_append, List.cons.injEq] at equal
          obtain ⟨same, inner⟩ := ih
            (fun character member => numbersLeft character (List.Mem.tail head member))
            (fun character member =>
              numbersRight character (List.Mem.tail otherHead member))
            delimitedLeft delimitedRight equal.2
          exact ⟨by rw [equal.1, same], inner⟩

/-! ## Injectivity

One induction over a size bound covers all three encoders. The statement is stronger than
injectivity — an encoding determines both its value and the remaining input — because that
is what the recursive cases need of each other. -/

theorem encode_unambiguous : ∀ bound : Nat,
    (∀ left right suffixLeft suffixRight, sizeOf left ≤ bound →
        numbersValid left = true → numbersValid right = true →
        Delimited suffixLeft → Delimited suffixRight →
        encodeJson left ++ suffixLeft = encodeJson right ++ suffixRight →
        left = right ∧ suffixLeft = suffixRight) ∧
    (∀ left right suffixLeft suffixRight, sizeOf left ≤ bound →
        itemsValid left = true → itemsValid right = true →
        Delimited suffixLeft → Delimited suffixRight →
        encodeItems left ++ suffixLeft = encodeItems right ++ suffixRight →
        left = right ∧ suffixLeft = suffixRight) ∧
    (∀ left right suffixLeft suffixRight, sizeOf left ≤ bound →
        entriesValid left = true → entriesValid right = true →
        Delimited suffixLeft → Delimited suffixRight →
        encodeEntries left ++ suffixLeft = encodeEntries right ++ suffixRight →
        left = right ∧ suffixLeft = suffixRight) := by
  intro bound
  induction bound with
  | zero =>
      refine ⟨?_, ?_, ?_⟩ <;>
        · intro left right suffixLeft suffixRight small
          exact absurd small (by cases left <;> simp)
  | succ bound ih =>
      obtain ⟨jsonIh, itemsIh, entriesIh⟩ := ih
      refine ⟨?_, ?_, ?_⟩
      · intro left right suffixLeft suffixRight small validLeft validRight
          delimitedLeft delimitedRight equal
        cases left with
        | num token =>
            cases right with
            | num otherToken =>
                obtain ⟨same, inner⟩ := numberToken_delimited
                  (numberToken_chars (by simpa [numbersValid] using validLeft))
                  (numberToken_chars (by simpa [numbersValid] using validRight))
                  delimitedLeft delimitedRight (by simpa [encodeJson] using equal)
                exact ⟨by rw [same], inner⟩
            | null =>
                exact absurd (by simpa [encodeJson] using equal)
                  (num_never_collides (other := .null)
                    (by simpa [numbersValid] using validLeft) (by simp))
            | bool flag =>
                exact absurd (by simpa [encodeJson] using equal)
                  (num_never_collides (other := .bool flag)
                    (by simpa [numbersValid] using validLeft) (by simp))
            | str value =>
                exact absurd (by simpa [encodeJson] using equal)
                  (num_never_collides (other := .str value)
                    (by simpa [numbersValid] using validLeft) (by simp))
            | arr items =>
                exact absurd (by simpa [encodeJson] using equal)
                  (num_never_collides (other := .arr items)
                    (by simpa [numbersValid] using validLeft) (by simp))
            | obj entries =>
                exact absurd (by simpa [encodeJson] using equal)
                  (num_never_collides (other := .obj entries)
                    (by simpa [numbersValid] using validLeft) (by simp))
        | null =>
            cases right with
            | null => exact ⟨rfl, by simpa [encodeJson] using equal⟩
            | num otherToken =>
                exact absurd (by simpa [encodeJson] using equal.symm)
                  (num_never_collides (other := .null)
                    (by simpa [numbersValid] using validRight) (by simp))
            | bool flag => cases flag <;> simp [encodeJson] at equal
            | str => simp [encodeJson, quoted] at equal
            | arr => simp [encodeJson] at equal
            | obj => simp [encodeJson] at equal
        | bool flag =>
            cases right with
            | bool otherFlag => cases flag <;> cases otherFlag <;> simp_all [encodeJson]
            | num otherToken =>
                exact absurd (by simpa [encodeJson] using equal.symm)
                  (num_never_collides (other := .bool flag)
                    (by simpa [numbersValid] using validRight) (by simp))
            | null => cases flag <;> simp [encodeJson] at equal
            | str => cases flag <;> simp [encodeJson, quoted] at equal
            | arr => cases flag <;> simp [encodeJson] at equal
            | obj => cases flag <;> simp [encodeJson] at equal
        | str value =>
            cases right with
            | str otherValue =>
                obtain ⟨same, inner⟩ := quoted_prefix_free (by simpa [encodeJson] using equal)
                exact ⟨by rw [same], inner⟩
            | num otherToken =>
                exact absurd (by simpa [encodeJson] using equal.symm)
                  (num_never_collides (other := .str value)
                    (by simpa [numbersValid] using validRight) (by simp))
            | null => simp [encodeJson, quoted] at equal
            | bool flag => cases flag <;> simp [encodeJson, quoted] at equal
            | arr => simp [encodeJson, quoted] at equal
            | obj => simp [encodeJson, quoted] at equal
        | arr items =>
            cases right with
            | arr otherItems =>
                obtain ⟨same, inner⟩ := itemsIh items otherItems suffixLeft suffixRight
                  (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_arr_items items) small))
                  (by simpa [numbersValid] using validLeft)
                  (by simpa [numbersValid] using validRight)
                  delimitedLeft delimitedRight (by simpa [encodeJson] using equal)
                exact ⟨by rw [same], inner⟩
            | num otherToken =>
                exact absurd (by simpa [encodeJson] using equal.symm)
                  (num_never_collides (other := .arr items)
                    (by simpa [numbersValid] using validRight) (by simp))
            | null => simp [encodeJson] at equal
            | bool flag => cases flag <;> simp [encodeJson] at equal
            | str => simp [encodeJson, quoted] at equal
            | obj => simp [encodeJson] at equal
        | obj entries =>
            cases right with
            | obj otherEntries =>
                obtain ⟨same, inner⟩ := entriesIh entries otherEntries suffixLeft suffixRight
                  (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_obj_entries entries) small))
                  (by simpa [numbersValid] using validLeft)
                  (by simpa [numbersValid] using validRight)
                  delimitedLeft delimitedRight (by simpa [encodeJson] using equal)
                exact ⟨by rw [same], inner⟩
            | num otherToken =>
                exact absurd (by simpa [encodeJson] using equal.symm)
                  (num_never_collides (other := .obj entries)
                    (by simpa [numbersValid] using validRight) (by simp))
            | null => simp [encodeJson] at equal
            | bool flag => cases flag <;> simp [encodeJson] at equal
            | str => simp [encodeJson, quoted] at equal
            | arr => simp [encodeJson] at equal
      · intro left right suffixLeft suffixRight small validLeft validRight
          delimitedLeft delimitedRight equal
        cases left with
        | nil =>
            cases right with
            | nil => exact ⟨rfl, by simpa [encodeItems] using equal⟩
            | cons otherItem otherRest =>
                obtain ⟨tail, shape⟩ := encodeItems_cons_shape otherItem otherRest suffixRight
                rw [shape] at equal
                refine absurd ?_ (encodeJson_not_delimited (itemsValid_cons validRight).1 tail)
                rw [← equal]
                simp [encodeItems, Delimited]
        | cons item rest =>
            cases right with
            | nil =>
                obtain ⟨tail, shape⟩ := encodeItems_cons_shape item rest suffixLeft
                rw [shape] at equal
                refine absurd ?_ (encodeJson_not_delimited (itemsValid_cons validLeft).1 tail)
                rw [equal]
                simp [encodeItems, Delimited]
            | cons otherItem otherRest =>
                cases rest with
                | nil =>
                    cases otherRest with
                    | nil =>
                        obtain ⟨same, inner⟩ := jsonIh item otherItem (']' :: suffixLeft)
                          (']' :: suffixRight) (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_item item _) small))
                          (itemsValid_cons validLeft).1 (itemsValid_cons validRight).1
                          (by simp [Delimited]) (by simp [Delimited])
                          (by simpa [encodeItems, List.append_assoc] using equal)
                        exact ⟨by rw [same], by simpa using inner⟩
                    | cons otherNext otherMore =>
                        obtain ⟨_, inner⟩ := jsonIh item otherItem (']' :: suffixLeft)
                          (',' :: (encodeItems (otherNext :: otherMore) ++ suffixRight))
                          (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_item item _) small))
                          (itemsValid_cons validLeft).1 (itemsValid_cons validRight).1
                          (by simp [Delimited]) (by simp [Delimited])
                          (by simpa [encodeItems, List.append_assoc] using equal)
                        simp at inner
                | cons next more =>
                    cases otherRest with
                    | nil =>
                        obtain ⟨_, inner⟩ := jsonIh item otherItem
                          (',' :: (encodeItems (next :: more) ++ suffixLeft)) (']' :: suffixRight)
                          (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_item item _) small))
                          (itemsValid_cons validLeft).1 (itemsValid_cons validRight).1
                          (by simp [Delimited]) (by simp [Delimited])
                          (by simpa [encodeItems, List.append_assoc] using equal)
                        simp at inner
                    | cons otherNext otherMore =>
                        obtain ⟨head, inner⟩ := jsonIh item otherItem
                          (',' :: (encodeItems (next :: more) ++ suffixLeft))
                          (',' :: (encodeItems (otherNext :: otherMore) ++ suffixRight))
                          (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_item item _) small))
                          (itemsValid_cons validLeft).1 (itemsValid_cons validRight).1
                          (by simp [Delimited]) (by simp [Delimited])
                          (by simpa [encodeItems, List.append_assoc] using equal)
                        simp only [List.cons.injEq, true_and] at inner
                        obtain ⟨same, deeper⟩ := itemsIh (next :: more) (otherNext :: otherMore)
                          suffixLeft suffixRight
                          (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_items_rest item _) small))
                          (itemsValid_cons validLeft).2 (itemsValid_cons validRight).2
                          delimitedLeft delimitedRight inner
                        exact ⟨by rw [head, same], deeper⟩
      · intro left right suffixLeft suffixRight small validLeft validRight
          delimitedLeft delimitedRight equal
        cases left with
        | nil =>
            cases right with
            | nil => exact ⟨rfl, by simpa [encodeEntries] using equal⟩
            | cons otherEntry otherRest =>
                obtain ⟨otherKey, otherValue⟩ := otherEntry
                obtain ⟨tail, shape⟩ :=
                  encodeEntries_cons_shape otherKey otherValue otherRest suffixRight
                rw [shape] at equal
                simp [encodeEntries, quoted] at equal
        | cons entry rest =>
            obtain ⟨key, value⟩ := entry
            cases right with
            | nil =>
                obtain ⟨tail, shape⟩ := encodeEntries_cons_shape key value rest suffixLeft
                rw [shape] at equal
                simp [encodeEntries, quoted] at equal
            | cons otherEntry otherRest =>
                obtain ⟨otherKey, otherValue⟩ := otherEntry
                cases rest with
                | nil =>
                    cases otherRest with
                    | nil =>
                        obtain ⟨sameKey, afterKey⟩ := quoted_prefix_free (left := key)
                          (right := otherKey)
                          (by simpa [encodeEntries, List.append_assoc] using equal)
                        simp only [List.cons.injEq, true_and] at afterKey
                        obtain ⟨sameValue, inner⟩ := jsonIh value otherValue ('}' :: suffixLeft)
                          ('}' :: suffixRight)
                          (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_entry_value key value _) small))
                          (entriesValid_cons validLeft).1 (entriesValid_cons validRight).1
                          (by simp [Delimited]) (by simp [Delimited])
                          (by simpa [List.append_assoc] using afterKey)
                        exact ⟨by rw [sameKey, sameValue], by simpa using inner⟩
                    | cons otherNext otherMore =>
                        obtain ⟨_, afterKey⟩ := quoted_prefix_free (left := key)
                          (right := otherKey)
                          (by simpa [encodeEntries, List.append_assoc] using equal)
                        simp only [List.cons.injEq, true_and] at afterKey
                        obtain ⟨_, inner⟩ := jsonIh value otherValue ('}' :: suffixLeft)
                          (',' :: (encodeEntries (otherNext :: otherMore) ++ suffixRight))
                          (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_entry_value key value _) small))
                          (entriesValid_cons validLeft).1 (entriesValid_cons validRight).1
                          (by simp [Delimited]) (by simp [Delimited])
                          (by simpa [List.append_assoc] using afterKey)
                        simp at inner
                | cons next more =>
                    cases otherRest with
                    | nil =>
                        obtain ⟨_, afterKey⟩ := quoted_prefix_free (left := key)
                          (right := otherKey)
                          (by simpa [encodeEntries, List.append_assoc] using equal)
                        simp only [List.cons.injEq, true_and] at afterKey
                        obtain ⟨_, inner⟩ := jsonIh value otherValue
                          (',' :: (encodeEntries (next :: more) ++ suffixLeft))
                          ('}' :: suffixRight)
                          (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_entry_value key value _) small))
                          (entriesValid_cons validLeft).1 (entriesValid_cons validRight).1
                          (by simp [Delimited]) (by simp [Delimited])
                          (by simpa [List.append_assoc] using afterKey)
                        simp at inner
                    | cons otherNext otherMore =>
                        obtain ⟨sameKey, afterKey⟩ := quoted_prefix_free (left := key)
                          (right := otherKey)
                          (by simpa [encodeEntries, List.append_assoc] using equal)
                        simp only [List.cons.injEq, true_and] at afterKey
                        obtain ⟨sameValue, inner⟩ := jsonIh value otherValue
                          (',' :: (encodeEntries (next :: more) ++ suffixLeft))
                          (',' :: (encodeEntries (otherNext :: otherMore) ++ suffixRight))
                          (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_entry_value key value _) small))
                          (entriesValid_cons validLeft).1 (entriesValid_cons validRight).1
                          (by simp [Delimited]) (by simp [Delimited])
                          (by simpa [List.append_assoc] using afterKey)
                        simp only [List.cons.injEq, true_and] at inner
                        obtain ⟨sameRest, deeper⟩ := entriesIh (next :: more)
                          (otherNext :: otherMore) suffixLeft suffixRight
                          (Nat.le_of_lt_succ (Nat.lt_of_lt_of_le (sizeOf_entries_rest key value _) small))
                          (entriesValid_cons validLeft).2 (entriesValid_cons validRight).2
                          delimitedLeft delimitedRight inner
                        exact ⟨by rw [sameKey, sameValue, sameRest], deeper⟩

/-- **The canonical encoding determines the value.** Two canonical JSON trees with the same
encoding are the same tree. -/
theorem canonical_encode_injective {left right : JsonTree} (validLeft : numbersValid left = true)
    (validRight : numbersValid right = true) (equal : encodeJson left = encodeJson right) :
    left = right :=
  ((encode_unambiguous (sizeOf left)).1 left right [] [] (Nat.le_refl _) validLeft validRight
    trivial trivial (by simpa using equal)).1

/-! ## Authority keys

`authorityKey(kind, components)` canonical-encodes `[tag, kind, ...components]`. Every
component of a Scope or Subject key is a string or `null`, so the number-token obligation
never arises and these keys are injective outright. -/

def authorityKeyTag : List Char := "agent-core.authority-key.v1".toList

def authorityKey (kind : List Char) (component : JsonTree) : List Char :=
  encodeJson (.arr [.str authorityKeyTag, .str kind, component])

/-- **A canonical-JSON composite key determines the tuple it was built from.** This is
`ASM-CANONICAL-KEY-INJECTIVE` for the key scheme the authority plane uses, discharged rather
than assumed — and unlike the delimiter join of `AC-KEY-001`, with no condition on the
component text. -/
theorem authorityKey_injective {kindLeft kindRight : List Char} {left right : JsonTree}
    (validLeft : numbersValid left = true) (validRight : numbersValid right = true)
    (equal : authorityKey kindLeft left = authorityKey kindRight right) :
    kindLeft = kindRight ∧ left = right := by
  have trees := canonical_encode_injective
    (left := .arr [.str authorityKeyTag, .str kindLeft, left])
    (right := .arr [.str authorityKeyTag, .str kindRight, right])
    (by simpa [numbersValid, itemsValid] using validLeft)
    (by simpa [numbersValid, itemsValid] using validRight) equal
  simp only [JsonTree.arr.injEq, List.cons.injEq, JsonTree.str.injEq, and_true, true_and] at trees
  exact ⟨trees.1, trees.2⟩

/-! ## Scope and Subject keys

`encodeScopeRef` and `encodeSubjectRef` are the object shapes the implementation builds, with
their fields already in the code-unit order `canonicalString` sorts them into. -/

inductive ScopeRefText where
  | tenant (tenant : List Char)
  | project (tenant project : List Char)
  | workspace (tenant : List Char) (project : Option (List Char)) (workspace : List Char)
  deriving DecidableEq, Repr

inductive SubjectRefText where
  | principal (tenant principal : List Char)
  | team (team : List Char)
  | foreign (homeTenant principal verifiedVia : List Char)
  deriving DecidableEq, Repr

def encodeScopeRefText : ScopeRefText → JsonTree
  | .tenant tenant =>
      .obj [("kind".toList, .str "tenant".toList), ("tenant".toList, .str tenant)]
  | .project tenant project =>
      .obj [("kind".toList, .str "project".toList), ("project".toList, .str project),
        ("tenant".toList, .str tenant)]
  | .workspace tenant project workspace =>
      .obj [("kind".toList, .str "workspace".toList),
        ("project".toList, match project with | none => .null | some value => .str value),
        ("tenant".toList, .str tenant), ("workspace".toList, .str workspace)]

def encodeSubjectRefText : SubjectRefText → JsonTree
  | .principal tenant principal =>
      .obj [("kind".toList, .str "principal".toList), ("principal".toList, .str principal),
        ("tenant".toList, .str tenant)]
  | .team team => .obj [("kind".toList, .str "team".toList), ("team".toList, .str team)]
  | .foreign homeTenant principal verifiedVia =>
      .obj [("homeTenant".toList, .str homeTenant), ("kind".toList, .str "foreign".toList),
        ("principal".toList, .str principal), ("verifiedVia".toList, .str verifiedVia)]

def scopeKeyText (scope : ScopeRefText) : List Char :=
  authorityKey "scope".toList (encodeScopeRefText scope)

def subjectKeyText (subject : SubjectRefText) : List Char :=
  authorityKey "subject".toList (encodeSubjectRefText subject)

theorem encodeScopeRefText_numberless (scope : ScopeRefText) :
    numbersValid (encodeScopeRefText scope) = true := by
  cases scope with
  | tenant => simp [encodeScopeRefText, numbersValid, entriesValid]
  | project => simp [encodeScopeRefText, numbersValid, entriesValid]
  | workspace _ project _ =>
      cases project <;> simp [encodeScopeRefText, numbersValid, entriesValid]

theorem encodeSubjectRefText_numberless (subject : SubjectRefText) :
    numbersValid (encodeSubjectRefText subject) = true := by
  cases subject <;> simp [encodeSubjectRefText, numbersValid, entriesValid]

/-- **A stored Scope key determines its Scope.** The authority resolver decides that a Grant
reaches the target by comparing these keys; this is what makes that comparison Scope
equality, for identifier text of any shape. -/
theorem scope_key_injective {left right : ScopeRefText}
    (equal : scopeKeyText left = scopeKeyText right) : left = right := by
  have trees := (authorityKey_injective (encodeScopeRefText_numberless left)
    (encodeScopeRefText_numberless right) equal).2
  cases left with
  | tenant => cases right <;> simp_all [encodeScopeRefText]
  | project => cases right <;> simp_all [encodeScopeRefText]
  | workspace _ projectLeft _ =>
      cases right with
      | tenant => simp_all [encodeScopeRefText]
      | project => simp_all [encodeScopeRefText]
      | workspace _ projectRight _ =>
          cases projectLeft <;> cases projectRight <;> simp_all [encodeScopeRefText]

/-- **A stored Subject key determines its Subject.** Same statement for the subject side of
the resolver's membership test. -/
theorem subject_key_injective {left right : SubjectRefText}
    (equal : subjectKeyText left = subjectKeyText right) : left = right := by
  have trees := (authorityKey_injective (encodeSubjectRefText_numberless left)
    (encodeSubjectRefText_numberless right) equal).2
  cases left <;> cases right <;> simp_all [encodeSubjectRefText]

/-- **A guest's verification stamp separates its Subject key.** `verifiedVia` sits inside the
encoded subject, so the same foreign Principal recorded under two schemes has two keys, and
comparing these keys is comparing the stamp as well as the Principal. SPEC §3.3 makes the
stamp part of `ForeignPrincipalRef` and also lets it change (`handshake` "downgrades all
future verifications to `token`"), so one guest is reachable under both.

What this does not settle is which comparison the resolver should make. `AuthorityRuntime`
matches an allow on the whole stamped subject and a deny on the identity underneath it
(`AgentCore.deny_survives_verification_scheme_change`), because a deny names who is refused
and a re-verified guest is the same who — so the deny sweep is not a comparison of these
keys at all. -/
theorem foreign_subject_key_separates_verification_schemes
    (homeTenant principal : List Char) :
    subjectKeyText (.foreign homeTenant principal "token".toList) ≠
      subjectKeyText (.foreign homeTenant principal "callback".toList) := by
  intro equal
  have same := subject_key_injective equal
  simp [SubjectRefText.foreign.injEq] at same

end AgentCore
