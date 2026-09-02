import AgentCore.Substrate.AtLeastOnce

/-!
# Queues: at-least-once delivery, per-message disposition, and dead-letter custody

SPEC §10.4: "Queues and Workflows are at-least-once with no platform-fenced DO callback;
all fencing is the application-level lease epoch (§5.3). A delivery the target accepts is
acknowledged and MUST NOT be handed back; one the target declines is retried and
redelivered. A message whose body carries no decodable delivery identity MUST NOT reach the
target and MUST NOT be acknowledged either, because acknowledging destroys it: it is
retried until the queue's own dead-letter policy takes custody, while the rest of its batch
keeps its own dispositions." That is `C13-CLOUDFLARE-QUEUE-DISPOSITION`.

Three separate obligations live in that paragraph, and they belong in three different
places, which is most of what this module is for.

**The transport's obligations** are `QueueLaws`: an acknowledged delivery leaves the
in-flight set, a retried one returns to it with its attempt counted, one delivery's
disposition never moves another's, and a delivery that exhausts the bounded attempt count
goes into dead-letter custody rather than being dropped or looping forever.

**The consumer's obligation** is `settle`: decide each message on its own, and never
acknowledge a body whose delivery identity does not decode.
`undecodable_is_retried_never_acknowledged` is that rule as a theorem. Acknowledging
destroys the message, so an undecodable body is retried — which is a disposition, not a
decision about intent — and custody passes to the queue's own dead-letter policy after the
bounded attempt count. The Cloudflare adapter settles it exactly this way
(`cloudflare/src/queue.ts#AtLeastOnceQueueAdapter`), and so does a target that threw rather
than declined: an error is not a decision, and the delivery is still owed.

**The exactly-once obligation is the kernel's**, and it is discharged in
`AgentCore.Substrate.AtLeastOnce`: `Inbox.accept` with a durable dedupe key, whose replay
theorems say a duplicated batch moves nothing. `Premise.queueAtLeastOnceDelivery` is the
only thing this seam assumes about delivery, it is a *progress* premise, and no safety
result here rests on it.
-/

namespace AgentCore.Substrate

/-- The queue requests a kernel can issue: wire tails of `Opcode.queueSend`,
`Opcode.queueAck`, `Opcode.queueRetry`. A delivery *arrival* is not here — it is inbound,
not a call the kernel makes. -/
inductive QueueOp where
  | send (body : ByteArray)
  | ack (delivery : Nat)
  | retry (delivery : Nat) (delayMillis : Nat)
  deriving DecidableEq

/-- Which opcode a queue request is. -/
def QueueOp.opcode : QueueOp → Opcode
  | .send _ => .queueSend
  | .ack _ => .queueAck
  | .retry _ _ => .queueRetry

/-- Every queue request lands on the queue seam. -/
theorem QueueOp.opcode_seam (op : QueueOp) : op.opcode.seam = .queue := by
  cases op <;> rfl

/-- What the queue can answer. -/
inductive QueueReply where
  | enqueued (message : Nat)
  | ok
  | refused (refusal : Refusal)
  deriving DecidableEq, Repr

/-- The queue interface, synchronous store-passing over an explicit `σ`. -/
structure QueueEffect (σ : Type) where
  send : ByteArray → σ → QueueReply × σ
  ack : Nat → σ → QueueReply × σ
  retry : Nat → Nat → σ → QueueReply × σ

/-- What the model observes about the queue's own state to state its laws: which deliveries
are still in flight, how many attempts each has had, and which have passed into dead-letter
custody. A view is proof plumbing — it is erased at lowering and is never a host call. -/
structure QueueView (σ : Type) where
  inflight : σ → Nat → Bool
  attempts : σ → Nat → Nat
  deadLettered : σ → Nat → Bool

/--
The queue laws.

