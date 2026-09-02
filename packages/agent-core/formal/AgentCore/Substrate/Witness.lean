import AgentCore.Substrate.Alarms
import AgentCore.Substrate.Content

/-!
# Witnesses: the law sets are satisfiable

A `Prop` structure of laws proves nothing if no implementation can satisfy it. Contradictory
laws make every theorem that assumes them vacuously true, and a contract discharged by
vacuity is worse than no contract at all — it reads as a guarantee and constrains nothing.

So a seam gets a reference implementation here and a proof that it satisfies that seam's
laws in full. Nothing in these witnesses is an adapter: they are the smallest state a
seam's equations admit, built to be checked rather than deployed, in the same spirit as the
`AgentCore.Examples.nonvacuous_*` witnesses one layer down.

What a witness establishes and what it does not: it establishes that the laws are jointly
satisfiable, so no theorem resting on that seam's laws is vacuous. It establishes nothing
about any deployed substrate — that remains `Premise.adapterImplementsSeam` and the
discharge map.

## What is witnessed, and what is owed

Witnessed here: `AlarmLaws` (`alarm_laws`) and `ContentLaws` (`content_laws`), the two law
sets carrying the most equations — content's fifteen include addressing, read verification,
both bound directions, stat faithfulness in both directions, and the range algebra.

Owed, with the reason rather than a promise: `LocalStoreLaws`, `QueueLaws`, `IsolateLaws`,
and `RpcLaws` have no witness yet.

* `LocalStoreLaws` needs `list_sorted` and `list_complete` together, which needs a strict
  total order on `ByteArray` keys. `List.pairwise_mergeSort` supplies sortedness for a
  *total* `Bool` order, so the remaining pieces are a lexicographic `keyLe`, its
  transitivity and totality, deduplication, and `byteRank` injectivity — the last being
  reachable in this toolchain through `ByteArray.ext`, `Array.toList_inj`, and
  `UInt8.toNat_inj`, none of which is a stub. That is the whole missing proof, named
  precisely so it can be finished rather than rediscovered.
* `QueueLaws`, `IsolateLaws`, and `RpcLaws` are stated against a `View`, so a witness has
  to build the state *and* the observers, including a fresh-identifier scheme that is fresh
  in every state of the type rather than only in reachable ones.

A degenerate witness would close all four in an afternoon — a loader that refuses every
load satisfies `IsolateLaws` with every interesting law vacuous — and that is exactly the
move this file exists to refuse. An unwitnessed law set is recorded as unwitnessed.

One honest limitation of the two witnesses that do exist. Each is a *total* function on its
whole state type, so every law must hold for states no operation of the witness can reach.
Where a law's hypothesis is about a state this witness cannot build — an object past the
declared bound, for instance — the witness satisfies the law by never entering that state,
and the interesting case lives in the adapter rather than here.
-/

namespace AgentCore.Substrate
namespace Witness

/-! ## The alarm slot -/

/-- The whole state one physical alarm needs: the armed time, if any. -/
abbrev AlarmSlot := Option Nat

/-- The reference alarm: one slot, last writer wins. -/
def alarmEffect : AlarmEffect AlarmSlot where
  set := fun dueAt _ => (.ok, some dueAt)
  get := fun slot =>
    (match slot with
     | some dueAt => .armed dueAt
     | none => .unarmed, slot)
  delete := fun _ => (.ok, none)

/-- The single-slot laws are satisfiable. -/
theorem alarm_laws : AlarmLaws alarmEffect where
  get_is_pure := fun _ => rfl
  set_arms := fun _ _ => rfl
  delete_disarms := fun _ => rfl
  set_accepts := fun _ _ => rfl
  delete_accepts := fun _ => rfl
  observation_is_total := fun slot => by
    cases slot with
    | none => exact Or.inl rfl
    | some dueAt => exact Or.inr ⟨dueAt, rfl⟩

/-! ## Content

