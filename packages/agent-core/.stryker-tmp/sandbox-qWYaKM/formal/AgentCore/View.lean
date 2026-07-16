import AgentCore.Approvals

/-!
# Structural View replay

The body and patches are explicit syntax, not opaque functions. Replay therefore states
an honest structural reconstruction result: matching-base deltas have one computed
result and advance revisions exactly.
-/

namespace AgentCore

structure ViewNode where
  /-- Canonically ordered rendered blocks. -/
  blocks : List String
  deriving DecidableEq, Repr

inductive ViewPatch where
  | replace (body : ViewNode)
  | append (child : ViewNode)
  deriving DecidableEq, Repr

def ViewPatch.apply : ViewPatch → ViewNode → ViewNode
  | .replace body, _ => body
  | .append child, body => ⟨body.blocks ++ child.blocks⟩

structure ViewState where
  revision : Nat
  body : ViewNode
  deriving DecidableEq, Repr

structure ViewDelta where
  base : Nat
  patch : ViewPatch
  deriving DecidableEq, Repr

def applyDelta (view : ViewState) (delta : ViewDelta) : Option ViewState :=
  if delta.base = view.revision then
    some ⟨view.revision + 1, delta.patch.apply view.body⟩
  else none

def replay : ViewState → List ViewDelta → Option ViewState
  | view, [] => some view
  | view, delta :: rest =>
      match applyDelta view delta with
      | none => none
      | some next => replay next rest

theorem apply_requires_matching_revision {view delta next}
    (applied : applyDelta view delta = some next) : delta.base = view.revision := by
  unfold applyDelta at applied
  split at applied
  · assumption
  · contradiction

theorem apply_advances_revision {view delta next}
    (applied : applyDelta view delta = some next) : next.revision = view.revision + 1 := by
  unfold applyDelta at applied
  split at applied
  · cases applied; rfl
  · contradiction

theorem replay_deterministic {view deltas first second}
    (one : replay view deltas = some first) (two : replay view deltas = some second) :
    first = second := by rw [one] at two; exact Option.some.inj two

theorem replay_revision {view deltas result} (done : replay view deltas = some result) :
    result.revision = view.revision + deltas.length := by
  induction deltas generalizing view with
  | nil => simp [replay] at done; cases done; simp
  | cons delta rest ih =>
      simp only [replay] at done
      cases applied : applyDelta view delta with
      | none => simp [applied] at done
      | some next =>
          rw [applied] at done
          rw [ih done, apply_advances_revision applied]
          simp [Nat.add_assoc, Nat.add_comm, Nat.add_left_comm]

end AgentCore
