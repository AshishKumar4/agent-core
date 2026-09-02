/-!
# Host effects: the substrate seams a kernel calls

A verified kernel is total and pure. Everything it cannot compute — a durable write, an
alarm, a content read, a queue send, a load into an isolate, a call on a stub — leaves
through a *seam*. This library says what a seam is, in the one shape a Lean → TypeScript
compiler can lower and a reviewer can audit:

* a closed **request vocabulary** per seam (`LocalStoreOp`, `AlarmOp`, …), plain data with
  a stable constructor name and a finite payload;
* a closed **reply vocabulary** per seam, so a host answer is a value the kernel can case
  on rather than an exception it must trust;
* an **effect interface** per seam: a structure whose fields are synchronous store-passing
  functions `args → σ → Reply × σ`, threaded as an explicit parameter. Dictionary passing,
  no monad transformer, no `IO`, and nothing that needs a new IR form to lower;
* a **laws** structure per seam whose fields are the equations the kernel relies on, taken
  as an explicit premise by every theorem that uses them;
* a **premise** vocabulary here for the facts a law cannot state, because they are about
  the deployed world rather than about the interface: durability across instance loss,
  at-least-once delivery, retention, absent ambient egress, an exclusive write span.

## Premise, never axiom

Nothing in this library is an `axiom`, an `opaque`, a `partial`, or a `sorry`. A seam is a
*parameter*: a theorem that needs the store to read back what it wrote says so in its
binder list, and a caller that cannot supply that law cannot use the theorem. That is the
whole discipline. An axiom would put the same sentence in the kernel's trusted base where
no reviewer is asked to discharge it; a premise puts it in the statement where every user
of the theorem sees it.

`Premise` is the second half of the same discipline. `AlarmLaws.set_overwrites` is an
equation about a function field and a caller can test it; "an armed alarm survives losing
the instance" is not an equation about anything in this interface, and pretending
otherwise would be the hidden axiom in disguise. So it is named here, classified safety or
progress, attached to the opcodes that rest on it, and bound to its discharging evidence
in `AgentCore.Substrate.Contracts` — a conformance atom, a live-lane scenario, or a
recorded gap. A premise with no discharge story is a gap with a name, which is the least a
reader is owed.

## What this library does not claim

It does not claim that any deployed substrate satisfies any law here. SPEC §14 lists
Durable Object transactions and storage/RPC failure semantics among the things the formal
package does not model (`NC-CLOUDFLARE-BEHAVIOR`, `NC-TYPESCRIPT-SUBSTRATE-REFINEMENT`),
and this library does not change that: `Premise.adapterImplementsSeam` is exactly that
non-claim, written down as the premise every host call rests on, with §13 conformance
evidence as its only discharge. Under `artifacts/traceability.yaml`'s vocabulary every
declaration here is a `component-shape-nonclaim`.

Nothing in `AgentCore.lean` imports this tree, so no designated theorem, witness, or
semantic definition of the model can depend on a substrate premise. `lake build
AgentCore.Substrate` is the target that builds it.
-/

namespace AgentCore.Substrate

/-- The six substrate seams a kernel reaches through. One per contract module. -/
inductive Seam where
  /-- The Actor-owned synchronous local store (`ActorLocalStore` / `TransactionalSqlite`,
  DO SQLite on the Cloudflare profile). -/
  | store
  /-- The object's single physical alarm. -/
  | alarm
  /-- Content-addressed bytes (R2, with the local store for small content). -/
  | content
  /-- At-least-once queue delivery. -/
  | queue
  /-- A `dynamic` protection domain: code loaded into a fresh isolate. -/
  | isolate
  /-- A capability stub held for one execution context. -/
  | rpc
  deriving DecidableEq, Repr

/-- The seam segment of a wire name. Grouping key for a registry row. -/
def Seam.wire : Seam → String
  | .store => "store"
  | .alarm => "alarm"
  | .content => "content"
  | .queue => "queue"
  | .isolate => "isolate"
  | .rpc => "rpc"

/--
Every host call the kernel can make, as one closed set.

