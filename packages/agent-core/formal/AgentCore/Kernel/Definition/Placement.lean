/-
Placement (SPEC §9.2; `src/definition/placement.ts`, `src/agents/runs/placement.ts`).

Placement is exactly `manifest ∩ policy ∩ substrate ∩ trust`, resolved by one fixed order:
`dynamic`, `provider`, `bundled`. There is no second ordering and no fallback for an empty
intersection — an empty intersection is a refusal (`PlacementUnavailableError`, which is an
`AgentCoreError` carrying `operation.invalid-input`).

Two runtime shapes collapse here. `canonicalModes` takes a mode list, refuses an empty or
repeating one, and re-emits it in preference order; the kernel's `ModeSet` is that
normalization made unrepresentable otherwise — three admissibility bits and the proof that
at least one is set. Order and uniqueness become properties of the type rather than
invariants a constructor re-establishes, and the list the runtime stores is a derived view.
The refusals the runtime raises on the way in are kept, because a caller handing over a
repeating list is still making a mistake worth naming.

`PlacementPin` carries its selection *with* the proof that the selection is the one the
fixed order picks. A pin recording any other mode does not typecheck, which is the
constructor's `preferredPlacement` re-derivation moved into the type.

Which mode a set of admissible-mode sets serves is decided in exactly one Lean place:
`AgentCore.Extract.Placement`, the module the runtime's own placement decision is lowered
from. `preferredPlacement` below consumes that decision through `ModeSet.modes` — the list
form a source already holds — rather than restating the four-source intersection or the
fixed preference order. `preferredPlacement_order` is then a theorem about what Extract
decides, not a second statement of it.
-/
import AgentCore.Extract.Placement
import AgentCore.Kernel.Facets.Tier

namespace AgentCore.Kernel

namespace IsolationMode

/-- Read a mode's wire label. -/
def ofWire (value : String) : Option IsolationMode :=
  if value = "dynamic" then some .dynamic
  else if value = "provider" then some .provider
  else if value = "bundled" then some .bundled
  else none

theorem ofWire_wire (mode : IsolationMode) : ofWire mode.wire = some mode := by
  cases mode <;> rfl

/-- The Extract mode this one is. -/
def toExtract : IsolationMode → Extract.IsolationMode
  | .dynamic => .dynamic
  | .provider => .provider
  | .bundled => .bundled

/-- The kernel mode for an Extract one. -/
def ofExtract : Extract.IsolationMode → IsolationMode
  | .dynamic => .dynamic
  | .provider => .provider
  | .bundled => .bundled

theorem ofExtract_toExtract (mode : IsolationMode) : ofExtract mode.toExtract = mode := by
  cases mode <;> rfl

end IsolationMode

/-- One placement source's admissible modes: `canonicalModes`' result, with order and
uniqueness carried by the representation and nonemptiness carried by a proof. -/
structure ModeSet where
  dynamic : Bool
  provider : Bool
  bundled : Bool
  nonempty : (dynamic || provider || bundled) = true

namespace ModeSet

def contains (set : ModeSet) : IsolationMode → Bool
  | .dynamic => set.dynamic
  | .provider => set.provider
  | .bundled => set.bundled

/-- The stored list form: the admitted modes in preference order, which is what
`canonicalModes` returns and what the codec writes. Written as one pass in that order, so
the order and the absence of repeats are visible in the definition. -/
def modes (set : ModeSet) : List IsolationMode :=
  (if set.dynamic then [IsolationMode.dynamic] else []) ++
    (if set.provider then [IsolationMode.provider] else []) ++
      (if set.bundled then [IsolationMode.bundled] else [])

/-- **The list form is the preference-ordered filter of the admitted modes**, which is
`PLACEMENT_PREFERENCE.filter(...)` in the runtime. -/
theorem modes_eq_filter (set : ModeSet) :
    set.modes = placementPreference.filter set.contains := by
  obtain ⟨dynamic, provider, bundled, _⟩ := set
  cases dynamic <;> cases provider <;> cases bundled <;>
    simp [modes, placementPreference, contains, List.filter]

