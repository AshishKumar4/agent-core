import AgentCore.RunGraph

/-!
# Consequences of the existing Turn-lifecycle model the controlled language needs (§5.6)

Two consequences of `AgentCore.RunGraph` as it stands, both about what the closed set of
graph transitions cannot do to a Turn.

`AgentCore.GraphLabel` is a closed inductive and `AgentCore.GraphStep` is the whole
normative transition relation over `AgentCore.GraphStore`. Five of its labels write the
`turns` table — `startTurn`, `claimTurn`, `suspendTurn`, `resumeTurn`,
`forceCancelSibling`, `terminalize` — and every one of them demands a *live* status of the
record it rewrites: `queued` for a claim, `running` for a suspend or a terminalization,
`suspended` for a resume, and one of the three live statuses for a forced cancellation.
`startTurn` demands the key be free. The first theorem below is the fixpoint of that
observation: a Turn recorded with a terminal status stays recorded and stays terminal
under every label, so no admitted transition resurrects one.

Note that this is a property of `GraphStep` and **not** of `LeaseStep`. The lease relation
on its own admits `claim` and `resume` after a `terminalFence`, because the fence clears
the holder and an unheld lease is exactly what those two labels require. What forbids
resurrection is the Turn-status premise the graph step carries, which is why the theorem
is stated over `GraphStore`.

The second theorem is the authority half: a Turn the graph starts holds
`TurnLease.initial`, whose holder is `none`, so `TurnLease.Admits` refuses every token at
every time. Nothing an earlier Turn held is admitted by a newly started one.

No definition is introduced or changed here. Both proofs read `GraphStep`,
`TurnLease.Admits`, `TurnLease.initial`, and `tableSet` exactly as they already stand.
-/

namespace AgentCore

/-- **No graph transition resurrects a terminal Turn.** A Turn the store records with a
terminal status — `succeeded`, `failed`, or `cancelled` — is still recorded after any
`GraphStep`, and still terminal. The three lifecycle labels that could move a Turn back to
a live status each demand a live status of the record they rewrite (`queued` for
`claimTurn`, `running` for `suspendTurn`, `suspended` for `resumeTurn`), `startTurn`
demands its key be free, and the two fences write terminal statuses, so the terminal
statuses are absorbing under the whole closed label set. -/
theorem graph_step_preserves_terminal_turns
    {effects : EffectLedger} {events : EventStore} {auditLog : AuditLog}
    {before after : GraphStore} {label : GraphLabel} {key : TurnId} {record : Turn}
    (step : GraphStep effects events auditLog before label after)
    (recorded : before.turns key = some record)
    (terminal : record.status = .succeeded ∨ record.status = .failed ∨
      record.status = .cancelled) :
    ∃ later, after.turns key = some later ∧
      (later.status = .succeeded ∨ later.status = .failed ∨ later.status = .cancelled) := by
  cases label with
  | startRun _ _ => cases step with | startRun => exact ⟨record, recorded, terminal⟩
  | startTurn started =>
      cases step with
      | startTurn fresh _ _ _ _ _ _ _ _ =>
          refine ⟨record, ?_, terminal⟩
          have different : key ≠ started := by
            intro same
            subst same
            simp_all
          simpa [tableSet, different] using recorded
  | claimTurn claimed =>
      cases step with
      | claimTurn lookup queued _ =>
          refine ⟨record, ?_, terminal⟩
          have different : key ≠ claimed := by
            intro same
            subst same
            simp_all
          simpa [tableSet, different] using recorded
  | suspendTurn suspended =>
      cases step with
      | suspendTurn lookup running _ =>
          refine ⟨record, ?_, terminal⟩
          have different : key ≠ suspended := by
            intro same
            subst same
            simp_all
          simpa [tableSet, different] using recorded
  | resumeTurn resumed =>
      cases step with
      | resumeTurn lookup held _ _ =>
          refine ⟨record, ?_, terminal⟩
          have different : key ≠ resumed := by
            intro same
            subst same
            simp_all
          simpa [tableSet, different] using recorded
  | spawnChild _ _ _ => cases step with | spawnChild => exact ⟨record, recorded, terminal⟩
  | append _ _ _ => cases step with | append => exact ⟨record, recorded, terminal⟩
  | migrate _ _ _ _ => cases step with | migrate => exact ⟨record, recorded, terminal⟩
  | reserveObligation _ _ _ =>
      cases step with | reserveObligation => exact ⟨record, recorded, terminal⟩
  | completeObligation _ _ _ =>
      cases step with | completeObligation => exact ⟨record, recorded, terminal⟩
  | recordAcceptanceVerdict _ _ =>
      cases step with | recordAcceptanceVerdict => exact ⟨record, recorded, terminal⟩
  | beginTerminalization _ _ _ =>
      cases step with | beginTerminalization => exact ⟨record, recorded, terminal⟩
  | forceCancelSibling _ _ sibling =>
      cases step with
      | forceCancelSibling _ _ _ _ _ _ _ _ lookup _ live _ _ _ _ _ =>
          refine ⟨record, ?_, terminal⟩
          have different : key ≠ sibling := by
            intro same
            subst same
            rcases live with status | status | status <;> simp_all
          simpa [tableSet, different] using recorded
  | terminalize _ fenced _ _ =>
      cases step with
      | terminalize _ _ lookup _ running _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ =>
          refine ⟨record, ?_, terminal⟩
          have different : key ≠ fenced := by
            intro same
            subst same
            simp_all
          simpa [tableSet, different] using recorded

/-- **A started Turn inherits no authority.** The lease a `startTurn` records is
`TurnLease.initial` for exactly that Turn: no holder and epoch zero. `TurnLease.Admits`
demands the lease name the token's holder, so a freshly started Turn admits no token at
all — not one an earlier Turn held, and not one minted against any epoch. -/
theorem turn_start_lease_is_initial_and_admits_nothing
    {effects : EffectLedger} {events : EventStore} {auditLog : AuditLog}
    {before after : GraphStore} {started : TurnId}
    (step : GraphStep effects events auditLog before (.startTurn started) after) :
    ∃ record, after.turns started = some record ∧
      record.lease = TurnLease.initial started ∧
      ∀ (token : LeaseToken) (now : Time), ¬ record.lease.Admits token now := by
  cases step with
  | startTurn _ _ _ _ _ _ _ _ leaseInitial =>
      refine ⟨_, tableSet_self .., leaseInitial, ?_⟩
      intro _ _ admitted
      rw [leaseInitial] at admitted
      simp [TurnLease.Admits, TurnLease.initial] at admitted

end AgentCore