Closed is the point: a certificate set that covers `Opcode.all` covers every way the
kernel leaves the model, and a seam operation that is not here cannot be lowered. The
absences are as deliberate as the entries — there is no opcode that reads a `dynamic`
domain's private store (§10.2 store custody), no opcode that deletes content (collection
is Tenant retention policy, not a kernel call), and no opcode that receives a delivery,
because a delivery arrives inbound and is not something the kernel calls.
-/
inductive Opcode where
  | storeGet
  | storePut
  | storeDelete
  | storeList
  | storeTxn
  | alarmSet
  | alarmGet
  | alarmDelete
  | contentPut
  | contentGet
  | contentHead
  | contentRange
  | queueSend
  | queueAck
  | queueRetry
  | isolateLoad
  | isolateCall
  | rpcCall
  | rpcDispose
  deriving DecidableEq, Repr

/-- Which seam owns an opcode. Written out rather than defaulted: an opcode added without
a seam fails to elaborate instead of inheriting one. -/
def Opcode.seam : Opcode → Seam
  | .storeGet | .storePut | .storeDelete | .storeList | .storeTxn => .store
  | .alarmSet | .alarmGet | .alarmDelete => .alarm
  | .contentPut | .contentGet | .contentHead | .contentRange => .content
  | .queueSend | .queueAck | .queueRetry => .queue
  | .isolateLoad | .isolateCall => .isolate
  | .rpcCall | .rpcDispose => .rpc

/--
The wire name a lowering registers, one literal per opcode. This is the join key between
the Lean opcode, the emitted TypeScript host-call, and the registry row that certifies it,
so the spelling lives here once and is read from here.
-/
def Opcode.wire : Opcode → String
  | .storeGet => "host.store.get"
  | .storePut => "host.store.put"
  | .storeDelete => "host.store.delete"
  | .storeList => "host.store.list"
  | .storeTxn => "host.store.txn"
  | .alarmSet => "host.alarm.set"
  | .alarmGet => "host.alarm.get"
  | .alarmDelete => "host.alarm.delete"
  | .contentPut => "host.content.put"
  | .contentGet => "host.content.get"
  | .contentHead => "host.content.head"
  | .contentRange => "host.content.range"
  | .queueSend => "host.queue.send"
  | .queueAck => "host.queue.ack"
  | .queueRetry => "host.queue.retry"
  | .isolateLoad => "host.isolate.load"
  | .isolateCall => "host.isolate.call"
  | .rpcCall => "host.rpc.call"
  | .rpcDispose => "host.rpc.dispose"

/-- The decoder for a wire name. Total, and `none` on anything not in the closed set. -/
def Opcode.ofWire : String → Option Opcode
  | "host.store.get" => some .storeGet
  | "host.store.put" => some .storePut
  | "host.store.delete" => some .storeDelete
  | "host.store.list" => some .storeList
  | "host.store.txn" => some .storeTxn
  | "host.alarm.set" => some .alarmSet
  | "host.alarm.get" => some .alarmGet
  | "host.alarm.delete" => some .alarmDelete
  | "host.content.put" => some .contentPut
  | "host.content.get" => some .contentGet
  | "host.content.head" => some .contentHead
  | "host.content.range" => some .contentRange
  | "host.queue.send" => some .queueSend
  | "host.queue.ack" => some .queueAck
  | "host.queue.retry" => some .queueRetry
  | "host.isolate.load" => some .isolateLoad
  | "host.isolate.call" => some .isolateCall
  | "host.rpc.call" => some .rpcCall
  | "host.rpc.dispose" => some .rpcDispose
  | _ => none

/-- The closed enumeration, in seam order. -/
def Opcode.all : List Opcode :=
  [.storeGet, .storePut, .storeDelete, .storeList, .storeTxn,
   .alarmSet, .alarmGet, .alarmDelete,
   .contentPut, .contentGet, .contentHead, .contentRange,
   .queueSend, .queueAck, .queueRetry,
   .isolateLoad, .isolateCall,
   .rpcCall, .rpcDispose]