/-- Every mode the set admits is in its list form, and nothing else is. -/
theorem mem_modes {set : ModeSet} {mode : IsolationMode} :
    mode ∈ set.modes ↔ set.contains mode = true := by
  obtain ⟨dynamic, provider, bundled, _⟩ := set
  cases dynamic <;> cases provider <;> cases bundled <;> cases mode <;>
    simp [modes, contains]

/-- The list form in Extract's vocabulary: what a source hands the placement decision. -/
def extractModes (set : ModeSet) : List Extract.IsolationMode :=
  set.modes.map IsolationMode.toExtract

/-- **Extract's membership test on the handed-over list is this set's own.** Every source
arrives as the list of modes it admits, and the decision reads membership per mode, so the
list form and the bits agree without either side normalizing again. -/
theorem extract_admits_dynamic (set : ModeSet) :
    Extract.admitsMode set.extractModes .dynamic = set.contains .dynamic := by
  obtain ⟨dynamic, provider, bundled, _⟩ := set
  cases dynamic <;> cases provider <;> cases bundled <;>
    simp [extractModes, modes, contains, IsolationMode.toExtract, Extract.admitsMode,
      Extract.isDynamicMode]

theorem extract_admits_provider (set : ModeSet) :
    Extract.admitsMode set.extractModes .provider = set.contains .provider := by
  obtain ⟨dynamic, provider, bundled, _⟩ := set
  cases dynamic <;> cases provider <;> cases bundled <;>
    simp [extractModes, modes, contains, IsolationMode.toExtract, Extract.admitsMode,
      Extract.isProviderMode]

theorem extract_admits_bundled (set : ModeSet) :
    Extract.admitsMode set.extractModes .bundled = set.contains .bundled := by
  obtain ⟨dynamic, provider, bundled, _⟩ := set
  cases dynamic <;> cases provider <;> cases bundled <;>
    simp [extractModes, modes, contains, IsolationMode.toExtract, Extract.admitsMode,
      Extract.isBundledMode]

theorem eq_of_bits {left right : ModeSet} (dynamic : left.dynamic = right.dynamic)
    (provider : left.provider = right.provider) (bundled : left.bundled = right.bundled) :
    left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨dynamic, provider, bundled⟩

instance : DecidableEq ModeSet := fun left right =>
  if bits : left.dynamic = right.dynamic ∧ left.provider = right.provider ∧
      left.bundled = right.bundled then
    .isTrue (eq_of_bits bits.1 bits.2.1 bits.2.2)
  else .isFalse fun equal => bits ⟨by rw [equal], by rw [equal], by rw [equal]⟩

/-- The model's `PlacementSet` for the same source. -/
def toModel (set : ModeSet) : AgentCore.PlacementSet :=
  ⟨set.bundled, set.provider, set.dynamic⟩

/-- `canonicalModes`: refuse an empty or repeating list, then normalize. A repeat is
detected the way it is detectable — the input is longer than its normal form — so the
refusal needs no separate uniqueness pass, and any input order is accepted. -/
def ofList (values : List IsolationMode) (subject : String) : Outcome ModeSet :=
  if nonempty : (values.contains IsolationMode.dynamic ||
      values.contains IsolationMode.provider ||
      values.contains IsolationMode.bundled) = true then
    let set : ModeSet := ⟨values.contains IsolationMode.dynamic,
      values.contains IsolationMode.provider, values.contains IsolationMode.bundled, nonempty⟩
    if values.length == set.modes.length then .ok set else unshaped subject
  else unshaped subject

/-- **A set's own list form reads back as that set.** Normalization is idempotent, so a
stored mode list and the set it came from are the same value. -/
theorem ofList_modes (set : ModeSet) (subject : String) :
    ofList set.modes subject = .ok set := by
  obtain ⟨dynamic, provider, bundled, nonempty⟩ := set
  cases dynamic <;> cases provider <;> cases bundled
  · exact absurd nonempty (by decide)
  all_goals simp [ofList, modes]

/-- **An empty mode list is refused.** A source that admits nothing is not a source. -/
theorem ofList_empty (subject : String) :
    ofList [] subject = (unshaped subject : Outcome ModeSet) := by
  simp [ofList]

end ModeSet

/-- Whether every source admits a mode, in the model's own conjunction shape. -/
def admitsAll (manifest policy substrate trust : ModeSet) (mode : IsolationMode) : Bool :=
  ((manifest.contains mode && policy.contains mode) && substrate.contains mode) &&
    trust.contains mode

