import AgentCore.Substrate.Effect

/-!
# The object's single alarm, and the claim table that arbitrates it

A Durable Object has exactly one alarm. SPEC §10.4 draws the only safe conclusion: "no
scheduler inside it writes that alarm directly: each records a durable per-owner claim, and
the physical alarm tracks the earliest live claim. Setting, advancing, or releasing one
owner's claim MUST leave every other owner's wakeup armed, a claim that fires releases only
itself, and the alarm falls back to the earliest surviving claim or is torn down when none
remains. The claim table, not the platform's alarm slot, is the state that arbitration is
repaired from." That is `C13-CLOUDFLARE-ALARM-CLAIMS`.

This module has two halves and the second is the point.

The first half is the seam: `AlarmOp`, `AlarmReply`, `AlarmEffect`, and `AlarmLaws`. The
single physical slot is one law — `set_arms` holds for *every* prior state, so a second
`set` necessarily replaces the first, which is what "exactly one alarm" means when written
as an equation rather than as a warning.

The second half is the arbitration, proved rather than assumed. `ClaimTable` is the durable
per-owner state, `AlarmEffect.arm` is the only writer of the physical slot, and the
theorems below are §10.4's sentences one at a time: the slot tracks the earliest live claim
and points at a claim that exists, it is at or before every live claim, recording or
releasing one owner leaves every other owner's due time exactly where it was, a fired claim
releases only itself, another owner's survival keeps the slot armed no later than that
owner needs, teardown happens only when the table empties, and a rebuild from the table is
idempotent so a restart may repeat it.

`C13-CLOUDFLARE-RECONCILIATION-FENCE` and `C13-CLOUDFLARE-RECONCILIATION-RETRY` are here
too, because both are claim-table properties: acknowledgement fences on the schedule the
sweep observed, so an entry rescheduled underneath a running sweep survives with the newer
schedule intact; and a failed entry is deferred to a strictly future time rather than
re-armed at a past schedule that would refire immediately and spin.

## What is premise and what is proved

Proved from `AlarmLaws`: everything about arbitration above. Premise, because no equation
over this interface can state it: `Premise.alarmDurableAcrossInstanceLoss` (an armed alarm
survives instance loss and a throwing handler), `Premise.alarmFiresNoEarlierThanArmed`, and
the one progress premise `Premise.alarmEventuallyFires`.

Deliberately not a premise: that an alarm fires at most once. Alarms are at-least-once, so
repetition is an adversary power the results here survive — `release_is_idempotent`,
`acknowledge_is_idempotent`, and `rebuild_is_idempotent` are what that survival looks like.
-/

namespace AgentCore.Substrate

/-- The alarm requests a kernel can issue: wire tails of `Opcode.alarmSet`,
`Opcode.alarmGet`, `Opcode.alarmDelete`. -/
inductive AlarmOp where
  | set (dueAt : Nat)
  | get
  | delete
  deriving DecidableEq, Repr

/-- Which opcode an alarm request is. -/
def AlarmOp.opcode : AlarmOp → Opcode
  | .set _ => .alarmSet
  | .get => .alarmGet
  | .delete => .alarmDelete

/-- Every alarm request lands on the alarm seam. -/
theorem AlarmOp.opcode_seam (op : AlarmOp) : op.opcode.seam = .alarm := by
  cases op <;> rfl

/-- What the alarm slot can answer. -/
inductive AlarmReply where
  | armed (dueAt : Nat)
  | unarmed
  | ok
  | refused (refusal : Refusal)
  deriving DecidableEq, Repr

/-- The single physical alarm slot, synchronous store-passing over an explicit `σ`. -/
structure AlarmEffect (σ : Type) where
  set : Nat → σ → AlarmReply × σ
  get : σ → AlarmReply × σ
  delete : σ → AlarmReply × σ

/--
The alarm laws.

