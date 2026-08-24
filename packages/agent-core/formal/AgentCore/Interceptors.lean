import AgentCore.Model

/-!
# Operation interceptors

The §4.4 interception pipeline at the two operation cut points, as a small-step
relation. A schedule is the applicable contributions in the total
`(mode, priority, facetId, interceptorId)` order, in which the declared mode dominates
every local priority; each step consumes the next contribution
and either records its transformation or blocks with its exact identity. The recorded
trace is the same `InterceptorTransformation` list a `ReplayItem` persists, so run
consequences land directly on the structural replay model. Replay reads only the
trace: reproducing a result never reruns interceptor behavior.
-/

namespace AgentCore

inductive CutPoint where | before | after deriving DecidableEq, Repr

/-- What an interceptor *is*, not how it breaks ties (§4.4 rule 9). A `rewrite` may change
the value in flight; a `gate` observes and may block. The union is closed and the field below
is required, so a mode that is absent or outside the union is unrepresentable here rather
than defaulted — a defaulted mode would be an ordering claim its author never made. -/
inductive InterceptorMode where | rewrite | gate deriving DecidableEq, Repr

/-- The dominant ordering band (§4.4 rule 3): every `rewrite` precedes every `gate`. -/
def InterceptorMode.rank : InterceptorMode → Nat
  | .rewrite => 0
  | .gate => 1

structure InterceptorContribution where
  interceptor : InterceptorRef
  cutPoint : CutPoint
  mode : InterceptorMode
  priority : Nat
  deriving DecidableEq, Repr

def InterceptorContribution.key (contribution : InterceptorContribution) :
    Nat × Nat × Nat × Nat :=
  (contribution.mode.rank, contribution.priority,
    contribution.interceptor.facet.value, contribution.interceptor.id)

/-- Ascending `(mode, priority, facetId, interceptorId)` (§4.4 rule 3). The mode rank is the
leading component, so it dominates priority rather than merely tie-breaking with it. -/
def InterceptorOrder (left right : InterceptorContribution) : Prop :=
  left.key.1 < right.key.1 ∨
    (left.key.1 = right.key.1 ∧
      (left.key.2.1 < right.key.2.1 ∨
        (left.key.2.1 = right.key.2.1 ∧
          (left.key.2.2.1 < right.key.2.2.1 ∨
            (left.key.2.2.1 = right.key.2.2.1 ∧ left.key.2.2.2 < right.key.2.2.2)))))

theorem interceptor_order_irrefl (contribution : InterceptorContribution) :
    ¬ InterceptorOrder contribution contribution := by
  unfold InterceptorOrder; omega

theorem interceptor_order_asymm {left right : InterceptorContribution}
    (before : InterceptorOrder left right) : ¬ InterceptorOrder right left := by
  unfold InterceptorOrder at *; omega

theorem interceptor_order_trans {left middle right : InterceptorContribution}
    (first : InterceptorOrder left middle) (second : InterceptorOrder middle right) :
    InterceptorOrder left right := by
  unfold InterceptorOrder at *; omega

/-- The order is total: two contributions it cannot separate name the same interceptor in the
same mode, which §4.4 rule 3 forbids a Facet to contribute twice. -/
theorem interceptor_order_total (left right : InterceptorContribution) :
    (left.interceptor = right.interceptor ∧ left.mode = right.mode) ∨
      InterceptorOrder left right ∨ InterceptorOrder right left := by
  obtain ⟨⟨⟨leftFacet⟩, leftId⟩, leftCut, leftMode, leftPriority⟩ := left
  obtain ⟨⟨⟨rightFacet⟩, rightId⟩, rightCut, rightMode, rightPriority⟩ := right
  cases leftMode <;> cases rightMode <;>
    simp only [InterceptorOrder, InterceptorContribution.key, InterceptorMode.rank,
      InterceptorRef.mk.injEq, FacetId.mk.injEq, and_true, true_and, reduceCtorEq,
      and_false, false_or] <;>
    omega

/-- **The declared mode dominates local priority (§4.4 rule 3).** Every `rewrite` precedes
every `gate` at a cut point whatever their priorities, so no number reaches across the band.
This is what makes the band a property of the order rather than a comment on it. -/
theorem rewrite_precedes_every_gate {rewriting gating : InterceptorContribution}
    (isRewrite : rewriting.mode = .rewrite) (isGate : gating.mode = .gate) :
    InterceptorOrder rewriting gating := by
  simp [InterceptorOrder, InterceptorContribution.key, isRewrite, isGate,
    InterceptorMode.rank]

/-- Strictly ascending schedule: the §4.4 rule 3 execution order. -/
def ScheduleOrdered : List InterceptorContribution → Prop
  | [] | [_] => True
  | first :: second :: rest =>
      InterceptorOrder first second ∧ ScheduleOrdered (second :: rest)

theorem ordered_schedule_tail {head : InterceptorContribution}
    {tail : List InterceptorContribution} (ordered : ScheduleOrdered (head :: tail)) :
    ScheduleOrdered tail := by
  cases tail with
  | nil => trivial
  | cons second rest => exact ordered.2