/-- `preferredPlacement`: SPEC §9.2's decision, taken by `Extract.preferredPlacement` over
the four sources' list forms. The four-source intersection and the fixed preference order
are stated there and nowhere else; this is the kernel reading the answer back into its own
vocabulary. -/
def preferredPlacement (manifest policy substrate trust : ModeSet) : Option IsolationMode :=
  (Extract.preferredPlacement manifest.extractModes policy.extractModes
    substrate.extractModes trust.extractModes).map IsolationMode.ofExtract

theorem extract_intersection_dynamic (manifest policy substrate trust : ModeSet) :
    (Extract.placementIntersection manifest.extractModes policy.extractModes
        substrate.extractModes trust.extractModes).dynamic =
      admitsAll manifest policy substrate trust .dynamic := by
  simp [Extract.placementIntersection, admitsAll, ModeSet.extract_admits_dynamic,
    Bool.and_assoc]

theorem extract_intersection_provider (manifest policy substrate trust : ModeSet) :
    (Extract.placementIntersection manifest.extractModes policy.extractModes
        substrate.extractModes trust.extractModes).provider =
      admitsAll manifest policy substrate trust .provider := by
  simp [Extract.placementIntersection, admitsAll, ModeSet.extract_admits_provider,
    Bool.and_assoc]

theorem extract_intersection_bundled (manifest policy substrate trust : ModeSet) :
    (Extract.placementIntersection manifest.extractModes policy.extractModes
        substrate.extractModes trust.extractModes).bundled =
      admitsAll manifest policy substrate trust .bundled := by
  simp [Extract.placementIntersection, admitsAll, ModeSet.extract_admits_bundled,
    Bool.and_assoc]

/-- The fixed order, written out. Nothing else decides placement — and the order written
here is a *consequence* of `Extract.PlacementIntersection.preferred`, not a second copy of
it. -/
theorem preferredPlacement_order (manifest policy substrate trust : ModeSet) :
    preferredPlacement manifest policy substrate trust =
      (if admitsAll manifest policy substrate trust .dynamic then some .dynamic
       else if admitsAll manifest policy substrate trust .provider then some .provider
       else if admitsAll manifest policy substrate trust .bundled then some .bundled
       else none) := by
  unfold preferredPlacement Extract.preferredPlacement Extract.PlacementIntersection.preferred
  rw [extract_intersection_dynamic, extract_intersection_provider,
    extract_intersection_bundled]
  cases first : admitsAll manifest policy substrate trust .dynamic <;>
    cases second : admitsAll manifest policy substrate trust .provider <;>
      cases third : admitsAll manifest policy substrate trust .bundled <;>
        simp [IsolationMode.ofExtract]

/-- `selectPlacement`: the selection, or the refusal an empty intersection earns. -/
def selectPlacement (manifest policy substrate trust : ModeSet) : Outcome IsolationMode :=
  match preferredPlacement manifest policy substrate trust with
  | some mode => .ok mode
  | none => refuse .operationInvalidInput

/-- **`dynamic` wins whenever every source admits it.** -/
theorem placement_prefers_dynamic {manifest policy substrate trust : ModeSet}
    (admitted : admitsAll manifest policy substrate trust .dynamic = true) :
    selectPlacement manifest policy substrate trust = .ok .dynamic := by
  unfold selectPlacement
  rw [preferredPlacement_order]
  simp [admitted]

/-- **`provider` is used only where `dynamic` is unavailable.** -/
theorem placement_uses_provider_without_dynamic {manifest policy substrate trust : ModeSet}
    (noDynamic : admitsAll manifest policy substrate trust .dynamic = false)
    (admitted : admitsAll manifest policy substrate trust .provider = true) :
    selectPlacement manifest policy substrate trust = .ok .provider := by
  unfold selectPlacement
  rw [preferredPlacement_order]
  simp [noDynamic, admitted]

/-- **`bundled` is last.** -/
theorem placement_uses_bundled_last {manifest policy substrate trust : ModeSet}
    (noDynamic : admitsAll manifest policy substrate trust .dynamic = false)
    (noProvider : admitsAll manifest policy substrate trust .provider = false)
    (admitted : admitsAll manifest policy substrate trust .bundled = true) :
    selectPlacement manifest policy substrate trust = .ok .bundled := by
  unfold selectPlacement
  rw [preferredPlacement_order]
  simp [noDynamic, noProvider, admitted]