`set_arms` is the single-slot law: it constrains the reading after a `set` from *any* prior
state, armed or not, so there is no state in which two due times are simultaneously armed.
An implementation with two slots cannot satisfy it, and the claim-table discipline that the
rest of this module proves correct is the consequence.
-/
structure AlarmLaws {σ : Type} (effect : AlarmEffect σ) : Prop where
  /-- Reading the slot is a query. -/
  get_is_pure : ∀ state, (effect.get state).2 = state
  /-- After arming, the slot reads exactly the armed time — whatever it held before. One
  slot, last writer wins. -/
  set_arms : ∀ dueAt state, (effect.get (effect.set dueAt state).2).1 = .armed dueAt
  /-- After tearing down, the slot is unarmed. -/
  delete_disarms : ∀ state, (effect.get (effect.delete state).2).1 = .unarmed
  /-- Arming is accepted. -/
  set_accepts : ∀ dueAt state, (effect.set dueAt state).1 = .ok
  /-- Tearing down is accepted, armed or not: a teardown of nothing is not an error. -/
  delete_accepts : ∀ state, (effect.delete state).1 = .ok
  /-- The slot is armed or unarmed and nothing else; there is no alarm read failure for the
  kernel to interpret. -/
  observation_is_total : ∀ state,
    (effect.get state).1 = .unarmed ∨ ∃ dueAt, (effect.get state).1 = .armed dueAt

/-- One durable per-owner wakeup claim. -/
structure Claim where
  owner : Nat
  dueAt : Nat
  deriving DecidableEq, Repr

/-- The durable claim table: the state arbitration is repaired from, per §10.4. A plain
list, so `List`'s own membership and induction principles apply; the operations below are
named rather than reached through dot notation for exactly that reason. -/
abbrev ClaimTable := List Claim

namespace ClaimTable

/-- The due time one owner holds, if any. -/
def due : ClaimTable → Nat → Option Nat
  | [], _ => none
  | claim :: rest, owner => if claim.owner = owner then some claim.dueAt else due rest owner

/-- The table with one owner's claim removed. -/
def without : ClaimTable → Nat → ClaimTable
  | [], _ => []
  | claim :: rest, owner =>
      if claim.owner = owner then without rest owner else claim :: without rest owner

/-- Record or advance one owner's claim. Replaces that owner's entry and no other. -/
def record (claims : ClaimTable) (claim : Claim) : ClaimTable :=
  claim :: without claims claim.owner

/-- Release one owner's claim — what a fired claim does to itself. -/
def release (claims : ClaimTable) (owner : Nat) : ClaimTable := without claims owner

/-- The earliest live claim, which is what the physical slot must track. -/
def earliest : ClaimTable → Option Nat
  | [] => none
  | claim :: rest =>
      match earliest rest with
      | none => some claim.dueAt
      | some other => some (min claim.dueAt other)

/-- The table is empty exactly when no wakeup is owed. -/
theorem earliest_eq_none_iff (claims : ClaimTable) : earliest claims = none ↔ claims = [] := by
  cases claims with
  | nil => simp [earliest]
  | cons claim rest =>
      simp only [earliest]
      cases earliest rest <;> simp

/-- A nonempty table owes a wakeup: the slot is never torn down while a claim survives. -/
theorem earliest_isSome_of_ne_nil {claims : ClaimTable} (live : claims ≠ []) :
    ∃ dueAt, earliest claims = some dueAt := by
  cases found : earliest claims with
  | none => exact absurd ((earliest_eq_none_iff claims).mp found) live
  | some dueAt => exact ⟨dueAt, rfl⟩

/-- The two arbitration facts about `earliest`, proved together because the induction needs
the due time universally quantified: the armed time is one a claim actually holds, and no
live claim is later than it. -/
theorem earliest_is_minimal_claim : ∀ (claims : ClaimTable) (dueAt : Nat),
    earliest claims = some dueAt →
      (∃ claim ∈ claims, claim.dueAt = dueAt) ∧ (∀ claim ∈ claims, dueAt ≤ claim.dueAt) := by
  intro claims
  induction claims with
  | nil => intro dueAt found; simp [earliest] at found
  | cons head rest inner =>
      intro dueAt found
      simp only [earliest] at found
      cases restEarliest : earliest rest with
      | none =>
          rw [restEarliest] at found
          have value : head.dueAt = dueAt := Option.some.inj found
          have empty : rest = [] := (earliest_eq_none_iff rest).mp restEarliest
          subst empty
          refine ⟨⟨head, by simp, value⟩, ?_⟩
          intro claim member
          simp only [List.mem_singleton] at member
          subst member
          omega
      | some other =>
          rw [restEarliest] at found
          have value : min head.dueAt other = dueAt := Option.some.inj found
          obtain ⟨⟨witness, witnessMember, witnessDue⟩, minimal⟩ := inner other restEarliest
          refine ⟨?_, ?_⟩
          · by_cases smaller : head.dueAt ≤ other
            · exact ⟨head, by simp, by omega⟩
            · exact ⟨witness, List.mem_cons_of_mem head witnessMember, by omega⟩
          · intro claim member
            rcases List.mem_cons.mp member with here | there
            · subst here; omega
            · have := minimal claim there
              omega

