# Important instructions:

**This codebase has not been public. Remove stale compatibility code and artifacts
instead of preserving them. This does not waive SPEC §5.2 Run migration: RunPins
migration is a domain operation with durable evidence, not legacy compatibility.**

## 1. Coding Standards & Conventions
​
**Code Style:** Follow established language-specific style guides. Automated formatting tools are mandatory. Use oxlint for JavaScript/TypeScript and ruff for Python.
​
**Modularity:** Code must be organized into logical, small, and reusable functions/modules. Business logic should be strictly separated from input/output handling.
​
**Readability:** Use clear, descriptive names for variables, functions, and classes. Add meaningful, concise, clean and straightforward comments where the *why* of the code is not immediately obvious.

**Pure Functions:** Prefer pure functions over impure ones. Pure functions have no side effects and are easier to test and reason about.

**Object Orientation:** Use object-oriented programming principles where appropriate. Encapsulate data and behavior together in classes.

**Rely on abstractions:** Use abstraction to hide complexity and make code more maintainable. Inherit from base classes when possible. If two classes have similar functionality, consider creating a base class.

**Elegance, simplicity, minimalism:** Everything should be designed with elegance, simplicity, and minimalism in mind, over hacky, short term solutions. Avoid over-engineering and unnecessary complexity which does not add value. But this doesn't mean sacrificing functionality, reliability, or performance. We always design for long term maintainability and scalability.

**Avoid hard coding strings and values:** Avoid hard coding strings and values. Use constants or configuration files instead.

**Avoid magic numbers:** Avoid magic numbers. Use constants or configuration files instead.

**Design with observability and tracing in mind:** Design with observability and tracing in mind. Use logging, metrics, and tracing to understand the behavior of the system. Design components, classes and functions with observability in mind. Build observability into the design from the start, using elegant primitives such as decorators and middleware.

**Design with error handling in mind:** Design with error handling in mind. Use try-catch blocks to handle errors gracefully. Use custom exceptions to provide more context about the error. Look into the Effects TS library and Better Results library. I love golang's error handling patterns.

**Strict typing:** Use strict typing to ensure type safety and prevent runtime errors. Use TypeScript's type system to catch errors at compile time.

**Rely on existing libraries and frameworks:** Use existing libraries and frameworks whenever possible to avoid reinventing the wheel. Always research on the latest best available options.

**Organize code:** Organize code in a logical and consistent manner. Use consistent naming conventions and file structure.

**Formal verification:** Use formal verification tools to ensure logical correctness and reliability.

**Research, ideate and architecture first:** Always research, ideate and architecture before implementing any code. This ensures that the code is well-designed and follows best practices.

**Audit and review:** Regularly audit and review code to ensure it meets the established standards and best practices.

**DRY** (Don't Repeat Yourself): Avoid code duplication by creating reusable functions and modules.

**Modularity and composition:** Break down complex problems into smaller, manageable modules that can be composed together to solve the problem.

​
## 2. Testing & Quality Assurance
​
**Unit Tests:** Every new feature or fix must be accompanied by comprehensive unit tests that cover core functionality and edge cases.

**Test Coverage:** *Requirement:* Code coverage must not decrease below the established project threshold (e.g., 80%).

**Integration Tests:** Implement tests to verify the agent's interaction with external APIs and databases.
​
**Test Framework:** Specify the required testing framework (e.g., Jest, Pytest).
​
**Mocking:** Use mocking for external service dependencies to ensure tests are fast, reliable, and isolated. But rely on real services whenever possible, such as using wrangler/vitest for durable objects.

**Functional Testing:** Implement tests to verify every component's ability to perform its intended functions.

**Always write tests decoupled from the implementation details.**

IMPORTANT: This repository uses pnpm, not npm. Always use pnpm.

IMPORTANT: Remember when using RPC to use promise pipelining whenever possible. Cap'n Web implements promise pipelining (similar to Cap'n Proto). This means that if an RPC returns a stub, it's not necessary to await the RPC -- the promise itself can be used in place of the stub. Also, Cap'n Web lets you use the promise for a future result (even if it isn't a stub) in the arguments for another call; the promise will be replaced with its resolution on the server side before delivering the arguments. See the Cap'n Web README.md for more details.

IMPORTANT: When using React's useState(), the state value cannot be an RPC stub. At runtime, all stubs appear to be callable (because the system doesn't actually know if the stub points to a function on the server side or not). But the setter returned by useState() has different behavior if passed a function (including any callable object): it calls the function in order to get the state. In order to avoid this problem, whenever a useState() state will contain an RpcStub, it's important to wrap the stub in an object, and set the state to that object instead.

IMPORTANT: RPC stubs must be disposed to prevent resource leaks on the server side. Call `stub[Symbol.dispose]()` when the stub is no longer needed (or use a `using` declaration where possible). In particular, when a React component obtains a stub in a useEffect, the cleanup function should dispose the stub.

