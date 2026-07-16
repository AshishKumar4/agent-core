# W1 Raw Source Coverage Requirement

Base commit: `058157571e1815840f8c6f7c53ff4e4c26827b54`.

This is a detached measurement requirement. `verification-manifest.json` is the exact
source and test inventory, and `vitest.config.mjs` applies it without broad selectors.

The denominator is every W1-owned production file currently present in the core,
Actor, content, generic protocol, and generic SQLite scope:

```text
src/actors/actor.ts
src/actors/context.ts
src/actors/fence.ts
src/actors/index.ts
src/actors/store.ts
src/actors/types.ts
src/content/index.ts
src/content/media.ts
src/content/memory.ts
src/content/range.ts
src/content/retention.ts
src/content/stat.ts
src/content/store.ts
src/content/transient.ts
src/core/base64.ts
src/core/canonical.ts
src/core/codec.ts
src/core/compat-range.ts
src/core/content-ref.ts
src/core/digest.ts
src/core/id.ts
src/core/index.ts
src/core/json.ts
src/core/revision.ts
src/core/schema.ts
src/core/secret-ref.ts
src/core/semver.ts
src/core/unicode.ts
src/protocol/authentication.ts
src/protocol/dispatcher.ts
src/protocol/envelope.ts
src/protocol/index.ts
src/protocol/ingress.ts
src/protocol/memory.ts
src/protocol/payload.ts
src/protocol/persistence.ts
src/protocol/policy.ts
src/protocol/registration.ts
src/protocol/write.ts
src/substrates/sqlite/actor.ts
src/substrates/sqlite/content-retention.ts
src/substrates/sqlite/content.ts
src/substrates/sqlite/protocol.ts
src/substrates/sqlite/sqlite.ts
```

W2 owns `src/protocol/bootstrap.ts`, `src/protocol/bootstrap-memory.ts`, and
`src/substrates/sqlite/bootstrap.ts` integration. W4 owns
`src/protocol/materialization-commands.ts`. W0 owns `src/errors.ts`, `src/index.ts`,
`src/substrates/index.ts`, and `src/substrates/sqlite/index.ts`. Other domain-specific
SQLite adapters are outside the W1 denominator. These are ownership partitions, not
coverage exclusions.

The external validator must emit V8 JSON coverage and sum integer `covered` and
`total` counters over the complete inventory before admission. Each metric passes
independently only when:

```text
covered * 100 >= 95 * total
```

| Metric | Covered | Total | Required result |
| --- | ---: | ---: | --- |
| Statements | 2608 | 2661 | 98.00% |
| Branches | 2002 | 2096 | 95.51% |
| Functions | 661 | 665 | 99.39% |
| Lines | 2461 | 2498 | 98.51% |

No W1 source exclusion, ignore pragma, skipped test, per-file bypass, pre-admission
rounding, zero-counter file omission, baseline substitution, or denominator adjustment
is permitted. Inventory files with zero executable counters remain present with their
integer zero totals.

The measured counters above came from Vitest 4.1.9 with V8 coverage, `all=true`, an
empty coverage exclusion, and the exact inventory listed in this file. The report was
generated under `/tmp` and removed after recording these raw
counters.

The detached workflow is run from the repository root:

```sh
test "$(git merge-base HEAD 058157571e1815840f8c6f7c53ff4e4c26827b54)" = "058157571e1815840f8c6f7c53ff4e4c26827b54"
test "$(git rev-parse HEAD)" != "058157571e1815840f8c6f7c53ff4e4c26827b54"
bun x pnpm@10.13.1 install --frozen-lockfile
report_dir="$(mktemp -d /tmp/agent-core-w1-coverage.XXXXXX)"
trap 'rm -rf "$report_dir"' EXIT
bun x pnpm@10.13.1 --filter @agent-core/core exec vitest run \
  --config artifacts/requests/W1/vitest.config.mjs --coverage \
  --coverage.reportsDirectory="$report_dir"
```
