import AgentCore.Substrate.Effect

/-!
# The Actor-owned local store

SPEC §8.1 gives one Actor one local transaction boundary; §8.5 puts the dispatcher's
envelope check and its guarded mutation inside one linearization point; §10.3 says how
this profile meets that — "DO SQLite is synchronous; the dispatcher's envelope check plus
guarded mutation is one synchronous span with no intervening `await` (input-gate hazard,
§8.5)". `ActorLocalStore` in TypeScript is the synchronous seam that statement is about,
and `TransactionalSqlite` and the memory reference store are its two implementations.

This module is that seam as a contract:

* `LocalStoreOp` / `LocalStoreReply` — the request and reply vocabulary, `host.store.get`
  through `host.store.txn`.
* `LocalStoreEffect σ` — the interface, synchronous store-passing over an explicit `σ`.
* `LocalStoreLaws` — the equations a kernel relies on, each a named field.
* `guardedCommit` — the §8.5 span itself, and the theorems that say what it does: a stale
  fence mutates nothing, a live fence applies exactly the plan, an over-limit payload is
  refused before the transaction opens, and there is no third outcome.

## Two shape decisions worth defending

**`txn` carries a write plan, not a callback.** A transaction whose body is a Lean function
would be a higher-order host call: nothing a registry row can spell, nothing an exported
opcode can carry, and nothing the TypeScript image can hand to `transactionSync` without
re-entering the interpreter. It is also not what the §8.5 span needs. The span reads its
gate, *computes*, and then commits; the computation is kernel code and the commit is a
finite set of writes. `List (ByteArray × Option ByteArray)` — `none` deletes — is that
commit, and `applyPlan` is what the host must make atomic.

**Fencing is not a store primitive.** §10.4 is explicit: "all fencing is the
application-level lease epoch (§5.3)". The platform offers no fenced write, so a law
claiming one would be a premise the deployment cannot discharge. What the store owes is the
*span*: a read whose result is still true when the write lands. That is `read_is_pure`
plus `Premise.storeSpanExclusive`, and `guardedCommit` is the kernel-side construction
that turns the two into a fence. The fence lives in the kernel, where a reviewer can see
it, rather than in an assumption about SQLite.
-/

namespace AgentCore.Substrate

/-- One entry of a write plan: `some value` writes it, `none` deletes the key. -/
abbrev StoreWrite := ByteArray × Option ByteArray

/-- The store requests a kernel can issue. Constructor names are the wire tails of
`Opcode.storeGet` … `Opcode.storeTxn`. -/
inductive LocalStoreOp where
  | get (key : ByteArray)
  | put (key value : ByteArray)
  | delete (key : ByteArray)
  | list (keyPrefix : ByteArray)
  | txn (plan : List StoreWrite)
  deriving DecidableEq

/-- Which opcode a request is, so a request and its certificate cannot drift apart. -/
def LocalStoreOp.opcode : LocalStoreOp → Opcode
  | .get _ => .storeGet
  | .put _ _ => .storePut
  | .delete _ => .storeDelete
  | .list _ => .storeList
  | .txn _ => .storeTxn

/-- Every store request lands on the store seam. -/
theorem LocalStoreOp.opcode_seam (op : LocalStoreOp) : op.opcode.seam = .store := by
  cases op <;> rfl

/-- What the store can answer. A host failure is a `refused` value the kernel cases on, not
an exception it must trust. -/
inductive LocalStoreReply where
  | value (bytes : ByteArray)
  | absent
  | ok
  | keys (found : List ByteArray)
  | refused (refusal : Refusal)
  deriving DecidableEq

/-- The keys a listing named; `[]` for every other reply. -/
def LocalStoreReply.keysOf : LocalStoreReply → List ByteArray
  | .keys found => found
  | _ => []

/--
The store interface: one function field per opcode, synchronous store-passing over an
explicit state `σ`.

