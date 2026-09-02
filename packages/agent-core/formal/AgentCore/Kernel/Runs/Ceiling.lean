/-
Resource ceilings and realized cost (SPEC §5.2; `packages/agent-core/src/agents/runs/ceiling.ts`
and `cost.ts`).

Four dimensions bound a Run, and the vocabulary is closed: `costMicros`, `depth`, `tokens`,
`wallClockMs`, in exactly that order. The order is not decoration — `exhaustedResource`
returns the *first* declared dimension with nothing left, so two hosts naming different
dimensions for one remainder would be two hosts disagreeing about why a Run was cancelled.

Three runtime facts become type-level facts here:

* a ceiling declares at least one dimension, because `new ResourceCeiling({})` throws. An
  undeclared dimension is *unbounded*, which is not the same as zero, so the absent case is
  `none` rather than a sentinel;
* every declared limit is a non-negative safe integer, which `Nat` plus one bound field
  gives;
* narrowing is truncated subtraction against `0`, which is exactly `Nat`'s `-`. The runtime
  writes `Math.max(0, limit - spent)`; the kernel writes `limit - spent` and they are the
  same function.

`depth` is the one dimension a Run does not spend from its own activity: it spends one level
of what it *inherited*, and none of its own declaration. That asymmetry is the whole content
of `spent`, and `narrow_depth_own_unspent` states it rather than leaving it to be read off
a conditional.

Nothing in the abstract model speaks about resource ceilings — `AgentCore.RunGraph` carries
no ceiling, usage, or cost — so this module states no refinement theorem. Its obligations
are internal laws (`narrowResources` never widens; the exhaustion decision is the canonical
order) plus the codec laws, and the refinement that does exist is stated where the model
does speak: `TerminalSnapshot` in `Runs.Settlement`.
-/
import AgentCore.Kernel.Core

namespace AgentCore.Kernel

/-- `RESOURCE_DIMENSIONS`, in the canonical order the runtime freezes them in. -/
inductive ResourceDimension where
  | costMicros
  | depth
  | tokens
  | wallClockMs
  deriving DecidableEq, Repr

namespace ResourceDimension

def wire : ResourceDimension → String
  | .costMicros => "costMicros"
  | .depth => "depth"
  | .tokens => "tokens"
  | .wallClockMs => "wallClockMs"

/-- `requireResourceDimension`'s vocabulary, in tuple order. -/
def all : List ResourceDimension := [.costMicros, .depth, .tokens, .wallClockMs]

theorem mem_all (dimension : ResourceDimension) : dimension ∈ all := by
  cases dimension <;> decide

/-- **The dimensions are distinguishable on the wire.** -/
theorem wire_nodup : (all.map wire).Nodup := by decide

/-- `requireResourceDimension`: only an exact member of the vocabulary. -/
def ofWire (value : String) : Option ResourceDimension :=
  if value = "costMicros" then some .costMicros
  else if value = "depth" then some .depth
  else if value = "tokens" then some .tokens
  else if value = "wallClockMs" then some .wallClockMs
  else none

theorem ofWire_wire (dimension : ResourceDimension) : ofWire dimension.wire = some dimension := by
  cases dimension <;> rfl

/-- **The wire names are already canonically ordered.** The runtime's tuple order and the
canonical key order of a `ResourceCeiling`'s JSON are the same order, so a ceiling's encoder
never sorts and its bytes are canonical by construction. -/
theorem wires_ordered : Text.strictlyOrdered (all.map wire) = true := by decide

end ResourceDimension

/-- A limit the runtime would accept: absent, or a non-negative safe integer. -/
def resourceLimitValid : Option Nat → Bool
  | none => true
  | some limit => limit ≤ maxSafeInteger

theorem resourceLimitValid_none : resourceLimitValid none = true := rfl

/-- `ResourceCeiling`: a limit per dimension where the ceiling declares one, with the two
constructor rules as fields. A ceiling that declares nothing does not typecheck, which is
the runtime's `Resource ceiling must declare at least one dimension`. -/
structure ResourceCeiling where
  costMicros : Option Nat
  depth : Option Nat
  tokens : Option Nat
  wallClockMs : Option Nat
  /-- Every declared limit is a non-negative safe integer. -/
  costMicrosValid : resourceLimitValid costMicros = true
  depthValid : resourceLimitValid depth = true
  tokensValid : resourceLimitValid tokens = true
  wallClockMsValid : resourceLimitValid wallClockMs = true
  /-- At least one dimension is declared. -/
  declaresSomething :
    (costMicros.isSome || depth.isSome || tokens.isSome || wallClockMs.isSome) = true

