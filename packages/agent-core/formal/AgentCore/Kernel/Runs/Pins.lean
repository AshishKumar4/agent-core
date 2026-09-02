/-
RunPins (SPEC §5.2; `packages/agent-core/src/agents/runs/pins.ts`).

A Run's pins are the exact sources every Turn of it runs against: one Blueprint pin, the
*complete* Package closure, and one pin each for the Agent, effective policy, model policy,
and Environment. Two constructor rules carry the weight — the closure is nonempty and its
Package identities are unique — and the runtime sorts the closure by Package id so one pin
set has one encoding.

The kernel makes both rules `Prop` fields, so a pin set with an empty or repeating closure
does not typecheck, and keeps the sortedness as a field too: `equals` in the runtime is
byte equality over the encoded record, and byte equality only decides pin identity if the
encoding is canonical. With sortedness in the type, `pins_equal_iff_fields` holds without a
normalization step.

Digests are not derived here. The runtime computes `RunPins.digest` by hashing the canonical
encoding, and hashing is a host primitive; the kernel carries the digest as data and states
what depends on it, rather than pretending to compute it.
-/
import AgentCore.RunGraph
import AgentCore.Kernel.Core

namespace AgentCore.Kernel

/-- A semantic version, as `SemVer` holds it. -/
structure SemVer where
  major : Nat
  minor : Nat
  patch : Nat
  deriving DecidableEq, Repr

/-- `SemVer.toString`. -/
def SemVer.wire (version : SemVer) : String :=
  String.ofList (Json.natToken version.major) ++ "." ++
    String.ofList (Json.natToken version.minor) ++ "." ++
      String.ofList (Json.natToken version.patch)

/-- `BlueprintPin`: the Blueprint a Run was opened against. The name is non-blank, which is
the constructor's one check. -/
structure BlueprintPin where
  name : String
  version : SemVer
  digest : Digest
  nameNonblank : isBlank name = false

/-- `PackagePin`: one Package of the closure, pinned by version and both digests. -/
structure PackagePin where
  package : TextId .package
  version : SemVer
  manifestDigest : Digest
  codeDigest : Digest
  deriving DecidableEq

/-- `SourcePin`: an identity with the revision and digest it was pinned at. -/
structure SourcePin (kind : IdKind) where
  id : TextId kind
  revision : Revision
  digest : Digest
  deriving DecidableEq

/-- The Package identities of a closure, in stored order. -/
def packageIdentities (packages : List PackagePin) : List String :=
  packages.map fun pin => pin.package.value

/-- A Run's pins. The closure's nonemptiness, uniqueness, and canonical order are fields, so
there is no unnormalized pin set to compare. -/
structure RunPins where
  blueprint : BlueprintPin
  packages : List PackagePin
  agent : SourcePin .agent
  effectivePolicy : SourcePin .agentPolicy
  modelPolicy : SourcePin .modelPolicy
  environment : SourcePin .environment
  /-- The closure is nonempty: a Run always runs against at least one Package. -/
  closureNonempty : packages ≠ []
  /-- No Package appears twice: the closure names each Package once. -/
  closureUnique : (packageIdentities packages).Nodup
  /-- The closure is in canonical Package-id order, so one pin set has one encoding and
  byte equality decides pin identity. -/
  closureOrdered : Text.strictlyOrdered (packageIdentities packages) = true

namespace RunPins

theorem eq_of_fields {left right : RunPins} (blueprint : left.blueprint = right.blueprint)
    (packages : left.packages = right.packages) (agent : left.agent = right.agent)
    (effectivePolicy : left.effectivePolicy = right.effectivePolicy)
    (modelPolicy : left.modelPolicy = right.modelPolicy)
    (environment : left.environment = right.environment) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨blueprint, packages, agent, effectivePolicy, modelPolicy, environment⟩

/-! ## Encoding

Field order is the runtime's `toData` order, which is already canonical: `agent`,
`blueprint`, `effectivePolicy`, `environment`, `modelPolicy`, `packages`. -/

def sourcePinJson {kind : IdKind} (pin : SourcePin kind) : Json.JsonValue :=
  .obj [("digest", .str pin.digest.value),
        ("id", .str pin.id.value),
        ("revision", .int pin.revision.value)]

def sourcePinOfJson (kind : IdKind) (value : Json.JsonValue) (subject : String) :
    Outcome (SourcePin kind) :=
  match Json.asObject value subject with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries ["digest", "id", "revision"] then
        match Json.field entries "digest", Json.field entries "id",
            Json.field entries "revision" with
        | some (.str digestText), some (.str idText), some (.int revisionValue) =>
            match Digest.parse digestText, TextId.parse kind idText with
            | .ok digest, .ok id =>
                if revisionValue < 0 then unshaped subject
                else
                  match Revision.parse revisionValue.natAbs with
                  | .ok revision => .ok ⟨id, revision, digest⟩
                  | .error fault => .error fault
            | _, _ => unshaped subject
        | _, _, _ => unshaped subject
      else unshaped subject

