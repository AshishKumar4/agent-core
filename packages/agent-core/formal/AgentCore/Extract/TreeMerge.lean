/-
Agent Core SPEC §5.2.1: how a merge resolves the tree its two parents share.

One Lean module lowers to one TypeScript file. This module owns the two facts a merge reads
off its Blueprint's declared policy — which side a wholesale resolution records, and whether
a path both branches changed is a conflict the operator resolves explicitly — which
`packages/agent-core/src/definition/policy.ts` used to spread across two subclasses of a
handwritten `TreeMergePolicy`. The lowering emits that same shape: an abstract base with a
singleton per case, which is the idiom the case behaviour belongs in.

Absence is not a fourth setting. A Blueprint that declares nothing declares a platform whose
branches own disjoint Environments, and a merge that would need a side is rejected rather
than guessed (C13-RUN-TREE-CONFLICT-EXPLICIT). That rejection is the host's, so it is not
modelled here; what is modelled is that exactly `perPath` surfaces conflicts and exactly the
two wholesale policies name a side.
-/

namespace AgentCore.Extract

/-- The side of a merge a wholesale resolution takes the tree from (SPEC §5.2.1). -/
inductive TreeMergeSide where
  | ours
  | theirs
  deriving DecidableEq, Repr

/--
How a merge resolves the tree its two parents share (SPEC §5.2.1): take one side's tree
wholesale, or take per path the side that changed it relative to the common ancestor.
-/
inductive TreeMergePolicy where
  | ours
  | theirs
  | perPath
  deriving DecidableEq, Repr

/--
The side a wholesale resolution records, and nothing when resolution is per path. A per-path
merge has no single side to record, which is exactly why it is the policy that can surface
a conflict.
-/
def TreeMergePolicy.side (policy : TreeMergePolicy) : Option TreeMergeSide :=
  match policy with
  | .ours => some .ours
  | .theirs => some .theirs
  | .perPath => none

/--
Whether a path both sides changed is a conflict the operator resolves explicitly. A
wholesale policy has already answered every path by naming a side; only a per-path merge
can reach a path whose answer it does not have.
-/
def TreeMergePolicy.surfacesConflicts (policy : TreeMergePolicy) : Bool :=
  match policy with
  | .ours => false
  | .theirs => false
  | .perPath => true

/-- A policy surfaces conflicts exactly when it records no side: the two facts are one fact. -/
theorem surfaces_conflicts_iff_no_side {policy : TreeMergePolicy} :
    policy.surfacesConflicts = true ↔ policy.side = none := by
  cases policy <;> simp [TreeMergePolicy.surfacesConflicts, TreeMergePolicy.side]

end AgentCore.Extract