/-- **An empty intersection is refused, never filled in.** The refusal carries
`operation.invalid-input`, which is the code `PlacementUnavailableError` raises. -/
theorem empty_intersection_refuses {manifest policy substrate trust : ModeSet}
    (noDynamic : admitsAll manifest policy substrate trust .dynamic = false)
    (noProvider : admitsAll manifest policy substrate trust .provider = false)
    (noBundled : admitsAll manifest policy substrate trust .bundled = false) :
    (selectPlacement manifest policy substrate trust).RefusedWith .operationInvalidInput := by
  unfold selectPlacement
  rw [preferredPlacement_order]
  simp [noDynamic, noProvider, noBundled, refuse, Outcome.RefusedWith]

/-- **A chosen mode is admitted by every source.** -/
theorem preferredPlacement_admits {manifest policy substrate trust : ModeSet}
    {mode : IsolationMode}
    (chosen : preferredPlacement manifest policy substrate trust = some mode) :
    admitsAll manifest policy substrate trust mode = true := by
  rw [preferredPlacement_order] at chosen
  by_cases dynamic : admitsAll manifest policy substrate trust .dynamic = true
  · have same : IsolationMode.dynamic = mode := by simpa [dynamic] using chosen
    rw [← same]
    exact dynamic
  · simp only [Bool.not_eq_true] at dynamic
    by_cases provider : admitsAll manifest policy substrate trust .provider = true
    · have same : IsolationMode.provider = mode := by simpa [dynamic, provider] using chosen
      rw [← same]
      exact provider
    · simp only [Bool.not_eq_true] at provider
      by_cases bundled : admitsAll manifest policy substrate trust .bundled = true
      · have same : IsolationMode.bundled = mode := by
          simpa [dynamic, provider, bundled] using chosen
        rw [← same]
        exact bundled
      · simp only [Bool.not_eq_true] at bundled
        simp [dynamic, provider, bundled] at chosen

/-- **A selection belongs to every source.** The runtime checks this separately; here it is
a consequence of how the selection is made, so the two can never disagree. -/
theorem selection_admitted_by_every_source {manifest policy substrate trust : ModeSet}
    {mode : IsolationMode}
    (chosen : preferredPlacement manifest policy substrate trust = some mode) :
    manifest.contains mode = true ∧ policy.contains mode = true ∧
      substrate.contains mode = true ∧ trust.contains mode = true := by
  have admitted := preferredPlacement_admits chosen
  unfold admitsAll at admitted
  obtain ⟨first, trustAdmits⟩ := (Bool.and_eq_true _ _).mp admitted
  obtain ⟨pair, substrateAdmits⟩ := (Bool.and_eq_true _ _).mp first
  obtain ⟨manifestAdmits, policyAdmits⟩ := (Bool.and_eq_true _ _).mp pair
  exact ⟨manifestAdmits, policyAdmits, substrateAdmits, trustAdmits⟩

/-! ## Refinement against the model's placement policy -/

theorem admitsAll_dynamic (manifest policy substrate trust : ModeSet) :
    (AgentCore.placementIntersection manifest.toModel policy.toModel substrate.toModel
      trust.toModel).dynamic = admitsAll manifest policy substrate trust .dynamic := rfl

theorem admitsAll_provider (manifest policy substrate trust : ModeSet) :
    (AgentCore.placementIntersection manifest.toModel policy.toModel substrate.toModel
      trust.toModel).provider = admitsAll manifest policy substrate trust .provider := rfl

theorem admitsAll_bundled (manifest policy substrate trust : ModeSet) :
    (AgentCore.placementIntersection manifest.toModel policy.toModel substrate.toModel
      trust.toModel).bundled = admitsAll manifest policy substrate trust .bundled := rfl