theorem ordered_schedule_head_least {head : InterceptorContribution}
    {tail : List InterceptorContribution} (ordered : ScheduleOrdered (head :: tail))
    {member : InterceptorContribution} (inTail : member ∈ tail) :
    InterceptorOrder head member := by
  induction tail generalizing head with
  | nil => cases inTail
  | cons second rest ih =>
      rcases List.mem_cons.mp inTail with rfl | inRest
      · exact ordered.1
      · exact interceptor_order_trans ordered.1 (ih ordered.2 inRest)

/-- Determinism of the order (§4.4 rule 3): a contribution set has exactly one
ascending schedule. -/
theorem ordered_schedule_unique {left right : List InterceptorContribution}
    (leftOrdered : ScheduleOrdered left) (rightOrdered : ScheduleOrdered right)
    (sameMembers : ∀ contribution, contribution ∈ left ↔ contribution ∈ right) :
    left = right := by
  induction left generalizing right with
  | nil =>
      cases right with
      | nil => rfl
      | cons rightHead rightTail =>
          cases (sameMembers rightHead).mpr (List.mem_cons_self)
  | cons leftHead leftTail ih =>
      cases right with
      | nil => cases (sameMembers leftHead).mp (List.mem_cons_self)
      | cons rightHead rightTail =>
          have headsEqual : leftHead = rightHead := by
            rcases List.mem_cons.mp
                ((sameMembers leftHead).mp (List.mem_cons_self)) with
              equal | leftInRightTail
            · exact equal
            rcases List.mem_cons.mp
                ((sameMembers rightHead).mpr (List.mem_cons_self)) with
              equal | rightInLeftTail
            · exact equal.symm
            exact absurd (ordered_schedule_head_least leftOrdered rightInLeftTail)
              (interceptor_order_asymm
                (ordered_schedule_head_least rightOrdered leftInRightTail))
          subst headsEqual
          have tailsEqual : leftTail = rightTail := by
            apply ih (ordered_schedule_tail leftOrdered) (ordered_schedule_tail rightOrdered)
            intro contribution
            constructor
            · intro inLeft
              rcases List.mem_cons.mp
                  ((sameMembers contribution).mp (List.Mem.tail _ inLeft)) with
                rfl | inRight
              · exact absurd (ordered_schedule_head_least leftOrdered inLeft)
                  (interceptor_order_irrefl contribution)
              · exact inRight
            · intro inRight
              rcases List.mem_cons.mp
                  ((sameMembers contribution).mpr (List.Mem.tail _ inRight)) with
                rfl | inLeft
              · exact absurd (ordered_schedule_head_least rightOrdered inRight)
                  (interceptor_order_irrefl contribution)
              · exact inLeft
          rw [tailsEqual]

/-- The §4.4 synchronous decision: a value now, or a scoped block. -/
inductive InterceptDecision where
  | proceed (value : StructuralValue)
  | block (reason : String)
  deriving DecidableEq, Repr

/-- Synchronous in-process interceptor behavior at one cut point. -/
abbrev InterceptorBehavior := InterceptorRef → StructuralValue → InterceptDecision

structure InterceptionBlock where
  interceptor : InterceptorRef
  reason : String
  deriving DecidableEq, Repr

structure InterceptionState where
  input : StructuralValue
  value : StructuralValue
  trace : List InterceptorTransformation
  pending : List InterceptorContribution
  blocked : Option InterceptionBlock
  deriving DecidableEq, Repr

def startInterception (schedule : List InterceptorContribution)
    (input : StructuralValue) : InterceptionState :=
  ⟨input, input, [], schedule, none⟩

def InterceptionState.Completed (state : InterceptionState) : Prop :=
  state.pending = [] ∧ state.blocked = none

def InterceptionState.Halted (state : InterceptionState) : Prop :=
  state.pending = [] ∨ state.blocked ≠ none

/-- The scoped block a host raises when a `gate` returns a value other than the one it
received (§4.4 rule 10). -/
def gateRewriteRefusal : String := "gate interceptor rewrote the value it received"

/-- One interceptor fires: the head of the pending schedule decides now. A proceed
records its transformation under its identity; a block records the exact blocker
(§4.4 rule 4) and, because every constructor requires an unblocked state, nothing
runs afterward. A `gate` that returns a different value is refused rather than applied
(§4.4 rule 10): `proceed` admits it only when the value is unchanged, and
`gateRewriteRefused` turns the attempt into a scoped block naming that interceptor. -/
inductive InterceptStep (behave : InterceptorBehavior) :
    InterceptionState → InterceptionState → Prop
  | proceed {state : InterceptionState} {next : InterceptorContribution}
      {rest : List InterceptorContribution} {output : StructuralValue} :
      state.blocked = none →
      state.pending = next :: rest →
      behave next.interceptor state.value = .proceed output →
      (next.mode = .gate → output = state.value) →
      InterceptStep behave state
        ⟨state.input, output,
          state.trace ++ [⟨next.interceptor, state.value, output⟩], rest, none⟩
  | block {state : InterceptionState} {next : InterceptorContribution}
      {rest : List InterceptorContribution} {reason : String} :
      state.blocked = none →
      state.pending = next :: rest →
      behave next.interceptor state.value = .block reason →
      InterceptStep behave state
        ⟨state.input, state.value, state.trace, rest, some ⟨next.interceptor, reason⟩⟩
  | gateRewriteRefused {state : InterceptionState} {next : InterceptorContribution}
      {rest : List InterceptorContribution} {output : StructuralValue} :
      state.blocked = none →
      state.pending = next :: rest →
      next.mode = .gate →
      behave next.interceptor state.value = .proceed output →
      output ≠ state.value →
      InterceptStep behave state
        ⟨state.input, state.value, state.trace, rest,
          some ⟨next.interceptor, gateRewriteRefusal⟩⟩

