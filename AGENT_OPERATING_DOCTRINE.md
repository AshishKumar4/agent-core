# Agent Operating Doctrine

**Version:** 1.0

**Status:** Normative after the adoption change passes change control and lands on
the protected default branch.

**Scope:** Automated contributors and the humans reviewing their work.

**Keywords:** MUST, MUST NOT, SHOULD, and MAY are used as defined by RFC 2119.

This doctrine governs engineering process and the integrity of project claims. The
SPEC governs product semantics. A direct maintainer instruction may change either,
but it must say which. `AGENTS.md` is subordinate to both. A conflict whose domain is
unclear stops the change until the maintainer resolves it.

Every rule has a stable ID. Change reports and commit messages cite the rules they
exercise with `Doctrine-Rules:` metadata. That metadata is an audit trail, not an
approval.

## Threat model

The controls below are designed to prevent:

1. vacuous theorems over empty, unreachable, or wrong behavior sets;
2. statements, scenarios, or gates weakened under pressure to make CI green;
3. drift between the formal decision and its runtime counterpart;
4. unchanged theorem text whose meaning changes through a dependency;
5. claim, boundary, assumption, or nonclaim prose drifting from its evidence;
6. formal or conformance evidence being promoted into a broader system claim;
7. sequential evidence overlooking concurrency, restart, or commit-unknown behavior;
   and
8. contributors weakening the classifier, approval verifier, workflow, or trust root
   that governs their own change.

## 1. Prime directives

**D-1 (Kernel authority).** Lean 4 is the proof authority for the formal model. A
solver, generator, model checker, test, or reviewer is not a substitute for a
kernel-checked proof. An agent MUST NOT implement a migration to another proof
authority. It MAY submit a written decision request that compares alternatives.

**D-2 (Two claim planes).** Formal claims cite `AC-*`, `NC-*`, and `ASM-*` entries in
`packages/agent-core/artifacts/traceability.yaml`. Implementation, substrate, and
deployment claims cite `C13-*` or `P11-*` conformance atoms. Neither plane implies
the other, and no claim may be routed through the wrong plane.

**D-3 (Normative surface).** Allowlist membership; theorem and witness types; the
complete project-owned semantic definition closure on which those types depend;
formal-scope membership; scenario mappings; formal and conformance claim status,
summary, boundary, assumption, and nonclaim prose; and normative SPEC prose are
human-reviewed surfaces. Proof terms, tactics, implementations, tests, and tooling
are agent-editable only while the normative surface remains unchanged or the change
passes the applicable approval gate.

**D-4 (No weakening to unblock).** An agent MUST NOT weaken a property, narrow the
accepted scenario set, delete a discriminating witness, relax a gate, or demote a
claim merely to make unrelated work pass. A false or overbroad claim MUST be
quarantined or corrected. That integrity correction requires a STUCK or incident
record and exact-head maintainer approval; preserving a false claim is not allowed.

**D-5 (Fail closed).** Unknown tier, ownership, approval, claim, scenario, or
normative-manifest state fails. The agent reports the missing fact instead of
guessing.

**D-6 (Formal scope).** The formal scope is the checked `formalBoundary` registry in
the traceability ledger and SPEC section 14, not a hard-coded prose list. Existing
areas remain bounded abstract claims. Adding or removing an area is normative and
requires exact-head maintainer approval. Formal scope never creates an implementation
refinement claim.

**D-7 (Claim language).** The system, implementation, substrate, profile, and product
MUST NOT be described as formally verified, formally proven, or provably correct.
Narrow formal statements identify their `AC-*`, `NC-*`, or `ASM-*` support. Narrow
implementation statements identify their `C13-*` or `P11-*` support. The claim linter
is a guardrail; CODEOWNER review remains responsible for meaning.

## 2. Change tiers

A change reports every detected category and declares one maximum tier. The order is
`S > D > L > I > P`; mixed changes use the highest tier and satisfy the union of gates
for every detected category. Classification is semantic, not a path-only rule, and
unknown cases fail closed. The doctrine, tier classifier, approval verifier, CI
workflow, CODEOWNERS, and gate implementations are Tier D because changing them can
weaken enforcement.