---

# Implementing the Agent Core spec (`packages/agent-core`)

This section is the implementation architecture for anyone (human or agent) turning
`packages/agent-core/SPEC.md` into code. Read the retained `src/core/`, `src/actors/`,
and `src/protocol/` foundations first. A source directory is not a public API: only
subpaths listed in `packages/agent-core/package.json` are supported consumer surfaces.
When a rule and the SPEC conflict, the SPEC wins; fix the rule.

## Bounded contexts

One directory per bounded context, owning its own `id.ts` and `index.ts`. No context
reaches into another's internals — only through its `index.ts` exports. A context
barrel is still internal unless `package.json` explicitly exports it.

| Directory | Owns (SPEC layer) | Must not own |
|---|---|---|
| `src/core` | cross-cutting value types: `TextId`, `Digest`, `ContentRef`, `SecretRef`, `Revision` (§1.4) | domain records |
| `src/identity` | Principal, Team, Membership, Role, and the Scope chain records (§3.1–§3.3) | grant storage |
| `src/authority` | Grants, Bindings, resolution, epochs, watermarks, and authority policy (§3.4) | identity records or invocation mediation |
| `src/facets` | manifests, contributions, Operations, Interceptors, Slots, Surfaces, and profile contracts (§4, §11) | substrate persistence |
| `src/invocations` | preparation, approval, effects, Receipts, reconciliation, and audit evidence (§7) | event routing or Run graphs |
| `src/agents` | Agent, Run, Turn, graph, lease, migration, and settlement behavior (§5) | invocation or environment runtime |
| `src/workspaces` | Workspace-owned Events, Subscriptions, routing, delivery, and View replay (§6) | invocation effects |
| `src/environments` | Environment and Session contracts and lifecycle (§4.5) | profile-specific substrate adapters |
| `src/slates` | Slate source, version, deployment, and authority contracts (§4.6) | environment implementation |
| `src/definition` | Packages, Blueprints, policy, placement, and materialization (§9) | runtime activation shortcuts |
| `src/actors` | the Actor primitive and fencing (§8.1) | Durable Object specifics |
| `src/protocol` | command envelopes and the dispatcher (§8.5) | domain logic |
| `src/composition` | internal cross-context adapter wiring owned by W9 | domain records or public API |
| `src/substrates/*` | concrete adapters (sqlite today; `cloudflare` as its own package later) | core policy |

The complete normative runtime is built in dependency-ordered layers. A layer under
construction remains absent from the package surface until it is implemented and
conformance-tested as a complete layer; the final conformance stage admits no planned,
implemented-only, or deferred requirement. Do not restore `BindingSet`, `FacetSet`, the
old `OperationCatalog`, the old invocation/workspace runtime, or compatibility wrappers
around them. Cross-context imports use `import type` for types
wherever possible and go through the target's retained `index.ts`, never a deep path.
The import-boundary gate's dependency-cycle model is intentionally limited to
top-level bounded contexts. Nested substrate adapters are implementation modules, not
independent cycle nodes, but every import originating there still goes through the
target context barrel. The baseline is permanently empty; no deep-import exception is
admitted for production, dormant, or test code.

## Object design

The codebase is deliberately object-oriented with deep modules. Keep it that way.

- **Identifiers** are branded classes extending `TextId` with constructor-validated
  invariants (`src/core/id.ts`). Never pass raw strings across a context boundary.
  Identity is by type and value: `equals` checks `this.constructor === other.constructor`
  and the value — two ids with the same string but different classes are not equal.
- **Domain concepts are smart value objects, not bare enums or primitives.** The
  dominant idiom in this codebase, and the one to reach for first: an abstract base
  class, `static` factory getters/methods for each case, and small private subclasses
  that carry the behavior — `WriteMode.create/replace/upsert` each with its own
  `validate`, `ReadRange.all/from/slice` each with its own `read`, `RunLifecycle`/
  `TurnStatus` each with their own transition methods. This keeps the illegal cases
  unrepresentable and the behavior next to the data, instead of scattering `switch`
  statements across the codebase. A concept modeled as a string union that callers
  branch on is usually asking to be one of these.
- **Durable records are immutable classes**: `readonly` fields, constructors that
  validate shape (`TypeError` on violation), and private `transition`/`revise` helpers
  that return new instances. Records never own live resources (§8.3).
- **State machines are behavior-carrying classes**, not string unions: the
  `RunLifecycle`/`TurnStatus` pattern — an abstract base with singleton subclasses whose
  methods either return the next state or throw `AgentCoreError` with a stable code.
  Illegal transitions must be unrepresentable as method calls that succeed.