/-- The earliest time is one a claim actually holds: the slot points at a real claim, never
at a time nobody asked for. -/
theorem earliest_is_a_claim {claims : ClaimTable} {dueAt : Nat}
    (found : earliest claims = some dueAt) : ∃ claim ∈ claims, claim.dueAt = dueAt :=
  (earliest_is_minimal_claim claims dueAt found).1

/-- No claim is missed: the armed time is at or before every live claim's due time. -/
theorem earliest_le_of_mem {claims : ClaimTable} {claim : Claim} {dueAt : Nat}
    (member : claim ∈ claims) (found : earliest claims = some dueAt) : dueAt ≤ claim.dueAt :=
  (earliest_is_minimal_claim claims dueAt found).2 claim member

/-- A recorded due time is a due time some claim in the table holds. -/
theorem mem_of_due {claims : ClaimTable} {owner dueAt : Nat}
    (held : due claims owner = some dueAt) :
    ∃ claim ∈ claims, claim.owner = owner ∧ claim.dueAt = dueAt := by
  induction claims with
  | nil => simp [due] at held
  | cons claim rest inner =>
      by_cases head : claim.owner = owner
      · rw [due, if_pos head] at held
        exact ⟨claim, by simp, head, Option.some.inj held⟩
      · rw [due, if_neg head] at held
        obtain ⟨witness, member, owns, holds⟩ := inner held
        exact ⟨witness, List.mem_cons_of_mem claim member, owns, holds⟩

/-- Removing one owner's claim removes it. -/
theorem due_without_self (claims : ClaimTable) (owner : Nat) :
    due (without claims owner) owner = none := by
  induction claims with
  | nil => rfl
  | cons claim rest inner =>
      by_cases head : claim.owner = owner
      · rw [without, if_pos head]; exact inner
      · rw [without, if_neg head, due, if_neg head]; exact inner

/-- Removing one owner's claim leaves every other owner's due time exactly as it was. -/
theorem due_without_of_ne (claims : ClaimTable) {owner other : Nat} (different : owner ≠ other) :
    due (without claims other) owner = due claims owner := by
  induction claims with
  | nil => rfl
  | cons claim rest inner =>
      by_cases head : claim.owner = other
      · have notOwner : ¬ claim.owner = owner := by
          rw [head]; exact fun same => different same.symm
        rw [without, if_pos head, due, if_neg notOwner]
        exact inner
      · by_cases isOwner : claim.owner = owner
        · rw [without, if_neg head, due, if_pos isOwner, due, if_pos isOwner]
        · rw [without, if_neg head, due, if_neg isOwner, due, if_neg isOwner]
          exact inner

/-- Releasing twice is releasing once: a claim that fires twice — alarms are at-least-once
— cannot corrupt the table. -/
theorem release_is_idempotent (claims : ClaimTable) (owner : Nat) :
    release (release claims owner) owner = release claims owner := by
  simp only [release]
  induction claims with
  | nil => rfl
  | cons claim rest inner =>
      by_cases head : claim.owner = owner
      · rw [without, if_pos head]; exact inner
      · rw [without, if_neg head, without, if_neg head, inner]

/-- A fired claim releases itself. -/
theorem due_release_self (claims : ClaimTable) (owner : Nat) :
    due (release claims owner) owner = none :=
  due_without_self claims owner

/-- A fired claim releases *only* itself: every other owner's wakeup is untouched. -/
theorem release_preserves_other_owners (claims : ClaimTable) {owner other : Nat}
    (different : owner ≠ other) : due (release claims other) owner = due claims owner :=
  due_without_of_ne claims different