The digest is the identity, which is the smallest function satisfying content addressing:
an object's address is the object. `get_verifies` then holds by construction, which is the
point — the law says a read's bytes hash to the address asked for, and a witness that stores
bytes under their own digest is exactly what an implementation of that law looks like.

The shelf treats an over-bound entry as absent, so `head_is_faithful` and
`get_refuses_over_limit` hold together: there is no state of this witness in which a stat
describes something a read refuses. The over-bound *read* refusal is therefore the one law
this witness satisfies by never entering the state — the adapter is where that branch is
live (`cloudflare/src/content-object.ts` refuses a read on the stored size).

Membership is spelled out rather than taken from `List.contains`, because `ByteArray`'s
`BEq` has no `LawfulBEq` instance in this toolchain: `==` on two byte arrays cannot be
reasoned with, while `DecidableEq` can.
-/

/-- Stored payloads. -/
abbrev ContentShelf := List ByteArray

/-- Whether a payload sits on the shelf, decided through `DecidableEq`. -/
def shelfHas : ContentShelf → ByteArray → Bool
  | [], _ => false
  | entry :: rest, requested => if entry = requested then true else shelfHas rest requested

/-- Whether this shelf serves an object: present, and within the bound. -/
def served (bound : Nat) (shelf : ContentShelf) (requested : ByteArray) : Bool :=
  shelfHas shelf requested && decide (requested.size ≤ bound)

theorem shelfHas_cons_self (shelf : ContentShelf) (payload : ByteArray) :
    shelfHas (payload :: shelf) payload = true := by
  show (if payload = payload then true else shelfHas shelf payload) = true
  rw [if_pos rfl]

theorem shelfHas_cons_of_ne {payload requested : ByteArray} (shelf : ContentShelf)
    (different : requested ≠ payload) :
    shelfHas (payload :: shelf) requested = shelfHas shelf requested := by
  show (if payload = requested then true else shelfHas shelf requested) =
    shelfHas shelf requested
  rw [if_neg (fun same => different same.symm)]

theorem served_of_has {bound : Nat} {shelf : ContentShelf} {requested : ByteArray}
    (held : shelfHas shelf requested = true) (fits : requested.size ≤ bound) :
    served bound shelf requested = true := by
  simp [served, held, fits]

theorem has_of_served {bound : Nat} {shelf : ContentShelf} {requested : ByteArray}
    (open_shelf : served bound shelf requested = true) :
    shelfHas shelf requested = true ∧ requested.size ≤ bound := by
  simp only [served, Bool.and_eq_true, decide_eq_true_eq] at open_shelf
  exact open_shelf

/-- The reference content store, addressed by identity digest. -/
def contentEffect (bound : Nat) : ContentEffect ContentShelf where
  put := fun payload shelf =>
    if bound < payload.size then (.refused .overLimit, shelf)
    else (.stored payload, if shelfHas shelf payload then shelf else payload :: shelf)
  get := fun requested shelf =>
    (if served bound shelf requested then .bytes requested else .absent, shelf)
  head := fun requested shelf =>
    (if served bound shelf requested then .stat requested.size requested else .absent, shelf)
  range := fun requested offset length shelf =>
    (if served bound shelf requested then
        if offset + length ≤ requested.size then
          .bytes (requested.extract offset (offset + length))
        else .refused .outOfRange
      else .absent,
     shelf)