- **Every record type gets a codec** (§8.3): a static `encode()`/`decode()` pair with a
  version tag, used identically for storage, the command protocol, and export/import.
  Tolerant-read and upcast within a major; typed rejection of unknown majors. The codec
  lives next to the record; a record without a codec is unfinished. Any future
  machine-readable schema is generated from these codecs, never a second source of truth.
- **Behavioral contracts are abstract classes; pure data shapes are interfaces** —
  the same convention the SPEC uses for its own contracts.
- **Seams are interfaces with in-memory reference implementations** used by tests.
  Substrate implementations live under `src/substrates/`, never inside a domain
  context. Do not invent a store merely to turn deferred ownership evidence green.

## Concurrency and substrate rules

- The Actor-owned storage seam is **synchronous** (`ActorLocalStore`, implemented by
  `TransactionalSqlite` and the memory reference store). Isolated gate reads and the
  dispatcher's guarded mutation remain one synchronous span with no intervening `await`
  (§8.5, §10.3) — an `await` between the read and write is a correctness bug, not style.
- Every executor mutation carries the exact Turn id and current lease epoch (§5.3).
  Never reuse a lease across Turns. Run commits obey the exact §5.2 root/Turn/system
  CommitWriter matrix; every merge is system-authored by successful control evidence,
  while synthesis also names its exact token. System evidence does not impersonate a Turn. Every cross-actor
  interaction is at-least-once and idempotency-keyed (§6.1, §10.1). There is no
  cross-actor transaction anywhere; do not write code that assumes one.
- Respect the ownership map (§8.4): each record type has exactly one owning Actor;
  everything else holds ids and rebuildable indexes. Adding a second durable copy of
  any state is a conformance violation — build a derived, disposable cache instead.
- Authority has one durable plane: allow and deny are Grant effects, Role rules
  materialize those Grants, and Binding resolution evaluates complete path-epoch
  evidence. Mediated stale checks atomically advance the delivered watermark before a
  pre-effect denial. Direct checks require the exact current Turn lease, unstaled
  watermark, and immutable deadline; renewal never extends it.
- Placement is exactly `manifest ∩ policy ∩ substrate ∩ trust`, followed by the
  one fixed order `dynamic`, `provider`, `bundled`. Do not encode a second ordering or
  fallback for an empty intersection.
- Enforcement and approval policies only tighten floors. Never lower mediated
  `execute`/`mutate`/`externalSend`/`delegate`/`administer` or remove required approval;
  recheck current epochs before every mediated effect.
- Preparation has one shared header with an optional exact Turn and exactly a single or
  nonempty ordered homogeneous payload. Derive each item key from the complete shared
  header identity, payload shape, item index, argument digest, and seed; digest the
  complete canonical structure. Pre-effect denied/cancelled Receipts have no attempt;
  attempted Receipts do, and only indeterminate may be superseded once. Atomically
  claim each item with a future expiry; claim ownership is separate from attempt
  ordinal. Only an expired claim with no attempt may be recovered, with the same
  ordinal, a new owner, and a new future expiry. Only a final failed attempt advances
  the ordinal.
- Event routing uses explicit accepted trust sets and initiator/delegated authority. The
  source Actor owns the authenticated RouteReservation; its projection admits a
  cause-free target-local `routeProjected` bridge root. No source AuditRecord causes
  that root. Cross-tenant routes require separate explicit authority.
- Security audit is append-only: typed causes preexist, and cross-Actor causality is
  permitted only through the source-owned RouteReservation projection bridge.
- The Run graph is canonical: one zero-parent root, unary non-root/non-merge commits, and ordered
  binary merges. Tree merge is binary. RunPins contain Blueprint and complete Package
  closure; Turn placement is separate. Terminalization closes admission only after
  every sibling Turn is both terminal and unheld, and captures a finite obligation set.
  BatchOutcome is derived once every item has a current Receipt
  and may be indeterminate; its terminal form and Run Settled require non-indeterminate
  obligations.
- Protocol commands use exact callers, optional LeaseTokens, deterministic rejection
  outcomes, and linked WriteRecord/AuditRecord evidence. Missing caller causes on
  rejection get host-created attributable roots.

## Errors and observability

- Runtime/domain failures: `AgentCoreError` with a stable code from the closed
  `AgentCoreErrorCode` union. Constructor shape violations: `TypeError`. Never throw
  bare `Error`; each implemented profile uses its SPEC-defined stable taxonomy.
- Telemetry spans are diagnostics, not durable domain evidence. RouteReservations,
  PreparedInvocations, EffectAttempts, Receipts, AuditRecords, and Events are durable
  evidence where required (§7.4); a span is never a substitute for one.

## Naming

- `execute(...)` is the low-level operation handler; `invoke(...)` is reserved for the
  mediated pipeline. Do not blur them.
- Facet profiles live at `src/facets/<profile>/` with `facet.ts` + `index.ts`; the
  public class is `<Profile>Facet` using SPEC vocabulary (`ApprovalGatewayFacet`, not
  internal codenames).
