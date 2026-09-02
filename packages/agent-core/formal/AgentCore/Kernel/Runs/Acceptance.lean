/-
Acceptance criteria and verdicts (SPEC §5.2; `packages/agent-core/src/agents/runs/acceptance.ts`).

A Run declares its acceptance criteria when it opens and never afterwards, and each one is
an ordinary Operation that decides whether the work is done. A verdict names the criterion,
the head tree digest the verifier saw, and the Receipt that earned it.

Both records are pure identity carriers: the runtime's constructors check nothing but that
each field uses its exact context class, which in the kernel is what the field's *type*
already says. So the interesting content here is not a `Prop` field — there is none to add —
but the two codecs and their laws, and the refinement that the kernel's criterion identity
is the model's: `AcceptanceCriteriaUnique` and `acceptance_verdict_only_for_its_subject` are
theorems about distinct `AcceptanceId`s and matching subjects, and `toModel_injective`
below is what carries them onto kernel records.

The runtime's `AcceptanceVerdict` does *not* check that the Receipt proves the criterion.
That is evidence logic in the Run graph, not a record invariant, and this module does not
pretend otherwise: the model states it as `AcceptanceSatisfied` over the effect ledger.
-/
import AgentCore.RunGraph
import AgentCore.Kernel.Core

namespace AgentCore.Kernel

/-- `AcceptanceCriterion`: the Operation that decides one criterion. -/
structure AcceptanceCriterion where
  id : TextId .acceptance
  operation : OperationRef
  deriving DecidableEq

namespace AcceptanceCriterion

theorem eq_of_fields {left right : AcceptanceCriterion} (id : left.id = right.id)
    (operation : left.operation = right.operation) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨id, operation⟩

/-- `toData`: exactly `id` and `operation`, already in canonical key order. -/
def toJson (criterion : AcceptanceCriterion) : Json.JsonValue :=
  .obj [("id", .str criterion.id.value), ("operation", .str criterion.operation.value)]

def ofJson (value : Json.JsonValue) : Outcome AcceptanceCriterion :=
  match Json.asObject value "Acceptance criterion" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries ["id", "operation"] then
        match Json.field entries "id", Json.field entries "operation" with
        | some (.str idText), some (.str operationText) =>
            match TextId.parse .acceptance idText, OperationRef.parse operationText with
            | .ok id, .ok operation => .ok ⟨id, operation⟩
            | .error fault, _ => .error fault
            | _, .error fault => .error fault
        | _, _ => unshaped "Acceptance criterion"
      else unshaped "Acceptance criterion"

theorem ofJson_toJson (criterion : AcceptanceCriterion) : ofJson criterion.toJson = .ok criterion := by
  obtain ⟨id, operation⟩ := criterion
  have idParse : TextId.parse .acceptance id.value = .ok id := by
    unfold TextId.parse
    simp [id.valid]
  have operationParse : OperationRef.parse operation.value = .ok operation :=
    OperationRef.parse_value operation
  simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
    idParse, operationParse]

theorem canonical_toJson (criterion : AcceptanceCriterion) :
    Json.canonical criterion.toJson = true := by
  have ordered : Text.strictlyOrdered ["id", "operation"] = true := by decide
  simp [toJson, Json.canonical, Json.canonicalEntries, ordered]

end AcceptanceCriterion

/-- `AcceptanceCriterionCodec`. -/
def acceptanceCriterionCodec : RecordCodec AcceptanceCriterion where
  kind := "run.acceptance-criterion"
  version := ⟨1, 0⟩
  encodePayload := AcceptanceCriterion.toJson
  decodePayload := AcceptanceCriterion.ofJson
  roundTrip := AcceptanceCriterion.ofJson_toJson
  canonicalPayload := AcceptanceCriterion.canonical_toJson

/-- `AcceptanceVerdict`: the criterion, the head tree digest the verifier saw, and the
Receipt that earned it. -/
structure AcceptanceVerdict where
  acceptance : TextId .acceptance
  subject : Digest
  receipt : TextId .receipt
  deriving DecidableEq

namespace AcceptanceVerdict

theorem eq_of_fields {left right : AcceptanceVerdict}
    (acceptance : left.acceptance = right.acceptance) (subject : left.subject = right.subject)
    (receipt : left.receipt = right.receipt) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨acceptance, subject, receipt⟩

/-- `toData`: `acceptance`, `receipt`, `subject`, already in canonical key order. -/
def toJson (verdict : AcceptanceVerdict) : Json.JsonValue :=
  .obj [("acceptance", .str verdict.acceptance.value),
        ("receipt", .str verdict.receipt.value),
        ("subject", .str verdict.subject.value)]

def ofJson (value : Json.JsonValue) : Outcome AcceptanceVerdict :=
  match Json.asObject value "Acceptance verdict" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries ["acceptance", "receipt", "subject"] then
        match Json.field entries "acceptance", Json.field entries "receipt",
            Json.field entries "subject" with
        | some (.str acceptanceText), some (.str receiptText), some (.str subjectText) =>
            match TextId.parse .acceptance acceptanceText, TextId.parse .receipt receiptText,
                Digest.parse subjectText with
            | .ok acceptance, .ok receipt, .ok subject => .ok ⟨acceptance, subject, receipt⟩
            | _, _, _ => unshaped "Acceptance verdict"
        | _, _, _ => unshaped "Acceptance verdict"
      else unshaped "Acceptance verdict"

