import AgentCore.View

/-!
# Consequences of the existing View model the controlled language needs (§6.3)

One consequence of `AgentCore.View` as it stands. `applyDelta` computes the whole
successor — the next revision *and* the patched body — but the model states only the
revision half as a theorem (`apply_advances_revision`). A controlled sentence about a
View being a projection of its patch stream needs the body half named too, because the
body is where "derived, not live" is decided: the successor's content is a function of
the source content and the patch it was handed, and of nothing else.

No definition is introduced or changed here. The proof reads `applyDelta` and
`ViewPatch.apply` exactly as they already stand.
-/

namespace AgentCore

/-- **An applied ViewDelta yields exactly the patched successor.** A delta that applies
carries the View to the next revision over the patch applied to the body it was handed:
`next` is determined by `view` and `delta`, so a View's content at any revision is the
fold of the deltas that produced it and holds nothing else. The revision half is
`apply_advances_revision`; this states both halves together, which is what a sentence
about the successor needs. -/
theorem view_apply_is_the_patched_successor {view : ViewState} {delta : ViewDelta}
    {next : ViewState} (applied : applyDelta view delta = some next) :
    next.revision = view.revision + 1 ∧ next.body = delta.patch.apply view.body := by
  unfold applyDelta at applied
  split at applied
  · cases applied; exact ⟨rfl, rfl⟩
  · contradiction

end AgentCore