namespace ResourceCeiling

/-- `limit(dimension)`. -/
def limit (ceiling : ResourceCeiling) : ResourceDimension → Option Nat
  | .costMicros => ceiling.costMicros
  | .depth => ceiling.depth
  | .tokens => ceiling.tokens
  | .wallClockMs => ceiling.wallClockMs

theorem limit_valid (ceiling : ResourceCeiling) (dimension : ResourceDimension) :
    resourceLimitValid (ceiling.limit dimension) = true := by
  cases dimension
  · exact ceiling.costMicrosValid
  · exact ceiling.depthValid
  · exact ceiling.tokensValid
  · exact ceiling.wallClockMsValid

/-- **A ceiling is its four limits.** This is the runtime's `equals`, which compares exactly
the four `limit` results including the absent ones, read as an identity rather than as a
method that could disagree with the record. -/
theorem eq_of_limits {left right : ResourceCeiling}
    (agree : ∀ dimension, left.limit dimension = right.limit dimension) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨agree .costMicros, agree .depth, agree .tokens, agree .wallClockMs⟩

instance : DecidableEq ResourceCeiling := fun left right =>
  if fields : left.costMicros = right.costMicros ∧ left.depth = right.depth ∧
      left.tokens = right.tokens ∧ left.wallClockMs = right.wallClockMs then
    .isTrue (eq_of_limits fun dimension => by
      cases dimension
      · exact fields.1
      · exact fields.2.1
      · exact fields.2.2.1
      · exact fields.2.2.2)
  else
    .isFalse fun equal =>
      fields ⟨by rw [equal], by rw [equal], by rw [equal], by rw [equal]⟩

/-- `entries`: the declared dimensions paired with their limits, in canonical order. -/
def entries (ceiling : ResourceCeiling) : List (ResourceDimension × Nat) :=
  ResourceDimension.all.filterMap fun dimension =>
    (ceiling.limit dimension).map fun value => (dimension, value)

/-- `declared`. -/
def declared (ceiling : ResourceCeiling) : List ResourceDimension :=
  ceiling.entries.map Prod.fst

/-- **`entries` reports exactly the declared limits.** -/
theorem mem_entries {ceiling : ResourceCeiling} {dimension : ResourceDimension} {value : Nat} :
    (dimension, value) ∈ ceiling.entries ↔ ceiling.limit dimension = some value := by
  constructor
  · intro member
    obtain ⟨candidate, _, mapped⟩ := List.mem_filterMap.mp member
    cases shape : ceiling.limit candidate with
    | none => rw [shape] at mapped; simp at mapped
    | some limit =>
        rw [shape] at mapped
        simp only [Option.map_some, Option.some.injEq, Prod.mk.injEq] at mapped
        rw [← mapped.1, shape, mapped.2]
  · intro declared
    refine List.mem_filterMap.mpr ⟨dimension, ResourceDimension.mem_all dimension, ?_⟩
    rw [declared]
    rfl

/-- Construct a ceiling, refusing exactly what the runtime's constructor refuses: a limit
outside the safe non-negative range, and a ceiling that declares nothing at all. -/
def ofLimits (costMicros depth tokens wallClockMs : Option Nat) (subject : String) :
    Outcome ResourceCeiling :=
  if costValid : resourceLimitValid costMicros = true then
    if depthValid : resourceLimitValid depth = true then
      if tokensValid : resourceLimitValid tokens = true then
        if wallValid : resourceLimitValid wallClockMs = true then
          if declared :
              (costMicros.isSome || depth.isSome || tokens.isSome || wallClockMs.isSome) = true
            then
              .ok ⟨costMicros, depth, tokens, wallClockMs, costValid, depthValid, tokensValid,
                    wallValid, declared⟩
            else unshaped subject
        else unshaped (subject ++ " " ++ ResourceDimension.wallClockMs.wire)
      else unshaped (subject ++ " " ++ ResourceDimension.tokens.wire)
    else unshaped (subject ++ " " ++ ResourceDimension.depth.wire)
  else unshaped (subject ++ " " ++ ResourceDimension.costMicros.wire)

