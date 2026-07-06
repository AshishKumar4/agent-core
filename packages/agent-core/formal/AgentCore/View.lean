/-!
# View revisions and ViewDelta replay (SPEC §6.3)

A Surface streams to clients as a sequence of ViewDeltas: RFC 6902 patches against a
View revision. A client applies a delta only when its base revision matches the View's
current revision, and each applied delta advances the revision by one. This module
models revisioned views and delta replay and proves the guarantees a hibernation-
surviving client relies on (SPEC §10.3): a delta out of order is refused, each applied
delta advances the revision by exactly one, replaying `n` deltas advances the revision
by `n`, and replay is deterministic — so a client that reconnects and replays from its
last-acked revision reconstructs exactly one view.
-/

namespace AgentCore

/-- The view body is left abstract; only the revision discipline matters here. -/
abbrev ViewBody := Nat

structure ViewState where
  revision : Nat
  body : ViewBody
  deriving DecidableEq, Repr

/-- A ViewDelta: the revision it applies against, and the patch it carries. -/
structure ViewDelta where
  base : Nat
  patch : ViewBody → ViewBody

/-- Apply a delta: it lands only if its base matches the current revision, and then the
    revision advances by one. -/
def applyDelta (view : ViewState) (delta : ViewDelta) : Option ViewState :=
  if delta.base = view.revision then
    some { revision := view.revision + 1, body := delta.patch view.body }
  else
    none

/-- **A delta applies only against its base revision.** An out-of-order delta is
    refused — the client will not apply a patch built against a revision it is not at. -/
theorem apply_requires_matching_revision {view delta view'}
    (applied : applyDelta view delta = some view') :
    delta.base = view.revision := by
  unfold applyDelta at applied
  split at applied
  · assumption
  · cases applied

/-- **Each applied delta advances the revision by one.** -/
theorem apply_advances_revision {view delta view'}
    (applied : applyDelta view delta = some view') :
    view'.revision = view.revision + 1 := by
  unfold applyDelta at applied
  split at applied
  · cases applied; rfl
  · cases applied

/-- Replay a stream of deltas from a starting view. Stops (returns `none`) at the first
    delta whose base does not match — the client is then out of sync and must resnapshot. -/
def replay : ViewState → List ViewDelta → Option ViewState
  | view, [] => some view
  | view, delta :: rest =>
      match applyDelta view delta with
      | some view' => replay view' rest
      | none => none

/-- **Replaying `n` deltas advances the revision by `n`.** A client that replays its
    backlog from a last-acked revision arrives at exactly the revision it should. -/
theorem replay_revision {view view' deltas}
    (replayed : replay view deltas = some view') :
    view'.revision = view.revision + deltas.length := by
  induction deltas generalizing view with
  | nil =>
      unfold replay at replayed
      cases replayed
      simp
  | cons delta rest ih =>
      unfold replay at replayed
      cases h : applyDelta view delta with
      | none => rw [h] at replayed; cases replayed
      | some mid =>
          rw [h] at replayed
          have step := apply_advances_revision h
          have := ih replayed
          rw [this, step]
          simp [List.length_cons]
          omega

/-- **Replay is deterministic.** Replaying the same deltas from the same view yields a
    unique result — reconnecting and replaying reconstructs exactly one view, never an
    ambiguous one. -/
theorem replay_deterministic {view deltas a b}
    (first : replay view deltas = some a)
    (second : replay view deltas = some b) :
    a = b := by
  rw [first] at second
  exact Option.some.inj second

end AgentCore