/-- The enumeration is complete. An opcode added without an `all` entry breaks this. -/
theorem Opcode.mem_all (op : Opcode) : op ∈ Opcode.all := by
  cases op <;> decide

/-- Decoding a wire name recovers the opcode. -/
theorem Opcode.ofWire_wire (op : Opcode) : Opcode.ofWire op.wire = some op := by
  cases op <;> rfl

/-- Distinct opcodes have distinct wire names: the registry join is unambiguous. Proved
through the decoder rather than by comparing literals pairwise. -/
theorem Opcode.wire_injective {left right : Opcode} (same : left.wire = right.wire) :
    left = right := by
  have decoded : Opcode.ofWire left.wire = some right := by
    rw [same]; exact Opcode.ofWire_wire right
  rw [Opcode.ofWire_wire left] at decoded
  exact Option.some.inj decoded

/-- The opcodes of one seam. -/
def Seam.opcodes : Seam → List Opcode
  | .store => [.storeGet, .storePut, .storeDelete, .storeList, .storeTxn]
  | .alarm => [.alarmSet, .alarmGet, .alarmDelete]
  | .content => [.contentPut, .contentGet, .contentHead, .contentRange]
  | .queue => [.queueSend, .queueAck, .queueRetry]
  | .isolate => [.isolateLoad, .isolateCall]
  | .rpc => [.rpcCall, .rpcDispose]

/-- `Seam.opcodes` and `Opcode.seam` are the same partition read in two directions, so a
seam's opcode list can neither omit one of its own nor borrow another's. -/
theorem Seam.mem_opcodes_iff (seam : Seam) (op : Opcode) :
    op ∈ seam.opcodes ↔ op.seam = seam := by
  cases seam <;> cases op <;> decide

/-- The `isolate` seam offers exactly a load and a call. This is
`C13-CLOUDFLARE-DYNAMIC-STORE-CUSTODY` at the interface: a `dynamic` domain's private
store is not merely unread by policy, there is no opcode that could read it. -/
theorem Opcode.isolate_seam_has_no_store_access (op : Opcode) (owned : op.seam = .isolate) :
    op = .isolateLoad ∨ op = .isolateCall := by
  cases op <;> simp_all [Opcode.seam]

/-- The `content` seam offers no deletion. Collection is Tenant retention policy over
unowned content (§8.2), never a kernel host call. -/
theorem Opcode.content_seam_has_no_deletion (op : Opcode) (owned : op.seam = .content) :
    op = .contentPut ∨ op = .contentGet ∨ op = .contentHead ∨ op = .contentRange := by
  cases op <;> simp_all [Opcode.seam]

/--
Why a host answered no. One closed union across the seams, because the kernel's obligation
is identical in every case: case on the refusal and leave the durable state alone.

A refusal is a *value*. The alternative — a thrown host error partway through a durable
write — is the failure mode `C13-CLOUDFLARE-STORAGE-LIMIT` exists to forbid, which is why
`overLimit` is refused before a transaction opens rather than surfaced from inside one.
-/
inductive Refusal where
  /-- Payload exceeds the declared durable size bound (`C13-CLOUDFLARE-STORAGE-LIMIT`). -/
  | overLimit
  /-- A guarded write under a superseded lease epoch (§5.3 fencing). -/
  | staleFence
  /-- A content range outside the stored object. -/
  | outOfRange
  /-- Stored bytes do not hash to the requested digest. -/
  | digestMismatch
  /-- An acknowledgement or retry naming no live delivery. -/
  | unknownDelivery
  /-- A load into a `dynamic` domain with no stated compute bound
  (`C13-CLOUDFLARE-DYNAMIC-COMPUTE-BOUND`). -/
  | unbounded
  /-- A stub already disposed, or whose execution context has closed. -/
  | disposed
  /-- A body carrying no decodable delivery identity
  (`C13-CLOUDFLARE-QUEUE-DISPOSITION`). -/
  | undecodable
  deriving DecidableEq, Repr