`σ` is the whole durable state of one Actor's store as the model sees it. It is abstract
because the contract must hold for `TransactionalSqlite`, for the memory reference store,
and for anything else that satisfies `LocalStoreLaws` — a kernel theorem may not depend on
which one is underneath.
-/
structure LocalStoreEffect (σ : Type) where
  get : ByteArray → σ → LocalStoreReply × σ
  put : ByteArray → ByteArray → σ → LocalStoreReply × σ
  delete : ByteArray → σ → LocalStoreReply × σ
  list : ByteArray → σ → LocalStoreReply × σ
  txn : List StoreWrite → σ → LocalStoreReply × σ

/-- A key is present when reading it does not answer `absent`. -/
def LocalStoreEffect.Present {σ : Type} (effect : LocalStoreEffect σ) (state : σ)
    (key : ByteArray) : Prop :=
  (effect.get key state).1 ≠ .absent

/-- Applying one plan entry through the single-key operations. -/
def LocalStoreEffect.applyWrite {σ : Type} (effect : LocalStoreEffect σ) (state : σ) :
    StoreWrite → σ
  | (key, some value) => (effect.put key value state).2
  | (key, none) => (effect.delete key state).2

/-- The state a transaction must produce: the plan applied left to right, all of it. -/
def LocalStoreEffect.applyPlan {σ : Type} (effect : LocalStoreEffect σ)
    (plan : List StoreWrite) (state : σ) : σ :=
  plan.foldl effect.applyWrite state

/-- Whether every value in a plan is within the declared bound. Decidable on purpose: the
refusal case is a branch the kernel takes, not a classical case split. -/
def planFits (bound : Nat) (plan : List StoreWrite) : Bool :=
  plan.all fun entry =>
    match entry.2 with
    | some value => value.size ≤ bound
    | none => true

/-- Lexicographic order on key bytes, ranked through `Nat` so every order fact reduces to
an arithmetic one. -/
def rankLt : List Nat → List Nat → Prop
  | [], [] => False
  | [], _ :: _ => True
  | _ :: _, [] => False
  | left :: lefts, right :: rights =>
      left < right ∨ (left = right ∧ rankLt lefts rights)

/-- Key bytes as `Nat` ranks. -/
def byteRank (key : ByteArray) : List Nat := key.toList.map UInt8.toNat

/-- Strict byte-lexicographic key order: the order a listing must iterate in. -/
def keyLt (left right : ByteArray) : Prop := rankLt (byteRank left) (byteRank right)

/-- Whether one key extends another, for prefix listings. -/
def hasPrefix (keyPrefix key : ByteArray) : Bool :=
  keyPrefix.toList.isPrefixOf key.toList

/-- No rank precedes itself. -/
theorem rankLt_irrefl (ranks : List Nat) : ¬ rankLt ranks ranks := by
  induction ranks with
  | nil => simp [rankLt]
  | cons rank rest inner =>
      simp only [rankLt, not_or]
      exact ⟨Nat.lt_irrefl rank, fun same => inner same.2⟩

/-- No key precedes itself, so a sorted listing cannot repeat a key. -/
theorem keyLt_irrefl (key : ByteArray) : ¬ keyLt key key :=
  rankLt_irrefl (byteRank key)

/--
The laws a kernel relies on, each one a named premise a caller must supply.

Every field is an equation over `effect`'s function fields and the stored representation,
so an implementation can be tested against it and a conformance row can cite the test. The
facts that are *not* equations over this interface — durability across instance loss, an
exclusive span, a platform-accepted bound — are `Premise` entries instead, discharged in
`AgentCore.Substrate.Contracts`.

