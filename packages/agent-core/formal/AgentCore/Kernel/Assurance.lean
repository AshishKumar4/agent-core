import AgentCore.Kernel.Assurance.System
import AgentCore.Kernel.Assurance.Shape
import AgentCore.Kernel.Assurance.Safety
import AgentCore.Kernel.Assurance.Liveness
import AgentCore.Kernel.Assurance.Correctness

/-!
# Safety, liveness, and total correctness over the Run lifecycle

`AgentCore.Kernel.Runs` states each record's own operation contracts: `Turn.claim` lands
running and held, `Run.terminalize` lands terminal, `RunAdmissionRegistry.close` advances the
epoch. Those are properties of one operation applied to one record, and there is a class of
property they structurally cannot express — anything about *every reachable state* of a Run,
because a state is not one record. The failures that matter are disagreements between
records: a Run that ended while its registry stayed open, a commit whose writer is nobody's
current lease, two records claiming one Turn identity, a Run that settles while it still owes
something.

This library is that layer. Five modules:

* `Assurance.System` — the state and the step. `RunSystem` is the Run, its admission
  registry, its Turns, its commit log, its remaining ceiling, and the clock, carrying **no
  `Prop` fields**; `RunEvent` is the closed alphabet of nineteen moves; `step` is one total
  function calling the kernel's own operations and adding only the bookkeeping no single
  record can hold. `Reachable` is genesis plus admitted steps, and every safety theorem is
  an induction over exactly it.
* `Assurance.Shape` — what each kernel transition leaves behind, one theorem per operation:
  identity is never re-parented, and every guard is recoverable from its success.
* `Assurance.Safety` — the invariant and the five named properties. Two of the five are false
  as informally stated and the corrected statements are proved instead; see the module header.
* `Assurance.Liveness` — no Run is permanently blocked, and every admitted obligation is
  eventually discharged or terminalized, under fairness stated as named premises tagged with
  the substrate *progress* premises they read.
* `Assurance.Correctness` — total correctness of all nineteen operations plus the composite
  step: the outcome channel is declared, the post-state satisfies the contract, and a refusal
  writes nothing.

## What this library is not

It is not a claim about any deployment. `artifacts/traceability.yaml` declares
`formalScope: abstract-model-only`, so nothing here is a designated theorem, owns a
requirement, or discharges an `AC-*` row: under that ledger's vocabulary every declaration in
this tree is a `component-shape-nonclaim`, exactly as `AgentCore.Substrate` is. The theorems
are about `AgentCore.Kernel`'s own definitions, which are the definitions the TypeScript
runtime is being replaced by rather than the runtime itself. Where the kernel already proves
a refinement against `AgentCore`'s abstract relations, that refinement is stated in the
`Runs` module that owns it; this library adds no new bridge.

There is no `axiom`, `opaque`, `partial`, `unsafe`, `sorry`, or `native_decide` anywhere in
it. Every hypothesis a theorem needs is in its binder list, and the three that are not
provable inside the kernel are named: `Liveness.Fairness` (weak fairness of the wakeup and
the fact that a Run stops taking on new work), `Liveness.Headroom` (the safe-integer
ceilings, which the kernel refuses at rather than wraps), and `Liveness.CanonicalKeys` (that
distinct obligation keys differ as UTF-16 code-unit sequences, which needs a `Text.units`
injectivity lemma the kernel does not have). `Liveness.EnvironmentResponsive` is named and
assumed by nothing: settlement needs evidence a principal produces, and no substrate premise
produces it.
-/
