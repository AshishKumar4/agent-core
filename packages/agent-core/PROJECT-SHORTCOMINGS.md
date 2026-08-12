# Agent Core shortcomings and completion backlog

**Baseline:** `7f738fe824b410436a2a149a75b4258e110ce020` on 2026-08-09.

This is the concise source of truth for known shortcomings. An item is not complete
until its implementation, behavioral evidence, formal claim, and live-substrate
evidence agree where applicable.

## P0 — security and assurance blockers

- [~] **Fix authority-cache identity confusion.** The authority cache itself is done and
      this entry was stale: `resolutionCacheKey` and `authorityKey` now encode their
      component tuple as canonical JSON rather than joining it with NUL, and
      `ActorAuthorityState.matches` revalidates tenant, caller, and candidate identity on
      both a cache hit and a miss. `AC-KEY-001` states the obligation every remaining
      composite key must discharge and proves which shapes discharge it. Surveyed against
      it, all nine remaining NUL-joined record-store keys are injective: four join a closed
      record-kind vocabulary on the left, five a decimal revision or ordinal on the right.
      What is not injective is the prefix scan built on one of them. `approvalEntries` in
      `src/invocations/memory.ts` selects an Approval's revisions by testing whether a key
      starts with the id followed by NUL, and `TextId` accepts U+0000 — so an Approval
      whose id itself contains NUL is selected by a scan for the id's prefix.
      `prefix_scan_admits_foreign_identifier` is that hazard exactly: a scan needs a
      delimiter-free identifier domain, which the join it is built on does not.
      Revalidation at line 111 stops it becoming a wrong-record read, so the reachable
      effect is a legitimate Approval reported as store corruption and a revision order
      sorted on `NaN`, not an authority escalation. Remaining: give the scan an exact parse
      or exclude the delimiter from the identifier domain, record the discharged side per
      key, and add the Unicode/NUL adversarial tests. Canonical-JSON keys rest on
      `ASM-CANONICAL-KEY-INJECTIVE`, which is assumed and not proved. A similar key in
      definition planning still requires review.
- [ ] **Connect formal claims to production behavior.** The current Lean package proves
      properties of an abstract model only. It does not prove that TypeScript, Cloudflare
      adapters, Memory/SQLite storage, provider calls, codecs, bundles, configuration, or
      deployments refine that model. This is an assurance shortcoming to close, not an
      acceptable final boundary.
- [x] **Model the abstract distributed authority protocol.** Lean now separates
      a target-owned immutable request, Tenant-local issuance from current authority and
      the authenticated request payload, typed lossy/duplicating/reordering transport,
      volatile target authentication, and target-local nonce-consumption plus
      EffectAttempt/audit atomicity. Reachability proves that transported, authenticated,
      and consumed permits have historical Tenant issuance without making consumption
      read issuer storage. It covers replay, expiry, restart/reset, and before/after
      commit-unknown observations without a cross-Actor transaction. Every attempt in the
      current reachable system requires exact request, issuance, consumption, and attempt
      evidence; no Actor-local boolean or claimed admission path exists. A generic
      Actor-local path remains open only if future canonical authority ownership makes it
      realizable in one owner transaction. This closes the abstract-model P0 only; the
      unchecked TypeScript/storage/Cloudflare refinement P0 above remains open.
- [ ] **Model live authority administration through mediated capabilities.** Canonical
      reachability currently initializes authority only in trusted bootstrap. It does not
      admit raw `AuthorityStep` or Role rematerialization as an ungated runtime path.
      Revocation, binding, membership, foreign-verification, and role-materialization
      interleavings remain incomplete until an actual object-capability/mediated admin
      transition exists; post-issuance revocation timing is therefore not claimed.
- [ ] **Finish the release gate honestly.** The source stage is `building`, conformance
      is 395/412, and 1,599 mutation survivors remain actionable. `check:final` must not
      pass until conformance is complete, mutation is closed, all aggregate coverage is at
      least 95%, and live evidence is bound to the exact release tree and deployment.

## P1 — missing normative implementation

