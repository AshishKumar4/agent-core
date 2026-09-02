import AgentCore.Substrate.Effect

/-!
# Loading code into a `dynamic` protection domain

§4.7 code — programmatic tool calls, Slate backends, agent-authored facets — runs in a
`dynamic` domain, and §10.2 gives that domain three rules this seam is shaped by.

**A load carries an exact resource bound, and the host states it.** "A submission never
states its own bound, and a host that cannot bound a submission MUST refuse to load it
rather than run it against that budget" — because "an unbounded compute budget is something
held — a denial-of-service capability nobody delegated, that no Grant names, and that
revoking nothing withdraws" (`C13-CLOUDFLARE-DYNAMIC-COMPUTE-BOUND`). So the bound is an
`Option` in the request and `load_requires_bound` refuses `none`. The refusal is an
equation, not a review note.

**Warm reuse is keyed on the whole load or it does not happen.** Worker Loader will hold an
isolate under a caller-chosen name and skip the code callback entirely — including the part
that supplies the capability set — so "a reuse identity MUST therefore cover every input the
load fixes, the delegated capability set included. Since §4.7 gives each submission its own
delegation, no two submissions share such an identity, so this profile loads a fresh isolate
per submission" (`C13-CLOUDFLARE-DYNAMIC-ISOLATE-IDENTITY`). `load_allocates_fresh` is that
decision: a load never returns a live isolate. `loads_never_share_an_isolate` and
`sibling_load_cannot_reach_another_delegation` are what it buys — no submission ever
observes another's capability set.

**The domain's own store is nobody else's.** `C13-CLOUDFLARE-DYNAMIC-STORE-CUSTODY` forbids
storing a record type with an owning Actor inside a `dynamic` domain and forbids satisfying
a rule with a value read back out of one. At this seam the rule needs no enforcement code,
because the opcode set has no operation that reads such a store:
`Opcode.isolate_seam_has_no_store_access` in `AgentCore.Substrate.Effect` is the proof, and
it is a proof about the interface rather than about a call site.

## What stays a premise