theorem ofLimits_self (ceiling : ResourceCeiling) (subject : String) :
    ofLimits ceiling.costMicros ceiling.depth ceiling.tokens ceiling.wallClockMs subject =
      .ok ceiling := by
  obtain ⟨costMicros, depth, tokens, wallClockMs, costValid, depthValid, tokensValid,
    wallValid, declared⟩ := ceiling
  simp [ofLimits, costValid, depthValid, tokensValid, wallValid, declared]

/-- **An empty ceiling is refused.** A Run under no declaration is unbounded, and the
unbounded case is the absent ceiling rather than a ceiling declaring nothing. -/
theorem ofLimits_empty (subject : String) :
    ofLimits none none none none subject = (unshaped subject : Outcome ResourceCeiling) := by
  simp [ofLimits, resourceLimitValid]

end ResourceCeiling

/-- The limit a possibly absent ceiling sets for a dimension: absent means unbounded. -/
def ceilingAllowance (ceiling : Option ResourceCeiling) (dimension : ResourceDimension) :
    Option Nat :=
  match ceiling with
  | none => none
  | some present => present.limit dimension

theorem ceilingAllowance_valid (ceiling : Option ResourceCeiling)
    (dimension : ResourceDimension) :
    resourceLimitValid (ceilingAllowance ceiling dimension) = true := by
  cases ceiling with
  | none => rfl
  | some present => exact present.limit_valid dimension

/-- `ResourceUsage`: what this Run itself has consumed. There is no `depth` field, because
depth is not something a Run's activity spends. -/
structure ResourceUsage where
  costMicros : Nat
  tokens : Nat
  wallClockMs : Nat
  deriving DecidableEq, Repr

/-- `spent`: what this Run has spent against a dimension of one source. Depth is spent only
against an *inherited* allowance, and then by exactly one level; every other dimension is
spent by this Run's own usage whichever source declared it. -/
def spent (usage : ResourceUsage) (dimension : ResourceDimension) (inherited : Bool) : Nat :=
  match dimension with
  | .depth => if inherited then 1 else 0
  | .costMicros => usage.costMicros
  | .tokens => usage.tokens
  | .wallClockMs => usage.wallClockMs

/-- **A Run spends none of its own depth declaration.** The level a `depth` ceiling counts is
measured from the Run that declared it, so declaring one does not immediately consume it. -/
theorem spent_own_depth (usage : ResourceUsage) : spent usage .depth false = 0 := rfl

/-- **An inherited depth allowance is spent one level per Run.** -/
theorem spent_inherited_depth (usage : ResourceUsage) : spent usage .depth true = 1 := rfl

/-- One dimension of `narrowResources`: the Run's own declaration reduced by its own usage,
the inherited remainder reduced by its own usage, and the tighter of the two. Truncated
subtraction is `Math.max(0, ...)`. -/
def narrowLimit (ownLimit inheritedAllowance : Option Nat) (ownSpent inheritedSpent : Nat) :
    Option Nat :=
  match ownLimit, inheritedAllowance with
  | some own, some inherited => some (min (own - ownSpent) (inherited - inheritedSpent))
  | some own, none => some (own - ownSpent)
  | none, some inherited => some (inherited - inheritedSpent)
  | none, none => none

theorem narrowLimit_valid {ownLimit inheritedAllowance : Option Nat}
    {ownSpent inheritedSpent : Nat} (ownValid : resourceLimitValid ownLimit = true)
    (inheritedValid : resourceLimitValid inheritedAllowance = true) :
    resourceLimitValid (narrowLimit ownLimit inheritedAllowance ownSpent inheritedSpent)
      = true := by
  cases ownLimit with
  | none =>
      cases inheritedAllowance with
      | none => rfl
      | some inherited =>
          simp only [resourceLimitValid, decide_eq_true_eq] at inheritedValid
          simp only [narrowLimit, resourceLimitValid, decide_eq_true_eq]
          omega
  | some own =>
      simp only [resourceLimitValid, decide_eq_true_eq] at ownValid
      cases inheritedAllowance with
      | none =>
          simp only [narrowLimit, resourceLimitValid, decide_eq_true_eq]
          omega
      | some inherited =>
          simp only [resourceLimitValid, decide_eq_true_eq] at inheritedValid
          simp only [narrowLimit, resourceLimitValid, decide_eq_true_eq]
          omega

