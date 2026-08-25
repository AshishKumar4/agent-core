import SpecCnl.Proofs

/-!
# The finding, and why it stays kernel-checked after the fix

`C13-AUTH-GUEST-VERIFICATION` (SPEC §3.3) fixes a *before-materialization* ordering: "the
host verifies provenance **before** materializing any guest Grant", and "this document
fixes … the before-materialization ordering."

Writing the controlled sentence found that the model did not require it. At the time
`AgentCore.MaterializationStep` carried exactly one premise, `membership.role = role.id`,
and verification gated `AuthorityLedger.ActsUnder` instead — at authorization time, after
the Grant already existed. The divergence was **proved**, not reported as a failed
tactic.

The model has since been strengthened: `MaterializationStep.rematerialize` now also
requires `ledger.SubjectVerified membership.subject`, and
`AgentCore.materialization_requires_verified_guest` is the theorem that closes it. So
`SpecCnl.Proofs.proved_C13_AUTH_GUEST_VERIFICATION` discharges the hand proposition and
the bridge is green.

That is exactly when a finding is usually deleted, and deleting it would throw away the
only mechanical evidence that the new premise does any work. The counterexample is
therefore kept and re-aimed at the definition it actually refutes:

1. `preFixOrderingHolds` is the ordering property stated over `PreFixMaterializationStep`,
   a **local reconstruction** of the pre-fix relation. It is not model content, nothing in
   `AgentCore` depends on it, and it exists only to carry the counterexample.
2. `prefix_guest_verification_diverges` proves that property false, with the same concrete
   unverified foreign `Membership` as the original finding.
3. `current_step_is_prefix_step` proves the fix was a strengthening rather than a rewrite:
   every current step is still a pre-fix step.
4. `fix_is_strict` proves the strengthening is strict: the pre-fix relation admits a step
   the current relation refuses.

Together, 2 and 4 make the `SubjectVerified` premise a *discriminating witness*. Remove
it and 4 stops holding while 2 still does, so the finding turns back into a live
divergence instead of quietly disappearing.

Read the original finding precisely: it was a **gap in the model**, not a contradiction
with the SPEC. The old model did not forbid verifying first; it failed to require it. The
value was that the gap was located mechanically, at a named premise, instead of a human
reading both artifacts and nodding.
-/

namespace SpecCnl.Divergence

open AgentCore

/-- The pre-fix relation, reconstructed locally. One premise, no verification, exactly as
`AgentCore.MaterializationStep` read before the fix. Nothing in `AgentCore` refers to
this; it carries a counterexample and nothing else. -/
inductive PreFixMaterializationStep :
    AuthorityLedger → Membership → Role → AuthorityLedger → Prop
  | rematerialize {ledger membership role} :
      membership.role = role.id →
      PreFixMaterializationStep ledger membership role
        (materializeRole (ledger.bumpScope membership.scope) membership role)

/-- The SPEC's before-materialization ordering, stated over the pre-fix relation. -/
def preFixOrderingHolds : Prop :=
  ∀ (before : AuthorityLedger) (membership : Membership) (after : AuthorityLedger),
    (∃ role, PreFixMaterializationStep before membership role after) →
      ∀ home principal scheme, membership.subject = Subject.foreign home principal scheme →
        before.foreignVerified home principal

private def unverifiedLedger : AuthorityLedger := default

private def guestRole : Role := ⟨⟨1⟩, []⟩

private def guestMembership : Membership :=
  ⟨⟨1⟩, Subject.foreign ⟨7⟩ ⟨9⟩ .token, .tenant ⟨7⟩, ⟨1⟩⟩

/-- `default` leaves nothing verified. -/
private theorem nothing_verified : ¬ unverifiedLedger.foreignVerified ⟨7⟩ ⟨9⟩ := id

private def materializedLedger : AuthorityLedger :=
  materializeRole (unverifiedLedger.bumpScope guestMembership.scope) guestMembership guestRole

/-- The pre-fix relation admits a guest materialization with no prior verification. -/
private theorem prefix_admits_unverified_guest :
    PreFixMaterializationStep unverifiedLedger guestMembership guestRole materializedLedger :=
  .rematerialize rfl

/-- The original finding. The before-materialization ordering is not a theorem of the
pre-fix relation, and this is a proof rather than an unfinished tactic block. -/
theorem prefix_guest_verification_diverges : ¬ preFixOrderingHolds := by
  intro claim
  exact nothing_verified
    (claim unverifiedLedger guestMembership materializedLedger
      ⟨guestRole, prefix_admits_unverified_guest⟩ ⟨7⟩ ⟨9⟩ .token rfl)

/-- The fix strengthened the relation rather than replacing it: every step the current
model admits, the pre-fix relation admitted too. -/
theorem current_step_is_prefix_step {ledger membership role after}
    (step : MaterializationStep ledger membership role after) :
    PreFixMaterializationStep ledger membership role after := by
  cases step with
  | rematerialize sameRole _ => exact .rematerialize sameRole

/-- The strengthening is strict, and this is what makes the `SubjectVerified` premise a
discriminating witness: the exact step that refutes the ordering above is refused by the
current model. Remove the premise and this theorem fails while
`prefix_guest_verification_diverges` still holds. -/
theorem fix_is_strict :
    ¬ MaterializationStep unverifiedLedger guestMembership guestRole materializedLedger := by
  intro step
  exact nothing_verified (materialization_requires_verified_guest rfl step)

end SpecCnl.Divergence