inductive InterceptRun (behave : InterceptorBehavior) :
    InterceptionState → InterceptionState → Prop
  | refl (state : InterceptionState) : InterceptRun behave state state
  | step {first middle last : InterceptionState} :
      InterceptStep behave first middle → InterceptRun behave middle last →
      InterceptRun behave first last

theorem intercept_run_preserves {behave : InterceptorBehavior}
    {motive : InterceptionState → Prop}
    (preserved : ∀ {current next : InterceptionState},
      motive current → InterceptStep behave current next → motive next)
    {first last : InterceptionState} (run : InterceptRun behave first last)
    (start : motive first) : motive last := by
  induction run with
  | refl => exact start
  | step step _ ih => exact ih (preserved start step)

/-- Synchronous single-successor execution: the head of the schedule and the behavior
admit exactly one next state. -/
theorem intercept_step_deterministic {behave : InterceptorBehavior}
    {state left right : InterceptionState} (one : InterceptStep behave state left)
    (two : InterceptStep behave state right) : left = right := by
  cases one with
  | proceed leftLive leftPending leftDecision leftFidelity =>
      cases two with
      | proceed rightLive rightPending rightDecision rightFidelity =>
          rw [leftPending] at rightPending
          cases rightPending
          rw [leftDecision] at rightDecision
          cases rightDecision
          rfl
      | block rightLive rightPending rightDecision =>
          rw [leftPending] at rightPending
          cases rightPending
          rw [leftDecision] at rightDecision
          cases rightDecision
      | gateRewriteRefused rightLive rightPending rightGate rightDecision rightRewrote =>
          rw [leftPending] at rightPending
          cases rightPending
          rw [leftDecision] at rightDecision
          cases rightDecision
          exact absurd (leftFidelity rightGate) rightRewrote
  | block leftLive leftPending leftDecision =>
      cases two with
      | proceed rightLive rightPending rightDecision rightFidelity =>
          rw [leftPending] at rightPending
          cases rightPending
          rw [leftDecision] at rightDecision
          cases rightDecision
      | block rightLive rightPending rightDecision =>
          rw [leftPending] at rightPending
          cases rightPending
          rw [leftDecision] at rightDecision
          cases rightDecision
          rfl
      | gateRewriteRefused rightLive rightPending rightGate rightDecision rightRewrote =>
          rw [leftPending] at rightPending
          cases rightPending
          rw [leftDecision] at rightDecision
          cases rightDecision
  | gateRewriteRefused leftLive leftPending leftGate leftDecision leftRewrote =>
      cases two with
      | proceed rightLive rightPending rightDecision rightFidelity =>
          rw [leftPending] at rightPending
          cases rightPending
          rw [leftDecision] at rightDecision
          cases rightDecision
          exact absurd (rightFidelity leftGate) leftRewrote
      | block rightLive rightPending rightDecision =>
          rw [leftPending] at rightPending
          cases rightPending
          rw [leftDecision] at rightDecision
          cases rightDecision
      | gateRewriteRefused rightLive rightPending rightGate rightDecision rightRewrote =>
          rw [leftPending] at rightPending
          cases rightPending
          rfl

theorem halted_state_has_no_step {behave : InterceptorBehavior}
    {state next : InterceptionState} (halted : state.Halted) :
    ¬ InterceptStep behave state next := by
  intro step
  rcases halted with empty | blockedNow
  · cases step with
    | proceed live pending _ _ => rw [empty] at pending; cases pending
    | block live pending _ => rw [empty] at pending; cases pending
    | gateRewriteRefused live pending _ _ _ => rw [empty] at pending; cases pending
  · cases step with
    | proceed live _ _ _ => exact blockedNow live
    | block live _ _ => exact blockedNow live
    | gateRewriteRefused live _ _ _ _ => exact blockedNow live

/-- **A `gate` never rewrites the value it received (§4.4 rule 10).** Any step that advances
past a gate contribution without blocking leaves the value in flight exactly as it was, so the
mutating distinction the attribution and replay clauses depend on is declared rather than
discovered from a completed run. -/
theorem gate_never_rewrites {behave : InterceptorBehavior} {current next : InterceptionState}
    {contribution : InterceptorContribution} {rest : List InterceptorContribution}
    (pending : current.pending = contribution :: rest)
    (gate : contribution.mode = .gate)
    (step : InterceptStep behave current next) (unblocked : next.blocked = none) :
    next.value = current.value := by
  cases step with
  | @proceed head tail candidate _ statePending _ fidelity =>
      rw [pending] at statePending
      obtain ⟨sameHead, _⟩ := List.cons.inj statePending
      exact fidelity (sameHead ▸ gate)
  | block _ _ _ => simp at unblocked
  | gateRewriteRefused _ _ _ _ _ => simp at unblocked

