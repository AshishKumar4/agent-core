import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# RunSettle vocabulary (§5.2)

Two planes, because the §5.2 settlement rules straddle two of the model's state types.

* **The run graph.** Five `TR` entries over `AgentCore.GraphStore` and
  `AgentCore.GraphLabel` — obligation reservation, obligation completion, verdict
  recording, sibling cancellation, and terminalization — with one lifter each. Every
  registry label carries a `RunId` beside its payload, and the registry a condition has to
  read is that Run's, so the reservation and completion conditions are state-relative
  relations `RE[graph,run,obligation]` rather than conditions on the payload alone. The
  reservation postcondition is indexed by an `AgentCore.AdmissionReservation` and its
  lifter assembles one from the three components the `reserveObligation` label carries,
  which is the same projection the §9.2 materialization lifter performs on its payload.
  `for the terminalized run` is two entries with one surface: the `RE\ST` reading binds the
  Run and its terminalizing Turn for a precondition, and the `PX\PO` reading binds the Run
  alone for a postcondition that reads the successor state. Distinct categories, so the
  lexicon admits both and no sentence has two readings.
* **The composed state.** `AgentCore.Settled` and `AgentCore.AcceptanceSatisfied` are
  predicates over an `AgentCore.SystemState`, not transitions, so the settled-run and
  verdict-evidence rules are rendered with `every <CN> <VP>`. `settled system state` is a
  real predicate — some Run of the state is Settled — while `system state` is a
  type-as-common-noun entry, and its record says so.

Every denotation is a term over `AgentCore` alone.
-/

namespace SpecCnl.Entries.RunSettle