`maxAttempts` is the queue's configured retry bound. It appears in exactly one law, and
that law is the one that matters for a poison message: at the bound, the delivery leaves
the in-flight set *and* enters dead-letter custody. Neither half alone is acceptable —
leaving in-flight is an infinite loop, and leaving custody is a lost message.
-/
structure QueueLaws {σ : Type} (effect : QueueEffect σ) (view : QueueView σ)
    (maxAttempts : Nat) : Prop where
  /-- A send is accepted and names its message. -/
  send_enqueues : ∀ body state, ∃ message, (effect.send body state).1 = .enqueued message
  /-- An acknowledged delivery leaves the in-flight set and is never handed back. -/
  ack_consumes : ∀ delivery state,
    view.inflight (effect.ack delivery state).2 delivery = false
  /-- Acknowledging one delivery moves no other delivery's disposition: a batch's messages
  are settled one at a time. -/
  ack_preserves_other_deliveries : ∀ delivery other state, other ≠ delivery →
    view.inflight (effect.ack delivery state).2 other = view.inflight state other
  /-- Acknowledging never dead-letters anything. -/
  ack_preserves_dead_letters : ∀ delivery other state,
    view.deadLettered (effect.ack delivery state).2 other = view.deadLettered state other
  /-- Acknowledging a delivery that is not in flight is refused rather than silently
  accepted, so a kernel cannot ack something it never received. -/
  ack_requires_inflight : ∀ delivery state, view.inflight state delivery = false →
    effect.ack delivery state = (.refused .unknownDelivery, state)
  /-- A declined delivery below the retry bound returns to the in-flight set: declining is
  a redelivery, not a discard. -/
  retry_redelivers : ∀ delivery delay state, view.inflight state delivery = true →
    view.attempts state delivery + 1 < maxAttempts →
      view.inflight (effect.retry delivery delay state).2 delivery = true
  /-- A retry counts its attempt. -/
  retry_counts_attempt : ∀ delivery delay state, view.inflight state delivery = true →
    view.attempts (effect.retry delivery delay state).2 delivery =
      view.attempts state delivery + 1
  /-- Retrying one delivery moves no other's disposition. -/
  retry_preserves_other_deliveries : ∀ delivery other delay state, other ≠ delivery →
    view.inflight (effect.retry delivery delay state).2 other = view.inflight state other
  /-- Nor another's attempt count. -/
  retry_preserves_other_attempts : ∀ delivery other delay state, other ≠ delivery →
    view.attempts (effect.retry delivery delay state).2 other = view.attempts state other
  /-- At the retry bound the delivery leaves the in-flight set and the queue's dead-letter
  policy takes custody of it. It is neither retried forever nor dropped. -/
  retry_dead_letters_at_bound : ∀ delivery delay state, view.inflight state delivery = true →
    maxAttempts ≤ view.attempts state delivery + 1 →
      view.inflight (effect.retry delivery delay state).2 delivery = false ∧
        view.deadLettered (effect.retry delivery delay state).2 delivery = true
  /-- Retrying one delivery dead-letters no other. -/
  retry_preserves_other_dead_letters : ∀ delivery other delay state, other ≠ delivery →
    view.deadLettered (effect.retry delivery delay state).2 other =
      view.deadLettered state other

/-- What a consumer decides about one message. -/
inductive Disposition where
  /-- The target accepted it: acknowledge. -/
  | accepted
  /-- The target declined it: retry, which redelivers. -/
  | declined
  /-- The body carries no decodable delivery identity: make no call at all. -/
  | undecodable
  deriving DecidableEq, Repr

/-- Settle one message. `identity` decodes the delivery identity out of a body — `none`
where there is none — and `accept` is the target's decision on a decoded key. -/
def settle (identity : ByteArray → Option ByteArray) (accept : ByteArray → Bool)
    (body : ByteArray) : Disposition :=
  match identity body with
  | none => .undecodable
  | some key => if accept key then .accepted else .declined

/-- Settle a batch: one decision per message, in order. -/
def settleBatch (identity : ByteArray → Option ByteArray) (accept : ByteArray → Bool)
    (bodies : List ByteArray) : List Disposition :=
  bodies.map (settle identity accept)

/-- The host call one disposition makes. Every message is dispositioned — leaving one
undispositioned is how a batch loses a decision — and `undecodable` retries rather than
acknowledges, because acknowledging destroys the message while retrying keeps it until the
queue's dead-letter policy takes custody. Retrying is not a claim about intent: the kernel
is saying it did not settle this delivery, which is exactly true. -/
def Disposition.hostCall (delivery delayMillis : Nat) : Disposition → QueueOp
  | .accepted => .ack delivery
  | .declined => .retry delivery delayMillis
  | .undecodable => .retry delivery delayMillis

section Dispositions

/-- An undecodable body is retried and never acknowledged: retrying keeps it, acknowledging
would destroy it, and the queue's dead-letter policy is what eventually takes custody. -/
theorem undecodable_is_retried_never_acknowledged (delivery delayMillis : Nat) :
    Disposition.hostCall delivery delayMillis .undecodable = .retry delivery delayMillis ∧
      Disposition.hostCall delivery delayMillis .undecodable ≠ .ack delivery := by
  refine ⟨rfl, ?_⟩
  simp [Disposition.hostCall]