- [~] **Implement the concrete Turn host and agent harness.** HOST DONE, HARNESS
  STARTED. `TurnExecutorHost` binds tools, streams ephemeral output, checkpoints,
  recovers, and settles the exact leased Turn through canonical Run records. The kernel
  still reaches no provider, which is correct for §5.6. `@agent-core/harness` now
  supplies the missing side: a `Transcript` record and codec, a `ModelProvider` seam
  with an OpenAI-compatible implementation for Workers AI and AI Gateway, a
  `TranscriptTurnModelPort`, and an `AgentLoopTurnExecutor` whose every tool call goes
  through `TurnInvocationHandle` under a request key derived from Turn, step, and
  tool-call id. What remains is the mediated half — see the two entries below, which
  block any tool call from producing a real Receipt outside core's own test tree.
- [x] **Make the executor boundary typed and public.** `TurnBoundTool` uses the existing
      `OperationDescriptor` source of truth, and the supported Run export exposes
      lease-scoped prompt/content, inbox, invocation, commit, checkpoint, cancellation,
      model-call, usage, and stream contracts.
- [x] **Give the mediation pipeline a production assembly.** All four collaborators now
      live beside `composition/permit.ts`: `DerivedMediationIdentities`,
      `CanonicalMediationPreparation`, `CanonicalMediationRecords`, and
      `DerivedDirectOperationContext`. Every identifier is a domain-separated digest of
      the durable evidence that determines it, so a restarted worker recomputes the same
      identity rather than forking a second one. `packages/agent-core-harness/test/audit-chain.test.ts`
      drives one real conversation end to end and shows the Run, Turn, commits,
      InvocationId, ItemClaim, EffectAttempt, Receipt, and the invocation -> attempt ->
      receipt AuditRecord chain.
- [~] **Make the mediated pipeline constructible by a consumer.** `@agent-core/core/mediation`
      publishes `MediatedOperationPipeline`, a composition root that takes the substrate
      ports and returns a `TurnMediatedInvocationPort`. `OperationGatewayHost` and
      `FacetRuntimeHost` stay forbidden — now including on the new subpath — because the
      root assembles them itself. What remains: the Tenant authority permit plane
      (`AuthorityPermitIssuer`, `AuthorityPermitAdmissionPort`, `MemoryAuthorityPermitStore`,
      `StoredAuthorityPermitAdmissionPort`, and an `AuthorityPermitExpectationFactory`) is
      still unexported, so a consumer must supply its own permit, authentication, and
      target-admission ports. Decide whether that plane gets its own composition root or
      stays a consumer responsibility.
- [x] **Give a running Turn a cancellation entry point.** `RunRuntime.deliverEvent` now
      admits the reserved `turn.cancel` Event against the exact presented live lease, so
      an ordinary stop request reaches the holder without fencing it out of its own
      §5.3 `running -> cancelled` transition. Cancellation evidence is recorded once per
      lease, and the executor seam no longer treats a cancellation on a still-current
      lease as a settled outcome.
- [ ] **Implement all interceptor cut points through one engine.** Only
      `operation.before` and `operation.after` execute. `prompt.assemble`,
      `input.submitted`, and `turn.step` are declarations without runtime behavior.
- [ ] **Resolve interceptor replay drift.** SPEC requires exact intermediate
      transformations; TypeScript persists digest traces plus final values. Either persist
      every exact transformation, directly or by immutable `ContentRef`, or deliberately
      revise the SPEC and guarantees. Correct the misleading conformance source mapping.
- [ ] **Complete guest Grant verification.** The authority service currently throws an
      explicit unimplemented error.
- [ ] **Remove or implement public placeholders.** In particular, do not expose
      `UnimplementedPlacementMigration` as a supported Cloudflare capability.
- [ ] **Complete crash consistency and recovery evidence.** Cover every transaction
      statement/reply boundary, rollback and commit-unknown outcome, cold start/reset,
      duplicate/lost/delayed/reordered delivery, reconciliation, and provider
      idempotency. Recovery must map to exactly the abstract before-state or after-state,
      never a partial state.
- [ ] **Complete real Cloudflare evidence.** Workerd is not proof of deployed Durable
      Object routing, hibernation, eviction, reset, RPC failure, transactions, or egress
      controls. Run disposable live scenarios bound to exact source, bundle, config,
      migrations, and deployment identity.

## P1 — out-of-the-box harness and hosted product