/-- **Narrowing never exceeds the inherited allowance.** Where the parent bounded a
dimension, the child's remainder is at most what the parent had left after this Run's own
spending — which is the executable half of SPEC §3.4 rule 2 for resources. -/
theorem narrowLimit_le_inherited {ownLimit inheritedAllowance : Option Nat}
    {ownSpent inheritedSpent value inherited : Nat}
    (allowance : inheritedAllowance = some inherited)
    (narrowed : narrowLimit ownLimit inheritedAllowance ownSpent inheritedSpent = some value) :
    value ≤ inherited - inheritedSpent := by
  cases ownLimit with
  | none =>
      rw [allowance] at narrowed
      simp only [narrowLimit, Option.some.injEq] at narrowed
      omega
  | some own =>
      rw [allowance] at narrowed
      simp only [narrowLimit, Option.some.injEq] at narrowed
      omega

/-- One dimension of the remainder a Run is left with: its own declaration and the inherited
remainder, each reduced by what this Run spent against that source. -/
def narrowedLimit (parentRemainder declared : Option ResourceCeiling) (usage : ResourceUsage)
    (dimension : ResourceDimension) : Option Nat :=
  narrowLimit (ceilingAllowance declared dimension)
    (ceilingAllowance parentRemainder dimension) (spent usage dimension false)
    (spent usage dimension true)

theorem narrowedLimit_valid (parentRemainder declared : Option ResourceCeiling)
    (usage : ResourceUsage) (dimension : ResourceDimension) :
    resourceLimitValid (narrowedLimit parentRemainder declared usage dimension) = true :=
  narrowLimit_valid (ceilingAllowance_valid declared dimension)
    (ceilingAllowance_valid parentRemainder dimension)

/-- `narrowResources`: what a Run may still spend, folding its own declaration and the
remainder it inherited. A dimension neither side declares stays absent, and a Run with
nothing declared anywhere has no ceiling at all. -/
def narrowResources (parentRemainder declared : Option ResourceCeiling)
    (usage : ResourceUsage) : Option ResourceCeiling :=
  if bound :
      ((narrowedLimit parentRemainder declared usage .costMicros).isSome ||
        (narrowedLimit parentRemainder declared usage .depth).isSome ||
        (narrowedLimit parentRemainder declared usage .tokens).isSome ||
        (narrowedLimit parentRemainder declared usage .wallClockMs).isSome) = true then
    some ⟨narrowedLimit parentRemainder declared usage .costMicros,
          narrowedLimit parentRemainder declared usage .depth,
          narrowedLimit parentRemainder declared usage .tokens,
          narrowedLimit parentRemainder declared usage .wallClockMs,
          narrowedLimit_valid parentRemainder declared usage .costMicros,
          narrowedLimit_valid parentRemainder declared usage .depth,
          narrowedLimit_valid parentRemainder declared usage .tokens,
          narrowedLimit_valid parentRemainder declared usage .wallClockMs,
          bound⟩
  else none

theorem narrowResources_limit {parentRemainder declared : Option ResourceCeiling}
    {usage : ResourceUsage} {remainder : ResourceCeiling} (dimension : ResourceDimension)
    (narrowed : narrowResources parentRemainder declared usage = some remainder) :
    remainder.limit dimension = narrowedLimit parentRemainder declared usage dimension := by
  unfold narrowResources at narrowed
  split at narrowed
  · simp only [Option.some.injEq] at narrowed
    cases dimension <;> rw [← narrowed] <;> rfl
  · simp at narrowed

/-- **A Run with no ceiling anywhere is unbounded.** Neither an inherited remainder nor an
own declaration means no remainder, rather than a remainder of zero. -/
theorem narrowResources_unbounded (usage : ResourceUsage) :
    narrowResources none none usage = none := by
  simp [narrowResources, narrowedLimit, narrowLimit, ceilingAllowance]

/-- **Narrowing never widens an inherited bound.** For every dimension the parent bounded,
the Run's remainder is at most what the parent had left. -/
theorem narrowResources_respects_parent {parentRemainder : ResourceCeiling}
    {declared : Option ResourceCeiling} {usage : ResourceUsage} {remainder : ResourceCeiling}
    {dimension : ResourceDimension} {value inherited : Nat}
    (allowance : parentRemainder.limit dimension = some inherited)
    (narrowed : narrowResources (some parentRemainder) declared usage = some remainder)
    (left : remainder.limit dimension = some value) :
    value ≤ inherited - spent usage dimension true := by
  have shape := narrowResources_limit dimension narrowed
  rw [left] at shape
  exact narrowLimit_le_inherited (inheritedAllowance := ceilingAllowance (some parentRemainder)
    dimension) allowance shape.symm