`bound` is the declared durable size bound of `C13-CLOUDFLARE-STORAGE-LIMIT`. It appears in
two laws that pull in opposite directions on purpose: a within-bound write is readable, and
an over-bound write is refused *with the state unchanged*, which is what "refuse an
over-limit payload as invalid input before opening a transaction" means when written as an
equation.
-/
structure LocalStoreLaws {σ : Type} (effect : LocalStoreEffect σ) (bound : Nat) : Prop where
  /-- A read is a query: it never changes durable state. This is half of what makes the
  §8.5 span a fence. -/
  read_is_pure : ∀ key state, (effect.get key state).2 = state
  /-- A listing is a query too. -/
  list_is_pure : ∀ keyPrefix state, (effect.list keyPrefix state).2 = state
  /-- A read answers `absent` or a value, never `ok`, `keys`, or a refusal: there is no
  read failure for the kernel to interpret. -/
  read_is_total : ∀ key state,
    (effect.get key state).1 = .absent ∨ ∃ bytes, (effect.get key state).1 = .value bytes
  /-- A within-bound write is accepted. -/
  put_accepts : ∀ key value state, value.size ≤ bound →
    (effect.put key value state).1 = .ok
  /-- What a write wrote is what a read reads. -/
  put_get : ∀ key value state, value.size ≤ bound →
    (effect.get key (effect.put key value state).2).1 = .value value
  /-- A write disturbs no other key. -/
  put_get_other : ∀ key other value state, other ≠ key →
    (effect.get other (effect.put key value state).2).1 = (effect.get other state).1
  /-- An over-bound write is refused before anything durable happens, and the state is the
  state it was (`C13-CLOUDFLARE-STORAGE-LIMIT`). -/
  put_refuses_over_limit : ∀ key value state, bound < value.size →
    effect.put key value state = (.refused .overLimit, state)
  /-- A deleted key reads `absent`. -/
  delete_get : ∀ key state, (effect.get key (effect.delete key state).2).1 = .absent
  /-- A delete disturbs no other key. -/
  delete_get_other : ∀ key other state, other ≠ key →
    (effect.get other (effect.delete key state).2).1 = (effect.get other state).1
  /-- A delete is accepted whether or not the key was present: a store miss is not an
  error (§8.4 rule 3). -/
  delete_accepts : ∀ key state, (effect.delete key state).1 = .ok
  /-- A transaction whose payload fits applies the whole plan and nothing else. This is the
  atomicity the kernel buys: there is no state between the first write and the last. -/
  txn_commits : ∀ plan state, planFits bound plan = true →
    effect.txn plan state = (.ok, effect.applyPlan plan state)
  /-- A transaction whose payload does not fit is refused with the state untouched — the
  refusal happens before the transaction opens, so no partial write exists to repair. -/
  txn_refuses_over_limit : ∀ plan state, planFits bound plan = false →
    effect.txn plan state = (.refused .overLimit, state)
  /-- A listing names exactly the present keys under the prefix. -/
  list_complete : ∀ keyPrefix state key,
    key ∈ (effect.list keyPrefix state).1.keysOf ↔
      (hasPrefix keyPrefix key = true ∧ effect.Present state key)
  /-- A listing is strictly ascending in byte order: deterministic sorted iteration, not
  hash order, and no key twice. -/
  list_sorted : ∀ keyPrefix state,
    ((effect.list keyPrefix state).1.keysOf).Pairwise keyLt

/--
The §8.5 guarded mutation, as one span.

Read the fence key; commit the plan only if the stored epoch is exactly the one the caller
holds. Every ingredient is a store call, so the whole thing is synchronous by construction
— there is nowhere to put an `await`, which is the property §10.3 asks an implementation to
maintain by discipline and this construction maintains by shape.
-/
def LocalStoreEffect.guardedCommit {σ : Type} (effect : LocalStoreEffect σ)
    (fenceKey expected : ByteArray) (plan : List StoreWrite) (state : σ) :
    LocalStoreReply × σ :=
  match (effect.get fenceKey state).1 with
  | .value stored =>
      if stored = expected then effect.txn plan state else (.refused .staleFence, state)
  | _ => (.refused .staleFence, state)

section Guarded

variable {σ : Type} {effect : LocalStoreEffect σ} {bound : Nat}

/-- A fence that does not match mutates nothing. The displaced holder's write is refused
and the durable state is the state the current holder left (§5.3, `C13-ADV-STALE-LEASE` in
the abstract). -/
theorem stale_fence_leaves_state_untouched (laws : LocalStoreLaws effect bound)
    (fenceKey expected : ByteArray) (plan : List StoreWrite) (state : σ)
    (mismatch : (effect.get fenceKey state).1 ≠ .value expected) :
    (effect.guardedCommit fenceKey expected plan state) = (.refused .staleFence, state) := by
  unfold LocalStoreEffect.guardedCommit
  rcases laws.read_is_total fenceKey state with absent | ⟨stored, present⟩
  · rw [absent]
  · rw [present]
    have different : stored ≠ expected := by
      intro same
      exact mismatch (by rw [present, same])
    simp [different]