/-- **The kernel's selection is the model's `choosePlacement`.** The executable four-source
intersection and the fixed order refine the abstract ones exactly, so every placement
theorem in the model — including `dynamic_only_manifest_never_places_ambient` — holds of
what the kernel computes. -/
theorem preferredPlacement_refines_model (manifest policy substrate trust : ModeSet) :
    (preferredPlacement manifest policy substrate trust).map IsolationMode.toModel =
      AgentCore.choosePlacement manifest.toModel policy.toModel substrate.toModel
        trust.toModel := by
  rw [preferredPlacement_order]
  simp only [AgentCore.choosePlacement, admitsAll_dynamic, admitsAll_provider,
    admitsAll_bundled]
  by_cases dynamic : admitsAll manifest policy substrate trust .dynamic = true
  · simp [dynamic, IsolationMode.toModel]
  · simp only [Bool.not_eq_true] at dynamic
    by_cases provider : admitsAll manifest policy substrate trust .provider = true
    · simp [dynamic, provider, IsolationMode.toModel]
    · simp only [Bool.not_eq_true] at provider
      by_cases bundled : admitsAll manifest policy substrate trust .bundled = true
      · simp [dynamic, provider, bundled, IsolationMode.toModel]
      · simp only [Bool.not_eq_true] at bundled
        simp [dynamic, provider, bundled]

/-- A recorded placement decision: the Facet it was taken for, the four sources, and the
selection, which cannot be anything but what the fixed order picks. -/
structure PlacementPin where
  facet : TextId .facetPackage
  manifest : ModeSet
  policy : ModeSet
  substrate : ModeSet
  trust : ModeSet
  selected : IsolationMode
  chosen : preferredPlacement manifest policy substrate trust = some selected

namespace PlacementPin

/-- **A pin's selection is admitted by all four of its sources.** -/
theorem selection_admitted (pin : PlacementPin) :
    pin.manifest.contains pin.selected = true ∧ pin.policy.contains pin.selected = true ∧
      pin.substrate.contains pin.selected = true ∧ pin.trust.contains pin.selected = true :=
  selection_admitted_by_every_source pin.chosen

/-- **A pin refines the model's `PlacementSnapshot.Valid`.** The snapshot a Turn records is
valid in the model's sense by construction, not by a later check. -/
theorem refines_model_snapshot (pin : PlacementPin) :
    AgentCore.PlacementSnapshot.Valid ⟨pin.manifest.toModel, pin.policy.toModel,
      pin.substrate.toModel, pin.trust.toModel, pin.selected.toModel⟩ := by
  unfold AgentCore.PlacementSnapshot.Valid
  rw [← preferredPlacement_refines_model, pin.chosen]
  rfl

theorem eq_of_fields {left right : PlacementPin} (facet : left.facet = right.facet)
    (manifest : left.manifest = right.manifest) (policy : left.policy = right.policy)
    (substrate : left.substrate = right.substrate) (trust : left.trust = right.trust)
    (selected : left.selected = right.selected) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨facet, manifest, policy, substrate, trust, selected⟩

/-- The modes of one source, as the record writes them. -/
def modesJson (set : ModeSet) : Json.JsonValue :=
  .arr (set.modes.map (fun mode => .str mode.wire))

/-- Read one mode label. Written with explicit matches rather than `do`: the kernel's
decoders are proved by reduction, and a monadic bind hides the step that has to reduce. -/
def modeOfJson (value : Json.JsonValue) (subject : String) : Outcome IsolationMode :=
  match Json.asString value subject with
  | .error fault => .error fault
  | .ok text =>
      match IsolationMode.ofWire text with
      | some mode => .ok mode
      | none => unshaped subject

theorem modeOfJson_str (mode : IsolationMode) (subject : String) :
    modeOfJson (.str mode.wire) subject = .ok mode := by
  cases mode <;> rfl

/-- Read a list of mode labels. -/
def modeListOfJson : List Json.JsonValue → String → Outcome (List IsolationMode)
  | [], _ => .ok []
  | item :: rest, subject =>
      match modeOfJson item subject with
      | .error fault => .error fault
      | .ok mode =>
          match modeListOfJson rest subject with
          | .error fault => .error fault
          | .ok modes => .ok (mode :: modes)

/-- Read one source's modes back. -/
def modesOfJson (value : Json.JsonValue) (subject : String) : Outcome ModeSet :=
  match Json.asArray value subject with
  | .error fault => .error fault
  | .ok items =>
      match modeListOfJson items subject with
      | .error fault => .error fault
      | .ok modes => ModeSet.ofList modes subject