/-- Whether a premise underwrites a safety property or only a progress one. The split is
load-bearing: no safety consequence in this library may rest on a `progress` premise. -/
inductive PremiseKind where
  | safety
  | progress
  deriving DecidableEq, Repr

/--
The closed premise vocabulary: the facts a seam's laws cannot state because they are about
the deployed world rather than about the interface.

Deliberately absent: duplication, reordering, and loss. A queue that delivers twice, an
alarm that fires twice, and a stub call that is redelivered are adversary powers the
theorems here survive — the idempotence results in the seam modules are stated against
them — not premises anything needs. Naming them as premises would claim the model is
weaker than it is. `RuntimeAssurance.Premise` takes the same position for the same reason.
-/
inductive Premise where
  /-- The deployed adapter implements the seam it is bound to: its replies are the modeled
  reply vocabulary and its state transitions are the modeled ones. This is SPEC §14's
  `NC-TYPESCRIPT-SUBSTRATE-REFINEMENT` non-claim written as a premise; §13 conformance
  evidence is its only discharge, and no theorem here proves it. -/
  | adapterImplementsSeam
  /-- Between a gate read and the guarded write that depends on it, no other writer
  interleaves — the §8.5 input-gate hazard, met on this profile by DO SQLite being
  synchronous and the span containing no `await` (§10.3). -/
  | storeSpanExclusive
  /-- A commit whose outcome is unknown is observed as either the before state or the whole
  after state, never a partial write (SPEC §14). -/
  | storeCommitAtomic
  /-- The declared size bound is one the deployed platform accepts, row overhead included,
  rather than one the local runtime happens to allow
  (`C13-CLOUDFLARE-STORAGE-LIMIT`). -/
  | storeDeclaredBoundAccepted
  /-- A restarted Actor reads back exactly its committed writes before serving (§8.1). -/
  | storeRestartResumesDurableState
  /-- An armed alarm survives instance loss and a throwing handler, and the platform — not
  an external timer, cron, or keepalive — recovers it
  (`C13-CLOUDFLARE-ALARM-DURABILITY`). -/
  | alarmDurableAcrossInstanceLoss
  /-- A firing never precedes the armed due time, under trusted monotone time. -/
  | alarmFiresNoEarlierThanArmed
  /-- An armed alarm eventually fires. The only progress premise the alarm seam has, and no
  safety result rests on it. -/
  | alarmEventuallyFires
  /-- Content a declared retainer owns is not collected, so a record cannot outlive the
  bytes it names (`C13-CONTENT-CUSTODY`). Unstatable at this interface: no opcode deletes
  content, so collection happens outside every equation here. -/
  | contentRetentionUntilReleased
  /-- Distinct byte strings do not share a digest (SPEC §14's stated collision assumption;
  `NC-CRYPTOGRAPHIC-COLLISION-RESISTANCE`). -/
  | contentDigestCollisionResistant
  /-- The bound bucket is the Tenant's own store, so a resolution through this seam is a
  resolution within that Tenant (`C13-CONTENT-RESOLUTION`). -/
  | contentBucketIsTenantOwned
  /-- An accepted send is delivered at least once. Progress; no safety result rests on
  it. -/
  | queueAtLeastOnceDelivery
  /-- An acknowledged delivery is never handed back
  (`C13-CLOUDFLARE-QUEUE-DISPOSITION`). -/
  | queueAckedNeverRedelivered
  /-- A body with no decodable delivery identity is neither delivered nor acknowledged, and
  the queue's dead-letter policy takes custody of it rather than dropping it
  (`C13-CLOUDFLARE-QUEUE-DISPOSITION`). -/
  | queueDeadLetterCustody
  /-- Code in a loaded isolate reaches the network only through an explicitly passed
  Binding, because `globalOutbound` is fixed where the isolate is built rather than
  supplied by a caller (`C13-CLOUDFLARE-DYNAMIC-NO-EGRESS`). -/
  | isolateNoAmbientEgress
  /-- The runtime enforces the stated CPU-time and subrequest bound by throwing at the
  boundary the moment either is reached
  (`C13-CLOUDFLARE-DYNAMIC-COMPUTE-BOUND`). -/
  | isolateBoundEnforcedByRuntime
  /-- A `dynamic` domain's private store is unreachable from the Actor that loaded it
  (`C13-CLOUDFLARE-DYNAMIC-STORE-CUSTODY`). -/
  | isolatePrivateStoreUnreadable
  /-- No warm isolate is handed to a submission unless the reuse identity covers every
  input the load fixed, the delegated capability set included
  (`C13-CLOUDFLARE-DYNAMIC-ISOLATE-IDENTITY`). -/
  | isolateFreshLoadPerSubmission
  /-- A stub does not outlive its execution context, hibernation, or isolate eviction
  (§10.2), so a held stub is a stale capability rather than a working one. -/
  | rpcStubLifetimeBoundedByContext
  /-- A redelivery reuses the same delivery identity and cannot remap or duplicate intent
  (§10.1) — the callee dedupes; the transport does not promise once. -/
  | rpcRedeliveryPreservesIntent
  /-- Disposing a stub releases the callee's resources for it (AGENTS.md's stub-disposal
  rule); nothing local can observe that release. -/
  | rpcDisposalReleasesRemoteResources
  deriving DecidableEq, Repr