/-- Recording one owner's claim records exactly that due time. -/
theorem due_record_self (claims : ClaimTable) (claim : Claim) :
    due (record claims claim) claim.owner = some claim.dueAt := by
  rw [record, due, if_pos rfl]

/-- Recording or advancing one owner's claim leaves every other owner's wakeup armed at the
time it already held (§10.4). -/
theorem record_preserves_other_owners (claims : ClaimTable) (claim : Claim) {owner : Nat}
    (different : owner ≠ claim.owner) :
    due (record claims claim) owner = due claims owner := by
  rw [record, due, if_neg (fun same => different same.symm)]
  exact due_without_of_ne claims different

/-- Acknowledge one owner's entry, fencing on the schedule the sweep observed. An entry
whose schedule moved underneath the sweep is not cleared
(`C13-CLOUDFLARE-RECONCILIATION-FENCE`). -/
def acknowledge (claims : ClaimTable) (owner observed : Nat) : ClaimTable :=
  if due claims owner = some observed then release claims owner else claims

/-- An entry whose schedule still matches what the sweep read is cleared. -/
theorem acknowledge_clears_the_observed_claim {claims : ClaimTable} {owner observed : Nat}
    (unmoved : due claims owner = some observed) :
    due (acknowledge claims owner observed) owner = none := by
  rw [acknowledge, if_pos unmoved]
  exact due_release_self claims owner

/-- An entry rescheduled underneath the sweep survives it, with the newer schedule intact
and no part of the table rewritten. -/
theorem acknowledge_is_fenced {claims : ClaimTable} {owner observed : Nat}
    (moved : due claims owner ≠ some observed) :
    acknowledge claims owner observed = claims := by
  rw [acknowledge, if_neg moved]

/-- Acknowledging is idempotent, so an at-least-once sweep may run twice. -/
theorem acknowledge_is_idempotent (claims : ClaimTable) (owner observed : Nat) :
    acknowledge (acknowledge claims owner observed) owner observed =
      acknowledge claims owner observed := by
  by_cases unmoved : due claims owner = some observed
  · have cleared : due (acknowledge claims owner observed) owner = none :=
      acknowledge_clears_the_observed_claim unmoved
    exact acknowledge_is_fenced (by rw [cleared]; simp)
  · rw [acknowledge_is_fenced unmoved]
    exact acknowledge_is_fenced unmoved

/-- Acknowledging one owner's entry never clears another's. -/
theorem acknowledge_preserves_other_owners (claims : ClaimTable) {owner other observed : Nat}
    (different : owner ≠ other) :
    due (acknowledge claims other observed) owner = due claims owner := by
  by_cases unmoved : due claims other = some observed
  · rw [acknowledge, if_pos unmoved]
    exact release_preserves_other_owners claims different
  · rw [acknowledge_is_fenced unmoved]

/-- Defer a failed entry to a bounded retry time. The re-arm is floored one delay out
rather than at the past schedule the sweep never settled, which would refire immediately
and spin (`C13-CLOUDFLARE-RECONCILIATION-RETRY`). -/
def defer (claims : ClaimTable) (owner now delay : Nat) : ClaimTable :=
  record claims ⟨owner, now + delay⟩

/-- A deferred entry is due strictly in the future, so the retry cannot refire on the same
sweep. -/
theorem defer_is_in_the_future (claims : ClaimTable) (owner now : Nat) {delay : Nat}
    (bounded : 0 < delay) :
    ∃ dueAt, due (defer claims owner now delay) owner = some dueAt ∧ now < dueAt := by
  refine ⟨now + delay, ?_, by omega⟩
  exact due_record_self claims ⟨owner, now + delay⟩

/-- Deferring one failed entry leaves every other owner's wakeup where it was. -/
theorem defer_preserves_other_owners (claims : ClaimTable) {owner other now delay : Nat}
    (different : owner ≠ other) :
    due (defer claims other now delay) owner = due claims owner :=
  record_preserves_other_owners claims ⟨other, now + delay⟩ different

end ClaimTable

/--
Arm the physical slot from the claim table. The only writer of the platform's alarm: it
tracks the earliest live claim and tears the slot down exactly when no claim remains.