theorem sourcePinOfJson_roundTrip {kind : IdKind} (pin : SourcePin kind) (subject : String) :
    sourcePinOfJson kind (sourcePinJson pin) subject = .ok pin := by
  obtain ⟨id, revision, digest⟩ := pin
  have digestParse : Digest.parse digest.value = .ok digest := by
    unfold Digest.parse
    simp [digest.valid]
  have idParse : TextId.parse kind id.value = .ok id := by
    unfold TextId.parse
    simp [id.valid]
  have revisionParse : Revision.parse revision.value = .ok revision := by
    unfold Revision.parse
    simp [revision.valid]
  have nonneg : ¬ ((revision.value : Int) < 0) := by omega
  have magnitude : ((revision.value : Int)).natAbs = revision.value := by omega
  simp [sourcePinJson, sourcePinOfJson, Json.asObject, Json.exactFields, Json.keys,
    Json.field, digestParse, idParse, nonneg, magnitude, revisionParse]

theorem canonical_sourcePinJson {kind : IdKind} (pin : SourcePin kind) :
    Json.canonical (sourcePinJson pin) = true := by
  have ordered : Text.strictlyOrdered ["digest", "id", "revision"] = true := by decide
  simp [sourcePinJson, Json.canonical, Json.canonicalEntries, ordered]

/-! ## Refinement against the model's RunPins -/

/-- The model's pin set for this one, under an explicit identifier abstraction: a named
premise with an obvious discharge (any injective interning), never a hidden axiom. The
model pins digests as `Nat` for the same reason. -/
def toModel (pins : RunPins) (idOf : String → Nat) : AgentCore.RunPins where
  blueprint := ⟨⟨idOf pins.blueprint.name⟩, pins.blueprint.version.major,
    idOf pins.blueprint.digest.value⟩
  packageClosure := pins.packages.map fun pin =>
    ⟨⟨idOf pin.package.value⟩, pin.version.major, idOf pin.manifestDigest.value,
      idOf pin.codeDigest.value⟩
  agent := ⟨⟨idOf pins.agent.id.value⟩, pins.agent.revision.value,
    idOf pins.agent.digest.value⟩
  effectivePolicy := ⟨⟨idOf pins.effectivePolicy.id.value⟩,
    pins.effectivePolicy.revision.value, idOf pins.effectivePolicy.digest.value⟩
  modelPolicy := ⟨⟨idOf pins.modelPolicy.id.value⟩, pins.modelPolicy.revision.value,
    idOf pins.modelPolicy.digest.value⟩
  environment := ⟨⟨idOf pins.environment.id.value⟩, pins.environment.revision.value,
    idOf pins.environment.digest.value⟩

theorem toModel_closure_length (pins : RunPins) (idOf : String → Nat) :
    (pins.toModel idOf).packageClosure.length = pins.packages.length := by
  unfold toModel
  simp

/-- **A kernel pin set's closure is nonempty in the model too.** -/
theorem toModel_closure_nonempty (pins : RunPins) (idOf : String → Nat) :
    (pins.toModel idOf).packageClosure ≠ [] := by
  intro empty
  have lengths := toModel_closure_length pins idOf
  rw [empty] at lengths
  simp only [List.length_nil] at lengths
  exact pins.closureNonempty (List.eq_nil_of_length_eq_zero lengths.symm)

/-- Mapping a duplicate-free list through an injective function leaves it duplicate-free.
Proved here because the toolchain's `List` API carries no such lemma without Mathlib, and
the model's `RunPins.Valid` asks for exactly this about the mapped Package identities. -/
theorem nodup_map : ∀ (values : List String) {β : Type} (f : String → β),
    (∀ left right, f left = f right → left = right) → values.Nodup → (values.map f).Nodup
  | [], _, _, _, _ => by simp
  | value :: rest, _, f, injective, nodup => by
      have head : value ∉ rest := (List.nodup_cons.mp nodup).1
      have tail : rest.Nodup := (List.nodup_cons.mp nodup).2
      refine List.nodup_cons.mpr ⟨?_, nodup_map rest f injective tail⟩
      intro mapped
      obtain ⟨other, member, same⟩ := List.mem_map.mp mapped
      exact head (injective value other same.symm ▸ member)

/-- **A kernel pin set satisfies the model's `RunPins.Valid`**, given the identifier
abstraction premise and the Agent the Run declares. Both halves the model asks for — the
Agent binding and the nonempty closure — come from the record's own fields; the third,
`Nodup` of the mapped Package identities, follows from the canonical order under the
injectivity premise. -/
theorem toModel_valid (pins : RunPins) (idOf : String → Nat)
    (injective : ∀ left right, idOf left = idOf right → left = right) :
    (pins.toModel idOf).Valid ⟨idOf pins.agent.id.value⟩ := by
  refine ⟨rfl, toModel_closure_nonempty pins idOf, ?_⟩
  have mapped : List.map AgentCore.PackagePin.package (pins.toModel idOf).packageClosure =
      (packageIdentities pins.packages).map
        (fun text => (⟨idOf text⟩ : AgentCore.PackageId)) := by
    unfold toModel packageIdentities
    simp
  rw [mapped]
  exact nodup_map (packageIdentities pins.packages)
    (fun text => (⟨idOf text⟩ : AgentCore.PackageId))
    (fun left right same => injective left right (by simpa using same)) pins.closureUnique

end RunPins

end AgentCore.Kernel
