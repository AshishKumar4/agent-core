import AgentCore.Substrate.AtLeastOnce

/-!
# Capability stubs: one execution context, pipelined calls, and mandatory disposal

§10.2 places a `provider` facet "behind a service binding or capability-RPC stub (Workers
RPC / Cap'n Web)", and then states the fact every rule about stubs follows from: "RPC stubs
do not survive execution contexts, hibernation, or isolate eviction, so provider resolutions
are scoped to a single Turn step and re-resolved with current path epochs each step (§3.4
rules 7–8). Revocation drops the stub; so do platform lifecycle events; re-resolution is the
uniform recovery for both." §10.1 adds the delivery rule: "Queues/RPC may redeliver but
cannot remap or duplicate intent."

The seam is two host calls, `host.rpc.call` and `host.rpc.dispose`, and the laws say three
things a kernel needs.

**A dead stub answers nothing.** `call_requires_live` refuses a call on a disposed or
expired stub with the state untouched, so a held stub is a failed call rather than a call
into a reused handle. `stepCall` is §10.2's single-step scope written as code, and
`step_closes_its_stub` proves what it leaves behind: nothing live. A kernel built this way
cannot carry a stub across steps even by accident, which is what makes re-resolution the
uniform recovery rather than a rule someone must remember.

**Disposal is required, and safe to repeat.** AGENTS.md: "RPC stubs must be disposed to
prevent resource leaks on the server side." `dispose_releases` and
`dispose_is_idempotent` are that obligation and its safety; the release *at the callee* is
`Premise.rpcDisposalReleasesRemoteResources`, since nothing local can observe it.

**Pipelining does not change what a call returns.** `pipelining_is_transparent` says a call
on a promise stub answers exactly as a call on its resolution would: Cap'n Web replaces the
promise with its resolution on the server side before delivering arguments, so the
optimisation AGENTS.md asks for — "use promise pipelining whenever possible" — is
observationally free. `pipelined_step_returns_the_resolved_reply` is the consequence a
caller can rely on.

## What stays a premise

`Premise.rpcStubLifetimeBoundedByContext` — that a stub is invalid after its context ends —
cannot be an equation here, because this interface has no context and no clock in it. What
it does have is the shape that makes the premise harmless: every step disposes what it
resolved, so a kernel never holds a stub long enough for the premise to matter.
`Premise.rpcRedeliveryPreservesIntent` is the transport's half of at-least-once; the
kernel's half is `AgentCore.Substrate.AtLeastOnce`, whose replay theorems are what make a
redelivered call harmless rather than a second effect.
-/

namespace AgentCore.Substrate

/-- The stub requests a kernel can issue: wire tails of `Opcode.rpcCall` and
`Opcode.rpcDispose`. -/
inductive RpcOp where
  | call (stub : Nat) (method argument : ByteArray)
  | dispose (stub : Nat)
  deriving DecidableEq

/-- Which opcode a stub request is. -/
def RpcOp.opcode : RpcOp → Opcode
  | .call _ _ _ => .rpcCall
  | .dispose _ => .rpcDispose

/-- Every stub request lands on the rpc seam. -/
theorem RpcOp.opcode_seam (op : RpcOp) : op.opcode.seam = .rpc := by
  cases op <;> rfl

/-- What a stub call can answer. `promise` is the pipelining case: a call may answer with a
stub for a result that has not arrived, and that stub is callable. -/
inductive RpcReply where
  | value (body : ByteArray)
  | promise (stub : Nat)
  | refused (refusal : Refusal)
  deriving DecidableEq

/-- The stub interface, synchronous store-passing over an explicit `σ`. -/
structure RpcEffect (σ : Type) where
  call : Nat → ByteArray → ByteArray → σ → RpcReply × σ
  dispose : Nat → σ → RpcReply × σ

/-- What the model observes about stubs: which are live, and what a promise stub resolves
to. Proof plumbing, erased at lowering. -/
structure RpcView (σ : Type) where
  live : σ → Nat → Bool
  resolves : σ → Nat → Option Nat

/-- The stub laws. -/
structure RpcLaws {σ : Type} (effect : RpcEffect σ) (view : RpcView σ) : Prop where
  /-- A call on a stub that is not live is refused, with the state untouched. A dropped,
  disposed, hibernated, or evicted stub answers nothing — it does not answer wrongly. -/
  call_requires_live : ∀ stub method argument state, view.live state stub = false →
    effect.call stub method argument state = (.refused .disposed, state)
  /-- Disposal releases the stub. -/
  dispose_releases : ∀ stub state, view.live (effect.dispose stub state).2 stub = false
  /-- Disposal releases only that stub. -/
  dispose_preserves_other_stubs : ∀ stub other state, other ≠ stub →
    view.live (effect.dispose stub state).2 other = view.live state other
  /-- Disposing twice is disposing once, so a `using` block and an explicit dispose can
  both run. -/
  dispose_is_idempotent : ∀ stub state,
    (effect.dispose stub (effect.dispose stub state).2).2 = (effect.dispose stub state).2
  /-- Disposal does not change what any promise resolves to; it ends a capability, it does
  not rewrite a result. -/
  dispose_preserves_resolution : ∀ stub target state,
    view.resolves (effect.dispose stub state).2 target = view.resolves state target
  /-- A call on a promise answers exactly as a call on its resolution would: the promise is
  replaced by its resolution before delivery. -/
  pipelining_is_transparent : ∀ promise target method argument state,
    view.resolves state promise = some target →
      (effect.call promise method argument state).1 =
        (effect.call target method argument state).1
  /-- A promise a call hands back is live and callable. -/
  call_promise_is_live : ∀ stub method argument state child,
    (effect.call stub method argument state).1 = .promise child →
      view.live (effect.call stub method argument state).2 child = true