- [ ] **Build a standard harness around low-level `pi-agent-core`/`pi-ai`.** Keep pi out
      of the agnostic kernel. Agent Core Runs, Turns, committed messages/evidence, and
      checkpoints remain canonical; pi owns no parallel session or WAL. Every tool call
      traverses Agent Core mediation and an explicit sandbox.
- [ ] **Implement one shared model-step pipeline.** It owns prompt assembly,
      interception, pruning/compaction, dynamic context, cache markers, model selection,
      streaming, tool mediation, cancellation, usage/cost evidence, and safe checkpoint
      boundaries.
- [ ] **Adopt the Proteus dynamic-context semantics without copying product state.**
      Recompute at every model call; append one `<dynamic_context>` block only when exact
      rendered bytes change; freeze prior blocks byte-identically; never persist the
      block; cold start/history reset creates exactly one fresh block. Its fingerprint is
      diagnostic only and must not control authority, identity, or deduplication.
- [ ] **Support subagents using existing primitives.** A child is an attenuated child
      Run reserved by `SpawnReservation`, not a second Subagent domain. Child history,
      authority, model policy, cost/resource ceiling, settlement, and recovery use the
      same canonical primitives.
- [ ] **Support MCTS and other search as orchestration policy.** Use Runs, branches,
      Environment snapshots, Operations, acceptance evidence, and binary merges. Do not
      add universal `MctsNode`/search-tree primitives. Losing heads must not leak shared
      filesystem or external effects, and full reports must use `ContentRef` without
      silent truncation.
- [ ] **Support mixed/cross-model-family panels.** The parent may select each child's
      provider/model only within delegated policy, budget, trust, egress, and data
      residency limits. Pin the exact provider/model/revision/options per call. Required
      panels use independent blind requests from distinct approved families and fail
      explicitly when quorum is unavailable; never pad with repeated same-family samples.
- [ ] **Implement ACP in both directions.** Provide an agent-side adapter for clients
      and a separate client-side `TurnExecutor` for Claude Code, Codex, pi, and other ACP
      agents. Negotiate ACP v1 capabilities, fail closed for unsupported capabilities,
      route filesystem/terminal/permissions through Agent Core, and never let “allow
      always” mint a Grant. Define reconnect idempotency rather than deduplicating text.
- [ ] **Power the Cloudflare hosted implementation with Agents SDK while retaining one
      domain model.** Agents SDK should provide Agent/Durable Object lifecycle, RPC,
      streaming/WebSockets, scheduling, and child hosting. Agent Core remains the sole
      canonical model for Runs, Turns, history/evidence, authority, Grants, approvals,
      attempts, Receipts, children, and recovery. SDK storage/helpers must directly
      implement those contracts or be disposable projections—never parallel canonical
      state.

## P2 — architecture and API quality

- [ ] **Reconcile the bounded-context map with source.** `content`, `operations`, and
      three `*-references` pseudo-contexts are absent from the declared map. Approve one
      explicit cycle-free identity layer or return IDs to their owning contexts; update
      the import checker to enforce the approved context registry.
- [ ] **Resolve AuthorityPermit ownership without weakening it.** The full security
      binding is necessary, but authority currently imports Actors, Runs, invocations,
      definitions, and facets despite being forbidden to own invocation mediation. Keep
      one complete permit and validation path, reuse existing typed evidence, and put
      cross-context assembly at the proper mediation/protocol boundary or explicitly
      sanction a clean one-way design.
- [ ] **Shrink the public API before publication.** The root exposes roughly 327
      runtime values and roughly 596 symbols including types. Curate stable deep modules
      and workflows; keep internal composition, test stores, snapshots, parsers, and
      unfinished records off supported surfaces. Add packed NodeNext positive and negative
      consumer tests.
- [ ] **Remove duplicate identity representation.** Several records store both a
      `ContentRef` and its directly derivable digest. Retain one canonical identity unless
      the second field is independently authenticated and necessary.
- [x] **Unify the placement closed vocabulary.** `IsolationMode`'s cases, order, and
      validity check now have one owner: `facets/manifest.ts` declares `PLACEMENT_PREFERENCE`
      beside the type itself; `definition/placement.ts` re-exports it instead of keeping a
      second copy, and every membership check (`facets/manifest.ts`, `definition/placement.ts`,
      `agents/runs/placement.ts`) delegates to `core`'s `isMember` against that one array.
      `invocations/operation-pin.ts` and `definition/policy.ts` already delegated correctly.
