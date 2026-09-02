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
  | agent | agentPolicy | modelPolicy
  | tenant | principal
  | package | blueprint | environment
  | invocation | receipt | approval | effectAttempt | auditRecord | routeReservation
  | facetPackage | operationName
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

/-- An Operation named by the Facet package that contributes it (SPEC §4.2). -/
structure OperationRef where
  package : TextId .facetPackage
  name : TextId .operationName
  deriving DecidableEq

end AgentCore.Kernel