- Files are lowercase, single-concept; a file that needs a plural name is usually two
  files.

## Mapping the SPEC into code

| SPEC construct | Code shape |
|---|---|
| primitive / constituent record | immutable class + codec + owning-context `id.ts` entry |
| behavioral contract (abstract class in SPEC) | abstract class with the same name and members |
| profile (§11) | declaration first; runtime module and export only with §13 conformance evidence |
| substrate contract (§8) | interface + memory implementation + substrate implementation |
| contribution kind (§4.2) | manifest data type + materializer handler — no bespoke runtime machinery |
| command family (§8.5) | request/reply types with envelopes, registered on the dispatcher |
| policy (tiers, placement, trust) | pure functions implementing SPEC rules; formal coverage never substitutes for conformance tests |

## Tests

- Test behavior through public interfaces and mock only at real seams. Run each
  parameterized contract against every implementation of that seam.
- Test package boundaries from a packed NodeNext consumer. Removed subpaths and symbols
  need negative declaration and runtime assertions; source-only imports are not evidence
  of a public contract.
- Every MUST in SPEC §13 needs a test that would fail if the MUST were violated. Use
  the complete adversarial list there, including wrong-Turn leases, allow/deny epoch
  changes, all direct revocation cutoffs, placement intersection failure, malformed
  batches, structural digest changes, Receipt lineage, duplicate reservations,
  non-binary and unequal-pin merges, writer-matrix violations, and audit-chain breaks.
- Formal trace IDs identify abstract coverage categories only. Do not name or infer a
  theorem claim in code or tests unless
  `packages/agent-core/artifacts/traceability.yaml` states it. SPEC
  §14 expressly makes no implementation-refinement claim.
- `pnpm check:traceability` must pass before any commit that touches
  `packages/agent-core/formal/` or
  `packages/agent-core/artifacts/traceability.yaml`.
- `pnpm check:final` is the release gate. It requires every atomic SPEC conformance
  requirement to be verified and all four aggregate coverage metrics to be at least 95%.

## Working style

- Work in the loop: small, test-verified commits; typecheck + lint + tests green before
  every commit. Never commit a stub that pretends to be an implementation — the
  prompt-string facets were a mistake we removed; do not reintroduce the pattern.
  If a piece is unimplemented, it should be absent, not fake.
- New abstractions must pass the deletion test: if inlining it at the call sites would
  be clearer, do not add it. Prefer extending an existing context over creating one.

## A worked example: the shape of everything

This is the pattern every record and operation follows. A domain concept modeled as a
smart value object, an immutable record that transitions rather than mutates, and an
operation that declares its impact and returns through the pipeline — nothing here is
special-cased, and new work should read like it.

```ts
// value.ts — a smart value object: abstract base, static factories, behavior in cases
export abstract class Visibility {
  public static get private(): Visibility { return privateVisibility; }
  public static get shared(): Visibility { return sharedVisibility; }
  public abstract canRead(subject: SubjectRef): boolean;
  public equals(other: Visibility): boolean { return this === other; }
}
class Private extends Visibility { public canRead(): boolean { return false; } }
class Shared  extends Visibility { public canRead(): boolean { return true; } }
const privateVisibility = new Private();
const sharedVisibility = new Shared();

// note.ts — an immutable record: readonly fields, validate in the constructor,
// transition helpers return new instances, never mutate.
export class Note {
  public constructor(
    public readonly id: NoteId,
    public readonly content: ContentRef,
    public readonly visibility: Visibility,
    public readonly revision: Revision,
  ) {}

  public share(): Note {
    return new Note(this.id, this.content, Visibility.shared, this.revision.next());
  }
}

// A codec lives beside the record (§8.3): NoteCodec.encode/decode with a version tag,
// tolerant-read within a major, typed rejection of unknown majors. A record without one
// is unfinished.
```

An operation declares its impact and does the work; the pipeline (§7) adds authority,
tiering, approval, receipt, and audit around it — the handler never reaches for those
itself:

```ts
class ShareNoteHandler extends FacetOperationHandler<ShareInput, FacetData> {
  public constructor(private readonly notes: NoteStore) { super(); }
  public async execute(_ctx: OperationContext, input: ShareInput): Promise<FacetData> {
    const note = (await this.notes.load(input.noteId)).share();  // mutate = returns new
    await this.notes.save(note);
    return { noteId: note.id.value, visibility: "shared" };
  }
}
// registered with its impact, so policy can tier it:
operation("note.share", "Share a note.", "mutate", new ShareNoteHandler(store))
```

The store (`NoteStore`) is an **interface** with a memory reference implementation used
by tests and a substrate implementation under `src/substrates/`; the handler depends on
the interface, never on a concrete backend.