/-- Safety or progress, written out per premise. -/
def Premise.kind : Premise → PremiseKind
  | .adapterImplementsSeam => .safety
  | .storeSpanExclusive => .safety
  | .storeCommitAtomic => .safety
  | .storeDeclaredBoundAccepted => .safety
  | .storeRestartResumesDurableState => .safety
  | .alarmDurableAcrossInstanceLoss => .safety
  | .alarmFiresNoEarlierThanArmed => .safety
  | .alarmEventuallyFires => .progress
  | .contentRetentionUntilReleased => .safety
  | .contentDigestCollisionResistant => .safety
  | .contentBucketIsTenantOwned => .safety
  | .queueAtLeastOnceDelivery => .progress
  | .queueAckedNeverRedelivered => .safety
  | .queueDeadLetterCustody => .safety
  | .isolateNoAmbientEgress => .safety
  | .isolateBoundEnforcedByRuntime => .safety
  | .isolatePrivateStoreUnreadable => .safety
  | .isolateFreshLoadPerSubmission => .safety
  | .rpcStubLifetimeBoundedByContext => .safety
  | .rpcRedeliveryPreservesIntent => .safety
  | .rpcDisposalReleasesRemoteResources => .safety

/-- The seams that rest on a premise. `adapterImplementsSeam` rests under all six; every
other premise names its own. -/
def Premise.seams : Premise → List Seam
  | .adapterImplementsSeam => [.store, .alarm, .content, .queue, .isolate, .rpc]
  | .storeSpanExclusive => [.store]
  | .storeCommitAtomic => [.store]
  | .storeDeclaredBoundAccepted => [.store]
  | .storeRestartResumesDurableState => [.store]
  | .alarmDurableAcrossInstanceLoss => [.alarm]
  | .alarmFiresNoEarlierThanArmed => [.alarm]
  | .alarmEventuallyFires => [.alarm]
  | .contentRetentionUntilReleased => [.content]
  | .contentDigestCollisionResistant => [.content]
  | .contentBucketIsTenantOwned => [.content]
  | .queueAtLeastOnceDelivery => [.queue]
  | .queueAckedNeverRedelivered => [.queue]
  | .queueDeadLetterCustody => [.queue]
  | .isolateNoAmbientEgress => [.isolate]
  | .isolateBoundEnforcedByRuntime => [.isolate]
  | .isolatePrivateStoreUnreadable => [.isolate]
  | .isolateFreshLoadPerSubmission => [.isolate]
  | .rpcStubLifetimeBoundedByContext => [.rpc]
  | .rpcRedeliveryPreservesIntent => [.rpc]
  | .rpcDisposalReleasesRemoteResources => [.rpc]