/-- **A `gate` result whose value differs is refused as a scoped block naming that
interceptor (§4.4 rule 10).** The refusal is available, and it is the only step available:
`proceed` cannot admit the rewrite, so every step out of this state blocks. -/
theorem gate_rewrite_is_refused {behave : InterceptorBehavior} {state : InterceptionState}
    {contribution : InterceptorContribution} {rest : List InterceptorContribution}
    {output : StructuralValue}
    (unblocked : state.blocked = none) (pending : state.pending = contribution :: rest)
    (gate : contribution.mode = .gate)
    (decision : behave contribution.interceptor state.value = .proceed output)
    (rewrote : output ≠ state.value) :
    InterceptStep behave state
        ⟨state.input, state.value, state.trace, rest,
          some ⟨contribution.interceptor, gateRewriteRefusal⟩⟩ ∧
      ∀ after, InterceptStep behave state after → after.blocked ≠ none := by
  refine ⟨.gateRewriteRefused unblocked pending gate decision rewrote, ?_⟩
  intro after step
  cases step with
  | @proceed head tail candidate _ statePending stepDecision fidelity =>
      rw [pending] at statePending
      obtain ⟨sameHead, _⟩ := List.cons.inj statePending
      subst sameHead
      rw [decision] at stepDecision
      obtain sameOutput := InterceptDecision.proceed.inj stepDecision
      exact absurd (sameOutput ▸ fidelity gate) rewrote
  | block _ _ _ => simp
  | gateRewriteRefused _ _ _ _ _ => simp

theorem halted_run_is_stationary {behave : InterceptorBehavior}
    {state last : InterceptionState} (halted : state.Halted)
    (run : InterceptRun behave state last) : last = state := by
  cases run with
  | refl => rfl
  | step step _ => exact absurd step (halted_state_has_no_step halted)

/-- Whole-pipeline determinism: from one start, all halted outcomes coincide — the
result, the recorded trace, and any block are unique. -/
theorem interception_outcome_deterministic {behave : InterceptorBehavior}
    {start left right : InterceptionState}
    (one : InterceptRun behave start left) (leftHalted : left.Halted)
    (two : InterceptRun behave start right) (rightHalted : right.Halted) :
    left = right := by
  induction one generalizing right with
  | refl => exact (halted_run_is_stationary leftHalted two).symm
  | step step rest ih =>
      cases two with
      | refl => exact absurd step (halted_state_has_no_step rightHalted)
      | step step' rest' =>
          cases intercept_step_deterministic step step'
          exact ih leftHalted rest' rightHalted

theorem transformation_chain_snoc {input middle output : StructuralValue}
    {trace : List InterceptorTransformation} {interceptor : InterceptorRef}
    (chain : TransformationChain input middle trace) :
    TransformationChain input output (trace ++ [⟨interceptor, middle, output⟩]) := by
  induction trace generalizing input with
  | nil => exact ⟨chain.symm, rfl⟩
  | cons entry rest ih => exact ⟨chain.1, ih chain.2⟩

/-- Invariant over the step relation: every reachable trace is the exact nested
transformation chain from the original value in flight to the current one — the same
`TransformationChain` a persisted `ReplayItem` must satisfy (§4.4 rules 5 and 7). -/
theorem run_records_transformation_chain {behave : InterceptorBehavior}
    {schedule : List InterceptorContribution} {input : StructuralValue}
    {state : InterceptionState}
    (run : InterceptRun behave (startInterception schedule input) state) :
    state.input = input ∧ TransformationChain input state.value state.trace := by
  refine intercept_run_preserves
    (motive := fun current =>
      current.input = input ∧ TransformationChain input current.value current.trace)
    ?_ run ⟨rfl, rfl⟩
  intro current next invariant step
  cases step with
  | proceed live pending decision fidelity =>
      exact ⟨invariant.1, transformation_chain_snoc invariant.2⟩
  | block live pending decision => exact invariant
  | gateRewriteRefused live pending gate decision rewrote => exact invariant

/-- The last recorded rewriting transformation: later entries all passed the value
through unchanged. -/
def lastRewrite : List InterceptorTransformation → Option InterceptorTransformation
  | [] => none
  | entry :: rest =>
      match lastRewrite rest with
      | some found => some found
      | none => if entry.input = entry.output then none else some entry

theorem lastRewrite_snoc (trace : List InterceptorTransformation)
    (entry : InterceptorTransformation) :
    lastRewrite (trace ++ [entry]) =
      if entry.input = entry.output then lastRewrite trace else some entry := by
  induction trace with
  | nil => rfl
  | cons head rest ih =>
      by_cases rewrote : entry.input = entry.output
      · simp only [List.cons_append, lastRewrite, ih, if_pos rewrote]
      · simp only [List.cons_append, lastRewrite, ih, if_neg rewrote]

theorem lastRewrite_rewrites {trace : List InterceptorTransformation}
    {entry : InterceptorTransformation} (found : lastRewrite trace = some entry) :
    entry ∈ trace ∧ entry.input ≠ entry.output := by
  induction trace with
  | nil => cases found
  | cons head rest ih =>
      simp only [lastRewrite] at found
      split at found
      · next inner =>
          obtain ⟨member, rewrites⟩ := ih (inner.trans found)
          exact ⟨List.Mem.tail _ member, rewrites⟩
      · split at found
        · cases found
        · next changed =>
            cases found
            exact ⟨List.mem_cons_self, changed⟩

