# Agent Core Cloudflare substrate

Private Cloudflare substrate primitives for Agent Core. This package
contains platform adapters only. It does not own domain records, authority, holds,
Receipts, or reconciliation policy.

The default platform tests and doubles are intentionally structural. Passing them is
not Cloudflare Workers conformance evidence.

`test/cloudflare/vitest.config.ts`, `wrangler.test.jsonc`, and `test/cloudflare/*` contain an
executable Workers-runtime suite using the current `cloudflareTest()` and
`cloudflare:test` APIs. W0 owns the package manifest, dependency pins, workspace
importer, lockfile, and aggregate commands; W8 requests their exact content in
`artifacts/requests/W8/shared-integration.json` rather than modifying those files.

The Workers suite asserts SQLite migrations and rollback, R2 access, per-message queue
ack/retry and idempotent redelivery, startup alarm repair from the ID-only outbox,
attachment-backed WebSocket replay after DO eviction, and migration idempotence across
restart. It also exercises the Loader binding with an allowlisted capability and proves
that Dynamic Workers have no ambient outbound access. Local Miniflare cannot provision
a Workers-for-Platforms staging script or establish Sandbox provider behavior, so those
remain explicit consent-gated integration gates and are not claimed here.

The SQLite adapter intentionally uses local structural interfaces. The public
`@agent-core/core/substrates/sqlite` package currently resolves through built `dist`
artifacts, which are not guaranteed to exist during isolated package tests. The local
types match that public seam structurally without importing unexported core source or
duplicating domain behavior.

The R2 repository is a tenant-scoped content-object store. It verifies bytes and
storage metadata but deliberately provides no content-hold or authority API. Those
remain core domain concerns.

Actor object names are a pure function of the core Actor identity `(kind, id)`:
`agent-core:actor:v1:<kind>:<id>`. One `ActorRef` therefore maps to exactly one object
name and one authoritative store (fence epoch and permit-nonce ledger), which is the
single-owner invariant the substrate must preserve.

Jurisdiction is physical placement only. A jurisdiction-restricted namespace still yields
a physically distinct object for the same name, so a given `ActorRef` must be bound to one
jurisdiction for its lifetime. `PlacementResolver` enforces this over a `PlacementRegistry`
seam (with `MemoryPlacementRegistry` as the deterministic reference and a Durable Object or
config store in production): the first resolution pins an `ActorPlacement`
`{ actorName, jurisdiction, pinnedAt, epoch }`, and every later resolution reads that pin.
An explicit, conflicting per-call jurisdiction for a pinned Actor is rejected with a typed
`protocol.invalid-state` error — it never resolves to a second object. `locateActorObject()`
remains the low-level name lookup and selects a jurisdiction-restricted namespace only when
its separate `namespaceJurisdiction` option is supplied.

Changing an Actor's jurisdiction is a fenced migration only, expressed by the
`PlacementMigration` contract (`PlacementMigrationRequest` carries the target jurisdiction and
the source lease epoch under which the source object must be drained and fenced before the
successor pin is installed at the next epoch). Full migration execution is out of the
adapter's current scope; `UnimplementedPlacementMigration` fails closed with a typed
not-implemented error rather than faking a move.

The alarm driver exposes two sides of crash-safe scheduling: call `armAlarm()` after
the Actor durably enqueues an outbox ID, and call `repairAlarm()` on Actor startup. A
crash between enqueue and physical alarm creation is repaired from the outbox. The
reconciliation callback receives only the outbox ID and must be idempotent for that ID,
because a crash or acknowledgement failure after the effect causes safe repetition.

## Dependency integration

- W0 must pin and audit Wrangler and `@cloudflare/vitest-pool-workers` without changing
  the W8 package's dependency-port boundaries.
- CI must retain generated-type, Workers-runtime, changed-source coverage, and packed
  consumer gates.
- Deployment replaces test binding names while preserving explicit deployment mode,
  capability allowlists, and the absence of ambient dynamic-Worker outbound access.
