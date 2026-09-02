import AgentCore.Kernel.Core
import AgentCore.Kernel.Facets.Tier
import AgentCore.Kernel.Definition.Placement
import AgentCore.Kernel.Runs.Lease
import AgentCore.Kernel.Runs.Turn
import AgentCore.Kernel.Runs.Pins
import AgentCore.Kernel.Runs.Commit
import AgentCore.Kernel.Runs.Admission
import AgentCore.Kernel.Runs.Ceiling
import AgentCore.Kernel.Runs.Acceptance
import AgentCore.Kernel.Runs.Source
import AgentCore.Kernel.Runs.Settlement
import AgentCore.Kernel.Runs.Spawn
import AgentCore.Kernel.Runs.TreeMerge
import AgentCore.Kernel.Runs.Lifecycle

/-!
# The executable Agent Core kernel

`AgentCore` is the abstract model: relations, `Prop`-valued admissibility, identifiers as
`Nat`. This library is the *executable* counterpart — the concrete records, state machines,
policies, and codecs the TypeScript runtime under `packages/agent-core/src` is being
replaced by — together with the refinement theorems that tie each executable definition to
the abstract one it implements.

Three rules hold throughout, and they are what make this a kernel rather than a second
model:

* **Total and pure.** Every definition is a total function. No `IO`, no `partial`, no
  `sorry`, no `axiom`, no `native_decide`. A failure is a value: `Outcome α`, carrying
  either a refusal with a stable `AgentCoreErrorCode` or a shape fault standing for the
  runtime's `TypeError`.
* **Illegal states are unrepresentable.** A record's constructor checks are `Prop` fields,
  so an inconsistent record does not typecheck and every transition has to re-establish
  them. Proof fields erase at extraction, so the TypeScript image is the plain data.
* **Assumptions are named premises.** Where the abstract model identifies things by `Nat`
  and the kernel by text, the abstraction `idOf : String → Nat` and its injectivity are
  explicit parameters of the refinement theorem. Nothing here introduces an axiom, and the
  axiom audit over this library is exactly `{propext, Classical.choice, Quot.sound}`.

A fourth rule governs where a decision lives. Some decisions are already stated once, in
`AgentCore.Extract` — the modules the TypeScript runtime's own value objects are lowered
from. The kernel *consumes* those rather than restating them: `Kernel.TurnStatus`'s four
transitions are `Extract.TurnStatus`'s table read through the refusal channel,
`Kernel.preferredPlacement` is `Extract.preferredPlacement` taken over `ModeSet.modes`, and
`Runs.TreeMerge` reads which side a merge records and whether a path is a conflict off
`Extract.TreeMergePolicy`. Where a decision has one Lean statement, this library points at
it.

Nothing in `AgentCore` imports this library, so no designated theorem of the model can
depend on an executable definition.
-/
