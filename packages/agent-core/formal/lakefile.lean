import Lake
open Lake DSL

package «agent-core-formal» where

lean_lib AgentCore where
  roots := #[`AgentCore]

lean_exe oracle where
  root := `Oracle.Main
