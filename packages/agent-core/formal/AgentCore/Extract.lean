import AgentCore.Extract.Placement
import AgentCore.Extract.TreeMerge
import AgentCore.Extract.TurnStatus

/-!
# The extraction plane

One module per generated TypeScript package, each the single source of truth for a decision
the runtime used to restate by hand. Every module here imports nothing but Lean core: the
TSLean compiler lowers an entry module's whole import closure, so a dependency on the
abstract model would drag constructs outside the admitted fragment into the lowering.

Nothing in `AgentCore` imports this root. The model's scope is abstract-model-only, so a
designated theorem may not come to rest on a definition whose reason to exist is that it
compiles; the dependency runs the other way, from executable core to model, when a model
module wants to reason about exactly the function that ships.

`packages/agent-core/artifacts/quality/tslean-packages.json` maps each module here to the
package its bytes live in, and `scripts/quality/tslean-consumer.mjs` holds those bytes to
this source.
-/