| Tier  | Meaning                                                                                                                     | Merge condition                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **P** | Proof bodies, tactics, or proof-irrelevant subterms only. The normative manifest is byte-identical.                         | Kernel, proof-hygiene, and normal CI checks pass.                                                             |
| **I** | Runtime, tooling, or tests with no normative or claim-surface change.                                                       | Normal CI and applicable conformance checks pass.                                                             |
| **L** | Formal or conformance status, mapping, summary, boundary, assumption, nonclaim, or other public claim-surface change.       | Checkers pass and an exact-head maintainer review approves the claim change.                                  |
| **D** | Allowlist membership, theorem or witness type, semantic definition closure, formal-scope membership, or scenario semantics. | Normative and proof gates pass, and an exact-head maintainer review approves the change.                      |
| **S** | Normative SPEC semantics.                                                                                                   | SPEC and all affected formal/conformance gates pass, and an exact-head maintainer review approves the change. |

A status promotion lands with its evidence. An integrity demotion lands with its
incident record. Boundary, assumption, nonclaim, and claim-summary prose is
human-reviewed and hard-blocking; it is never treated as harmless text.

## 3. Enforcement gates

### G-1. Normative manifest

`artifacts/normative.lock` is generated deterministically from the elaborated Lean
environment. It records:

1. the type of every designated theorem and non-vacuity witness;
2. allowlist and witness-coverage membership;
3. the type and value of every reachable project-owned semantic definition;
4. the exact kernel axiom set of every designated theorem and witness; and
5. the Lean toolchain, dependency manifest, encoding version, and hash algorithm.

The encoder uses a versioned structural representation of elaborated expressions:
fully qualified constants, universes, binder information, de Bruijn structure, and
literals. It erases source metadata, alpha-irrelevant binder names, designated theorem
and witness proof bodies, and subterms whose inferred type is `Prop`. It does not erase
propositions from theorem, witness, or semantic-definition types. It MUST NOT hash
pretty-printed expressions or `.olean` bytes.

Closure traversal follows declaration types and values. A reachable project
declaration missing from the manifest is an error. Proof-only rewrites and notation or
whitespace changes leave the lock unchanged; theorem, witness, allowlist, or reachable
semantic-definition changes alter it. Two clean generations must be byte-identical.

### G-2. Proof hygiene

For every designated theorem and witness, CI records the exact kernel axiom set and
rejects every custom axiom. The only currently permitted kernel dependencies are the
reviewed Lean built-ins `propext`, `Quot.sound`, and `Classical.choice`.

`sorry`, `admit`, custom `axiom`, `native_decide`, `ofReduceBool`, `unsafe`, `partial`
inside the modeled fragment, and metaprograms that introduce axioms are forbidden.
`ASM-*` entries are reviewed operational or refinement-boundary metadata. They are not
Lean axioms and MUST NOT be equated with `#print axioms`. A mathematical premise
belongs as an explicit theorem hypothesis; adding it is Tier D.

### G-3. Scenario provenance

Every new or semantically changed witness must cite a nonempty set of approved
scenario IDs. Approval binds the canonical scenario payload and the exact theorem and
witness type hashes. Near-miss relationships and opposite verdicts are mechanically
checked. Whether prose matches a witness and whether a perturbation is minimal remain
human judgments.

Legacy witnesses are grandfathered only by their exact adoption-manifest hashes. A
changed legacy witness loses that grandfathering. Until the scenario registry and its
signature checks are active, ordinary Tier D witness and statement changes are
frozen; only an approved integrity correction may proceed.

### G-4. Standing adversary

Touched adversary checks run before merge. Findings are append-only; resolutions are
separate and require an independent exact-head maintainer review. An open finding
against a proved-safety claim quarantines that release claim. Until automated spec
attack exists, every approved Tier D or S integrity correction requires a signed human
adversary review recorded with the change.

### G-5. Claim lint

The checker scans configured public prose and package-description surfaces, normalizes
case, punctuation, and Unicode, and ignores fenced and inline code. Blockquotes on a
public surface remain claim-bearing prose. It hard-bans system-level
formal-verification claims. An explicitly allowed formal claim must cite `AC-*`,
`NC-*`, or `ASM-*`; an implementation claim must cite `C13-*` or `P11-*`. Positive and
negative fixtures test the checker. It is a guardrail, not proof that prose is
semantically honest.

## 4. Approval and change control

Plain `Approved-By:`, `approved_by`, `Change-Tier:`, and `Doctrine-Rules:` strings do
not grant authority. They are contributor-controlled text.

The event-aware change-control gate compares explicit base and head commits, computes
all categories and the maximum tier, validates the declared tier, and verifies an
approval when required. The reviewed head must contain the exact base, so a base
advance forces a rebase and fresh approval. Approval is either:

- a GitHub CODEOWNER review whose `APPROVED` review is bound to the exact PR head SHA,
  where the trusted reviewer set is read from the base commit; or
- a maintainer-signed Git commit over the exact tree, verified against a trust root
  that the candidate diff cannot alter.