This is also the startup rebuild of `C13-CLOUDFLARE-ALARM-DURABILITY`: an Actor that starts
runs `arm` over the table it recovered, so an object whose platform retries were exhausted
re-arms the moment it is next instantiated.
-/
def AlarmEffect.arm {σ : Type} (effect : AlarmEffect σ) (claims : ClaimTable) (state : σ) : σ :=
  match ClaimTable.earliest claims with
  | some dueAt => (effect.set dueAt state).2
  | none => (effect.delete state).2

section Arbitration

variable {σ : Type} {effect : AlarmEffect σ}

/-- The physical slot tracks the earliest live claim. -/
theorem arm_tracks_earliest_claim (laws : AlarmLaws effect) {claims : ClaimTable}
    {dueAt : Nat} (state : σ) (found : ClaimTable.earliest claims = some dueAt) :
    (effect.get (effect.arm claims state)).1 = .armed dueAt := by
  simp only [AlarmEffect.arm, found]
  exact laws.set_arms dueAt state

/-- The slot is torn down exactly when the table has emptied. -/
theorem arm_tears_down_when_no_claim_remains (laws : AlarmLaws effect) {claims : ClaimTable}
    (state : σ) (drained : claims = []) :
    (effect.get (effect.arm claims state)).1 = .unarmed := by
  have found : ClaimTable.earliest claims = none :=
    (ClaimTable.earliest_eq_none_iff claims).mpr drained
  simp only [AlarmEffect.arm, found]
  exact laws.delete_disarms state

/-- A surviving claim keeps the slot armed. Releasing one owner cannot leave a live table
with a torn-down alarm. -/
theorem arm_stays_armed_while_a_claim_survives (laws : AlarmLaws effect)
    {claims : ClaimTable} (state : σ) (live : claims ≠ []) :
    ∃ dueAt, (effect.get (effect.arm claims state)).1 = .armed dueAt := by
  obtain ⟨dueAt, found⟩ := ClaimTable.earliest_isSome_of_ne_nil live
  exact ⟨dueAt, arm_tracks_earliest_claim laws state found⟩

/--
The load-bearing consequence of the claim table, and §10.4's rule that releasing one
owner's claim leaves every other owner's wakeup armed.

Release the owner whose claim just fired; if any other owner still holds a claim, the
re-armed slot is armed, and it is armed no later than that owner's own due time. So a
scheduler cannot lose its wakeup because a different scheduler fired.
-/
theorem release_keeps_other_owners_wakeup (laws : AlarmLaws effect) {claims : ClaimTable}
    {fired other dueAt : Nat} (state : σ) (different : other ≠ fired)
    (held : ClaimTable.due claims other = some dueAt) :
    ∃ armedAt, (effect.get (effect.arm (ClaimTable.release claims fired) state)).1 =
      .armed armedAt ∧ armedAt ≤ dueAt := by
  have survives : ClaimTable.due (ClaimTable.release claims fired) other = some dueAt := by
    rw [ClaimTable.release_preserves_other_owners claims different]; exact held
  obtain ⟨claim, member, _, holds⟩ := ClaimTable.mem_of_due survives
  obtain ⟨armedAt, found⟩ :=
    ClaimTable.earliest_isSome_of_ne_nil (List.ne_nil_of_mem member)
  refine ⟨armedAt, arm_tracks_earliest_claim laws state found, ?_⟩
  have := ClaimTable.earliest_le_of_mem member found
  omega

/-- Rebuilding the slot from the table is idempotent, so a restart — or a platform retry
after a throwing handler — may repeat it. -/
theorem rebuild_is_idempotent (laws : AlarmLaws effect) (claims : ClaimTable) (state : σ) :
    (effect.get (effect.arm claims (effect.arm claims state))).1 =
      (effect.get (effect.arm claims state)).1 := by
  cases found : ClaimTable.earliest claims with
  | none =>
      have drained : claims = [] := (ClaimTable.earliest_eq_none_iff claims).mp found
      rw [arm_tears_down_when_no_claim_remains laws _ drained,
        arm_tears_down_when_no_claim_remains laws _ drained]
  | some dueAt =>
      rw [arm_tracks_earliest_claim laws _ found, arm_tracks_earliest_claim laws _ found]

end Arbitration

end AgentCore.Substrate
