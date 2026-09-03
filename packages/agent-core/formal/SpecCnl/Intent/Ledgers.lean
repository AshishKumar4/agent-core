import SpecCnl.Intent.Grammar

/-!
# The ledger table

The intent language introduces no model constant. What it introduces is this table: a
reviewed list naming, per ledger, the state and label types, the designated step relation,
the executable mirror and its soundness and completeness theorems, the initial-state
predicate where one exists, and the finite window the untrusted search enumerates.

Every name here is text, because a ratification pin has to record names a reviewer can
diff. Text alone would let a rename leave a row naming a declaration that no longer exists,
so the last section of this file uses each name at the type the row claims for it. A rename,
a signature change, or a weakened theorem is a Lean error here rather than a stale string in
an artifact.

Stage 1 registers one row. A second ledger is a second row plus its own candidate generator
in `SpecCnl.Intent.Check`; nothing else in the instrument is per-ledger.
-/

namespace SpecCnl.Intent

/-- One enumeration bound of a ledger's search window. The window is pinned because a
bounded no-witness report means nothing without the bounds it explored. -/
structure Bound where
  field : String
  low : Nat
  high : Nat
  deriving Repr, Inhabited

/-- One registered ledger. -/
structure Ledger where
  /-- Stable key. A record names its ledger by this. -/
  key : String
  state : String
  label : String
  /-- The designated step relation: the upper bound a platform may not exceed. -/
  step : String
  /-- The computable mirror the search uses to compute a successor state. -/
  exec : String
  soundness : String
  completeness : String
  initial : Option String
  /-- How the search enumerates its window. Pinned, because which instance the search calls
  smallest depends on it. -/
  order : String
  bounds : List Bound
  deriving Repr, Inhabited

/-- Every declaration a row names, in report order. The gate resolves each one. -/
def Ledger.boundNames (ledger : Ledger) : List String :=
  [ledger.state, ledger.label, ledger.step, ledger.exec, ledger.soundness,
    ledger.completeness] ++ ledger.initial.toList

/-! ## The Turn-lease window

The one place the search's numbers live: `bounds` renders them for the pin and
`SpecCnl.Intent.Check` generates candidates from them, so a pinned bound and an explored
bound cannot differ.

The window is narrower than the differential suite's generator window
(`test/differential/lease.differential.test.ts`), which draws 300 random samples rather than
enumerating. Exhaustive enumeration of that window is millions of candidates; this one is
52032, which every stage-1 question needs less than a second to scan. Nothing rests on the
width: a bounded no-witness report is never a verdict here, only a proposal that a named
kernel refutation then has to close. -/

structure LeaseWindow where
  turns : Nat
  principals : Nat
  epochs : Nat
  expiries : Nat
  times : Nat
  deriving Repr, Inhabited

def leaseWindow : LeaseWindow :=
  { turns := 2, principals := 2, epochs := 1, expiries := 4, times := 4 }

def LeaseWindow.bounds (window : LeaseWindow) : List Bound :=
  [ { field := "lease.turn.value", low := 0, high := window.turns },
    { field := "lease.holder.id.value", low := 0, high := window.principals },
    { field := "lease.epoch", low := 0, high := window.epochs },
    { field := "lease.expiresAt.tick", low := 1, high := window.expiries },
    { field := "label.holder.id.value", low := 0, high := window.principals },
    { field := "label.now.tick", low := 0, high := window.times },
    { field := "label.expiresAt.tick", low := 1, high := window.expiries },
    { field := "label.token.turn.value", low := 0, high := window.turns },
    { field := "label.token.epoch", low := 0, high := window.epochs } ]

def leaseLedger : Ledger :=
  { key := "AgentCore.TurnLease"
    state := "AgentCore.TurnLease"
    label := "AgentCore.LeaseLabel"
    step := "AgentCore.LeaseStep"
    exec := "AgentCore.leaseStepExec"
    soundness := "AgentCore.leaseStepExec_sound"
    completeness := "AgentCore.leaseStepExec_complete"
    initial := some "AgentCore.TurnLease.initial"
    order :=
      "lexicographic in the bounds listed, smallest first; lease.holder ranges over none \
       and then each principal; label constructors in declaration order (claim, renew, \
       reclaim, suspendFence, resume, terminalFence); every tenant is 0"
    bounds := leaseWindow.bounds }

/-- Every registered ledger. A row is appended here and nowhere else. -/
def ledgers : List Ledger := [leaseLedger]

/-- The ledger with this key, if any. -/
def ledgerWithKey? (key : String) : Option Ledger :=
  ledgers.find? (fun ledger => ledger.key == key)

/-! ## The lease row's binding, kernel-checked -/

private def leaseStepBinding : Lts AgentCore.TurnLease AgentCore.LeaseLabel :=
  AgentCore.LeaseStep

private def leaseExecBinding :
    AgentCore.TurnLease → AgentCore.LeaseLabel → Option AgentCore.TurnLease :=
  AgentCore.leaseStepExec

private def leaseInitialBinding : AgentCore.TurnId → AgentCore.TurnLease :=
  AgentCore.TurnLease.initial

private theorem leaseSoundnessBinding (lease after : AgentCore.TurnLease)
    (label : AgentCore.LeaseLabel)
    (executed : AgentCore.leaseStepExec lease label = some after) :
    AgentCore.LeaseStep lease label after :=
  AgentCore.leaseStepExec_sound executed

private theorem leaseCompletenessBinding (lease after : AgentCore.TurnLease)
    (label : AgentCore.LeaseLabel) (step : AgentCore.LeaseStep lease label after) :
    AgentCore.leaseStepExec lease label = some after :=
  AgentCore.leaseStepExec_complete step

end SpecCnl.Intent
