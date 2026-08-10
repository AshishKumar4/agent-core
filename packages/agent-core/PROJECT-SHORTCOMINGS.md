# Agent Core shortcomings and completion backlog

**Baseline:** `7f738fe824b410436a2a149a75b4258e110ce020` on 2026-08-09.

This is the concise source of truth for known shortcomings. An item is not complete
until its implementation, behavioral evidence, formal claim, and live-substrate
evidence agree where applicable.

## P0 — security and assurance blockers

- [ ] **Fix authority-cache identity confusion.** `ActorAuthorityState` uses raw
      NUL-delimited tenant/principal/binding keys even though IDs allow U+0000. Distinct
      cross-tenant identities can collide and retrieve the wrong cached authority
      candidate. Use an injective typed encoding, revalidate tenant/caller/candidate
      identity at the trust boundary, sweep all composite keys, and add Unicode/NUL
      adversarial tests. A similar key in definition planning also requires review.
- [ ] **Connect formal claims to production behavior.** The current Lean package proves
      properties of an abstract model only. It does not prove that TypeScript, Cloudflare
      adapters, Memory/SQLite storage, provider calls, codecs, bundles, configuration, or
      deployments refine that model. This is an assurance shortcoming to close, not an
      acceptable final boundary.
- [ ] **Model the real distributed authority protocol.** Lean's atomic mediated step
      does not represent the actual split between asynchronous permit authentication and
      target-local nonce-consumption/effect-attempt transaction. Model loss, duplication,
      reordering, replay, expiry, revoke races, restart, reset, and commit-unknown states
      without assuming a cross-Actor transaction.
- [ ] **Integrate runtime authority administration into reachability.** The canonical
      reachable system excludes revoke, bind, rematerialize, membership, and foreign
      verification transitions after bootstrap. Prove mediation safety across these live
      interleavings.
- [ ] **Finish the release gate honestly.** The source stage is `building`, conformance
      is 394/412, and 1,599 mutation survivors remain actionable. `check:final` must not
      pass until conformance is complete, mutation is closed, all aggregate coverage is at
      least 95%, and live evidence is bound to the exact release tree and deployment.

## P1 — missing normative implementation

- [ ] **Implement the concrete Turn host and agent harness.** `TurnExecutor` is only an
      internal abstract seam with a fake test subclass. No production host calls a model,
      binds tools, streams output, checkpoints, recovers, or settles a Turn. Reopen the
      integration-ledger entry that falsely marks TurnExecutor host composition accepted
      using unrelated Run-frontier evidence.
- [ ] **Make the executor boundary typed and public.** Replace raw facet/operation
      strings with the existing typed `OperationDescriptor` source of truth; provide
      lease-scoped prompt/content, inbox, invocation, commit, checkpoint, cancellation,
      model-call, usage, and stream contracts through a supported package export.
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
- [ ] **Unify closed vocabularies.** Placement cases/order and impact cases/order have
      multiple owners. Establish one smart value object/source of truth for cases,
      validation, and canonical ordering. Resolve `CapabilitySpec` ownership.
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

- [ ] Give security-critical pure decisions executable Lean definitions with
      soundness and completeness proofs.
- [ ] Define concrete representation relations for typed IDs, time, integers,
      canonical JSON, codecs, digests, errors, and validated inputs.
- [ ] Generate or run the small verified decision kernel where practical; otherwise
      label differential/property/mutation evidence as empirical, not proof.
- [ ] Prove Actor-local persistence refinement over transaction, uniqueness,
      rollback, restart, and commit-unknown states. Keep SQLite itself in the documented
      trusted base unless it is independently verified.
- [ ] Model Tenant Actor, target Actor, transport, time, crash/restart, permit, and
      route machines separately. Prove safety under loss/duplication/reorder/replay/reset;
      state liveness only under explicit fairness/eventual-delivery assumptions.
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

- [ ] `C13-AUDIT-TELEMETRY-EXCLUDED`
- [ ] `C13-AUTH-GUEST-VERIFICATION`
- [ ] `C13-AUTH-RESOLUTION-LIFETIME`
- [ ] `C13-CONFIG-SECRET-CUSTODY`
- [ ] `C13-CONTENT-CUSTODY`
- [ ] `C13-FACET-DISPOSAL`
- [ ] `C13-FACET-INSTALL-VERIFICATION`
- [ ] `C13-OWNERSHIP-SINGLE-OWNER`
- [ ] `C13-PLACEMENT-DYNAMIC-NO-EGRESS`
- [ ] `C13-POLICY-IMPACT-BOUNDARY`
- [ ] `C13-RECEIPT-IMMUTABLE`
- [ ] `C13-ROUTE-DELIVERY-ONCE`
- [ ] `C13-RUN-CHECKPOINT-KINDS`
- [ ] `C13-RUN-PIN-IDENTITY-TYPES`
- [ ] `C13-RUN-TREE-CONFLICT-EXPLICIT`
- [ ] `C13-TURN-MODEL-CALL`
- [ ] `C13-VIEW-APPROVAL-PROVENANCE`
- [ ] `P11-ENVIRONMENT-NO-AMBIENT-EGRESS`

## Required execution order

1. Fix identity/cache security and inaccurate evidence mappings.
2. Reconcile bounded contexts, ownership, and public contracts before adding harness
   types.
3. Close the 18 conformance atoms, coherence findings, mutation survivors, and final
   release gate.
4. Implement one typed, crash-safe pi Turn vertical slice.
5. Add the shared step pipeline, dynamic context, and ACP adapters.
6. Add attenuated subagents, mixed-family panels, and MCTS policies.
7. Complete implementation/storage/distributed refinement and exact-deployment live
   evidence.

No stage is complete because tests are numerous, coverage is high, or a theorem/checker
passes. Completion requires the named behavior and its evidence to agree.