/-- The content laws are satisfiable, with the identity digest. -/
theorem content_laws (bound : Nat) : ContentLaws (contentEffect bound) id bound where
  get_is_pure := fun _ _ => rfl
  head_is_pure := fun _ _ => rfl
  range_is_pure := fun _ _ _ _ => rfl
  put_is_content_addressed := fun payload shelf fits => by
    simp only [contentEffect, id]
    rw [if_neg (by omega : ¬ bound < payload.size)]
  put_refuses_over_limit := fun payload shelf oversized => by
    simp only [contentEffect]
    rw [if_pos oversized]
  put_get := fun payload shelf fits => by
    simp only [contentEffect, id]
    rw [if_neg (by omega : ¬ bound < payload.size)]
    by_cases held : shelfHas shelf payload = true
    · rw [if_pos held, if_pos (served_of_has held fits)]
    · rw [if_neg held, if_pos (served_of_has (shelfHas_cons_self shelf payload) fits)]
  put_preserves_other_objects := fun payload requested shelf different => by
    simp only [contentEffect, id] at different ⊢
    by_cases oversized : bound < payload.size
    · rw [if_pos oversized]
    · rw [if_neg oversized]
      by_cases held : shelfHas shelf payload = true
      · rw [if_pos held]
      · rw [if_neg held, served, served, shelfHas_cons_of_ne shelf different]
  get_verifies := fun requested shelf payload readable => by
    simp only [contentEffect] at readable
    by_cases open_shelf : served bound shelf requested = true
    · rw [if_pos open_shelf] at readable
      exact congrArg id (ContentReply.bytes.inj readable).symm
    · rw [if_neg open_shelf] at readable
      exact absurd readable (by simp)
  get_is_total := fun requested shelf => by
    by_cases open_shelf : served bound shelf requested = true
    · exact Or.inr (Or.inr ⟨requested, by simp only [contentEffect]; rw [if_pos open_shelf]⟩)
    · exact Or.inl (by simp only [contentEffect]; rw [if_neg open_shelf])
  get_refuses_over_limit := fun requested shelf size statted oversized => by
    simp only [contentEffect] at statted
    by_cases open_shelf : served bound shelf requested = true
    · rw [if_pos open_shelf] at statted
      have sized : requested.size = size := (ContentReply.stat.inj statted).1
      have bounded : requested.size ≤ bound := (has_of_served open_shelf).2
      omega
    · rw [if_neg open_shelf] at statted
      exact absurd statted (by simp)
  head_reports_size := fun requested shelf payload readable => by
    simp only [contentEffect] at readable ⊢
    by_cases open_shelf : served bound shelf requested = true
    · rw [if_pos open_shelf] at readable ⊢
      rw [(ContentReply.bytes.inj readable).symm]
    · rw [if_neg open_shelf] at readable
      exact absurd readable (by simp)
  head_is_faithful := fun requested shelf size statted => by
    simp only [contentEffect] at statted
    by_cases open_shelf : served bound shelf requested = true
    · rw [if_pos open_shelf] at statted
      exact ⟨requested, by simp only [contentEffect]; rw [if_pos open_shelf],
        (ContentReply.stat.inj statted).1⟩
    · rw [if_neg open_shelf] at statted
      exact absurd statted (by simp)
  range_is_a_slice := fun requested offset length shelf payload readable inside => by
    simp only [contentEffect] at readable ⊢
    by_cases open_shelf : served bound shelf requested = true
    · rw [if_pos open_shelf] at readable ⊢
      have same : requested = payload := ContentReply.bytes.inj readable
      rw [same, if_pos inside]
    · rw [if_neg open_shelf] at readable
      exact absurd readable (by simp)
  range_refuses_outside := fun requested offset length shelf payload readable outside => by
    simp only [contentEffect] at readable ⊢
    by_cases open_shelf : served bound shelf requested = true
    · rw [if_pos open_shelf] at readable ⊢
      have same : requested = payload := ContentReply.bytes.inj readable
      rw [same, if_neg (by omega : ¬ offset + length ≤ payload.size)]
    · rw [if_neg open_shelf] at readable
      exact absurd readable (by simp)
  range_absent := fun requested offset length shelf absent => by
    simp only [contentEffect] at absent ⊢
    by_cases open_shelf : served bound shelf requested = true
    · rw [if_pos open_shelf] at absent
      exact absurd absent (by simp)
    · rw [if_neg open_shelf]
  range_refuses_when_get_refuses := fun requested offset length shelf refusal refused => by
    simp only [contentEffect] at refused
    by_cases open_shelf : served bound shelf requested = true
    · rw [if_pos open_shelf] at refused
      exact absurd refused (by simp)
    · rw [if_neg open_shelf] at refused
      exact absurd refused (by simp)

end Witness
end AgentCore.Substrate