/-- Only acceptance acknowledges. Nothing the kernel cannot identify, and nothing the target
declined, can reach an `ack`. -/
theorem only_acceptance_acknowledges (disposition : Disposition) (delivery delayMillis : Nat)
    (acknowledged : Disposition.hostCall delivery delayMillis disposition = .ack delivery) :
    disposition = .accepted := by
  cases disposition <;> simp_all [Disposition.hostCall]

/-- A body whose identity does not decode is exactly the undecodable case: the kernel
cannot accept it by accident. -/
theorem settle_undecodable_iff (identity : ByteArray → Option ByteArray)
    (accept : ByteArray → Bool) (body : ByteArray) :
    settle identity accept body = .undecodable ↔ identity body = none := by
  unfold settle
  cases decoded : identity body with
  | none => simp
  | some key =>
      by_cases accepted : accept key = true
      · simp [accepted]
      · simp [accepted]

/-- An accepted message had a decodable identity. -/
theorem accepted_body_decodes {identity : ByteArray → Option ByteArray}
    {accept : ByteArray → Bool} {body : ByteArray}
    (decided : settle identity accept body = .accepted) : ∃ key, identity body = some key := by
  unfold settle at decided
  cases decoded : identity body with
  | none => rw [decoded] at decided; exact absurd decided (by simp)
  | some key => exact ⟨key, rfl⟩

/--
Dispositions are per-message by construction: the decision at each index depends on that
message's body alone, so one undecodable message in a batch cannot destroy, acknowledge, or
retry its neighbours (§10.4, "the rest of its batch keeps its own dispositions").
-/
theorem batch_dispositions_are_independent (identity : ByteArray → Option ByteArray)
    (accept : ByteArray → Bool) (bodies : List ByteArray) (index : Nat) :
    (settleBatch identity accept bodies)[index]? =
      (bodies[index]?).map (settle identity accept) := by
  unfold settleBatch
  exact List.getElem?_map

/-- A batch's settlement has one decision per message. -/
theorem batch_settles_every_message (identity : ByteArray → Option ByteArray)
    (accept : ByteArray → Bool) (bodies : List ByteArray) :
    (settleBatch identity accept bodies).length = bodies.length := by
  unfold settleBatch
  simp

end Dispositions

section Custody

variable {σ : Type} {effect : QueueEffect σ} {view : QueueView σ} {maxAttempts : Nat}

/-- A poison message is neither retried forever nor lost: at the bound it leaves the
in-flight set and the dead-letter policy holds it. -/
theorem poison_message_reaches_dead_letter_custody (laws : QueueLaws effect view maxAttempts)
    (delivery delay : Nat) (state : σ) (delivered : view.inflight state delivery = true)
    (exhausted : maxAttempts ≤ view.attempts state delivery + 1) :
    view.inflight (effect.retry delivery delay state).2 delivery = false ∧
      view.deadLettered (effect.retry delivery delay state).2 delivery = true :=
  laws.retry_dead_letters_at_bound delivery delay state delivered exhausted

/-- Below the bound a declined delivery comes back, with its attempt counted — so the
attempt count strictly increases and the bound is actually reached rather than approached
forever. -/
theorem decline_makes_progress_toward_the_bound (laws : QueueLaws effect view maxAttempts)
    (delivery delay : Nat) (state : σ) (delivered : view.inflight state delivery = true) :
    view.attempts (effect.retry delivery delay state).2 delivery >
      view.attempts state delivery := by
  rw [laws.retry_counts_attempt delivery delay state delivered]
  omega

/-- Settling one delivery never moves another's disposition, whichever way it was settled.
This is the batch-independence rule at the transport rather than at the consumer. -/
theorem settling_one_delivery_leaves_the_batch_alone (laws : QueueLaws effect view maxAttempts)
    (delivery other delay : Nat) (state : σ) (different : other ≠ delivery) :
    view.inflight (effect.ack delivery state).2 other = view.inflight state other ∧
      view.inflight (effect.retry delivery delay state).2 other = view.inflight state other :=
  ⟨laws.ack_preserves_other_deliveries delivery other state different,
   laws.retry_preserves_other_deliveries delivery other delay state different⟩

/-- An acknowledgement of something never delivered changes nothing. A kernel that
reconstructs its inbox after a restart cannot destroy a message by acking a stale id. -/
theorem stale_acknowledgement_is_inert (laws : QueueLaws effect view maxAttempts)
    (delivery : Nat) (state : σ) (absent : view.inflight state delivery = false) :
    (effect.ack delivery state).2 = state := by
  rw [laws.ack_requires_inflight delivery state absent]

end Custody

end AgentCore.Substrate
