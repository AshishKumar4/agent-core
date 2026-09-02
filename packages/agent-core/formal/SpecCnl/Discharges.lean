import SpecCnl.Proofs
import SpecCnl.Proofs.Auth
import SpecCnl.Proofs.Commands
import SpecCnl.Proofs.FacetInstall
import SpecCnl.Proofs.Isolate
import SpecCnl.Proofs.Placement
import SpecCnl.Proofs.RunGraph

/-!
# Every discharge, assembled

The corpus is authored in groups, and each group's discharges live beside its bridges
under `SpecCnl/Proofs/`. This module imports every one of them, so the report elaborates
against an environment holding all four declarations of every unit. A group whose module
is not imported here is not audited, so a missing import is a missing unit rather than a
silently smaller ledger: `SpecCnl.Report` refuses when a registered declaration does not
exist.
-/
