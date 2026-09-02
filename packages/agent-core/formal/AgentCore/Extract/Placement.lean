/-
Agent Core SPEC §9.2: placement by admissible-set intersection and one preference order.

One Lean module lowers to one TypeScript file. This module owns the placement *decision* —
the `IsolationMode` vocabulary, the four-source intersection, and which member of that
intersection is served — for `packages/agent-core/src/facets/manifest.ts` and every caller
that used to restate it: `preferredPlacement` in `src/definition/placement.ts`,
`choosePlacement` in `src/definition/plan.ts`, and the `canonicalModes` helpers in
`src/agents/runs/placement.ts` and `src/invocations/operation-pin.ts`.

What stays in TypeScript is the vocabulary *listing*: `PLACEMENT_PREFERENCE` is the array
the decoders validate against and the canonical order they sort into. The order it spells
and the order `PlacementIntersection.preferred` walks are the same order stated twice, once
per language, because the lowering admits list consumption and not list construction — so
the two are bound by an exhaustive contract test over every admissible-set combination
rather than by a comment.

`IsolationMode` deliberately carries no dot-notation method: it is decided by the
intersection, never by itself, and an inductive that owns behaviour lowers to a value
object whose matches must all dispatch on itself.
-/

namespace AgentCore.Extract

/--
Where a Package's code runs (SPEC §1.5, §9.2). The three modes are the whole vocabulary;
the order they are declared in is the preference order `preferred` walks.
-/
inductive IsolationMode where
  | dynamic
  | provider
  | bundled
  deriving DecidableEq, Repr

/-- Whether this mode is `dynamic`. -/
def isDynamicMode (mode : IsolationMode) : Bool :=
  match mode with
  | .dynamic => true
  | .provider => false
  | .bundled => false

/-- Whether this mode is `provider`. -/
def isProviderMode (mode : IsolationMode) : Bool :=
  match mode with
  | .dynamic => false
  | .provider => true
  | .bundled => false

/-- Whether this mode is `bundled`. -/
def isBundledMode (mode : IsolationMode) : Bool :=
  match mode with
  | .dynamic => false
  | .provider => false
  | .bundled => true

/--
The modes admitted by all four independently derived sets (SPEC §9.2): what the Facet's
manifest declares, what the Blueprint's policy allows, what the substrate profile offers,
and what the trust policy admits for the Package. Carrying the intersection as its own
value is what keeps "admissible" and "preferred" separate: the intersection is derived
once, and the preference order is applied to it once.
-/
structure PlacementIntersection where
  dynamic : Bool
  provider : Bool
  bundled : Bool
  deriving DecidableEq, Repr

/-- Whether the intersection admits this mode. -/
def PlacementIntersection.admits (intersection : PlacementIntersection)
    (mode : IsolationMode) : Bool :=
  match mode with
  | .dynamic => intersection.dynamic
  | .provider => intersection.provider
  | .bundled => intersection.bundled

/-- Whether the intersection admits no mode at all, which SPEC §9.2 rejects rather than guesses. -/
def PlacementIntersection.empty (intersection : PlacementIntersection) : Bool :=
  !intersection.dynamic && !intersection.provider && !intersection.bundled

/--
The mode served, as SPEC §9.2's one fixed preference order decides it: the first member of
the intersection in the order `dynamic`, `provider`, `bundled`. There is no second ordering
and no fallback for an empty intersection — that case has no answer, and the caller rejects.
-/
def PlacementIntersection.preferred (intersection : PlacementIntersection) :
    Option IsolationMode :=
  if intersection.dynamic then some .dynamic
  else if intersection.provider then some .provider
  else if intersection.bundled then some .bundled
  else none

/--
Whether a source's admissible-mode set contains this mode. A source arrives as the list of
modes it admits, which is how every caller already holds it, and membership is decided per
mode so the answer never depends on the order a source happened to list its modes in.
-/
def admitsMode (modes : List IsolationMode) (mode : IsolationMode) : Bool :=
  match mode with
  | .dynamic => modes.any isDynamicMode
  | .provider => modes.any isProviderMode
  | .bundled => modes.any isBundledMode

/-- The intersection of the four independently derived admissible-mode sets (SPEC §9.2). -/
def placementIntersection (manifest policy substrate trust : List IsolationMode) :
    PlacementIntersection :=
  { dynamic :=
      admitsMode manifest .dynamic && admitsMode policy .dynamic &&
        admitsMode substrate .dynamic && admitsMode trust .dynamic
    provider :=
      admitsMode manifest .provider && admitsMode policy .provider &&
        admitsMode substrate .provider && admitsMode trust .provider
    bundled :=
      admitsMode manifest .bundled && admitsMode policy .bundled &&
        admitsMode substrate .bundled && admitsMode trust .bundled }

/--
SPEC §9.2's placement decision end to end: intersect the four admissible-mode sets, then
serve the first member of the intersection in the fixed preference order.
-/
def preferredPlacement (manifest policy substrate trust : List IsolationMode) :
    Option IsolationMode :=
  (placementIntersection manifest policy substrate trust).preferred

/-- A served mode is one the intersection admits: the decision never invents a mode. -/
theorem preferred_admits {intersection : PlacementIntersection} {mode : IsolationMode}
    (served : intersection.preferred = some mode) : intersection.admits mode = true := by
  unfold PlacementIntersection.preferred at served
  split at served
  · next dynamic => cases served; simpa [PlacementIntersection.admits] using dynamic
  · split at served
    · next provider => cases served; simpa [PlacementIntersection.admits] using provider
    · split at served
      · next bundled => cases served; simpa [PlacementIntersection.admits] using bundled
      · exact absurd served (by simp)

/-- Exactly the empty intersection has nothing to serve (SPEC §9.2's rejected case). -/
theorem preferred_eq_none_iff_empty {intersection : PlacementIntersection} :
    intersection.preferred = none ↔ intersection.empty = true := by
  unfold PlacementIntersection.preferred PlacementIntersection.empty
  cases intersection.dynamic <;> cases intersection.provider <;> cases intersection.bundled <;>
    simp

/-- Intersection is exactly membership in all four sources, for every mode (SPEC §9.2). -/
theorem intersection_admits_iff {manifest policy substrate trust : List IsolationMode}
    {mode : IsolationMode} :
    (placementIntersection manifest policy substrate trust).admits mode =
      (admitsMode manifest mode && admitsMode policy mode && admitsMode substrate mode &&
        admitsMode trust mode) := by
  cases mode <;> simp [placementIntersection, PlacementIntersection.admits, admitsMode]

/-- A served mode is admitted by every one of the four sources: the SPEC §9.2 rule, end to end. -/
theorem preferred_placement_admitted {manifest policy substrate trust : List IsolationMode}
    {mode : IsolationMode} (served : preferredPlacement manifest policy substrate trust = some mode) :
    admitsMode manifest mode = true ∧ admitsMode policy mode = true ∧
      admitsMode substrate mode = true ∧ admitsMode trust mode = true := by
  have admitted := preferred_admits served
  rw [intersection_admits_iff] at admitted
  simpa [Bool.and_eq_true, and_assoc] using admitted

end AgentCore.Extract
