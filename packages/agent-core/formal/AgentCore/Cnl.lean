import AgentCore.Cnl.Auth
import AgentCore.Cnl.Claims
import AgentCore.Cnl.Commands
import AgentCore.Cnl.FacetInstall
import AgentCore.Cnl.Isolate
import AgentCore.Cnl.Placement
import AgentCore.Cnl.Receipts
import AgentCore.Cnl.RunGraph
import AgentCore.Cnl.TrustRoute

/-!
# Theorems the controlled language needs, grouped by SPEC domain

Every module under `AgentCore/Cnl/` states and proves consequences **of the existing
model**: no definition here gains a premise, loses one, or changes shape, so nothing in
this directory can make an existing theorem easier or an existing step admissible where
it was not. Writing a controlled sentence for a rule unit regularly needs a consequence
the model implies but never spelled out; that consequence belongs here rather than in
`SpecCnl`, because a bridge may only relate a sentence to a statement about the model, and
`SpecCnl` is imported by nothing in `AgentCore`.

The directory is part of `AgentCore` proper — the public root imports it — so these
theorems are built, audited, and available to any later model work, not only to the
grammar that motivated them.
-/
