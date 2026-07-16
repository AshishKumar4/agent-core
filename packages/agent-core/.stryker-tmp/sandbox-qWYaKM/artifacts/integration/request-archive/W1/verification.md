# W1 Verification Status And Integration Request

Base commit: `058157571e1815840f8c6f7c53ff4e4c26827b54`.

The baseline check is ancestry-based. A final integrated commit must descend from the
exact base; it must not equal the base:

```sh
test "$(git merge-base HEAD 058157571e1815840f8c6f7c53ff4e4c26827b54)" = "058157571e1815840f8c6f7c53ff4e4c26827b54"
```

## Passing W1 Gates

Observed results after the W1 review fixes:

| Gate | Result |
| --- | --- |
| Typecheck | passed |
| Lint | passed |
| W1 tests | passed: 584 tests across 26 manifest-owned files |
| W1 raw coverage | statements 2608/2661; branches 2002/2096; functions 661/665; lines 2461/2498 |
| Import boundaries | passed: 937 module references, 0 grandfathered violations |
| Build | passed |
| Lean build | passed with `/shared/lean-4.16.0-linux/bin/lake` |
| Traceability | passed: 143 designated claims/witnesses |

The canonical post-integration commands remain:

```sh
bun x pnpm@10.13.1 --filter @agent-core/core check:types
bun x pnpm@10.13.1 --filter @agent-core/core lint
bun x pnpm@10.13.1 --filter @agent-core/core test
bun x pnpm@10.13.1 --filter @agent-core/core check:imports
```

## Error Taxonomy

`error-taxonomy.json` v2 classifies all 98 remaining W1 `TypeError` constructions:
57 `constructor-shape`, 25 `codec-input-shape`, and 16 `programmer-contract`.
Every entry includes its exact AST-derived source file and one-based line. Its `sources`
array is the exact W1 inventory and its `testCases` map names stable branch evidence.
The taxonomy scanner rejects direct, global, computed, aliased,
`call`/`apply`, `Reflect.construct`, and unresolved dynamic Error constructor forms
while respecting lexical shadowing.

`verification-manifest.json` contains the exact 44 production files and 26 tests.
`vitest.config.mjs` reads that manifest for both test selection and V8 coverage. Run
the detached workflow from the repository root:

```sh
bun x pnpm@10.13.1 install --frozen-lockfile
report_dir="$(mktemp -d /tmp/agent-core-w1-coverage.XXXXXX)"
trap 'rm -rf "$report_dir"' EXIT
bun x pnpm@10.13.1 --filter @agent-core/core exec vitest run \
  --config artifacts/requests/W1/vitest.config.mjs --coverage \
  --coverage.reportsDirectory="$report_dir"
```

Pinned pnpm 10.13.1 was invoked through `bun x pnpm@10.13.1` because no global pnpm or
corepack executable is installed. No package-manager files were changed.

## W0 Blockers

- `bun run --cwd packages/agent-core check:records` fails because
  `content.owner-edge` is not yet in the authoritative record registry. W0 must merge
  both `content.owner-edge` and `content.transient-lease` from `ownership.json`.
- The closed error union lacks `content.collision` and `actor.commit-unknown`.
  Temporary `protocol.invalid-state` and `actor.closed` fallbacks are not final stable
  evidence.
- Content collision assertions cannot be finalized until W0 adds `content.collision`
  and the W1 memory/SQLite contracts assert that exact code.
- `artifacts/implementation-conformance.yaml` and
  `artifacts/migration-inventory.yaml` still reference deleted split-source paths,
  including `src/core/value.ts` and `test/core/value.test.ts`. W0 must apply every
  exact replacement in `shared-integration.json`, including deleted version, content
  record, and hold-contract paths.
- `check:conformance`, `check:implementation`, and packed exports build successfully,
  then reject stale W0 paths or exact symbol manifests as intended.

## W2 Blockers

- `test/protocol/bootstrap.test.ts` cannot construct MemoryTenantBootstrap or
  SqliteTenantBootstrap because neither composition supplies the required
  CommandAuthenticator.
- W2 bootstrap composition still references deleted HeldContentStore,
  HeldContentVerifier, heldContentVerifier, and holdForMilliseconds names instead of
  TransientContentAccess and leaseForMilliseconds.
- W1 retains inert type-level aliases for those names solely so package typechecking
  can remain green without editing W2. They confer no authentication or hold authority
  and are deleted atomically with W2's cutover.

## W4 Blockers

- `test/protocol/materialization-commands.test.ts` constructs a dispatcher with a
  store that does not implement ActorActivationStore.
- The W4 harness still uses the deleted held-content initialization names and must
  adopt the current ProtocolCommandRegistration decision-time contract.

## Full-Suite Dependency Audit

The full suite currently reports 1076 passed and 28 failed tests out of 1104. The
failures are exactly 4 W2 bootstrap tests, 14 W4 materialization protocol tests,
9 W0 record-registry tests blocked by the two new content record kinds, and 1 W0
conformance test blocked by deleted split-source paths. All foreign bootstrap and
materialization source, test, and harness files had zero diff during this run.

## Final Commands

After W0, W2, and W4 integrate their requested changes, run from the repository root:

```sh
test "$(git merge-base HEAD 058157571e1815840f8c6f7c53ff4e4c26827b54)" = "058157571e1815840f8c6f7c53ff4e4c26827b54"
test "$(git rev-parse HEAD)" != "058157571e1815840f8c6f7c53ff4e4c26827b54"
bun x pnpm@10.13.1 --filter @agent-core/core check:types
bun x pnpm@10.13.1 --filter @agent-core/core lint
bun x pnpm@10.13.1 --filter @agent-core/core test
bun x pnpm@10.13.1 --filter @agent-core/core build
bun x pnpm@10.13.1 --filter @agent-core/core check:imports
bun x pnpm@10.13.1 --filter @agent-core/core check:records
bun x pnpm@10.13.1 --filter @agent-core/core check:exports
bun x pnpm@10.13.1 --filter @agent-core/core check:implementation
bun x pnpm@10.13.1 --filter @agent-core/core check:conformance
bun x pnpm@10.13.1 --filter @agent-core/core check:coverage
PATH="/shared/lean-4.16.0-linux/bin:$PATH" \
  bun x pnpm@10.13.1 --filter @agent-core/core check:traceability
```

The W1 raw >=95% four-metric requirement in `coverage.md` is measured by the detached
manifest/config command. Lean checks only the declared abstract model and do not
replace runtime, ownership, coverage, or conformance evidence.