theorem lastRewrite_none_all_unchanged {trace : List InterceptorTransformation}
    (nothing : lastRewrite trace = none) :
    ∀ entry, entry ∈ trace → entry.input = entry.output := by
  induction trace with
  | nil => intro entry member; cases member
  | cons head rest ih =>
      intro entry member
      simp only [lastRewrite] at nothing
      split at nothing
      · cases nothing
      · next inner =>
          split at nothing
          · next unchanged =>
              rcases List.mem_cons.mp member with rfl | inRest
              · exact unchanged
              · exact ih inner entry inRest
          · cases nothing

/-- Every entry after the last rewrite passed the value through unchanged: `lastRewrite`
names the interceptor that genuinely rewrote last, not merely some rewriter. -/
theorem lastRewrite_is_final {trace : List InterceptorTransformation}
    {entry : InterceptorTransformation} (found : lastRewrite trace = some entry) :
    ∃ recorded later, trace = recorded ++ entry :: later ∧
      ∀ passed, passed ∈ later → passed.input = passed.output := by
  induction trace with
  | nil => cases found
  | cons head rest ih =>
      simp only [lastRewrite] at found
      split at found
      · next inner =>
          obtain ⟨recorded, later, shape, unchanged⟩ := ih (inner.trans found)
          exact ⟨head :: recorded, later, by rw [shape]; rfl, unchanged⟩
      · next inner =>
          split at found
          · cases found
          · cases found
            exact ⟨[], rest, rfl, lastRewrite_none_all_unchanged inner⟩

/-- Attribution completeness as an invariant over the step relation (§4.4 rules 3 and
5): in every reachable state, either the value in flight is still the submitted input,
or the trace names the interceptor that last rewrote it and that entry's recorded
output is the current value. -/
theorem run_attributes_last_rewriter {behave : InterceptorBehavior}
    {schedule : List InterceptorContribution} {input : StructuralValue}
    {state : InterceptionState}
    (run : InterceptRun behave (startInterception schedule input) state) :
    match lastRewrite state.trace with
    | some entry => entry.output = state.value
    | none => state.value = input := by
  refine intercept_run_preserves
    (motive := fun current =>
      match lastRewrite current.trace with
      | some entry => entry.output = current.value
      | none => current.value = input)
    ?_ run rfl
  intro current next invariant step
  cases step with
  | block live pending decision => exact invariant
  | gateRewriteRefused live pending gate decision rewrote => exact invariant
  | @proceed contribution rest output live pending decision fidelity =>
      show match lastRewrite
          (current.trace ++ [⟨contribution.interceptor, current.value, output⟩]) with
        | some entry => entry.output = output
        | none => output = input
      rw [lastRewrite_snoc]
      by_cases rewrote : current.value = output
      · rw [if_pos rewrote]
        revert invariant
        cases lastRewrite current.trace with
        | some entry => exact fun invariant => invariant.trans rewrote
        | none => exact fun invariant => rewrote ▸ invariant
      · rw [if_neg rewrote]

/-- A rewritten value in any reachable state is attributed: the trace contains the
entry of the interceptor that last rewrote it, every later entry passed the value
through unchanged, and the entry's recorded output is the current value. -/
theorem run_rewritten_value_names_last_rewriter {behave : InterceptorBehavior}
    {schedule : List InterceptorContribution} {input : StructuralValue}
    {state : InterceptionState}
    (run : InterceptRun behave (startInterception schedule input) state)
    (rewritten : state.value ≠ input) :
    ∃ entry, lastRewrite state.trace = some entry ∧ entry ∈ state.trace ∧
      entry.input ≠ entry.output ∧ entry.output = state.value := by
  have attributed := run_attributes_last_rewriter run
  cases found : lastRewrite state.trace with
  | none => rw [found] at attributed; exact absurd attributed rewritten
  | some entry =>
      rw [found] at attributed
      obtain ⟨member, rewrites⟩ := lastRewrite_rewrites found
      exact ⟨entry, rfl, member, rewrites, attributed⟩