/-- `widensResourceCeiling`: whether a child's declaration exceeds what the parent has left.
An absent parent remainder bounds nothing, so no child declaration widens it; a dimension
the parent does not bound is likewise not widened by a child that does. -/
def widensResourceCeiling (parentRemainder : Option ResourceCeiling)
    (child : ResourceCeiling) : Bool :=
  child.entries.any fun entry =>
    match ceilingAllowance parentRemainder entry.1 with
    | none => false
    | some allowance => decide (allowance < entry.2)

/-- **An unbounded parent is never widened.** -/
theorem widensResourceCeiling_unbounded (child : ResourceCeiling) :
    widensResourceCeiling none child = false := by
  unfold widensResourceCeiling ceilingAllowance
  simp

/-- **Widening is exactly a child limit above a parent allowance.** -/
theorem widensResourceCeiling_iff {parentRemainder : Option ResourceCeiling}
    {child : ResourceCeiling} :
    widensResourceCeiling parentRemainder child = true ↔
      ∃ dimension allowance limit, child.limit dimension = some limit ∧
        ceilingAllowance parentRemainder dimension = some allowance ∧ allowance < limit := by
  unfold widensResourceCeiling
  constructor
  · intro widened
    obtain ⟨entry, member, above⟩ := List.any_eq_true.mp widened
    cases allowanceShape : ceilingAllowance parentRemainder entry.1 with
    | none => rw [allowanceShape] at above; simp at above
    | some allowance =>
        rw [allowanceShape] at above
        exact ⟨entry.1, allowance, entry.2, ResourceCeiling.mem_entries.mp (by simpa using member),
          allowanceShape, by simpa using above⟩
  · intro ⟨dimension, allowance, limit, declared, allowanceShape, above⟩
    refine List.any_eq_true.mpr ⟨(dimension, limit), ResourceCeiling.mem_entries.mpr declared, ?_⟩
    simp [allowanceShape, above]

/-- `exhaustedResource`: the first declared dimension, in canonical order, with nothing left
to spend. There is no second ordering, so one remainder names one dimension. -/
def exhaustedResource (remainder : Option ResourceCeiling) : Option ResourceDimension :=
  remainder.bind fun ceiling =>
    (ceiling.entries.find? fun entry => entry.2 == 0).map Prod.fst

/-- **An unbounded Run is never exhausted.** -/
theorem exhaustedResource_unbounded : exhaustedResource none = none := rfl

/-- **A named exhausted dimension really has nothing left.** -/
theorem exhaustedResource_zero {ceiling : ResourceCeiling} {dimension : ResourceDimension}
    (exhausted : exhaustedResource (some ceiling) = some dimension) :
    ceiling.limit dimension = some 0 := by
  simp only [exhaustedResource, Option.bind_some] at exhausted
  cases found : ceiling.entries.find? (fun entry => entry.2 == 0) with
  | none => rw [found] at exhausted; simp at exhausted
  | some entry =>
      rw [found] at exhausted
      simp only [Option.map_some, Option.some.injEq] at exhausted
      have zero : entry.2 = 0 := by
        simpa using List.find?_some found
      have member : entry ∈ ceiling.entries := List.mem_of_find?_eq_some found
      rw [← exhausted]
      have shape : (entry.1, entry.2) ∈ ceiling.entries := by simpa using member
      rw [ResourceCeiling.mem_entries.mp shape, zero]

/-- Realized cost's currency: opaque text the platform compares and never interprets. -/
abbrev Currency := TextId .currency

/-- `RealizedCost`: integer millionths of a currency's major unit, as the call incurred it.
There is no estimated form. -/
structure RealizedCost where
  micros : Nat
  currency : Currency
  microsValid : micros ≤ maxSafeInteger
  deriving DecidableEq

namespace RealizedCost

theorem eq_of_fields {left right : RealizedCost} (micros : left.micros = right.micros)
    (currency : left.currency = right.currency) : left = right := by
  cases left
  cases right
  simp only [mk.injEq]
  exact ⟨micros, currency⟩

def toJson (cost : RealizedCost) : Json.JsonValue :=
  .obj [("currency", .str cost.currency.value), ("micros", .int cost.micros)]