Everything about what happens *inside* the isolate. `Premise.isolateNoAmbientEgress` (code
in the isolate reaches the network only through an explicitly passed Binding, because
`globalOutbound` is fixed where the isolate is built),
`Premise.isolateBoundEnforcedByRuntime` (the runtime throws at the boundary when the bound
is reached), `Premise.isolatePrivateStoreUnreadable`, and
`Premise.isolateFreshLoadPerSubmission` (the platform's own caching behaviour). No equation
over `IsolateEffect` can state any of them: this interface can say what the host was asked
for and what it answered, and §10.2 is explicit that "an assertion that the host supplied
the right argument is not this evidence, because it observes the host's intent and not the
domain's reach". The discharge is code running in a real isolate of each offered backing,
and that is a conformance lane, not a theorem.
-/

namespace AgentCore.Substrate

/-- The per-invocation resource bound a host states for a load: a maximum CPU time and a
maximum subrequest count, which the runtime enforces by throwing at the boundary. -/
structure ComputeBound where
  cpuMillis : Nat
  subrequests : Nat
  deriving DecidableEq, Repr

/-- The isolate requests a kernel can issue: wire tails of `Opcode.isolateLoad` and
`Opcode.isolateCall`. There is deliberately no store operation and no bound-free load. -/
inductive IsolateOp where
  | load (codeDigest : ByteArray) (capabilities : List ByteArray) (bound : Option ComputeBound)
  | call (isolate : Nat) (request : ByteArray)
  deriving DecidableEq

/-- Which opcode an isolate request is. -/
def IsolateOp.opcode : IsolateOp → Opcode
  | .load _ _ _ => .isolateLoad
  | .call _ _ => .isolateCall

/-- Every isolate request lands on the isolate seam. -/
theorem IsolateOp.opcode_seam (op : IsolateOp) : op.opcode.seam = .isolate := by
  cases op <;> rfl

/-- What a load or a call can answer. -/
inductive IsolateReply where
  | loaded (isolate : Nat)
  | response (body : ByteArray)
  | refused (refusal : Refusal)
  deriving DecidableEq

/-- The isolate interface, synchronous store-passing over an explicit `σ`. -/
structure IsolateEffect (σ : Type) where
  load : ByteArray → List ByteArray → Option ComputeBound → σ → IsolateReply × σ
  call : Nat → ByteArray → σ → IsolateReply × σ

/-- What the model observes about loaded isolates: which are live, which capability set each
one reaches, and which submission each was loaded from. Proof plumbing, erased at
lowering. -/
structure IsolateView (σ : Type) where
  live : σ → Nat → Bool
  reach : σ → Nat → List ByteArray
  submission : σ → Nat → ByteArray

/--
The isolate laws.

Two of them carry the profile's decisions rather than the platform's behaviour, and that is
intentional: `load_requires_bound` is the host refusing to load what it cannot bound, and
`load_allocates_fresh` is the host declining to key a warm cache it cannot key correctly.
Both are properties of the seam the host offers the kernel, so both are checkable at the
seam.
-/
structure IsolateLaws {σ : Type} (effect : IsolateEffect σ) (view : IsolateView σ) : Prop where
  /-- A load with no stated bound is refused, and nothing is loaded
  (`C13-CLOUDFLARE-DYNAMIC-COMPUTE-BOUND`). -/
  load_requires_bound : ∀ codeDigest capabilities state,
    effect.load codeDigest capabilities none state = (.refused .unbounded, state)
  /-- A load never hands back an isolate that is already live: fresh per submission
  (`C13-CLOUDFLARE-DYNAMIC-ISOLATE-IDENTITY`). -/
  load_allocates_fresh : ∀ codeDigest capabilities bound state isolate,
    (effect.load codeDigest capabilities (some bound) state).1 = .loaded isolate →
      view.live state isolate = false
  /-- A loaded isolate is live. -/
  load_makes_live : ∀ codeDigest capabilities bound state isolate,
    (effect.load codeDigest capabilities (some bound) state).1 = .loaded isolate →
      view.live (effect.load codeDigest capabilities (some bound) state).2 isolate = true
  /-- A loaded isolate reaches exactly the capability set the load passed it — no ambient
  addition, and no severed capability either. -/
  load_reaches_exactly_delegated : ∀ codeDigest capabilities bound state isolate,
    (effect.load codeDigest capabilities (some bound) state).1 = .loaded isolate →
      view.reach (effect.load codeDigest capabilities (some bound) state).2 isolate =
        capabilities
  /-- A loaded isolate records the submission it came from. -/
  load_records_submission : ∀ codeDigest capabilities bound state isolate,
    (effect.load codeDigest capabilities (some bound) state).1 = .loaded isolate →
      view.submission (effect.load codeDigest capabilities (some bound) state).2 isolate =
        codeDigest
  /-- Loading one submission changes no other isolate's liveness. -/
  load_preserves_other_liveness : ∀ codeDigest capabilities bound state isolate other,
    (effect.load codeDigest capabilities (some bound) state).1 = .loaded isolate →
      other ≠ isolate →
        view.live (effect.load codeDigest capabilities (some bound) state).2 other =
          view.live state other
  /-- Nor any other isolate's capability set: a later submission cannot widen an earlier
  one. -/
  load_preserves_other_reach : ∀ codeDigest capabilities bound state isolate other,
    (effect.load codeDigest capabilities (some bound) state).1 = .loaded isolate →
      other ≠ isolate →
        view.reach (effect.load codeDigest capabilities (some bound) state).2 other =
          view.reach state other
  /-- A call into an isolate that is not live is refused, with the state untouched. A
  destroyed or never-loaded domain answers nothing. -/
  call_requires_live : ∀ isolate request state, view.live state isolate = false →
    effect.call isolate request state = (.refused .disposed, state)
  /-- A call does not change any isolate's capability set. Whatever the loaded code does, it
  cannot widen its own reach or anyone else's through this seam. -/
  call_preserves_reach : ∀ isolate request target state,
    view.reach (effect.call isolate request state).2 target = view.reach state target

section Delegation

variable {σ : Type} {effect : IsolateEffect σ} {view : IsolateView σ}

/-- A load the host cannot bound leaves the world exactly as it was: no isolate, no state
change, and therefore no unbounded compute anywhere. -/
theorem unbounded_load_changes_nothing (laws : IsolateLaws effect view)
    (codeDigest : ByteArray) (capabilities : List ByteArray) (state : σ) :
    (effect.load codeDigest capabilities none state).2 = state := by
  rw [laws.load_requires_bound codeDigest capabilities state]

/-- An unbounded load loads nothing at all. -/
theorem unbounded_load_yields_no_isolate (laws : IsolateLaws effect view)
    (codeDigest : ByteArray) (capabilities : List ByteArray) (state : σ) (isolate : Nat) :
    (effect.load codeDigest capabilities none state).1 ≠ .loaded isolate := by
  rw [laws.load_requires_bound codeDigest capabilities state]
  simp

/--
Two submissions never share an isolate.

This is `C13-CLOUDFLARE-DYNAMIC-ISOLATE-IDENTITY`'s consequence, and the reason the profile
declines to key a warm cache: the second load's own freshness law says the isolate it
returns was not live, and the first load's says its isolate is. So they are different
isolates whatever the two submissions' code and capabilities were — including the case the
rule exists for, where the code digests are equal and the delegated capability sets are
not.
-/
theorem loads_never_share_an_isolate (laws : IsolateLaws effect view)
    {firstCode secondCode : ByteArray} {firstCaps secondCaps : List ByteArray}
    {firstBound secondBound : ComputeBound} {state : σ} {firstIsolate secondIsolate : Nat}
    (first : (effect.load firstCode firstCaps (some firstBound) state).1 = .loaded firstIsolate)
    (second : (effect.load secondCode secondCaps (some secondBound)
        (effect.load firstCode firstCaps (some firstBound) state).2).1 = .loaded secondIsolate) :
    firstIsolate ≠ secondIsolate := by
  intro same
  have live : view.live (effect.load firstCode firstCaps (some firstBound) state).2
      firstIsolate = true :=
    laws.load_makes_live firstCode firstCaps firstBound state firstIsolate first
  have fresh : view.live (effect.load firstCode firstCaps (some firstBound) state).2
      secondIsolate = false :=
    laws.load_allocates_fresh secondCode secondCaps secondBound _ secondIsolate second
  rw [same] at live
  rw [live] at fresh
  exact Bool.noConfusion fresh

/--
A later submission cannot reach an earlier submission's delegation, and the earlier one
keeps exactly what it was passed.

This is the failure §10.2 describes — "an identity covering the submitted code alone would
hand a later submission an isolate still holding an earlier submission's Bindings" — ruled
out from the laws rather than by convention.
-/
theorem sibling_load_cannot_reach_another_delegation (laws : IsolateLaws effect view)
    {firstCode secondCode : ByteArray} {firstCaps secondCaps : List ByteArray}
    {firstBound secondBound : ComputeBound} {state : σ} {firstIsolate secondIsolate : Nat}
    (first : (effect.load firstCode firstCaps (some firstBound) state).1 = .loaded firstIsolate)
    (second : (effect.load secondCode secondCaps (some secondBound)
        (effect.load firstCode firstCaps (some firstBound) state).2).1 = .loaded secondIsolate) :
    view.reach (effect.load secondCode secondCaps (some secondBound)
        (effect.load firstCode firstCaps (some firstBound) state).2).2 firstIsolate =
      firstCaps ∧
    view.reach (effect.load secondCode secondCaps (some secondBound)
        (effect.load firstCode firstCaps (some firstBound) state).2).2 secondIsolate =
      secondCaps := by
  have different : firstIsolate ≠ secondIsolate := loads_never_share_an_isolate laws first second
  refine ⟨?_, laws.load_reaches_exactly_delegated secondCode secondCaps secondBound _
    secondIsolate second⟩
  rw [laws.load_preserves_other_reach secondCode secondCaps secondBound _ secondIsolate
    firstIsolate second different]
  exact laws.load_reaches_exactly_delegated firstCode firstCaps firstBound state firstIsolate first

/-- Calling a domain that was never loaded, or has been destroyed, is inert: it answers a
refusal and writes nothing. A withdrawal is therefore final at this seam — there is no state
in which a destroyed domain answers again. -/
theorem call_into_a_dead_domain_is_inert (laws : IsolateLaws effect view)
    (isolate : Nat) (request : ByteArray) (state : σ)
    (destroyed : view.live state isolate = false) :
    effect.call isolate request state = (.refused .disposed, state) :=
  laws.call_requires_live isolate request state destroyed

/-- Running loaded code never widens any delegation. Whatever the isolate computes, the
capability sets afterwards are the capability sets before. -/
theorem calls_do_not_widen_delegation (laws : IsolateLaws effect view)
    (isolate : Nat) (request : ByteArray) (target : Nat) (state : σ) :
    view.reach (effect.call isolate request state).2 target = view.reach state target :=
  laws.call_preserves_reach isolate request target state

end Delegation

end AgentCore.Substrate