/-- Invariant over the step relation: the schedule splits exactly into the consumed
prefix and the pending suffix, the trace names the consumed interceptors in schedule
order, and a block names the exact contribution it happened at. -/
theorem run_consumes_schedule_in_order {behave : InterceptorBehavior}
    {schedule : List InterceptorContribution} {input : StructuralValue}
    {state : InterceptionState}
    (run : InterceptRun behave (startInterception schedule input) state) :
    ∃ consumed, schedule = consumed ++ state.pending ∧
      match state.blocked with
      | none =>
          state.trace.map InterceptorTransformation.interceptor =
            consumed.map InterceptorContribution.interceptor
      | some blockedOn => ∃ ran blocker, consumed = ran ++ [blocker] ∧
          blocker.interceptor = blockedOn.interceptor ∧
          state.trace.map InterceptorTransformation.interceptor =
            ran.map InterceptorContribution.interceptor := by
  refine intercept_run_preserves
    (motive := fun current => ∃ consumed, schedule = consumed ++ current.pending ∧
      match current.blocked with
      | none =>
          current.trace.map InterceptorTransformation.interceptor =
            consumed.map InterceptorContribution.interceptor
      | some blockedOn => ∃ ran blocker, consumed = ran ++ [blocker] ∧
          blocker.interceptor = blockedOn.interceptor ∧
          current.trace.map InterceptorTransformation.interceptor =
            ran.map InterceptorContribution.interceptor)
    ?_ run ⟨[], rfl, rfl⟩
  intro current next invariant step
  obtain ⟨consumed, split, traced⟩ := invariant
  cases step with
  | @proceed contribution rest output live pending decision fidelity =>
      simp only [live] at traced
      refine ⟨consumed ++ [contribution], ?_, ?_⟩
      · rw [split, pending, List.append_assoc]; rfl
      · show (current.trace ++
              [(⟨contribution.interceptor, current.value, output⟩ :
                InterceptorTransformation)]).map
            InterceptorTransformation.interceptor =
          (consumed ++ [contribution]).map InterceptorContribution.interceptor
        rw [List.map_append, List.map_append, traced]; rfl
  | @block contribution rest reason live pending decision =>
      simp only [live] at traced
      refine ⟨consumed ++ [contribution], ?_, ?_⟩
      · rw [split, pending, List.append_assoc]; rfl
      · show ∃ ran blocker, consumed ++ [contribution] = ran ++ [blocker] ∧
            blocker.interceptor =
              (⟨contribution.interceptor, reason⟩ : InterceptionBlock).interceptor ∧
            current.trace.map InterceptorTransformation.interceptor =
              ran.map InterceptorContribution.interceptor
        exact ⟨consumed, contribution, rfl, rfl, traced⟩
  | @gateRewriteRefused contribution rest output live pending gate decision rewrote =>
      simp only [live] at traced
      refine ⟨consumed ++ [contribution], ?_, ?_⟩
      · rw [split, pending, List.append_assoc]; rfl
      · show ∃ ran blocker, consumed ++ [contribution] = ran ++ [blocker] ∧
            blocker.interceptor =
              (⟨contribution.interceptor, gateRewriteRefusal⟩ : InterceptionBlock).interceptor ∧
            current.trace.map InterceptorTransformation.interceptor =
              ran.map InterceptorContribution.interceptor
        exact ⟨consumed, contribution, rfl, rfl, traced⟩

/-- A completed pipeline recorded the whole schedule, in the deterministic order. -/
theorem completed_trace_records_schedule_order {behave : InterceptorBehavior}
    {schedule : List InterceptorContribution} {input : StructuralValue}
    {state : InterceptionState}
    (run : InterceptRun behave (startInterception schedule input) state)
    (completed : state.Completed) :
    state.trace.map InterceptorTransformation.interceptor =
      schedule.map InterceptorContribution.interceptor := by
  obtain ⟨consumed, split, traced⟩ := run_consumes_schedule_in_order run
  simp only [completed.2] at traced
  rw [split, completed.1, List.append_nil]
  exact traced

/-- A blocked pipeline names the exact scheduled contribution that blocked, with the
untouched trace prefix of everything that ran before it (§4.4 rule 4). -/
theorem blocked_names_exact_scheduled_interceptor {behave : InterceptorBehavior}
    {schedule : List InterceptorContribution} {input : StructuralValue}
    {state : InterceptionState} {blockedOn : InterceptionBlock}
    (run : InterceptRun behave (startInterception schedule input) state)
    (blockedNow : state.blocked = some blockedOn) :
    ∃ ran blocker, schedule = ran ++ blocker :: state.pending ∧
      blocker.interceptor = blockedOn.interceptor ∧
      state.trace.map InterceptorTransformation.interceptor =
        ran.map InterceptorContribution.interceptor := by
  obtain ⟨consumed, split, traced⟩ := run_consumes_schedule_in_order run
  simp only [blockedNow] at traced
  obtain ⟨ran, blocker, shape, named, prefixTraced⟩ := traced
  refine ⟨ran, blocker, ?_, named, prefixTraced⟩
  rw [split, shape, List.append_assoc]
  rfl

/-- A block is final: no continuation of a blocked pipeline ever completes (§4.4
rule 4 — a thrown error blocks, it is not skipped over). -/
theorem blocked_pipeline_never_completes {behave : InterceptorBehavior}
    {state last : InterceptionState} {blockedOn : InterceptionBlock}
    (blockedNow : state.blocked = some blockedOn)
    (run : InterceptRun behave state last) : ¬ last.Completed := by
  intro completed
  have stationary := halted_run_is_stationary
    (Or.inr fun isNone => by rw [blockedNow] at isNone; cases isNone) run
  rw [stationary] at completed
  have final := completed.2
  rw [blockedNow] at final
  cases final

/-- Replay applies a persisted transformation trace to a value. It validates every
nested link and reads no interceptor: reuse never reruns behavior (§4.4 rules 7-8). -/
def replayInterceptions : StructuralValue → List InterceptorTransformation →
    Option StructuralValue
  | value, [] => some value
  | value, entry :: rest =>
      if entry.input = value then replayInterceptions entry.output rest else none

theorem replay_matches_chain {input output : StructuralValue}
    {trace : List InterceptorTransformation} :
    replayInterceptions input trace = some output ↔
      TransformationChain input output trace := by
  induction trace generalizing input with
  | nil => simp [replayInterceptions, TransformationChain]
  | cons entry rest ih =>
      simp only [replayInterceptions, TransformationChain]
      by_cases link : entry.input = input
      · rw [if_pos link]
        exact ⟨fun replayed => ⟨link, ih.mp replayed⟩, fun chain => ih.mpr chain.2⟩
      · rw [if_neg link]
        constructor
        · intro impossible; cases impossible
        · intro chain; exact absurd chain.1 link