theorem ofJson_toJson (verdict : AcceptanceVerdict) : ofJson verdict.toJson = .ok verdict := by
  obtain ⟨acceptance, subject, receipt⟩ := verdict
  have acceptanceParse : TextId.parse .acceptance acceptance.value = .ok acceptance := by
    unfold TextId.parse
    simp [acceptance.valid]
  have receiptParse : TextId.parse .receipt receipt.value = .ok receipt := by
    unfold TextId.parse
    simp [receipt.valid]
  have subjectParse : Digest.parse subject.value = .ok subject := by
    unfold Digest.parse
    simp [subject.valid]
  simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
    acceptanceParse, receiptParse, subjectParse]

theorem canonical_toJson (verdict : AcceptanceVerdict) :
    Json.canonical verdict.toJson = true := by
  have ordered : Text.strictlyOrdered ["acceptance", "receipt", "subject"] = true := by decide
  simp [toJson, Json.canonical, Json.canonicalEntries, ordered]

end AcceptanceVerdict

/-- `AcceptanceVerdictCodec`. -/
def acceptanceVerdictCodec : RecordCodec AcceptanceVerdict where
  kind := "run.acceptance-verdict"
  version := ⟨1, 0⟩
  encodePayload := AcceptanceVerdict.toJson
  decodePayload := AcceptanceVerdict.ofJson
  roundTrip := AcceptanceVerdict.ofJson_toJson
  canonicalPayload := AcceptanceVerdict.canonical_toJson

/-! ## Refinement against the model's acceptance records

The model identifies everything by `Nat`, so the bridge takes the same explicit `idOf`
abstraction the other kernel modules take. The Operation the model names also carries a
version, which the kernel's `OperationRef` does not: an Operation *reference* names the
Facet package and the Operation, and the version comes from the pinned Package. That
parameter is therefore supplied to the bridge rather than invented by it. -/

namespace AcceptanceCriterion

/-- The model's criterion for this one. -/
def toModel (criterion : AcceptanceCriterion) (idOf : String → Nat) (version : Nat) :
    AgentCore.AcceptanceCriterion where
  id := ⟨idOf criterion.id.value⟩
  operation := ⟨⟨idOf criterion.operation.package.value⟩, criterion.operation.name.value, version⟩

/-- **Distinct kernel criteria are distinct model criteria.** `AcceptanceCriteriaUnique` is
a statement about distinct `AcceptanceId`s, so a Run whose kernel criteria have distinct ids
satisfies it — the uniqueness the runtime maintains is the uniqueness the model asks for. -/
theorem toModel_id_injective {left right : AcceptanceCriterion} {idOf : String → Nat}
    {version : Nat} (injective : ∀ first second, idOf first = idOf second → first = second)
    (same : (left.toModel idOf version).id = (right.toModel idOf version).id) :
    left.id = right.id := by
  unfold toModel at same
  exact TextId.eq_of_value (injective _ _ (by simpa using same))

end AcceptanceCriterion

namespace AcceptanceVerdict

/-- The model's verdict for this one. -/
def toModel (verdict : AcceptanceVerdict) (idOf : String → Nat) :
    AgentCore.AcceptanceVerdict where
  acceptance := ⟨idOf verdict.acceptance.value⟩
  subject := ⟨idOf verdict.subject.value⟩
  receipt := ⟨idOf verdict.receipt.value⟩

/-- **A verdict answers exactly the criterion it names.** The model's
`acceptance_verdict_only_for_its_subject` is a fact about a verdict whose `acceptance` and
`subject` are the ones asked about; the kernel record carries both, so the bridge preserves
the pairing rather than re-deriving it. -/
theorem toModel_pairs (verdict : AcceptanceVerdict) (idOf : String → Nat) :
    (verdict.toModel idOf).acceptance = ⟨idOf verdict.acceptance.value⟩ ∧
      (verdict.toModel idOf).subject = ⟨idOf verdict.subject.value⟩ :=
  ⟨rfl, rfl⟩

/-- **A verdict for a different tree is a different verdict.** Under the identifier
abstraction, two kernel verdicts that the model cannot tell apart name the same criterion,
subject, and Receipt. -/
theorem toModel_injective {left right : AcceptanceVerdict} {idOf : String → Nat}
    (injective : ∀ first second, idOf first = idOf second → first = second)
    (same : left.toModel idOf = right.toModel idOf) : left = right := by
  unfold toModel at same
  simp only [AgentCore.AcceptanceVerdict.mk.injEq] at same
  exact eq_of_fields (TextId.eq_of_value (injective _ _ (by simpa using same.1)))
    (Digest.eq_of_value (injective _ _ (by simpa using same.2.1)))
    (TextId.eq_of_value (injective _ _ (by simpa using same.2.2)))

end AcceptanceVerdict

end AgentCore.Kernel
