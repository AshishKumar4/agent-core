import AgentCore.Substrate.Effect
import AgentCore.Substrate.LocalStore
import AgentCore.Substrate.Alarms
import AgentCore.Substrate.Content
import AgentCore.Substrate.AtLeastOnce
import AgentCore.Substrate.Queue
import AgentCore.Substrate.Isolate
import AgentCore.Substrate.Rpc
import AgentCore.Substrate.Contracts

/-!
# Substrate contracts: every seam a kernel calls, as a named premise with a discharge story

A verified kernel is total and pure, so every durable write, wakeup, content read, delivery,
isolate load, and stub call leaves through a seam. Each seam is a place the proof stops and
something else takes over. This library is what stands there instead of an axiom.

Six contracts, one module each:

* `AgentCore.Substrate.LocalStore` — the Actor-owned synchronous store (§8.1, §8.5, §10.3).
  A transaction carries a write plan rather than a callback, fencing is the kernel's
  construction rather than a store primitive, and `guardedCommit` has exactly two outcomes.
* `AgentCore.Substrate.Alarms` — the object's single alarm and the claim table that
  arbitrates it (§10.4, `C13-CLOUDFLARE-ALARM-CLAIMS`, `-RECONCILIATION-FENCE`, `-RETRY`).
  §10.4's arbitration sentences are theorems here, not conventions.
* `AgentCore.Substrate.Content` — content-addressed bytes (§8.2, §10.1). Addressing and
  verification are laws; retention and collision resistance are premises, and the theorem
  that needs the latter takes it as an explicit parameter.
* `AgentCore.Substrate.AtLeastOnce` — the kernel's side of at-least-once delivery: an
  idempotency-keyed inbox whose replay theorems make duplication an adversary power rather
  than a premise (§6.1, §10.4).
* `AgentCore.Substrate.Queue` — at-least-once queues, per-message disposition, and
  dead-letter custody (`C13-CLOUDFLARE-QUEUE-DISPOSITION`). An undecodable body makes no
  host call at all.
* `AgentCore.Substrate.Isolate` — loading code into a `dynamic` protection domain (§4.7,
  §10.2). An unbounded load is refused by a law; two submissions never share an isolate;
  no opcode can read a `dynamic` domain's private store.
* `AgentCore.Substrate.Rpc` — capability stubs scoped to one execution context (§10.2).
  A step disposes what it resolved, so nothing is held across steps, and pipelining is
  observationally free.

Two modules hold the parts that are shared rather than per-seam:

* `AgentCore.Substrate.Effect` — the closed `Opcode` set with its wire names and decoder,
  the closed `Premise` vocabulary, the safety/progress split, and each opcode's premise
  closure.
* `AgentCore.Substrate.Contracts` — the discharge map: which channel establishes which
  premise, which four remain open gaps, and which host calls inherit them.

## The discipline

**Premise, never axiom.** There is no `axiom`, `opaque`, `partial`, `unsafe`, `sorry`, or
`native_decide` in this tree. A seam is a structure of function fields; a law is a field of
a `Prop` structure; a theorem that needs a law names it in its binder list. What a law
cannot state — durability across instance loss, absent ambient egress, retention, eventual
delivery — is a `Premise` entry with a channel in the discharge map. A reader can therefore
find, for any conclusion, both the assumptions it rests on and the evidence behind each one.

**Nothing here is claimed of any deployment.** SPEC §14 places Durable Object transactions
and storage/RPC failure semantics outside what the formal package models, and this library
does not move that boundary: `Premise.adapterImplementsSeam` *is* that boundary, named at
every opcode. Under `artifacts/traceability.yaml`'s vocabulary every declaration here is a
`component-shape-nonclaim`: the Lean holds the shape and the ledger claims nothing for it.
No `AC-*` requirement, no `ASM-*` entry, no line in `AgentCore/Axioms.lean`, no designated
theorem.

**Nothing in `AgentCore.lean` imports this tree**, so no designated theorem, witness, or
semantic definition of the model can depend on a substrate premise — the same directional
guarantee `RuntimeAssurance` and `SpecCnl` rely on, for the same reason. `lake build
AgentCore.Substrate` is the target that builds it, and it imports nothing from the model, so
it stands alone.

**The compiler lowers this shape.** Each seam's request vocabulary is a plain inductive with
one constructor per wire tail; each effect is a structure of `args → σ → Reply × σ` fields
threaded as an explicit parameter, which is dictionary passing over a synchronous
store-passing image; `Opcode.wire` is the single source of the `host.<seam>.<op>` spellings
a registry joins on; and `Opcode.premises` is the premise closure a preservation row
consumes for each opcode.
-/
