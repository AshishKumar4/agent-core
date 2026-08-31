import RuntimeAssurance.External
import RuntimeAssurance.Hostile

/-!
# Runtime assurance: why a deployed guarantee is conditional

SPEC §14 lists the premises a deployment relies on and `artifacts/traceability.yaml` records
one `ASM-*` entry for each. Both say what is assumed. Neither says what follows when one of
them turns out to be false, so nothing in the repository could answer the question an
operator asks first after an incident: which guarantees are gone, which are merely
unestablished, and which still hold. This library answers exactly that and nothing more.

* `RuntimeAssurance.Premise` — the closed premise vocabulary, the safety/progress split, and
  the two channels by which a premise leaves `conditional`.
* `RuntimeAssurance.Fault` — the closed fault vocabulary and the one mapping between the two.
  Six faults refute nothing because the model already carries them.
* `RuntimeAssurance.Monitor` — monitor evidence bound to model, adapter, runtime, and
  observation window, with the refusals for drift, staleness, out-of-coverage attribution,
  and outside-model events.
* `RuntimeAssurance.Assurance` — the premise ledger and its transitions. A monitor writes
  refutations and coverage; only a durable domain record writes a discharge.
* `RuntimeAssurance.External` — one-key one-intent provider semantics. An identical retry is
  a no-op, a conflicting retry is refused, and a lost acknowledgement is ambiguity rather
  than a second effect.
* `RuntimeAssurance.Claim` — the residual calculus: void, conditional, proved, with exact
  attribution and an exact blast radius.
* `RuntimeAssurance.Hostile` — typechecked hostile probes for stale, missing, substituted,
  and outside-model observations.

## Why this is a separate library

It imports `AgentCore` and nothing in `AgentCore` imports it. That direction is the whole
guarantee that no platform observation can reach the kernel axiom set: no designated theorem,
witness, or project-owned semantic definition of the model can depend on a declaration here,
because dependency is a compile-time fact rather than a review promise. It also means the
audited module closure behind `artifacts/normative.lock` is unchanged — `check-normative.mjs`
walks `formal/AgentCore`, and this tree is outside it.

`formal/SpecCnl` sits at the same altitude for the same reason, and the two are independent
of each other.

## What this library does not claim

It designates no theorem in `AgentCore/Axioms.lean`, owns no `AC-*` requirement, and adds no
`ASM-*` entry. Under `artifacts/traceability.yaml`'s own vocabulary that makes every
declaration here a `component-shape-nonclaim`: Lean contains the shape, and the ledger claims
nothing for it until a maintainer reviews it into the normative surface. Promoting any of it
is a Tier D change under `AGENT_OPERATING_DOCTRINE.md` §2, requiring exact-head approval, and
the doctrine freezes ordinary Tier D theorem changes until M-5 and A-2 are active. Nothing
here asks for that promotion.

Three things it specifically does not do. It does not decide which durable record discharges
which premise — that is a `C13-*` conformance question. It does not decide which claim rests
on which premise; a claim's support is reviewed input, and `Claim.WellFormed` is the only
constraint the model places on it. And it does not observe anything: a `Report` is data
handed to it, and the TypeScript boundary at `src/assurance` is where a real adapter produces
one.
-/