The checker implements both routes. The signed-commit route requires GitHub's valid
signature result, the exact commit SHA, and a signer who is a base-commit CODEOWNER;
it rejects GitHub-generated signatures so an API credential cannot impersonate the
maintainer's independently held signing key. Branch or ruleset protection MUST require
the change-control and verification checks with no bypass. The CODEOWNER route also
requires CODEOWNER review and stale-review dismissal; the signature route also
requires signed commits. Hooks and local checks are conveniences, not authorization.
CI MUST NOT run untrusted candidate code in a privileged `pull_request_target`
context.

The adoption change is the bootstrap boundary. Its base commit and pre-existing
CODEOWNERS are grandfathered only so the new checker can run; the adoption PR itself
still requires real CODEOWNER approval before merge.

## 5. W-1: scenario-first normative work

Before changing a theorem or witness type or modeling a new SPEC property:

1. read the exact SPEC rule and existing claim boundary;
2. write structured scenarios with concrete inputs and exact expected verdicts;
3. include discriminating near-miss pairs and oracle-killing cases for executable
   decisions;
4. obtain exact-head maintainer approval over the scenarios and affected type hashes;
5. change definitions and statements; then write proofs; and
6. bind each witness to one or more approved scenario IDs.

Scenario records contain stable ID, requirement ID, structured input when executable,
given/when/then, exact verdict, rationale, adversarial flag, near-miss IDs, theorem and
witness type hashes, and disposition. Reviewer identity is display metadata only; the
approval gate is authoritative.

## 6. W-2: derived backlog

The backlog is a deterministic view, never a second editable source of truth. Inputs
are typed obligations explicitly marked `candidate`, open conformance atoms, open
release-chain links, formal-mutation survivors, open adversary findings, differential
divergences, and infrastructure milestones.

Operational assumptions and nonclaims are not automatically debt. Each source record
declares a disposition such as `candidate`, `permanent-boundary`, `mechanize`, or
`conformance`, an owner, priority, and an exact oracle. Free prose is not converted
into a fabricated acceptance test. A source without a typed oracle produces a
maintainer-triage item and stays unresolved.

The generator runs in check mode in CI and never mutates the tree. IDs derive from the
source kind and source ID. It rejects duplicate sources, missing gates or selectors,
editable shadow state, and stale output. Human veto or reorder changes the reviewed
source policy; regeneration applies it.

## 7. W-3: executable formal fragments

Executable models are listed in one structured registry with entry point, transitive
fragment closure, oracle operation, generated target, runtime adapter, and bounds
artifact. Name suffixes are not classification.

The fragment checker accepts only the reviewed total, first-order subset and rejects
higher-order or unbounded constructs. If a model falls outside the fragment, restrict
the transpiler representation without narrowing the SPEC property or accepted
scenarios. Otherwise file STUCK or use the reviewed Lean-to-Wasm fallback.

Generated TypeScript carries source, toolchain, transpiler, registry, and bounds
hashes and regenerates byte-identically. It replaces only the exact modeled decision
behind an explicit adapter. For example, an executable Grant-plane decision cannot be
claimed to replace Binding, path, Principal, or guest-current checks it does not model.
Differential evidence remains empirical and never becomes a refinement proof.

## 8. W-4: concurrency model checking

Quint may model lease, epoch, watermark, mailbox, commit-unknown, and restart
interleavings as a separate artifact. The repository pins the tool, model, bounds,
fairness or transport assumptions, explored-state count, and result hashes. Results
are labeled `model-checked`, never `proved`. No Lean/Quint or Quint/TypeScript
refinement is implied.

Liveness wording such as “no command is silently lost” requires explicit fairness and
transport assumptions or a safety reformulation. State-space bounds and correspondence
to SPEC are reviewed facts, not inferred guarantees.

## 9. W-5: assumptions

`ASM-*` records stay reviewed boundary metadata. They MUST NOT become global Lean
axioms. The checker validates their ownership, references, and structured dispositions
without pretending they are kernel dependencies.

When a theorem needs a mathematical premise, state it as an explicit proposition in
the theorem type. Operational assumptions are discharged by implementation or
substrate evidence only when the relevant conformance plane supports that narrower
claim. Removing or changing a premise, assumption, or boundary is a reviewed claim
change.

## 10. W-6: adversarial assurance

### A-1. Formal-model mutation

Mutate semantic definitions in an isolated tree and rebuild unchanged definitions,
theorems, and witnesses. Disable only normative-lock comparison during the mutant
run, or the lock becomes a trivial oracle. Target zero actionable survivors, not zero
raw survivors. Each equivalent mutant requires its own falsifiable Lean equivalence
proof and exact stale/refuted register entry. This register is separate from Stryker's
TypeScript mutation evidence.

