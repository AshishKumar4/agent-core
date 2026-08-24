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

lean_exe oracle where
  root := `Oracle.Main
