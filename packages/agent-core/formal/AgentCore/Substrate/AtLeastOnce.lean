import AgentCore.Substrate.Effect

/-!
# At-least-once delivery, and the kernel's side of it

Two seams deliver at least once. SPEC §10.4: "Queues and Workflows are at-least-once with
no platform-fenced DO callback; all fencing is the application-level lease epoch (§5.3)";
§10.1: "Queues/RPC may redeliver but cannot remap or duplicate intent". §6.1 says the same
thing one layer up — every cross-Actor interaction is at-least-once and idempotency-keyed.

The platform is therefore not where exactly-once comes from, and no premise in this library
claims it is. Exactly-once is something the *kernel* constructs, out of a durable dedupe key
and one rule: apply a delivery only if its key has not been applied. This module is that
construction and its proof, shared by the queue seam and the RPC redelivery premise because
it is the same construction in both.

`Inbox` is the kernel's state: which keys have been applied, and the domain state they were
applied to. `Inbox.accept` is the guarded application. The theorems say what a caller needs:
accepting a key twice is accepting it once, and replaying an entire batch — in any order, any
number of times — changes nothing. That is the sense in which a duplicating transport is an
adversary this model survives rather than a premise it needs.

Two things this module deliberately does not do. It does not assume delivery: that is
`Premise.queueAtLeastOnceDelivery`, a progress premise, and no theorem here uses it. And it
does not decide what a key is — key derivation is the domain's business (§7.3 derives an item
key from the complete shared header identity, payload shape, item index, argument digest, and
seed), and a rekeyed submission defeating dedupe is a domain defect, not a substrate one.
-/

namespace AgentCore.Substrate

/--
The kernel's idempotency-keyed inbox: the applied-key set and the domain state.

`seen` is a decidable predicate rather than a list because that is what a durable dedupe
index is — a membership test — and because the guarded application must be a `Bool` branch
the kernel can compile, not a classical case split.
-/
structure Inbox (κ : Type) where
  seen : ByteArray → Bool
  state : κ

/-- Apply one delivery under its key, or recognise it as already applied. -/
def Inbox.accept {κ : Type} (apply : ByteArray → κ → κ) (inbox : Inbox κ)
    (key : ByteArray) : Inbox κ :=
  if inbox.seen key then inbox
  else { seen := fun probe => decide (probe = key) || inbox.seen probe
         state := apply key inbox.state }

/-- Apply a batch left to right. Each delivery carries its own key and its own decision;
there is no batch-level acknowledgement here, matching §10.4's rule that the rest of a batch
keeps its own dispositions. -/
def Inbox.acceptAll {κ : Type} (apply : ByteArray → κ → κ) (inbox : Inbox κ)
    (keys : List ByteArray) : Inbox κ :=
  keys.foldl (Inbox.accept apply) inbox

section Dedupe

variable {κ : Type} {apply : ByteArray → κ → κ}

/-- An applied key is recorded as applied. -/
theorem accept_marks_key (inbox : Inbox κ) (key : ByteArray) :
    (Inbox.accept apply inbox key).seen key = true := by
  unfold Inbox.accept
  by_cases known : inbox.seen key = true
  · rw [if_pos known]; exact known
  · rw [if_neg known]; simp

/-- Applying a delivery never forgets a key. -/
theorem accept_preserves_seen {inbox : Inbox κ} {probe : ByteArray} (key : ByteArray)
    (known : inbox.seen probe = true) : (Inbox.accept apply inbox key).seen probe = true := by
  unfold Inbox.accept
  by_cases seenKey : inbox.seen key = true
  · rw [if_pos seenKey]; exact known
  · rw [if_neg seenKey]; simp [known]

/-- A redelivery of an already-applied key is a no-op on the whole inbox — domain state and
dedupe index alike. -/
theorem redelivery_is_a_noop {inbox : Inbox κ} {key : ByteArray}
    (known : inbox.seen key = true) : Inbox.accept apply inbox key = inbox := by
  unfold Inbox.accept
  rw [if_pos known]

/-- Accepting the same delivery twice is accepting it once. The at-least-once transport can
hand the same message back and the kernel's state does not move. -/
theorem accept_is_idempotent (inbox : Inbox κ) (key : ByteArray) :
    Inbox.accept apply (Inbox.accept apply inbox key) key = Inbox.accept apply inbox key :=
  redelivery_is_a_noop (accept_marks_key inbox key)

/-- A batch never forgets a key either. -/
theorem acceptAll_preserves_seen {inbox : Inbox κ} {probe : ByteArray}
    (keys : List ByteArray) (known : inbox.seen probe = true) :
    (Inbox.acceptAll apply inbox keys).seen probe = true := by
  induction keys generalizing inbox with
  | nil => exact known
  | cons key rest inner =>
      exact inner (accept_preserves_seen key known)

/-- Every key of an applied batch is recorded as applied. -/
theorem acceptAll_marks_keys {inbox : Inbox κ} {key : ByteArray} (keys : List ByteArray)
    (member : key ∈ keys) : (Inbox.acceptAll apply inbox keys).seen key = true := by
  induction keys generalizing inbox with
  | nil => simp at member
  | cons head rest inner =>
      rcases List.mem_cons.mp member with here | there
      · subst here
        exact acceptAll_preserves_seen rest (accept_marks_key inbox key)
      · exact inner there

/-- A batch of keys the inbox has already applied does nothing. -/
theorem acceptAll_of_all_seen {inbox : Inbox κ} (keys : List ByteArray)
    (known : ∀ key ∈ keys, inbox.seen key = true) :
    Inbox.acceptAll apply inbox keys = inbox := by
  induction keys generalizing inbox with
  | nil => rfl
  | cons head rest inner =>
      have headKnown : inbox.seen head = true := known head (by simp)
      have step : Inbox.accept apply inbox head = inbox := redelivery_is_a_noop headKnown
      unfold Inbox.acceptAll
      rw [List.foldl_cons, step]
      exact inner (fun key member => known key (List.mem_cons_of_mem head member))

/--
Replaying a whole batch changes nothing.

This is the exactly-once result, and it is the reason no premise in this library asks a
queue or an RPC transport to deliver once. The transport may repeat the entire batch, and
the kernel's state after the replay is the state before it — including the dedupe index, so
a third replay is equally free.
-/
theorem batch_replay_is_a_noop (inbox : Inbox κ) (keys : List ByteArray) :
    Inbox.acceptAll apply (Inbox.acceptAll apply inbox keys) keys =
      Inbox.acceptAll apply inbox keys :=
  acceptAll_of_all_seen keys fun _key member => acceptAll_marks_keys keys member

/-- Any subset of a batch may be redelivered, one message at a time, with the same
result. -/
theorem redelivered_message_is_absorbed (inbox : Inbox κ) (keys : List ByteArray)
    {key : ByteArray} (member : key ∈ keys) :
    Inbox.accept apply (Inbox.acceptAll apply inbox keys) key =
      Inbox.acceptAll apply inbox keys :=
  redelivery_is_a_noop (acceptAll_marks_keys keys member)

end Dedupe

end AgentCore.Substrate