def ofJson (value : Json.JsonValue) (subject : String) : Outcome RealizedCost :=
  match Json.asObject value subject with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries ["currency", "micros"] then
        match Json.field entries "currency", Json.field entries "micros" with
        | some (.str currencyText), some (.int microsValue) =>
            match TextId.parse .currency currencyText with
            | .error fault => .error fault
            | .ok currency =>
                if bound : 0 ≤ microsValue ∧ microsValue.natAbs ≤ maxSafeInteger then
                  .ok ⟨microsValue.natAbs, currency, by simpa using bound.2⟩
                else unshaped subject
        | _, _ => unshaped subject
      else unshaped subject

theorem ofJson_toJson (cost : RealizedCost) (subject : String) :
    ofJson cost.toJson subject = .ok cost := by
  obtain ⟨micros, currency, microsValid⟩ := cost
  have currencyParse : TextId.parse .currency currency.value = .ok currency := by
    unfold TextId.parse
    simp [currency.valid]
  have bound : 0 ≤ (micros : Int) ∧ ((micros : Int)).natAbs ≤ maxSafeInteger := by
    refine ⟨by omega, ?_⟩
    simpa using microsValid
  simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
    currencyParse, bound, microsValid]

theorem canonical_toJson (cost : RealizedCost) : Json.canonical cost.toJson = true := by
  have ordered : Text.strictlyOrdered ["currency", "micros"] = true := by decide
  simp [toJson, Json.canonical, Json.canonicalEntries, ordered]

/-- `Run.recordModelUsage`'s addition: two costs in one currency add, and the sum stays in
the safe range or the transition refuses rather than losing precision. -/
def add (held : RealizedCost) (next : RealizedCost) : Outcome RealizedCost :=
  if bound : held.micros + next.micros ≤ maxSafeInteger then
    .ok ⟨held.micros + next.micros, next.currency, bound⟩
  else refuse .runInvalidState

/-- **Adding cost keeps the currency the call reported.** -/
theorem add_currency {held next total : RealizedCost} (step : held.add next = .ok total) :
    total.currency = next.currency := by
  unfold add at step
  by_cases bound : held.micros + next.micros ≤ maxSafeInteger
  · rw [dif_pos bound] at step
    rw [← Except.ok.inj step]
  · rw [dif_neg bound] at step
    simp [refuse] at step

end RealizedCost

/-! ## Optional-field objects

`ResourceCeiling` writes only the dimensions it declares, so its object's key list is a
*subsequence* of the vocabulary rather than the whole of it. `optionalFields` is the reader
for that shape: the keys must appear in canonical order and nothing else may appear. -/

/-- Whether the keys are a subsequence of the declared vocabulary, in order. -/
def optionalFields : List String → List String → Bool
  | [], _ => true
  | _ :: _, [] => false
  | key :: rest, candidate :: remaining =>
      if key == candidate then optionalFields rest remaining
      else optionalFields (key :: rest) remaining

/-- `SpawnAttenuation`: the attenuation a spawn commits to. Resources ride on it rather than
on a record of their own, so an absent ceiling is the attenuation that bounds nothing. -/
structure SpawnAttenuation where
  ceiling : Option ResourceCeiling
  deriving DecidableEq

namespace ResourceCeiling

/-- The declared limits as JSON, in canonical order, absent dimensions omitted. -/
def toJson (ceiling : ResourceCeiling) : Json.JsonValue :=
  .obj (ceiling.entries.map fun entry => (entry.1.wire, Json.JsonValue.int entry.2))

/-- An optional non-negative safe integer field. -/
def optionalLimit (entries : List (String × Json.JsonValue)) (key subject : String) :
    Outcome (Option Nat) :=
  match Json.field entries key with
  | none => .ok none
  | some (.int value) =>
      if 0 ≤ value then .ok (some value.natAbs) else unshaped subject
  | some _ => unshaped subject

def ofJson (value : Json.JsonValue) (subject : String) : Outcome ResourceCeiling :=
  match Json.asObject value subject with
  | .error fault => .error fault
  | .ok entries =>
      if optionalFields (Json.keys entries) (ResourceDimension.all.map ResourceDimension.wire)
        then
          match optionalLimit entries "costMicros" subject,
              optionalLimit entries "depth" subject,
              optionalLimit entries "tokens" subject,
              optionalLimit entries "wallClockMs" subject with
          | .ok costMicros, .ok depth, .ok tokens, .ok wallClockMs =>
              ofLimits costMicros depth tokens wallClockMs subject
          | _, _, _, _ => unshaped subject
        else unshaped subject

