# Important instructions:

**We have never made the codebase public and thus there is absolutely no need for any kind of 'migrations' or 'keeping things backward compatible'. If something is dead/stale, just remove and build things better. **

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
`packages/agent-core/SPEC.md` into code. The existing `src/` already follows these
patterns — read `src/agents/runs/`, `src/invocations/`, and `src/facets/filesystem/`
first; they are the reference for the style expected everywhere. Every rule below is
derived from either the SPEC (cited by §) or from patterns already established in the
code. When a rule and the SPEC conflict, the SPEC wins; fix the rule.

## Bounded contexts

One directory per bounded context, owning its own `id.ts` and `index.ts`. No context
reaches into another's internals — only through its `index.ts` exports.

| Directory | Owns (SPEC layer) | Must not own |
|---|---|---|
| `src/core` | cross-cutting value types: `TextId`, `Digest`, `ContentRef`, `SecretRef`, `Revision` (§1.4) | domain records |
| `src/identity` | Principal, Team, Membership, the Scope chain records (§3.1–§3.3) | grant storage |
| `src/authority` | Grant/Binding records, role→grant materialization, resolution, revocation epochs (§3.3–§3.4) | facet implementations |
| `src/facets` | Facet contract, manifests, contributions, slots, interceptors, and profile facets in subdirectories (§4) | substrate persistence |
| `src/invocations` | the tiered invocation pipeline, approvals, receipts, audit (§7) | workspace event storage |
| `src/workspaces` | Workspace records, Events, Subscriptions, ingress, trust-tier derivation (§6) | tenant policy |
| `src/agents` | Agent, Run/RunBranch/RunCommit, Turn, leases, executor seam (§5) | model-provider SDKs |
| `src/environments` | Environment/Session records and providers (§4.5) | concrete containers |
| `src/slates` | Slate records, versions, deployments (§4.6) | frontend frameworks |
| `src/actors` | the Actor primitive and fencing (§8.1) | Durable Object specifics |
| `src/operations` | OperationContext and observability helpers | the Operation primitive |
| `src/definition` *(planned)* | Package, Blueprint, the materializer (§9) | runtime execution |
| `src/protocol` *(planned)* | command envelopes and the dispatcher (§8.5) | domain logic |
| `src/substrates/*` | concrete adapters (sqlite today; `cloudflare` as its own package later) | core policy |

Contexts marked *(planned)* do not exist yet; create them when you implement that
layer. The rest exist and are the reference. Cross-context imports use `import type`
for types wherever possible and go through the target's `index.ts`, never a deep path.

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
  `validate`, `ReadRange.all/from/slice` each with its own `read`, `RunStatus`/
  `TurnStatus` each with their own transition methods. This keeps the illegal cases
  unrepresentable and the behavior next to the data, instead of scattering `switch`
  statements across the codebase. A concept modeled as a string union that callers
  branch on is usually asking to be one of these.
- **Durable records are immutable classes**: `readonly` fields, constructors that
  validate shape (`TypeError` on violation), and private `transition`/`revise` helpers
  that return new instances (see `Run`, `Turn`, `Invocation`). Records never own live
  resources (§8.3).
- **State machines are behavior-carrying classes**, not string unions: the
  `RunStatus`/`TurnStatus` pattern — an abstract base with singleton subclasses whose
  methods either return the next state or throw `AgentCoreError` with a stable code.
  Illegal transitions must be unrepresentable as method calls that succeed.
- **Every record type gets a codec** (§8.3): a static `encode()`/`decode()` pair with a
  version tag, used identically for storage, the command protocol, and export/import.
  Tolerant-read and upcast within a major; typed rejection of unknown majors. The codec
  lives next to the record; a record without a codec is unfinished.
- **Behavioral contracts are abstract classes; pure data shapes are interfaces** —
  the same convention the SPEC uses for its own contracts.
- **Seams are interfaces with in-memory reference implementations** used by tests
  (`MemoryWorkspaceEventStore` pattern). Substrate implementations live under
  `src/substrates/`, never inside a domain context.

## Concurrency and substrate rules

- The storage seam is **synchronous** (`TransactionalSqlite`), matching Durable Object
  SQLite. The dispatcher's envelope check plus guarded mutation must be one synchronous
  span with no intervening `await` (§8.5, §10.3) — an `await` between the read and the
  write is a correctness bug, not a style issue.
- Every Turn-owned mutation carries and checks the lease epoch (§5.3). Every cross-actor
  interaction is at-least-once and idempotency-keyed (§6.1, §10.1). There is no
  cross-actor transaction anywhere; do not write code that assumes one.
- Respect the ownership map (§8.4): each record type has exactly one owning Actor;
  everything else holds ids and rebuildable indexes. Adding a second durable copy of
  any state is a conformance violation — build a derived, disposable cache instead.

## Errors and observability

- Runtime/domain failures: `AgentCoreError` with a stable code from the closed
  `AgentCoreErrorCode` union. Constructor shape violations: `TypeError`. Filesystem
  keeps its own `FileErrorCode` taxonomy. Never throw bare `Error`.
- Telemetry spans (`src/observability`) are diagnostics. Receipts, audit records, and
  Events are the durable truth (§7.4); a span is never a substitute for one.

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
| profile (§11) | `src/facets/<profile>/` module + parameterized conformance suite |
| substrate contract (§8) | interface + memory implementation + substrate implementation |
| contribution kind (§4.2) | manifest data type + materializer handler — no bespoke runtime machinery |
| command family (§8.5) | request/reply types with envelopes, registered on the dispatcher |
| policy (tiers, placement, trust) | pure functions mirroring the Lean derivations in `formal/AgentCore/Policy.lean` |

## Tests

- Behavior-first through public interfaces; mock only at real seams. The filesystem
  conformance suite (`test/filesystem/conformance.ts`) is the template: one
  parameterized suite run against every implementation of a seam.
- Every MUST in SPEC §13 needs a test that would fail if the MUST were violated,
  including the adversarial list (stale lease, revoked grant mid-turn, digest mismatch
  at approval resume, duplicate event delivery, hostile tier assertion, unauthorized
  slot contribution, interceptor overreach).
- Where a behavior is proven in `formal/`, the test should exercise the same scenario
  the theorem states — the proof covers the abstract model, the test covers this
  implementation of it, and they should visibly correspond.
- `pnpm check:traceability` must pass before any commit that touches `formal/` or
  `artifacts/traceability.yaml`.

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