/--
One Turn step's use of a provider stub: call it, then dispose it.

§10.2 scopes a provider resolution to a single Turn step and re-resolves with current path
epochs each step. This is that scope as code rather than as a rule to remember — the stub is
released before the step's value is returned, so there is no value of this function that
leaves a live stub behind.
-/
def RpcEffect.stepCall {σ : Type} (effect : RpcEffect σ) (stub : Nat)
    (method argument : ByteArray) (state : σ) : RpcReply × σ :=
  let called := effect.call stub method argument state
  (called.1, (effect.dispose stub called.2).2)

section Lifetime

variable {σ : Type} {effect : RpcEffect σ} {view : RpcView σ}

/-- A step closes the stub it used. No stub crosses a step boundary, so
`Premise.rpcStubLifetimeBoundedByContext` cannot be violated by a kernel that steps this
way: there is nothing held to become stale. -/
theorem step_closes_its_stub (laws : RpcLaws effect view) (stub : Nat)
    (method argument : ByteArray) (state : σ) :
    view.live (effect.stepCall stub method argument state).2 stub = false := by
  unfold RpcEffect.stepCall
  exact laws.dispose_releases stub _

/-- A step closes only its own stub. -/
theorem step_leaves_other_stubs_alone (laws : RpcLaws effect view) (stub other : Nat)
    (method argument : ByteArray) (state : σ) (different : other ≠ stub) :
    view.live (effect.stepCall stub method argument state).2 other =
      view.live (effect.call stub method argument state).2 other := by
  unfold RpcEffect.stepCall
  exact laws.dispose_preserves_other_stubs stub other _ different

/-- A step returns exactly what the call returned: disposal is a release, not a rewrite of
the answer. -/
theorem step_returns_the_call_reply (stub : Nat) (method argument : ByteArray) (state : σ) :
    (effect.stepCall stub method argument state).1 =
      (effect.call stub method argument state).1 := rfl

/-- Calling a stub the kernel is still holding after its context ended is a refusal, and it
changes nothing. Recovery is re-resolution, and it is the only recovery this seam offers. -/
theorem held_stub_answers_only_a_refusal (laws : RpcLaws effect view) (stub : Nat)
    (method argument : ByteArray) (state : σ) (dropped : view.live state stub = false) :
    effect.call stub method argument state = (.refused .disposed, state) :=
  laws.call_requires_live stub method argument state dropped

/-- A second step on a stub the first step disposed refuses rather than reaching a reused
handle. This is the pair that makes single-step scoping self-enforcing. -/
theorem second_step_on_a_closed_stub_refuses (laws : RpcLaws effect view) (stub : Nat)
    (method argument : ByteArray) (state : σ) :
    effect.call stub method argument (effect.stepCall stub method argument state).2 =
      (.refused .disposed, (effect.stepCall stub method argument state).2) :=
  laws.call_requires_live stub method argument _
    (step_closes_its_stub laws stub method argument state)

/-- Pipelining is observationally free: a step on a promise returns what a call on its
resolution returns, so a kernel may use the promise as the target without changing any
result. -/
theorem pipelined_step_returns_the_resolved_reply (laws : RpcLaws effect view)
    {promise target : Nat} {method argument : ByteArray} {state : σ}
    (resolved : view.resolves state promise = some target) :
    (effect.stepCall promise method argument state).1 =
      (effect.call target method argument state).1 := by
  rw [step_returns_the_call_reply]
  exact laws.pipelining_is_transparent promise target method argument state resolved

/-- Disposing a promise stub does not disturb what its neighbours resolve to, so a
pipelined chain can be released in any order. -/
theorem disposal_does_not_disturb_pipelining (laws : RpcLaws effect view)
    (stub target : Nat) (state : σ) :
    view.resolves (effect.dispose stub state).2 target = view.resolves state target :=
  laws.dispose_preserves_resolution stub target state

/-- Redelivery of a stub call is harmless when the callee dedupes it: the kernel's
idempotency-keyed inbox absorbs the repeat, which is why
`Premise.rpcRedeliveryPreservesIntent` is a statement about identity rather than about
counting. -/
theorem redelivered_call_is_absorbed {κ : Type} (apply : ByteArray → κ → κ)
    (inbox : Inbox κ) (key : ByteArray) :
    Inbox.accept apply (Inbox.accept apply inbox key) key = Inbox.accept apply inbox key :=
  accept_is_idempotent inbox key

end Lifetime

end AgentCore.Substrate