theorem modeListOfJson_labels : ∀ (modes : List IsolationMode) (subject : String),
    modeListOfJson (modes.map (fun mode => (Json.JsonValue.str mode.wire))) subject = .ok modes
  | [], _ => rfl
  | mode :: rest, subject => by
      simp [modeListOfJson, modeOfJson_str, modeListOfJson_labels rest subject]

theorem modesOfJson_modesJson (set : ModeSet) (subject : String) :
    modesOfJson (modesJson set) subject = .ok set := by
  simp [modesOfJson, modesJson, Json.asArray, modeListOfJson_labels, ModeSet.ofList_modes]

theorem canonicalItems_labels : ∀ modes : List IsolationMode,
    Json.canonicalItems (modes.map (fun mode => (Json.JsonValue.str mode.wire))) = true
  | [] => rfl
  | mode :: rest => by
      simp [Json.canonicalItems, Json.canonical, canonicalItems_labels rest]

theorem canonical_modesJson (set : ModeSet) : Json.canonical (modesJson set) = true := by
  simp [modesJson, Json.canonical, canonicalItems_labels]

def payload (pin : PlacementPin) : Json.JsonValue :=
  .obj [("facet", .str pin.facet.value),
        ("manifest", modesJson pin.manifest),
        ("policy", modesJson pin.policy),
        ("selected", .str pin.selected.wire),
        ("substrate", modesJson pin.substrate),
        ("trust", modesJson pin.trust)]

/-- Read a pin back. Every step is an explicit match, and the selection is admitted only
with the proof that it is the fixed order's choice — a payload naming any other mode is
refused here rather than trusted and re-checked later. -/
def ofPayload (value : Json.JsonValue) : Outcome PlacementPin :=
  match Json.asObject value "Placement pin" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries
          ["facet", "manifest", "policy", "selected", "substrate", "trust"] then
        match Json.field entries "facet", Json.field entries "manifest",
            Json.field entries "policy", Json.field entries "selected",
            Json.field entries "substrate", Json.field entries "trust" with
        | some (.str facetText), some manifestJson, some policyJson, some (.str selectedText),
            some substrateJson, some trustJson =>
            match TextId.parse .facetPackage facetText, modesOfJson manifestJson
                "Manifest modes", modesOfJson policyJson "Policy modes",
                modesOfJson substrateJson "Substrate modes",
                modesOfJson trustJson "Trust modes", IsolationMode.ofWire selectedText with
            | .ok facet, .ok manifest, .ok policy, .ok substrate, .ok trust, some selected =>
                if chosen : preferredPlacement manifest policy substrate trust = some selected
                then .ok ⟨facet, manifest, policy, substrate, trust, selected, chosen⟩
                else unshaped "Placement pin"
            | _, _, _, _, _, _ => unshaped "Placement pin"
        | _, _, _, _, _, _ => unshaped "Placement pin"
      else unshaped "Placement pin"

theorem canonical_payload (pin : PlacementPin) : Json.canonical (payload pin) = true := by
  have ordered : Text.strictlyOrdered
      ["facet", "manifest", "policy", "selected", "substrate", "trust"] = true := by decide
  simp [payload, Json.canonical, Json.canonicalEntries, ordered, canonical_modesJson]

theorem roundTrip (pin : PlacementPin) : ofPayload (payload pin) = .ok pin := by
  obtain ⟨facet, manifest, policy, substrate, trust, selected, chosen⟩ := pin
  have facetParse : TextId.parse .facetPackage facet.value = .ok facet := by
    unfold TextId.parse
    simp [facet.valid]
  simp [ofPayload, payload, Json.asObject, Json.exactFields, Json.keys, Json.field,
    facetParse, modesOfJson_modesJson, IsolationMode.ofWire_wire, chosen]

/-- The `placement.pin` codec. Both §8.3 laws are discharged here, so this codec exists
only because the record round-trips and writes canonical bytes. -/
def codec : RecordCodec PlacementPin where
  kind := "placement.pin"
  version := ⟨1, 0⟩
  encodePayload := payload
  decodePayload := ofPayload
  roundTrip := roundTrip
  canonicalPayload := canonical_payload

end PlacementPin

end AgentCore.Kernel