- [ ] **Unify the impact closed vocabulary.** Impact cases/order still have multiple
      owners. Establish one smart value object/source of truth for cases, validation, and
      canonical ordering. Resolve `CapabilitySpec` ownership.
- [ ] **Consolidate narrow codec mechanics.** Byte equality and canonical-JSON parsing
      helpers are repeated across contexts and already differ semantically. Centralize
      syntax mechanics while keeping domain validation local. Specify constant-time
      equality where secrets require it.
- [ ] **Remove stale pre-public compatibility/dead code.** Review
      `holdForMilliseconds`, `HeldContentStore`, `HeldContentVerifier`, stale capability
      ownership encoding/comments, and the unused duplicate `facets/surface.ts`.
- [ ] **Empty the architecture baseline.** It reports zero current issues but retains
      168 resolved fingerprints, allowing identical debt to recur during building-stage
      checks. Remove resolved entries or fail on a stale baseline.

## P2 — evidence quality

- [ ] **Close 14 coherence issues.** Add missing atoms for SPEC §10.1, §4.3, §5.5,
      and §9.2; split shared blocks covering 11 Run atoms and five Turn no-retry atoms; and
      define the eight referenced DEVICE/MCP/SLATE/WEB crash-retry/dispatch labels.
- [ ] **Eliminate all actionable mutation survivors.** Review equivalent mutants
      narrowly; do not rely on broad static exclusions or killed percentages.
- [ ] **Test supported contracts, not only source layout.** 264 core tests import
      relative `src` paths. Every release claim also needs evidence through packed public
      exports.
- [ ] **Assert stable error contracts.** Replace prose-coupled assertions where the
      contract is an `AgentCoreError` code/type/field. Current tests contain hundreds of
      literal and more than a thousand regex `toThrow` message assertions.
- [ ] **Correct source-to-requirement mappings.** Tests that execute authority
      composition omit its production symbols, and other atoms point at records that do
      not implement the claimed behavior. Trace the actual requirement, theorem,
      production path, public behavior, and live scenario.

## Formal completion program

- [~] Give security-critical pure decisions executable Lean definitions with
      soundness and completeness proofs. DONE for the exact Turn lease
      (`AC-LEASE-001`), the §7.2 tier floor and placement order (`AC-PLACEMENT-001`),
      and capability admission and attenuation (`AC-CAPABILITY-001`). The attenuation
      decision is stated as SPEC §3.4 rule 2 itself — containment of admitted intents
      over the whole intent domain — proved sound unconditionally, with the pattern
      layer proved exactly equivalent to glob language containment in both directions;
      `covering_chain_never_widens` lifts the resolver's pairwise check to the whole
      lineage. That work found and fixed a live escalation: `CapabilitySpec.covers`
      approximated containment by prefix and suffix and admitted `a*a` over `a`.
      Completeness at the capability level is relative to argument paths being treated
      as independent, which soundness does not rely on. Remaining: deny precedence and
      the rest of Grant resolution (`AuthorityRuntime.evaluate`) have no executable
      definition — `deny_overrides` is proved over the abstract ledger only.
- [~] Define concrete representation relations for typed IDs, time, integers,
      canonical JSON, codecs, digests, errors, and validated inputs. STARTED. Typed IDs
      have one: `AC-KEY-001` proves when a stored delimiter-joined key determines the
      identity it was built from, proves it does not when neither component side
      excludes the delimiter, and proves the prefix scan built from it admits a foreign
      identifier under that condition. Validated inputs have one where the capability
      decision needs it (`PatternValid`, `CapabilityValid`), and constraint values are
      represented by the canonical encoding the implementation actually compares.
      Remaining: time, integers, canonical JSON itself (assumed injective as
      `ASM-CANONICAL-KEY-INJECTIVE`), codecs, digests, and errors have none, and no
      stored key has yet discharged its per-key obligation.
- [~] Generate or run the small verified decision kernel where practical; otherwise
      label differential/property/mutation evidence as empirical, not proof. LABELLED.
      `NC-DIFFERENTIAL-EMPIRICAL` records that oracle agreement, property runs, and
      mutation measurement bound only the inputs exercised and earn no proved status;
      the oracle and its client say the same where a passing run is read. No decision
      kernel is generated: the executable definitions are written in Lean and extracted
      by no tool, so the oracle binary and the TypeScript remain two implementations
      whose agreement is sampled, not one artifact derived from the other.