def entries : List LexEntry :=
  [ { id := "settle.every.obligation.reservation"
      surface := "every obligation reservation"
      category := "TR[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ run epoch obligation, " ++
        "label = AgentCore.GraphLabel.reserveObligation run epoch obligation) ∧ " ++
        "∃ effects events audit, " ++
        "AgentCore.GraphStep effects events audit before label after" },
    { id := "settle.every.obligation.completion"
      surface := "every obligation completion"
      category := "TR[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ run epoch obligation, " ++
        "label = AgentCore.GraphLabel.completeObligation run epoch obligation) ∧ " ++
        "∃ effects events audit, " ++
        "AgentCore.GraphStep effects events audit before label after" },
    { id := "settle.every.verdict.recording"
      surface := "every verdict recording"
      category := "TR[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ run verdict, " ++
        "label = AgentCore.GraphLabel.recordAcceptanceVerdict run verdict) ∧ " ++
        "∃ effects events audit, " ++
        "AgentCore.GraphStep effects events audit before label after" },
    { id := "settle.every.sibling.cancellation"
      surface := "every sibling cancellation"
      category := "TR[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ run terminalTurn sibling, " ++
        "label = AgentCore.GraphLabel.forceCancelSibling run terminalTurn sibling) ∧ " ++
        "∃ effects events audit, " ++
        "AgentCore.GraphStep effects events audit before label after" },
    { id := "settle.every.run.terminalization"
      surface := "every run terminalization"
      category := "TR[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ run turn id expected, " ++
        "label = AgentCore.GraphLabel.terminalize run turn id expected) ∧ " ++
        "∃ effects events audit, " ++
        "AgentCore.GraphStep effects events audit before label after" },
    { id := "settle.for.the.completed.obligation"
      surface := "for the completed obligation"
      category :=
        "RE[AgentCore.GraphStore,AgentCore.RunId,AgentCore.OpenObligation]" ++
        "\\ST[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun cond before label => ∀ run epoch obligation, " ++
        "label = AgentCore.GraphLabel.completeObligation run epoch obligation → " ++
        "cond before run obligation" },
    { id := "settle.a.reserved.obligation"
      surface := "a reserved obligation"
      category := "RE[AgentCore.GraphStore,AgentCore.RunId,AgentCore.OpenObligation]"
      denotation :=
        "fun before run obligation => ∃ registry, " ++
        "AgentCore.GraphStore.admissionRegistry before run = some registry ∧ " ++
        "obligation ∈ AgentCore.RunAdmissionRegistry.reserved registry" },
    { id := "settle.for.the.reserved.obligation"
      surface := "for the reserved obligation"
      category :=
        "PX[AgentCore.GraphStore,AgentCore.AdmissionReservation]" ++
        "\\PO[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun cond before label after => ∀ run epoch obligation, " ++
        "label = AgentCore.GraphLabel.reserveObligation run epoch obligation → " ++
        "cond before ⟨run, epoch, obligation⟩ after" },
    { id := "settle.a.valid.admission.reservation"
      surface := "a valid admission reservation"
      category := "PX[AgentCore.GraphStore,AgentCore.AdmissionReservation]"
      denotation :=
        "fun _ reservation after => " ++
        "AgentCore.AdmissionReservation.ValidIn reservation after" },
    { id := "settle.for.the.verdict"
      surface := "for the verdict"
      category :=
        "RE[AgentCore.GraphStore,AgentCore.AcceptanceId,AgentCore.AcceptanceVerdict]" ++
        "\\ST[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun cond before label => ∀ run verdict, " ++
        "label = AgentCore.GraphLabel.recordAcceptanceVerdict run verdict → " ++
        "cond before (AgentCore.AcceptanceVerdict.acceptance verdict) verdict" },
    { id := "settle.an.unrecorded.subject"
      surface := "an unrecorded subject"
      category :=
        "RE[AgentCore.GraphStore,AgentCore.AcceptanceId,AgentCore.AcceptanceVerdict]"
      denotation :=
        "fun before accId verdict => " ++
        "AgentCore.GraphStore.AcceptanceRetryAdmissible before accId " ++
        "(AgentCore.AcceptanceVerdict.subject verdict)" },
    { id := "settle.for.the.cancelled.sibling"
      surface := "for the cancelled sibling"
      category :=
        "PX[AgentCore.GraphStore,AgentCore.TurnId]" ++
        "\\PO[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun cond before label after => ∀ run terminalTurn sibling, " ++
        "label = AgentCore.GraphLabel.forceCancelSibling run terminalTurn sibling → " ++
        "cond before sibling after" },
    { id := "settle.a.fenced.cancelled.sibling"
      surface := "a fenced cancelled sibling"
      category := "PX[AgentCore.GraphStore,AgentCore.TurnId]"
      denotation :=
        "fun _ sibling after => ∃ cancelled evidence, " ++
        "AgentCore.GraphStore.turns after sibling = some cancelled ∧ " ++
        "AgentCore.Turn.status cancelled = AgentCore.TurnStatus.cancelled ∧ " ++
        "AgentCore.TurnLease.holder (AgentCore.Turn.lease cancelled) = none ∧ " ++
        "AgentCore.GraphStore.forcedCancellations after sibling = some evidence ∧ " ++
        "AgentCore.ForcedCancellation.turn evidence = sibling" },
    { id := "settle.for.the.terminalized.run"
      surface := "for the terminalized run"
      category :=
        "RE[AgentCore.GraphStore,AgentCore.RunId,AgentCore.TurnId]" ++
        "\\ST[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun cond before label => ∀ run turn id expected, " ++
        "label = AgentCore.GraphLabel.terminalize run turn id expected → " ++
        "cond before run turn" },
    { id := "settle.terminal.unheld.siblings"
      surface := "terminal unheld siblings"
      category := "RE[AgentCore.GraphStore,AgentCore.RunId,AgentCore.TurnId]"
      denotation := "AgentCore.SiblingTurnsTerminalAndUnheld" },
    { id := "settle.for.the.terminalized.run.post"
      surface := "for the terminalized run"
      category :=
        "PX[AgentCore.GraphStore,AgentCore.RunId]" ++
        "\\PO[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun cond before label after => ∀ run turn id expected, " ++
        "label = AgentCore.GraphLabel.terminalize run turn id expected → " ++
        "cond before run after" },
    { id := "settle.an.exact.closed.frontier"
      surface := "an exact closed frontier"
      category := "PX[AgentCore.GraphStore,AgentCore.RunId]"
      denotation :=
        "fun before run after => ∃ registry snapshot, " ++
        "AgentCore.GraphStore.admissionRegistry before run = some registry ∧ " ++
        "AgentCore.GraphStore.terminalSnapshots after run = some snapshot ∧ " ++
        "(∀ obligation, " ++
        "obligation ∈ AgentCore.TerminalSnapshot.obligations snapshot ↔ " ++
        "obligation ∈ AgentCore.RunAdmissionRegistry.reserved registry ∧ " ++
        "obligation ∉ AgentCore.RunAdmissionRegistry.completed registry) ∧ " ++
        "AgentCore.TerminalSnapshot.registryEpoch snapshot = " ++
        "AgentCore.RunAdmissionRegistry.epoch registry ∧ " ++
        "∃ closed, " ++
        "AgentCore.GraphStore.admissionRegistry after run = some closed ∧ " ++
        "AgentCore.RunAdmissionRegistry.accepting closed = false ∧ " ++
        "AgentCore.RunAdmissionRegistry.epoch closed = " ++
        "AgentCore.RunAdmissionRegistry.epoch registry + 1" },
    { id := "settle.system.state"
      surface := "system state"
      category := "CN[AgentCore.SystemState]"
      denotation := "fun _ => True"
      caveats := [.typeAsCommonNoun] },
    { id := "settle.refuses.acceptance.without.a.head.verdict"
      surface := "refuses acceptance without a head verdict"
      category := "NP[AgentCore.SystemState]\\S"
      denotation :=
        "fun state => ∀ run accId subject, " ++
        "AgentCore.GraphStore.HeadTree (AgentCore.SystemState.graph state) run subject → " ++
        "(∀ verdict, verdict ∈ AgentCore.GraphStore.acceptanceVerdicts " ++
        "(AgentCore.SystemState.graph state) accId → " ++
        "AgentCore.AcceptanceVerdict.acceptance verdict = accId → " ++
        "AgentCore.AcceptanceVerdict.subject verdict ≠ subject) → " ++
        "¬ AgentCore.AcceptanceSatisfied (AgentCore.SystemState.graph state) " ++
        "(AgentCore.SystemState.effects state) run accId" },
    { id := "settle.settled.system.state"
      surface := "settled system state"
      category := "CN[AgentCore.SystemState]"
      denotation := "fun state => ∃ run, AgentCore.Settled state run" },
    { id := "settle.captures.a.coherent.terminal.snapshot"
      surface := "captures a coherent terminal snapshot"
      category := "NP[AgentCore.SystemState]\\S"
      denotation :=
        "fun state => ∀ run, AgentCore.Settled state run → ∃ snapshot, " ++
        "AgentCore.GraphStore.terminalSnapshots (AgentCore.SystemState.graph state) run = " ++
        "some snapshot ∧ AgentCore.TerminalSnapshot.run snapshot = run ∧ " ++
        "AgentCore.TerminalSnapshotCoherent (AgentCore.SystemState.graph state) snapshot" },
    { id := "settle.discharges.its.captured.obligations"
      surface := "discharges its captured obligations"
      category := "NP[AgentCore.SystemState]\\S"
      denotation :=
        "fun state => ∀ run, AgentCore.Settled state run → ∀ snapshot, " ++
        "AgentCore.GraphStore.terminalSnapshots (AgentCore.SystemState.graph state) run = " ++
        "some snapshot → ∀ obligation, " ++
        "obligation ∈ AgentCore.TerminalSnapshot.obligations snapshot → " ++
        "AgentCore.ObligationDischarged state run obligation" } ]

end SpecCnl.Entries.RunSettle
