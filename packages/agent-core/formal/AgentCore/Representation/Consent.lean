import AgentCore.Scopes

/-!
# Representing a device-consent gate (the cloud↔device tunnel shape)

A durable cloud agent can reach a user's real machine over a reverse tunnel. Before it
runs anything there, the platform requires *consent*, granted per (agent, device) pair
and revocable. The promises are

1. **consent-before-effect** — a device command executes only if a live consent record
   exists for that exact (agent, device) pair; and
2. **revocable, bounded-window** — revoking consent bumps an epoch, and a command
   carrying a stale consent stamp is refused. This is the device reading of the
   bounded-window revocation rule (SPEC §3.4 rule 5), so device consent is not a
   separate authority system — it is the scope-epoch mechanism applied to a
   transport-attached grant.

The gate is fail-closed: absence of consent denies.
-/

namespace AgentCore.Representation.Consent

structure AgentId where value : Nat deriving DecidableEq, Repr
structure DeviceId where value : Nat deriving DecidableEq, Repr

/-- A (agent, device) pair — the granularity at which consent is held. -/
structure Pair where
  agent : AgentId
  device : DeviceId
  deriving DecidableEq, Repr

/-- The consent ledger: which pairs currently hold consent, and the per-pair epoch that
    a resolved consent stamp is checked against. -/
structure ConsentState where
  granted : Pair → Prop
  epoch : Pair → Nat

/-- A resolved consent stamp carried by an in-flight device command: the pair it was
    resolved for and the epoch at resolution (SPEC §3.4: every resolution is stamped). -/
structure ConsentStamp where
  pair : Pair
  epoch : Nat
  deriving DecidableEq, Repr

/-- Consent is *live* for a stamp when the pair is granted and the stamp's epoch is
    current. A device command may execute only under a live stamp. -/
def Live (state : ConsentState) (stamp : ConsentStamp) : Prop :=
  state.granted stamp.pair ∧ stamp.epoch = state.epoch stamp.pair

/-- Grant consent for a pair (the user taps "allow" on the consent card). -/
def grant (state : ConsentState) (pair : Pair) : ConsentState :=
  { state with granted := fun candidate => candidate = pair ∨ state.granted candidate }

/-- Revoke consent for a pair: drop the grant and bump its epoch, so every stamp
    resolved before now is stale (SPEC §3.4 rule 5). -/
def revoke (state : ConsentState) (pair : Pair) : ConsentState :=
  { granted := fun candidate => candidate ≠ pair ∧ state.granted candidate
    epoch := fun candidate => if candidate = pair then state.epoch candidate + 1 else state.epoch candidate }

/-- **Fail-closed.** With no grant for a pair, no stamp for that pair is live — a
    device command cannot execute. -/
theorem no_grant_denies {state : ConsentState} {stamp : ConsentStamp}
    (ungranted : ¬ state.granted stamp.pair) :
    ¬ Live state stamp :=
  fun live => ungranted live.1

/-- **Revocation blocks a previously-live stamp.** After revoking the stamp's pair, the
    stamp is no longer live — the command it authorizes is refused. This is the
    consent-gate instance of bounded-window revocation. -/
theorem revoke_blocks {state : ConsentState} {stamp : ConsentStamp} :
    ¬ Live (revoke state stamp.pair) stamp :=
  fun live => live.1.1 rfl

/-- Granting an unrelated pair does not make a stale stamp live: consent is per-pair,
    so one device's consent never leaks to another. -/
theorem grant_is_per_pair {state : ConsentState} {stamp : ConsentStamp} {other : Pair}
    (different : other ≠ stamp.pair)
    (notLive : ¬ Live state stamp) :
    ¬ Live (grant state other) stamp := by
  intro live
  apply notLive
  refine ⟨?_, live.2⟩
  rcases live.1 with eq | original
  · exact absurd eq.symm different
  · exact original

/-- A device command paired with its resolved consent stamp. It may take effect only
    when the stamp is live. -/
structure DeviceCommand where
  stamp : ConsentStamp
  deriving DecidableEq, Repr

/-- The execution gate: `Executes` holds exactly when the command's stamp is live.
    There is no other way to run a device command — the definition *is* the gate. -/
def Executes (state : ConsentState) (command : DeviceCommand) : Prop :=
  Live state command.stamp

/-- **Consent-before-effect.** A device command that executes had live consent for its
    exact pair at execution time. -/
theorem execute_requires_live_consent {state : ConsentState} {command : DeviceCommand}
    (executes : Executes state command) :
    state.granted command.stamp.pair ∧ command.stamp.epoch = state.epoch command.stamp.pair :=
  executes

end AgentCore.Representation.Consent