/-- Replay determinism: one persisted trace admits at most one result. -/
theorem interception_replay_deterministic {input leftOutput rightOutput : StructuralValue}
    {trace : List InterceptorTransformation}
    (left : TransformationChain input leftOutput trace)
    (right : TransformationChain input rightOutput trace) : leftOutput = rightOutput := by
  have leftReplay := replay_matches_chain.mpr left
  rw [replay_matches_chain.mpr right] at leftReplay
  exact (Option.some.inj leftReplay).symm

/-- Replaying the recorded trace of any reachable pipeline state reproduces its exact
value. The conclusion never mentions the behavior: replay reuses the persisted
transformations and reruns no interceptor (C13-INTERCEPTOR-REPLAY,
C13-INTERCEPTOR-FROZEN-RETRY). -/
theorem run_replay_reproduces_result {behave : InterceptorBehavior}
    {schedule : List InterceptorContribution} {input : StructuralValue}
    {state : InterceptionState}
    (run : InterceptRun behave (startInterception schedule input) state) :
    replayInterceptions input state.trace = some state.value :=
  replay_matches_chain.mpr (run_records_transformation_chain run).2

/-- Replay fails exactly on tampered traces: a trace refuses to replay iff no output
completes it as a nested chain. -/
theorem replay_refuses_exactly_broken_chains {input : StructuralValue}
    {trace : List InterceptorTransformation} :
    replayInterceptions input trace = none ↔
      ¬ ∃ output, TransformationChain input output trace := by
  constructor
  · intro refused ⟨output, chain⟩
    rw [replay_matches_chain.mpr chain] at refused
    cases refused
  · intro noChain
    cases replayed : replayInterceptions input trace with
    | none => rfl
    | some output => exact absurd ⟨output, replay_matches_chain.mp replayed⟩ noChain

/-- A persisted `ReplayItem` pins both phases: its before chain replays to exactly the
persisted prepared arguments and its after chain to exactly the persisted
presentation, without rerunning either interceptor pass (§4.4 rules 7-8). -/
theorem replay_item_reuses_persisted_transformations {replay : ReplayItem}
    {item : PreparedItem} (valid : replay.ValidFor item) :
    replayInterceptions item.arguments replay.before = some replay.preparedArguments ∧
    replayInterceptions replay.effectOutput replay.after = some replay.presentation :=
  ⟨replay_matches_chain.mpr valid.2.2.1, replay_matches_chain.mpr valid.2.2.2⟩

/-- Two completed pipeline runs — `operation.before` over an item's arguments and
`operation.after` over its effect output — assemble a `ReplayItem` the structural
replay model validates for that exact item: the runtime pipeline records precisely
what mediated replay persists and reuses. -/
theorem completed_runs_assemble_valid_replay_item {behave : InterceptorBehavior}
    {beforeSchedule afterSchedule : List InterceptorContribution} {item : PreparedItem}
    {effectOutput : StructuralValue} {beforeFinal afterFinal : InterceptionState}
    (beforeRun : InterceptRun behave
      (startInterception beforeSchedule item.arguments) beforeFinal)
    (afterRun : InterceptRun behave
      (startInterception afterSchedule effectOutput) afterFinal) :
    ReplayItem.ValidFor
      ⟨item.index, item.key, beforeFinal.trace, beforeFinal.value, effectOutput,
        afterFinal.trace, afterFinal.value⟩ item :=
  ⟨rfl, rfl, (run_records_transformation_chain beforeRun).2,
    (run_records_transformation_chain afterRun).2⟩

/-- The cut an interception targets: the operation, its protection domain, and whether
the target Facet declared it interceptable (§4.4 rules 1-2). -/
structure InterceptionSite where
  operation : OperationId
  domain : ProtectionDomain
  interceptable : Bool
  deriving Repr

/-- §4.4 rules 1-2. Self-scope needs nothing further; a foreign contributor needs the
target declared interceptable and a Grant, and always the same protection domain.
Sharing a domain confers no interception rights by itself. -/
def MayIntercept (granted : FacetId → OperationId → Prop)
    (domainOf : FacetId → ProtectionDomain) (site : InterceptionSite)
    (contribution : InterceptorContribution) : Prop :=
  domainOf contribution.interceptor.facet = site.domain ∧
    (contribution.interceptor.facet = site.operation.facet ∨
      (site.interceptable = true ∧ granted contribution.interceptor.facet site.operation))

theorem cross_domain_interception_rejected {granted : FacetId → OperationId → Prop}
    {domainOf : FacetId → ProtectionDomain} {site : InterceptionSite}
    {contribution : InterceptorContribution}
    (foreignDomain : domainOf contribution.interceptor.facet ≠ site.domain) :
    ¬ MayIntercept granted domainOf site contribution :=
  fun may => foreignDomain may.1

/-- The four parameters of one interception decision, bundled so the rule can be stated as
    a property of a single subject. `cross_domain_interception_rejected` proves the same
    fact over the loose parameters; this record adds no content. -/
structure InterceptionQuestion where
  granted : FacetId → OperationId → Prop
  domainOf : FacetId → ProtectionDomain
  site : InterceptionSite
  contribution : InterceptorContribution