/-- **A ceiling's decode reaches its own constructor.** Reading the object back recovers
exactly the four optional limits the encoder wrote, which is where the constructor's own
rules take over. -/
theorem ofJson_reaches_ofLimits (ceiling : ResourceCeiling) (subject : String) :
    ofJson ceiling.toJson subject =
      ofLimits ceiling.costMicros ceiling.depth ceiling.tokens ceiling.wallClockMs subject := by
  obtain ⟨costMicros, depth, tokens, wallClockMs, _, _, _, _, _⟩ := ceiling
  cases costMicros <;> cases depth <;> cases tokens <;> cases wallClockMs <;>
    simp [toJson, ofJson, entries, limit, ResourceDimension.all, ResourceDimension.wire,
      optionalFields, optionalLimit, Json.asObject, Json.keys, Json.field, List.find?,
      List.filterMap]

theorem ofJson_toJson (ceiling : ResourceCeiling) (subject : String) :
    ofJson ceiling.toJson subject = .ok ceiling := by
  rw [ofJson_reaches_ofLimits, ofLimits_self]

theorem canonical_toJson (ceiling : ResourceCeiling) :
    Json.canonical ceiling.toJson = true := by
  obtain ⟨costMicros, depth, tokens, wallClockMs, _, _, _, _, declares⟩ := ceiling
  cases costMicros <;> cases depth <;> cases tokens <;> cases wallClockMs <;>
    simp_all [toJson, entries, limit, ResourceDimension.all, ResourceDimension.wire,
      Json.canonical, Json.canonicalEntries, List.filterMap] <;> decide

end ResourceCeiling

namespace SpawnAttenuation

/-- `toData`: `{ ceiling: null }` where the attenuation bounds nothing. -/
def toJson (attenuation : SpawnAttenuation) : Json.JsonValue :=
  .obj [("ceiling",
    match attenuation.ceiling with
    | none => .null
    | some ceiling => ceiling.toJson)]

def ofJson (value : Json.JsonValue) : Outcome SpawnAttenuation :=
  match Json.asObject value "Spawn attenuation" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries ["ceiling"] then
        match Json.field entries "ceiling" with
        | some .null => .ok ⟨none⟩
        | some present =>
            match ResourceCeiling.ofJson present "Resource ceiling" with
            | .error fault => .error fault
            | .ok ceiling => .ok ⟨some ceiling⟩
        | none => unshaped "Spawn attenuation"
      else unshaped "Spawn attenuation"

theorem ofJson_toJson (attenuation : SpawnAttenuation) :
    ofJson attenuation.toJson = .ok attenuation := by
  obtain ⟨ceiling⟩ := attenuation
  cases ceiling with
  | none => simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field,
      List.find?]
  | some present =>
      have decoded := ResourceCeiling.ofJson_toJson present "Resource ceiling"
      obtain ⟨pairs, encoded⟩ : ∃ pairs, present.toJson = .obj pairs := ⟨_, rfl⟩
      rw [encoded] at decoded
      simp [toJson, ofJson, Json.asObject, Json.exactFields, Json.keys, Json.field, List.find?,
        encoded, decoded]

theorem canonical_toJson (attenuation : SpawnAttenuation) :
    Json.canonical attenuation.toJson = true := by
  obtain ⟨ceiling⟩ := attenuation
  cases ceiling with
  | none => decide
  | some present =>
      have inner := ResourceCeiling.canonical_toJson present
      have ordered : Text.strictlyOrdered ["ceiling"] = true := by decide
      simp [toJson, Json.canonical, Json.canonicalEntries, inner, ordered]

end SpawnAttenuation

/-- `SpawnAttenuationCodec`. -/
def spawnAttenuationCodec : RecordCodec SpawnAttenuation where
  kind := "run.spawn-attenuation"
  version := ⟨1, 0⟩
  encodePayload := SpawnAttenuation.toJson
  decodePayload := SpawnAttenuation.ofJson
  roundTrip := SpawnAttenuation.ofJson_toJson
  canonicalPayload := SpawnAttenuation.canonical_toJson

end AgentCore.Kernel