/-- A matching fence applies exactly the plan. -/
theorem live_fence_applies_exact_plan (laws : LocalStoreLaws effect bound)
    (fenceKey expected : ByteArray) (plan : List StoreWrite) (state : σ)
    (fenceMatches : (effect.get fenceKey state).1 = .value expected)
    (fits : planFits bound plan = true) :
    (effect.guardedCommit fenceKey expected plan state) =
      (.ok, effect.applyPlan plan state) := by
  unfold LocalStoreEffect.guardedCommit
  rw [fenceMatches]
  simp [laws.txn_commits plan state fits]

/-- An over-limit plan is refused even under a live fence, and the durable log is
unchanged. The write seam refuses invalid input rather than discovering the bound partway
through a transaction (`C13-CLOUDFLARE-STORAGE-LIMIT`). -/
theorem over_limit_plan_never_mutates (laws : LocalStoreLaws effect bound)
    (fenceKey expected : ByteArray) (plan : List StoreWrite) (state : σ)
    (oversized : planFits bound plan = false) :
    (effect.guardedCommit fenceKey expected plan state).2 = state := by
  unfold LocalStoreEffect.guardedCommit
  rcases laws.read_is_total fenceKey state with absent | ⟨stored, present⟩
  · rw [absent]
  · rw [present]
    by_cases same : stored = expected
    · simp [same, laws.txn_refuses_over_limit plan state oversized]
    · simp [same]

/-- There is no third outcome. A guarded commit either leaves the state exactly as it was
or lands the whole plan; nothing observes a partial write. This is the modeled consequence
of `Premise.storeCommitAtomic`, and the reason a recovery path has only two states to
consider. -/
theorem guarded_commit_is_all_or_nothing (laws : LocalStoreLaws effect bound)
    (fenceKey expected : ByteArray) (plan : List StoreWrite) (state : σ) :
    (effect.guardedCommit fenceKey expected plan state).2 = state ∨
      (effect.guardedCommit fenceKey expected plan state).2 =
        effect.applyPlan plan state := by
  by_cases fits : planFits bound plan = true
  · rcases laws.read_is_total fenceKey state with absent | ⟨stored, present⟩
    · left; unfold LocalStoreEffect.guardedCommit; rw [absent]
    · by_cases same : stored = expected
      · right
        have fenceMatches : (effect.get fenceKey state).1 = .value expected := by
          rw [present, same]
        rw [live_fence_applies_exact_plan laws fenceKey expected plan state
          fenceMatches fits]
      · left
        unfold LocalStoreEffect.guardedCommit
        rw [present]
        simp [same]
  · left
    exact over_limit_plan_never_mutates laws fenceKey expected plan state
      (by simpa using fits)

/-- A listing names no key twice, because it is strictly ascending. With `list_complete`
this is what makes an iteration a deterministic sequence rather than a bag: a kernel fold
over a listing sees each present key exactly once, in one order. -/
theorem listing_is_duplicate_free (laws : LocalStoreLaws effect bound)
    (keyPrefix : ByteArray) (state : σ) :
    ((effect.list keyPrefix state).1.keysOf).Nodup :=
  (laws.list_sorted keyPrefix state).imp fun {left _right} ordered same => by
    exact keyLt_irrefl left (same ▸ ordered)

/-- A key outside the prefix is never listed, whatever the store holds. -/
theorem listing_respects_prefix (laws : LocalStoreLaws effect bound)
    (keyPrefix key : ByteArray) (state : σ) (outside : hasPrefix keyPrefix key = false) :
    key ∉ (effect.list keyPrefix state).1.keysOf := by
  intro listed
  have := ((laws.list_complete keyPrefix state key).mp listed).1
  rw [outside] at this
  exact Bool.noConfusion this

end Guarded

end AgentCore.Substrate