/-- The contribution's Facet lives in a different protection domain from the site. -/
def InterceptionQuestion.Foreign (question : InterceptionQuestion) : Prop :=
  question.domainOf question.contribution.interceptor.facet ≠ question.site.domain

/-- The contribution may intercept at the site. -/
def InterceptionQuestion.Admits (question : InterceptionQuestion) : Prop :=
  MayIntercept question.granted question.domainOf question.site question.contribution

/-- **Interceptors are domain-confined, as a property of one interception question.** A
    restatement of `cross_domain_interception_rejected` over `InterceptionQuestion`. -/
theorem foreign_question_never_intercepts {question : InterceptionQuestion}
    (foreign : question.Foreign) : ¬ question.Admits :=
  cross_domain_interception_rejected foreign

theorem undeclared_cross_facet_interception_rejected
    {granted : FacetId → OperationId → Prop} {domainOf : FacetId → ProtectionDomain}
    {site : InterceptionSite} {contribution : InterceptorContribution}
    (foreignFacet : contribution.interceptor.facet ≠ site.operation.facet)
    (undeclared : site.interceptable = false) :
    ¬ MayIntercept granted domainOf site contribution := by
  intro may
  rcases may.2 with own | ⟨declared, _⟩
  · exact foreignFacet own
  · rw [undeclared] at declared; cases declared

theorem ungranted_cross_facet_interception_rejected
    {granted : FacetId → OperationId → Prop} {domainOf : FacetId → ProtectionDomain}
    {site : InterceptionSite} {contribution : InterceptorContribution}
    (foreignFacet : contribution.interceptor.facet ≠ site.operation.facet)
    (ungranted : ¬ granted contribution.interceptor.facet site.operation) :
    ¬ MayIntercept granted domainOf site contribution := by
  intro may
  rcases may.2 with own | ⟨_, grant⟩
  · exact foreignFacet own
  · exact ungranted grant

/-- A schedule admitted at a site: ascending order, one cut point, and every
contribution authorized to intercept there. -/
def AdmittedSchedule (granted : FacetId → OperationId → Prop)
    (domainOf : FacetId → ProtectionDomain) (site : InterceptionSite) (cut : CutPoint)
    (schedule : List InterceptorContribution) : Prop :=
  ScheduleOrdered schedule ∧ ∀ contribution, contribution ∈ schedule →
    contribution.cutPoint = cut ∧ MayIntercept granted domainOf site contribution

/-- Invariant over the step relation: every transformation a reachable state records
is attributed to a contribution the site admitted. -/
theorem run_trace_is_admitted {behave : InterceptorBehavior}
    {granted : FacetId → OperationId → Prop} {domainOf : FacetId → ProtectionDomain}
    {site : InterceptionSite} {cut : CutPoint}
    {schedule : List InterceptorContribution} {input : StructuralValue}
    {state : InterceptionState}
    (admitted : AdmittedSchedule granted domainOf site cut schedule)
    (run : InterceptRun behave (startInterception schedule input) state) :
    ∀ entry, entry ∈ state.trace → ∃ contribution, contribution ∈ schedule ∧
      contribution.interceptor = entry.interceptor ∧ contribution.cutPoint = cut ∧
      MayIntercept granted domainOf site contribution := by
  intro entry member
  obtain ⟨consumed, split, traced⟩ := run_consumes_schedule_in_order run
  have named : entry.interceptor ∈ consumed.map InterceptorContribution.interceptor := by
    cases blockedNow : state.blocked with
    | none =>
        simp only [blockedNow] at traced
        rw [← traced]
        exact List.mem_map_of_mem member
    | some blockedOn =>
        simp only [blockedNow] at traced
        obtain ⟨ran, blocker, shape, _, prefixTraced⟩ := traced
        rw [shape, List.map_append]
        exact List.mem_append_left _ (prefixTraced ▸ List.mem_map_of_mem member)
  obtain ⟨contribution, inConsumed, sameRef⟩ := List.mem_map.mp named
  have inSchedule : contribution ∈ schedule := by
    rw [split]
    exact List.mem_append_left _ inConsumed
  obtain ⟨atCut, may⟩ := admitted.2 contribution inSchedule
  exact ⟨contribution, inSchedule, sameRef, atCut, may⟩

/-- The rules-1-2 safety consequence: an interceptor without authority at the site —
wrong protection domain, or foreign to the target without its opt-in and a Grant —
is never attributed a transformation in any reachable state. -/
theorem unauthorized_interceptor_never_attributed {behave : InterceptorBehavior}
    {granted : FacetId → OperationId → Prop} {domainOf : FacetId → ProtectionDomain}
    {site : InterceptionSite} {cut : CutPoint}
    {schedule : List InterceptorContribution} {input : StructuralValue}
    {state : InterceptionState} {intruder : InterceptorRef}
    (admitted : AdmittedSchedule granted domainOf site cut schedule)
    (run : InterceptRun behave (startInterception schedule input) state)
    (unauthorized : ∀ contribution : InterceptorContribution,
      contribution.interceptor = intruder →
        ¬ MayIntercept granted domainOf site contribution) :
    ∀ entry, entry ∈ state.trace → entry.interceptor ≠ intruder := by
  intro entry member same
  obtain ⟨contribution, _, sameRef, _, may⟩ := run_trace_is_admitted admitted run entry member
  exact unauthorized contribution (sameRef.trans same) may

end AgentCore
