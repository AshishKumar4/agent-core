/-
Identifiers (SPEC §1.4; `packages/agent-core/src/core/id.ts` and each context's `id.ts`).

`TextId` is a branded class with a constructor-validated invariant, and its `equals` is
identity by *type and value*: two ids with the same text but different classes are not
equal. The kernel keeps both halves, and moves the type half into the type: `TextId` is
indexed by the identifier kind, so `TextId .run` and `TextId .turn` are different types and
comparing them is a compile error rather than a runtime `false`. That is the same rule,
enforced one layer earlier.

The value half is the runtime's three-part check: a string, between 1 and 256
`String.prototype.length` units, containing only Unicode scalar values. The third part is
discharged by `Char`, which cannot hold an unpaired surrogate — the kernel therefore
proves what the runtime tests. The first two are `textIdValid`, and the bound is in UTF-16
code units because that is what the runtime counts (see `Kernel.Text`).
-/
import AgentCore.Kernel.Error
import AgentCore.Kernel.Core.Text

namespace AgentCore.Kernel

/-- The greatest identifier length the runtime admits, in UTF-16 code units. -/
def textIdMaxLength : Nat := 256

/-- Every identifier kind the kernel's records name, with the context that owns it. -/
inductive IdKind where
  | run | runBranch | runCommit | runCheckpoint | turn | turnInboxEntry | acceptance
  | spawnReservation
  | agent | agentProfile | agentPolicy | modelPolicy
  | tenant | principal
  | package | blueprint | environment
  | invocation | receipt | approval | effectAttempt | auditRecord | routeReservation
  | facetPackage | operationName
  | currency
  deriving DecidableEq, Repr

/-- The subject name the runtime constructor reports in its `TypeError`. -/
def IdKind.subject : IdKind → String
  | .run => "Run ID"
  | .runBranch => "Run branch ID"
  | .runCommit => "Run commit ID"
  | .runCheckpoint => "Run checkpoint ID"
  | .turn => "Turn ID"
  | .turnInboxEntry => "Turn inbox entry ID"
  | .acceptance => "Acceptance ID"
  | .agent => "Agent ID"
  | .agentPolicy => "Agent policy ID"
  | .modelPolicy => "Model policy ID"
  | .tenant => "Tenant ID"
  | .principal => "Principal ID"
  | .package => "Package ID"
  | .blueprint => "Blueprint ID"
  | .environment => "Environment ID"
  | .invocation => "Invocation ID"
  | .receipt => "Receipt ID"
  | .approval => "Approval ID"
  | .effectAttempt => "Effect attempt ID"
  | .auditRecord => "Audit record ID"
  | .routeReservation => "Route reservation ID"
  | .facetPackage => "Facet package ID"
  | .operationName => "Operation name"
  | .spawnReservation => "Spawn reservation ID"
  | .agentProfile => "Agent profile ID"
  | .currency => "Currency"

/-- `TextId`'s value invariant. -/
def textIdValid (value : String) : Bool :=
  0 < Text.length value && Text.length value ≤ textIdMaxLength

/-- One identifier: the text, and the proof it satisfies the invariant its constructor
validates. The proof is a `Prop` field, so the extracted image is the branded string the
runtime holds and nothing else. -/
structure TextId (kind : IdKind) where
  value : String
  valid : textIdValid value = true

namespace TextId

/-- **An identifier is its text.** Two ids of one kind with equal text are the same id,
which is the value half of the runtime's `equals`. -/
theorem eq_of_value {kind : IdKind} {left right : TextId kind}
    (same : left.value = right.value) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact same

instance {kind : IdKind} : DecidableEq (TextId kind) := fun left right =>
  if same : left.value = right.value then .isTrue (eq_of_value same)
  else .isFalse fun equal => same (equal ▸ rfl)

/-- Construct an identifier, refusing text the runtime's constructor refuses. -/
def parse (kind : IdKind) (value : String) : Outcome (TextId kind) :=
  if valid : textIdValid value = true then .ok ⟨value, valid⟩
  else unshaped kind.subject

theorem parse_ok_iff {kind : IdKind} {value : String} :
    (∃ identifier : TextId kind, parse kind value = .ok identifier) ↔
      textIdValid value = true := by
  unfold parse
  constructor
  · intro ⟨_, parsed⟩
    by_cases valid : textIdValid value = true
    · exact valid
    · simp [valid, unshaped] at parsed
  · intro valid
    exact ⟨⟨value, valid⟩, by simp [valid]⟩

/-- **Parsing keeps the text.** The identifier a caller gets back holds exactly the text it
handed over, so an id is never silently normalized. -/
theorem parse_value {kind : IdKind} {value : String} {identifier : TextId kind}
    (parsed : parse kind value = .ok identifier) : identifier.value = value := by
  unfold parse at parsed
  by_cases valid : textIdValid value = true
  · simp only [valid, dite_true] at parsed
    exact (Except.ok.injEq _ _ ▸ parsed.symm) ▸ rfl
  · simp [valid, unshaped] at parsed

/-- **Empty and overlong text is refused as a shape violation, never as a refusal.** A
caller cannot turn an unbuildable identifier into a domain answer. -/
theorem parse_shape_refusal {kind : IdKind} {value : String}
    (invalid : textIdValid value = false) :
    parse kind value = (unshaped kind.subject : Outcome (TextId kind)) := by
  unfold parse
  simp [invalid]

end TextId

/-- A Principal named inside its Tenant (SPEC §3.1): the pair the lease holder is. -/
structure PrincipalRef where
  tenant : TextId .tenant
  principal : TextId .principal
  deriving DecidableEq

/-- Text holding no `:`. `OperationRef` in `src/facets/id.ts` accepts a value whose first
colon is also its last, so neither component can contain one. -/
def colonFree (value : String) : Bool := value.toList.all fun character => character != ':'

/-- An Operation named by the Facet package that contributes it (SPEC §4.2).

The runtime's `OperationRef` *is* the text `<facet-package-id>:<operation-name>` and derives
the two halves from it, refusing a value whose `indexOf(":")` is not also its
`lastIndexOf(":")`. The kernel carries the halves and the proof that neither holds a colon,
which is the same fact stated so that an ambiguous pair cannot be built at all: `value` and
`parse` below are then inverse, and a decoder recovers exactly the ref that was written. -/
structure OperationRef where
  package : TextId .facetPackage
  name : TextId .operationName
  /-- The package half holds no separator. -/
  packagePlain : colonFree package.value = true
  /-- The Operation half holds no separator. -/
  namePlain : colonFree name.value = true

namespace OperationRef

theorem eq_of_parts {left right : OperationRef} (package : left.package = right.package)
    (name : left.name = right.name) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨package, name⟩

instance : DecidableEq OperationRef := fun left right =>
  if parts : left.package = right.package ∧ left.name = right.name then
    .isTrue (eq_of_parts parts.1 parts.2)
  else .isFalse fun equal => parts ⟨by rw [equal], by rw [equal]⟩

/-- The stored text: what `OperationRef.value` returns at runtime. -/
def value (reference : OperationRef) : String :=
  String.ofList (reference.package.value.toList ++ ':' :: reference.name.value.toList)

/-- Split at the first colon, which is where the runtime's `indexOf(":")` cuts. -/
def splitFirst : List Char → Option (List Char × List Char)
  | [] => none
  | character :: rest =>
      if character = ':' then some ([], rest)
      else (splitFirst rest).map fun halves => (character :: halves.1, halves.2)

theorem splitFirst_append : ∀ (before after : List Char),
    (before.all fun character => character != ':') = true →
      splitFirst (before ++ ':' :: after) = some (before, after)
  | [], _, _ => by simp [splitFirst]
  | character :: rest, after, plain => by
      have parts := List.all_cons ▸ plain
      have head : ¬ character = ':' := by
        have single : (character != ':') = true := ((Bool.and_eq_true _ _).mp parts).1
        simpa using single
      have tail : (rest.all fun candidate => candidate != ':') = true :=
        ((Bool.and_eq_true _ _).mp parts).2
      simp [splitFirst, head, splitFirst_append rest after tail]

/-- Read `<facet-package-id>:<operation-name>` back, refusing exactly what the runtime's
constructor refuses: no separator, an empty half, or a half that holds a second colon. -/
def parse (text : String) : Outcome OperationRef :=
  match splitFirst text.toList with
  | none => unshaped "Operation reference"
  | some (before, after) =>
      match TextId.parse .facetPackage (String.ofList before),
          TextId.parse .operationName (String.ofList after) with
      | .ok package, .ok name =>
          if packagePlain : colonFree package.value = true then
            if namePlain : colonFree name.value = true then
              .ok ⟨package, name, packagePlain, namePlain⟩
            else unshaped "Operation reference"
          else unshaped "Operation reference"
      | _, _ => unshaped "Operation reference"

/-- **An Operation reference round-trips through its text.** The separator is unambiguous
because neither half holds one, so the decoder recovers the exact pair that was encoded. -/
theorem parse_value (reference : OperationRef) : parse reference.value = .ok reference := by
  obtain ⟨package, name, packagePlain, namePlain⟩ := reference
  have split : splitFirst (package.value.toList ++ ':' :: name.value.toList) =
      some (package.value.toList, name.value.toList) :=
    splitFirst_append package.value.toList name.value.toList packagePlain
  have packageParse : TextId.parse .facetPackage package.value = .ok package := by
    unfold TextId.parse
    simp [package.valid]
  have nameParse : TextId.parse .operationName name.value = .ok name := by
    unfold TextId.parse
    simp [name.valid]
  show parse (String.ofList (package.value.toList ++ ':' :: name.value.toList)) = _
  unfold parse
  rw [String.toList_ofList, split]
  simp only [String.ofList_toList, packageParse, nameParse, packagePlain, namePlain,
    dite_true]

end OperationRef

end AgentCore.Kernel