- [ ] Prove Actor-local persistence refinement over transaction, uniqueness,
      rollback, restart, and commit-unknown states. Keep SQLite itself in the documented
      trusted base unless it is independently verified.
- [x] Model the target-owned request, Tenant Actor permit issuance, typed transport,
      target Actor authentication/consumption, monotonic time, restart/reset, replay, and
      commit-unknown observations separately. The abstract safety theorems cover
      loss/duplication/reorder/replay/reset and historical issuance; no liveness theorem
      is claimed without explicit fairness/eventual-delivery assumptions. Route transport
      remains owned by the separate routing LTS.
- [ ] Build the release assurance chain:

    ```text
    SPEC requirement
      -> Lean theorem and assumptions
      -> executable decision
      -> TypeScript refinement evidence
      -> Memory/SQLite crash contract
      -> Cloudflare live scenario
      -> exact deployed bundle/config/migrations
    ```

## Behavioral and dynamical test requirements

- [ ] P0: identity substitution, epochs/deadlines/leases/fences/nonces/claims, every
      authority/admission interleaving, no pre-admission effects, secret non-disclosure,
      sandbox/ambient-egress denial, duplicate/reordered messages, and every crash boundary.
- [ ] P1: model/tool success/failure/cancel/suspend/indeterminate paths, checkpoint and
      cold-start recovery, child/panel partial failure, dynamic-context invariants, ACP
      negotiation/reconnect, interceptor replay, Memory/SQLite parity, and real deployed
      substrate behavior.
- [ ] P2: randomized state-machine traces with replay seeds, long-history/catalog
      pressure, fan-out/depth/backpressure/cancellation storms, load/performance,
      telemetry completeness, and provider/model compatibility/evals.
- [ ] Run every seam contract against Memory and SQLite, and every platform-specific
      claim against a disposable live deployment. Preserve minimal failing traces.

## Incomplete conformance atoms

- [x] `C13-AUDIT-TELEMETRY-EXCLUDED`
- [x] `C13-AUTH-GUEST-VERIFICATION`
- [ ] `C13-AUTH-ISOLATE-DELEGATION`
- [ ] `C13-AUTH-RESOLUTION-LIFETIME`
- [ ] `C13-CONFIG-SECRET-CUSTODY`
- [ ] `C13-CONTENT-CUSTODY`
- [ ] `C13-FACET-DISPOSAL`
- [x] `C13-FACET-INSTALL-VERIFICATION`
- [ ] `C13-OWNERSHIP-SINGLE-OWNER`
- [ ] `C13-PLACEMENT-AUTHORED-BACKING`
- [ ] `C13-PLACEMENT-DYNAMIC-NO-EGRESS`
- [ ] `C13-POLICY-IMPACT-BOUNDARY`
- [x] `C13-RECEIPT-IMMUTABLE`
- [x] `C13-ROUTE-DELIVERY-ONCE`
- [x] `C13-RUN-CHECKPOINT-KINDS`
- [x] `C13-RUN-PIN-IDENTITY-TYPES`
- [ ] `C13-RUN-RESOURCE-CEILING`
- [ ] `C13-RUN-TREE-CONFLICT-EXPLICIT`
- [x] `C13-TURN-MODEL-CALL`
- [ ] `C13-VIEW-APPROVAL-PROVENANCE`
- [ ] `P11-ENVIRONMENT-NO-AMBIENT-EGRESS`
- [x] `P11-FILESYSTEM-SESSION-DIRECT`

## Required execution order

1. Fix identity/cache security and inaccurate evidence mappings.
2. Reconcile bounded contexts, ownership, and public contracts before adding harness
   types.
3. Close the 17 conformance atoms, coherence findings, mutation survivors, and final
   release gate.
4. Implement one typed, crash-safe pi Turn vertical slice.
5. Add the shared step pipeline, dynamic context, and ACP adapters.
6. Add attenuated subagents, mixed-family panels, and MCTS policies.
7. Complete implementation/storage/distributed refinement and exact-deployment live
   evidence.

No stage is complete because tests are numerous, coverage is high, or a theorem/checker
passes. Completion requires the named behavior and its evidence to agree.
