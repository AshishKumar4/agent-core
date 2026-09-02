import Lake
open Lake DSL

package «agent-core-formal» where

lean_lib AgentCore where
  roots := #[`AgentCore]

/-- The controlled-language instrument. It imports `AgentCore` and is imported by
nothing in it, so no designated theorem, witness, or semantic definition of the model
can depend on the grammar. -/
lean_lib SpecCnl where
  roots := #[`SpecCnl]

/-- The runtime premise plane: hardware, platform, external-service, and engine premises,
the faults that refute them, monitor evidence bound to model/adapter/runtime/window, and
what remains proved after one fails. Same altitude as `SpecCnl` and for the same reason —
it imports `AgentCore` and is imported by nothing in it, so no platform observation can
become a dependency of a designated theorem. -/
lean_lib RuntimeAssurance where
  roots := #[`RuntimeAssurance]

/-- The extraction plane: the executable cores TSLean lowers into `src/**/generated/**`.
It imports nothing — not even `AgentCore` — because the compiler lowers an entry module's
whole import closure, and everything outside the admitted fragment would have to be lowered
too. It is imported by nothing in the model for the reason `SpecCnl` is: `formalScope` is
`abstract-model-only`, so no designated theorem may come to rest on a definition that exists
to be compiled. Kernel-checked here (`lake build Extract`) and again at every generation,
whose manifest records the olean digest it read. -/
lean_lib Extract where
  roots := #[`AgentCore.Extract]

lean_exe oracle where
  root := `Oracle.Main

/-- The executable kernel: the concrete records, state machines, policies, and codecs the
TypeScript runtime is being replaced by. It imports the abstract model to state its
refinement theorems against it, and nothing in `AgentCore` imports it, so no designated
theorem of the model can depend on an executable definition. -/
lean_lib «AgentCore.Kernel» where
  roots := #[`AgentCore.Kernel]