/-- The closed premise enumeration. -/
def Premise.all : List Premise :=
  [.adapterImplementsSeam,
   .storeSpanExclusive, .storeCommitAtomic, .storeDeclaredBoundAccepted,
   .storeRestartResumesDurableState,
   .alarmDurableAcrossInstanceLoss, .alarmFiresNoEarlierThanArmed, .alarmEventuallyFires,
   .contentRetentionUntilReleased, .contentDigestCollisionResistant,
   .contentBucketIsTenantOwned,
   .queueAtLeastOnceDelivery, .queueAckedNeverRedelivered, .queueDeadLetterCustody,
   .isolateNoAmbientEgress, .isolateBoundEnforcedByRuntime, .isolatePrivateStoreUnreadable,
   .isolateFreshLoadPerSubmission,
   .rpcStubLifetimeBoundedByContext, .rpcRedeliveryPreservesIntent,
   .rpcDisposalReleasesRemoteResources]

/-- The premise enumeration is complete. -/
theorem Premise.mem_all (premise : Premise) : premise ∈ Premise.all := by
  cases premise <;> decide

/-- The progress premises are exactly the two eventual ones. Discriminating witness for the
split: reclassifying any premise breaks it, and a safety result that reached for one of
these two would have to name it. -/
theorem Premise.progress_is_exactly_eventual (premise : Premise) :
    premise.kind = .progress ↔
      (premise = .alarmEventuallyFires ∨ premise = .queueAtLeastOnceDelivery) := by
  cases premise <;> simp [Premise.kind]

/--
The premise closure of one opcode: what must hold about the deployed world for a call to
mean what the model says it means.

This is the list a lowering's preservation row consumes for `host.<seam>.<op>`. Every
entry is either the refinement premise or a premise whose `seams` contains this opcode's
seam, and `Opcode.premises_are_seam_local` proves it.
-/
def Opcode.premises : Opcode → List Premise
  | .storeGet =>
      [.adapterImplementsSeam, .storeSpanExclusive, .storeRestartResumesDurableState]
  | .storePut =>
      [.adapterImplementsSeam, .storeSpanExclusive, .storeCommitAtomic,
       .storeDeclaredBoundAccepted, .storeRestartResumesDurableState]
  | .storeDelete =>
      [.adapterImplementsSeam, .storeSpanExclusive, .storeCommitAtomic,
       .storeRestartResumesDurableState]
  | .storeList =>
      [.adapterImplementsSeam, .storeSpanExclusive, .storeRestartResumesDurableState]
  | .storeTxn =>
      [.adapterImplementsSeam, .storeSpanExclusive, .storeCommitAtomic,
       .storeDeclaredBoundAccepted, .storeRestartResumesDurableState]
  | .alarmSet =>
      [.adapterImplementsSeam, .alarmDurableAcrossInstanceLoss,
       .alarmFiresNoEarlierThanArmed, .alarmEventuallyFires]
  | .alarmGet => [.adapterImplementsSeam, .alarmDurableAcrossInstanceLoss]
  | .alarmDelete => [.adapterImplementsSeam, .alarmDurableAcrossInstanceLoss]
  | .contentPut =>
      [.adapterImplementsSeam, .contentRetentionUntilReleased,
       .contentDigestCollisionResistant, .contentBucketIsTenantOwned]
  | .contentGet =>
      [.adapterImplementsSeam, .contentRetentionUntilReleased,
       .contentDigestCollisionResistant, .contentBucketIsTenantOwned]
  | .contentHead =>
      [.adapterImplementsSeam, .contentRetentionUntilReleased,
       .contentBucketIsTenantOwned]
  | .contentRange =>
      [.adapterImplementsSeam, .contentRetentionUntilReleased,
       .contentDigestCollisionResistant, .contentBucketIsTenantOwned]
  | .queueSend => [.adapterImplementsSeam, .queueAtLeastOnceDelivery]
  | .queueAck => [.adapterImplementsSeam, .queueAckedNeverRedelivered]
  | .queueRetry =>
      [.adapterImplementsSeam, .queueAtLeastOnceDelivery, .queueDeadLetterCustody]
  | .isolateLoad =>
      [.adapterImplementsSeam, .isolateNoAmbientEgress, .isolateBoundEnforcedByRuntime,
       .isolatePrivateStoreUnreadable, .isolateFreshLoadPerSubmission]
  | .isolateCall =>
      [.adapterImplementsSeam, .isolateNoAmbientEgress, .isolateBoundEnforcedByRuntime,
       .isolatePrivateStoreUnreadable]
  | .rpcCall =>
      [.adapterImplementsSeam, .rpcStubLifetimeBoundedByContext,
       .rpcRedeliveryPreservesIntent]
  | .rpcDispose =>
      [.adapterImplementsSeam, .rpcStubLifetimeBoundedByContext,
       .rpcDisposalReleasesRemoteResources]