### A-2. Spec attack

A finding contains a concrete model satisfying the designated theorem hypotheses and
a specific quoted SPEC rule it violates. Filing and resolution are append-only,
separate records. Only an independently reviewed resolution may close a finding; an
agent name string is not separation of duties.

### A-3. Round-trip review

Back-translation of formal statements may flag prose divergence. It is a review aid,
not evidence, a finding, or a replacement for source inspection.

## 11. STUCK and integrity corrections

A STUCK record names the task and rule IDs, the precise obstruction, the weakening
that would unblock but was not applied, alternatives attempted, evidence, and a
recommendation. Pending proposals are agent-authored. Approval and resolution records
are immutable, separate, and contributor-unforgeable.

An integrity correction may demote or quarantine a false claim. It must include the
incident or STUCK record, affected claim IDs, before and after normative manifests,
before and after SPEC digests, a recorded human adversary-review report, and
exact-head maintainer approval. It MUST NOT be bundled as an offset for unrelated
work.

## 12. Milestones and freeze state

| Milestone | Completion condition                                                                                                       | State at adoption                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **M-1**   | Normative manifest, proof hygiene, claim lint, semantic tier classifier, event-aware approval, CI and rule-registry wiring | Milestone-gated pending protected-branch enforcement and a contributor-independent approval identity |
| **M-2**   | Typed source obligations and deterministic complete backlog view with stale-output tests                                   | Milestone-gated pending classification of every free-text formal evidence obligation                 |
| **M-3**   | Executable-model registry and recorded bounded-exhaustive differential runs                                                | Milestone-gated                                                                                      |
| **M-4**   | Formal mutation runner and exact equivalence register                                                                      | Milestone-gated                                                                                      |
| **M-5**   | Signed scenario registry plus exact legacy-witness grandfather manifest                                                    | Milestone-gated                                                                                      |
| **M-6**   | Reviewed transpiler slice and pinned Quint track                                                                           | Milestone-gated                                                                                      |
| **A-2**   | Append-only adversary findings and independently approved resolution workflow                                              | Milestone-gated                                                                                      |

Milestone-gated means the doctrine does not claim the mechanism exists. M-1 remains
gated until the protected default branch requires the immutable change-control and
verification checks and either an independent CODEOWNER or a maintainer signing key
can approve the exact candidate tree without being available to agents. Ordinary Tier
D witness or theorem changes stay frozen until M-5 and A-2 are active. M-2 remains
gated until every formal remaining-evidence source has a reviewed disposition, owner,
priority, and machine oracle. The derived triage view does not itself type those
sources. M-3, M-4, and M-6 claims stay forbidden until their named evidence exists.
Proof-only work and implementation work continue under the active gates. Approved
integrity corrections remain possible through section 11.

## 13. Definitions of done

- **Proof-only:** only proof bodies, tactics, or proof-irrelevant subterms changed;
  kernel build and proof hygiene pass; normative lock is unchanged.
- **Implementation:** behavior, types, lint, build, and applicable conformance checks
  pass; no normative or claim-surface drift exists.
- **Formal normative:** scenarios and adversary controls are active; exact scenarios,
  lock diff, proof hygiene, traceability, and approval pass.
- **Claim change:** dual-plane checker and claim lint pass; evidence is exact; approval
  is bound to the reviewed head.
- **SPEC change:** SPEC, normative coverage, affected formal/conformance checks, and
  exact-head approval pass.
- **Backlog item:** its source disposition changes or its recorded machine oracle
  passes; regeneration removes it without hand-editing the derived file.

No task is done because a status string changed, a checker was weakened, a baseline
was refreshed without evidence, or a future milestone was described in prose.

## 14. Default locations

```text
AGENT_OPERATING_DOCTRINE.md
packages/agent-core/artifacts/normative.lock
packages/agent-core/artifacts/quality/doctrine.json
packages/agent-core/artifacts/quality/backlog.json
packages/agent-core/artifacts/scenarios/
packages/agent-core/artifacts/stuck/
packages/agent-core/artifacts/findings/
packages/agent-core/scripts/quality/change-control.mjs
packages/agent-core/scripts/quality/doctrine.mjs
packages/agent-core/scripts/quality/claims.mjs
packages/agent-core/scripts/quality/backlog.mjs
packages/agent-core/formal/AgentCore/Normative.lean
```

Paths may change through a reviewed implementation decision. The rules they enforce
do not change implicitly with a path.