/-- Every host call rests on the refinement premise. There is no seam whose adapter is
assumed correct for free. -/
theorem Opcode.refinement_is_always_required (op : Opcode) :
    Premise.adapterImplementsSeam ∈ op.premises := by
  cases op <;> decide

/-- An opcode's premise closure never reaches into another seam. -/
theorem Opcode.premises_are_seam_local (op : Opcode) (premise : Premise)
    (required : premise ∈ op.premises) : op.seam ∈ premise.seams := by
  cases op <;> revert required <;> cases premise <;> decide

/-- No premise is dead: each one is required by some opcode, so removing a seam operation
that no longer needs it makes the premise unreachable rather than silently retained. -/
theorem Premise.is_required_by_some_opcode (premise : Premise) :
    ∃ op : Opcode, premise ∈ op.premises := by
  cases premise
  case adapterImplementsSeam => exact ⟨.storeGet, by decide⟩
  case storeSpanExclusive => exact ⟨.storeGet, by decide⟩
  case storeCommitAtomic => exact ⟨.storePut, by decide⟩
  case storeDeclaredBoundAccepted => exact ⟨.storePut, by decide⟩
  case storeRestartResumesDurableState => exact ⟨.storeGet, by decide⟩
  case alarmDurableAcrossInstanceLoss => exact ⟨.alarmSet, by decide⟩
  case alarmFiresNoEarlierThanArmed => exact ⟨.alarmSet, by decide⟩
  case alarmEventuallyFires => exact ⟨.alarmSet, by decide⟩
  case contentRetentionUntilReleased => exact ⟨.contentPut, by decide⟩
  case contentDigestCollisionResistant => exact ⟨.contentPut, by decide⟩
  case contentBucketIsTenantOwned => exact ⟨.contentPut, by decide⟩
  case queueAtLeastOnceDelivery => exact ⟨.queueSend, by decide⟩
  case queueAckedNeverRedelivered => exact ⟨.queueAck, by decide⟩
  case queueDeadLetterCustody => exact ⟨.queueRetry, by decide⟩
  case isolateNoAmbientEgress => exact ⟨.isolateLoad, by decide⟩
  case isolateBoundEnforcedByRuntime => exact ⟨.isolateLoad, by decide⟩
  case isolatePrivateStoreUnreadable => exact ⟨.isolateLoad, by decide⟩
  case isolateFreshLoadPerSubmission => exact ⟨.isolateLoad, by decide⟩
  case rpcStubLifetimeBoundedByContext => exact ⟨.rpcCall, by decide⟩
  case rpcRedeliveryPreservesIntent => exact ⟨.rpcCall, by decide⟩
  case rpcDisposalReleasesRemoteResources => exact ⟨.rpcDispose, by decide⟩

/-- No safety-critical read rests on a progress premise: the two progress premises appear
only in the closures of `host.alarm.set`, `host.queue.send`, and `host.queue.retry` — the
three calls whose whole purpose is to make something happen later. -/
theorem Opcode.progress_premises_are_confined (op : Opcode) (premise : Premise)
    (required : premise ∈ op.premises) (progress : premise.kind = .progress) :
    op = .alarmSet ∨ op = .queueSend ∨ op = .queueRetry := by
  cases op <;> revert required progress <;> cases premise <;> decide

end AgentCore.Substrate
