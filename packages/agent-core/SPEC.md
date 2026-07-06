# Agent Core

**A specification for building agent platforms.**

*AI tools have been used to shape parts of this document and the project. The ideas and concepts presented here are of my own, and they may change as I ideate further.*

---

## 1. Introduction

### 1.1 Why this exists

I have built the same platform several times now. An agent that survives restarts. A
place to put its conversations, its tools, its files. A way for a webhook, a schedule,
a chat message, and a button press to all end up in front of the same agent loop. A
per-user vault so the agent can act on someone's behalf without ever holding their
credentials. A sandbox with a preview URL. An approval card for the scary actions. A
way to share all of it with a team.

Every platform re-solves these problems, couples the solutions to its own product, and
then can't reuse them for the next one. The frameworks that exist don't help at the
right layer: agent SDKs give you the loop and stop there; the hosted platforms give you
a control plane you don't own, shaped like their product rather than yours. Nobody
gives you the Lego blocks.

Agent Core is that box of blocks. It defines a small set of primitives — sixteen of
them — that compose into complete agent platforms: multi-tenant or personal, chat-first
or headless, exploratory or transactional. And it defines a **definition plane** above
them, so that an entire platform is a validated configuration document — a Blueprint —
materialized onto a substrate. The first substrate is Cloudflare Durable Objects. The
model doesn't depend on it.

The design rests on a few core ideas:

**Authority works like a capability.** The idea is that nothing in the system should
act because of *who it is* — things act because of *what they hold*. A Grant records
authority, a Binding gives it a name inside one isolation domain, and resolving a
binding produces a live capability that can be narrowed, delegated, and revoked. Roles
and memberships exist so humans can reason about access, but they materialize *into*
Grants, so there is only one enforcement path to get right; revoking a Grant disables
everything derived from it. This is the object-capability model (the ideas go back to
Mark Miller's work), and the reason it matters here is prompt injection: an agent
reads untrusted content all day, and if it also holds broad ambient authority,
injected instructions will eventually find something to do with it. Capabilities keep
the blast radius of any single compromise small and revocable.

**Everything durable is a record with a single owner, and every input is an event.**
A conversation is stored as an append-only commit graph with named branches, so
branching a conversation, undoing a step, and exploring in parallel are just graph
operations. An execution attempt is a Turn holding a lease with a fencing epoch,
which means a crashed executor that comes back later simply cannot write anything —
its writes carry a stale epoch and get rejected. And a webhook, a cron tick, a slash
command, and a button press are all the same thing — an Event, routed by a
Subscription — so automation becomes configuration rather than extra plumbing.

**Enforcement is tiered by impact.** Every protected action is an Invocation, but an
agent loop makes thousands of small read calls per session, and writing several
durable records for every file read would make the whole system unusable. At the same
time, an external send with no receipt is a real liability. So the operation's
declared impact decides how it is enforced: reading a file inside the agent's own
sandbox is an in-memory call, while sending an email goes through a durable pipeline
of intent, approval, receipt, and audit. Policy can always tighten this, never the
other way around.

The rest is composition. Facets bundle operations, UI, events, and prompt text into
one installable capability. Contributions let any facet add commands, automations, and
settings to a platform *as data* — a slash command is a manifest entry, not a code
change. A Slate is an application the agent builds for you, running with no ambient
authority at all. And because the primitives are small and the rules are mechanical,
the core of the model is machine-checked in Lean rather than just written down:
authority attenuation, revocation, lease fencing, approval single-use, and the undo
semantics are all proven properties of the abstract model.

### 1.2 What this specifies — and what it leaves to you

Agent Core specifies the platform layer: identity and tenancy, authority, durable
execution, input routing, mediated actions, UI contributions, environments, generated
applications, and the definition plane. It deliberately does **not** specify the agent
loop — model choice, prompting, streaming, tool-call parsing. The loop lives behind the
Turn executor seam (§5.6), so you can drive Runs with the Claude Agent SDK, Pydantic
AI, a bespoke loop, or whatever comes next. Think of Agent Core as everything *around*
the loop.

### 1.3 How to read this document

Sections 2–10 are normative; §11–§12 define profiles and sketches; §13–§14 cover
conformance and the formal model. MUST, SHOULD, and MAY are RFC 2119 keywords.
Behavioral contracts appear as abstract TypeScript classes; pure data shapes as
interfaces. Sections marked *(informative)* explain; everything else binds. Short
*why* paragraphs record the reasoning behind the less obvious choices, so the
reasoning itself can be checked and challenged, not just the rules.

### 1.4 Notation and type vocabulary

Identifiers ending in `Id` or `Name` (`PrincipalId`, `SurfaceId`, `BindingName`,
`SlotName`) are opaque, codec-stable identifier types, as are the simple reference
types `ContentRef`, `OperationRef`, `FacetRef`, and `RunRef`. Two `Ref` types are
structured records, defined where they appear: `SecretRef` (§3.5) and
`ForeignPrincipalRef` (§3.3). Types ending in `Schema`, `Spec`, `Policy`, `Template`,
`Mapping` (declarative field maps: `FieldMapping`, `PayloadMapping`,
`ProvenanceMapping`), `Selector` (predicate sets over descriptors:
`OperationSelector`), `Entry` (`SlotEntry` — a validated contribution instance plus its
contributor), or `Requirement` (`BindingRequirement` — a named capability a facet needs
bound before start) are JSON-Schema-validated records. The unions the prose depends
on:

```ts
type Impact          = "observe" | "mutate" | "externalSend" | "execute" | "delegate" | "administer";
type TrustTier       = "owner" | "authenticated" | "external" | "self";      // §6.1
type EnforcementTier = "mediated" | "direct";                                 // §7.2
type IsolationMode   = "bundled" | "provider" | "dynamic";                    // §1.5, §10.2
type CutPoint        = "operation.before" | "operation.after" | "prompt.assemble"
                     | "input.submitted" | "turn.step";                       // §4.4
type Contributions   = { readonly [slot: SlotName]: readonly unknown[] };     // validated against
                                                                              // the slot's schema (§4.2)
```

Core value types (fields, not primitives): `Digest` — a collision-resistant content
digest, SHA-256 or stronger; `ContentRef` — resolvable through a ContentStore (§8.2);
`SecretRef` (§3.5); `Revision` — a per-record optimistic-concurrency counter.

A `FacetRef` *identifies* a facet instance; a `Binding` *names* a Grant-backed instance
in one protection domain; a `ResolvedFacet` is the *live capability* returned by
resolution. The order is always the same: identify, then name, then resolve.

### 1.5 Protection domains

A **protection domain** is an isolation boundary. Inside one, calls are plain
in-process calls and carry no security cost. Across one, nothing passes except
explicitly delegated capabilities and asynchronous Events. Platform policy places
facet code into a domain (§9.2, §10.2) using three isolation modes: `bundled`
(in-process with the hosting Actor), `provider` (a separate service behind a capability
stub), and `dynamic` (loaded code in a fresh isolate with zero ambient authority).

---

## 2. The model at a glance

Agent Core has **sixteen primitives**. Everything else is a constituent record of a
primitive, a value type (§1.4), a contribution kind (§4.2), a substrate contract (§8),
or a profile (§11). I try hard to keep this count from growing: a concept becomes a
primitive only when at least two real platforms need it and it cannot be built by
composing the others.

| Layer | Primitive | Constituents |
| --- | --- | --- |
| L0 Identity & authority | **Principal** | Team (a named principal set; a Tenant record) |
| | **Scope** — the chain Tenant ⊇ Project ⊇ Workspace | Membership, Role |
| | **Grant** | — |
| | **Binding** | ResolvedFacet |
| L1 Composition | **Facet** | FacetManifest, Contribution, Slot |
| | **Operation** | OperationDescriptor |
| | **Interceptor** | — |
| | **Environment** | Session, tree Checkpoint |
| | **Slate** | versions, deployments |
| L2 Execution | **Agent** | AgentProfile |
| | **Run** | RunBranch, RunCommit, run Checkpoint |
| | **Turn** | TurnLease |
| L3 Interaction | **Event** | provenance, TrustTier |
| | **Subscription** | PayloadMapping, DedupePolicy |
| | **Surface** | View, ViewDelta |
| L4 Mediation | **Invocation** | Approval, Receipt, AuditRecord |

Substrate contracts (L5): **Actor**, **ContentStore**, **RecordCodec**, and the command
protocol dispatcher (§8.5). The definition plane (L6) adds two artifacts: **Package**
and **Blueprint** — eighteen nouns in total.

![The system at a glance](diagrams/overview.svg)

Three paths describe almost every interaction in the system:

```text
ACTIVE       resolved Facet → Operation → Invocation(tier) → [Approval] → Receipt → Audit → Event
INTERACTION  surface action / ingress / schedule / command / callback → Event → Subscription → Operation
AUTHORITY    Membership/Role ⇒ materialized Grants → Binding → resolved Facet → Operation → Invocation
```

These three paths are worth internalizing before reading further — every feature in
the assembly sketches of §12 is just a composition of them.

---

## 3. Identity and authority (L0)

### 3.1 Principal and Team

A **Principal** is an accountable actor: a human, a service account, a CI bot, or an
independently accountable Agent. Principals authenticate; Scopes own resources.

A **Team** is a named set of Principals recorded in a Tenant. Teams are Membership
subjects, not a separate primitive: wherever a Membership names a subject, the subject
is `Principal | Team`, and a Principal's effective access derives from the union of its
direct and team Memberships under the precedence rule of §3.3.

### 3.2 The Scope chain

**Scope** is one primitive with three roles forming a fixed chain
`Tenant ⊇ Project ⊇ Workspace`, with Project optional:

- a **Tenant** is the ownership and isolation boundary. It owns Projects, Workspaces,
  Teams, credentials, installed Packages, quotas, and retention. A single-user
  installation still has a Tenant — one Principal, one personal Tenant.
- a **Project** groups Workspaces for organization, policy, and sharing. It is a
  record owned by the Tenant's Actor, not a coordination unit of its own (§8.1,
  §10.1) — grouping your workspaces costs nothing at runtime.
- a **Workspace** is the composition boundary. It hosts Facet installs, Bindings,
  Events, Subscriptions, Agents, Runs, and Slates, and enforces workspace policy.

*Why a fixed chain rather than arbitrary nesting:* two container levels are what most
mature resource hierarchies converged on (cloud providers, code forges), they cover
the sharing shapes that actually come up, and they keep policy resolution bounded at
three steps. Recursive workspaces would turn policy resolution, the UI, and the
substrate mapping into graph problems, and I have yet to see a platform that needed
them.

### 3.3 Membership, roles, and sharing

A **Membership** binds a subject (`Principal | Team`) to a Scope with a **Role**.

**Roles materialize Grants.** A Membership is not itself callable authority. Assigning
a Role at a Scope materializes — idempotently, exactly as a Blueprint materializes
records (§9.3) — the Role's defined set of Grants for that subject at that Scope.
Downward flow, attenuation, and revocation all operate on those Grants. The enforcement
plane (§7) resolves only Grants and Bindings; Roles and Memberships have no second
enforcement path. Revoking a Membership revokes its materialized Grants and bumps the
Scope's revocation epoch (§3.4).

*Why:* the moment roles and grants are two separate enforcement systems, they drift
apart, and that kind of drift tends to be discovered during an incident rather than
before it. With one plane, the question "what can this subject actually do" always has
exactly one answer, computed one way.

**Precedence.** Effective authority is the union of allow-Grants from all direct and
team Memberships, each attenuated along its flow path, minus explicit denies. A deny at
any Scope on the path overrides allows from ancestor Scopes, and a descendant allow
cannot re-widen an ancestor deny. Example: Team A holds `reader` on Project P, so its
members read every Workspace in P; a deny for W2 at W2's scope removes W2 without
touching W1.

**Sharing** is Membership issuance — there is no second mechanism. Sharing a Project
with a user is a Membership at that Project; a team owning a Project is a Team
Membership at that Project, and every member inherits access by default. Cross-tenant
sharing uses a **guest Membership** whose subject is a `ForeignPrincipalRef
{ homeTenant, principalId, verifiedVia }`: authentication is delegated to the home
Tenant through a declared trust relationship, guest-materialized Grants are always
attenuated, MUST NOT carry `delegate` or `administer` capability, and MUST NOT resolve
the host Tenant's credentials. Credential custody never leaves the owning Tenant.

`verifiedVia` names how the host Tenant verifies who the guest is, and it works in two
stages. First, **trust establishment**: an `administer`-impact Operation on the host
Tenant (mediated and audited like any other, §7.2) records a trust relationship —
`{ homeTenant, scheme, verifier, expiry, allowedRoles }` — where `scheme` is one of:

- `federation` — the home Tenant exposes a token issuer; guests authenticate at home
  and present an identity token, which the host verifies against the issuer keys
  pinned in the trust relationship (the OIDC shape);
- `attestation` — the home Tenant signs `(principalId, hostTenant, expiry)` with a key
  whose public part was exchanged at establishment, and the guest presents the signed
  attestation.

Second, **verification**: the proof is checked both when the guest Membership is
issued and on every authentication of the guest. Revoking the trust relationship
revokes every Membership issued under it and bumps the affected Scopes' revocation
epochs, so guest-materialized Grants expire under the same bounded-window rule
(§3.4 rule 5) as everything else.

### 3.4 Grant, Binding, resolution, revocation

A **Grant** records authority: subject, Scope, capability, attenuation lineage,
revocation state. A **Binding** associates a subject-local name with a Grant-backed
Facet instance in one protection domain. Callable access requires a **ResolvedFacet**
produced by the authorization and Binding-resolution path; identifiers alone confer
nothing.

![One authority plane](diagrams/authority.svg)

```ts
abstract class AuthorityService {
  abstract assignMembership(scope: ScopeRef, subject: SubjectRef, role: RoleSpec): Promise<Membership>;
  abstract revokeMembership(membership: MembershipId): Promise<void>;   // revokes materialized grants, bumps epoch
  abstract grant(scope: ScopeRef, subject: SubjectRef, capability: CapabilitySpec,
                 attenuationOf?: GrantId): Promise<Grant>;
  abstract revoke(grant: GrantId): Promise<void>;                       // disables descendants, bumps epoch
  abstract bind(domain: ProtectionDomain, name: BindingName, grant: GrantId,
                facet: FacetRef): Promise<Binding>;
  abstract resolve(domain: ProtectionDomain, name: BindingName): Promise<ResolvedFacet>;
  abstract memberships(principal: PrincipalId): Promise<readonly Membership[]>;
}
```

Authority rules:

1. Missing authority denies.
2. Child authority is always attenuated — delegation can only narrow.
3. Raw credentials remain in Tenant custody; delegation moves capability stubs, not
   secrets.
4. Discovery is policy-controlled: a Turn receives a redacted view of installed Facets
   under the same policy that governs direct reads.
5. **Revocation is bounded-window.** Each Scope carries a monotonically increasing
   revocation epoch; every ResolvedFacet is stamped with the epoch at resolution.
   Revocation bumps the epoch and pushes invalidation to Actors holding live
   resolutions (the authority Actor keeps a rebuildable reverse index of holders). A
   revocation takes effect no later than the earliest of: (a) invalidation delivery,
   (b) the subject's next **mediated** Invocation — which always revalidates the epoch
   on its durable path — or (c) expiry of the current Turn lease. `direct`-tier calls
   MAY run against the Turn-start resolution for at most that window, so the lease
   duration caps revocation staleness.
6. Resolved-facet lifetime follows the isolation mode: `bundled` resolutions live for
   the Turn; `provider`/`dynamic` resolutions are scoped to a single Turn step and
   re-resolved, with epoch revalidation, each step (§10.2).

*Why bounded-window rather than instantaneous:* on any real distributed substrate
there is no transaction that spans the authority store and every holder of a live
capability. Rule 5 states the guarantee a substrate can actually keep, ties the worst
case to a knob you control (lease duration), and makes the mediated path — the one
that touches the outside world — always-fresh.

### 3.5 SecretRef

A **SecretRef** `{ source, provider, id }` names a credential held in Tenant custody.
Configuration, manifests, and Blueprints carry SecretRefs, never raw credential
values. A SecretRef is custody delegation, not process isolation: if plaintext is
readable in an agent-visible filesystem, the ref does not protect it. Substrates
SHOULD provide credential-injecting seams — proxy-injected headers, masked environment
variables — so raw values never enter agent-visible domains at all.

---

## 4. Facets and composition (L1)

### 4.1 The manifest / runtime split

A **Facet** is a live, named, typed capability exposed to a protection domain. It is
defined in two halves:

- the **FacetManifest** — declarative, schema-validated, inspectable *without executing
  code*: identity, version, compatibility range, config-schema fragment, binding
  requirements, isolation requirement, and contributions;
- the **runtime class** — the behavior: operation handlers, surface rendering,
  interceptors, lifecycle, child facets.

```ts
interface FacetManifest {
  readonly id: FacetPackageId;                 // e.g. "core.fs", "acme.deploy"
  readonly version: SemVer;
  readonly compat: CompatRange;                // spec + host compatibility
  readonly isolation: IsolationMode;           // the MINIMUM isolation this facet tolerates;
                                               // placement is decided by platform policy (§9.2)
  readonly bindings: readonly BindingRequirement[];
  readonly configSchema?: JsonSchema;          // merged into the platform config schema
  readonly contributions: Contributions;       // open map keyed by SlotName (§4.2)
}

abstract class Facet {
  abstract readonly manifest: FacetManifest;
  abstract operation(name: OperationName): Operation<unknown, unknown>;
  abstract surface(id: SurfaceId): Surface;
  abstract interceptor(id: InterceptorId): Interceptor;
  abstract children(): FacetSet;
  abstract start(ctx: OperationContext): Promise<void>;   // idempotent
  abstract stop(ctx: OperationContext): Promise<void>;    // stops children first
}

abstract class Operation<I, O> {
  abstract readonly descriptor: OperationDescriptor<I, O>; // name, impact, schemas, help
  abstract execute(ctx: OperationContext, input: I): Promise<O>;
}
```

The host verifies at install time that the runtime provides every implementation the
manifest declares, refuses contributions the manifest does not declare, and treats the
manifest's `isolation` as a *minimum*: placement at a stronger isolation mode is always
permitted, and placement at `bundled` is granted only by platform policy (§9.2), never
by the manifest alone — untrusted code should never be able to place itself into the
trusted process.

Facet lifecycle hooks are idempotent from the caller's perspective. Protected
invocation requires an active, undisposed Facet whose Grant, Binding, lease, and
revocation state are valid per §3.4. Turns dispose resolved Facets on completion,
failure, cancellation, suspension, or authority loss.

*Why the split:* everything a host, a registry, or the Blueprint validator needs to
know about a facet is data it can read without running anything. This is the property
that makes a config-defined platform possible at all — and it is the shape that both
VS Code extensions and the most successful open agent platforms independently arrived
at.

### 4.2 Contributions and slots

A **Contribution** is a typed, schema-validated manifest entry targeting a **Slot** —
the extension points of a platform. The spec defines the core slots; the `slots`
meta-contribution declares new ones. Contributions are data that compiles down to
existing primitives, and a conforming host materializes them through the same paths it
offers imperatively, so declared and programmatic behavior cannot diverge.

| Core slot | Entry | Materializes as |
| --- | --- | --- |
| `operations` | OperationDescriptor | catalog entry (runtime must implement) |
| `surfaces` | SurfaceDescriptor | renderable Surface |
| `events` | EventDeclaration | accepted Event kinds + visibility |
| `ingress` | IngressDeclaration (§6.1) | verified external endpoint minting Events |
| `prompt` | PromptContribution | prompt-assembly section |
| `commands` | Command (§4.3) | catalog entry + derived Subscription |
| `automations` | SubscriptionTemplate | Subscription |
| `interceptors` | InterceptorDeclaration (§4.4) | ordered sync hook |
| `settings` | JSON-schema fragment | merged platform config schema |
| `slots` | SlotDeclaration | a new slot others may target |

```ts
interface SlotDeclaration {
  readonly name: SlotName;                  // e.g. "dashboard.card"
  readonly entrySchema: JsonSchema;
  readonly authority: SlotAuthorityPolicy;  // who may contribute; who may see entries
}
```

**Reading slots.** Hosts expose a query API — the data source for composers, palettes,
and dashboards:

```ts
abstract class SlotCatalog {
  abstract query(slot: SlotName, viewer: SubjectRef): Promise<readonly SlotEntry[]>;
}
```

`query` filters by the slot's visibility policy; the materializer (§9.3) rejects
contributions that violate the slot's contribute-authority. Core slots carry an
implicit default policy: contribute = any installed Facet in scope; visibility = the
same policy as direct reads (§3.4 rule 4).

Slot entries come in two flavors: *declarative* (the entry is data validated against
`entrySchema`; the reading Surface renders it) and *surface-backed* (the entry carries
a `SurfaceId`; an aggregating platform Surface embeds the referenced child Views —
refs, never live stubs, per §6.3). A `dashboard.card` slot is the canonical
surface-backed case: the platform's dashboard Surface queries the slot and composes
the contributed cards' Views.

### 4.3 Commands

A **Command** is the general form of slash commands, palette entries, and CLI verbs —
a user-invocable, parameterized shortcut to an Operation. It is a contribution kind,
not a primitive: it compiles entirely to catalog entries plus a derived Subscription,
which means installing a command changes *no code anywhere* and the full authority,
approval, and audit machinery applies to it automatically.

```ts
interface Command {
  readonly name: string;                    // canonical id is `${facetId}:${name}`
  readonly title: string;                   // localizable (string or i18n key)
  readonly help?: string;
  readonly arguments: JsonSchema;           // validation + autocomplete
  readonly operation: OperationRef;         // target
  readonly mapping?: FieldMapping;          // arguments → operation input (see below)
  readonly completion?: OperationRef;       // optional observe-impact completion provider
  readonly surfaces: readonly SlotName[];   // where discoverable (chat.composer, cli, palette)
}
```

The lifecycle, end to end:

1. **Install.** The materializer registers the command in each declared surface slot.
   Command `name` MUST be unique per surface slot per Scope; a collision rejects the
   later contribution unless the Scope configures an alias. Per-Scope visibility
   policy (§9.2) MAY disable individual commands.
2. **Discovery.** Surfaces render catalogs via `SlotCatalog.query`. For dynamic
   argument completion beyond schema enums, the host MAY call the command's
   `completion` Operation (`observe` impact) with the partial argument context.
3. **Argument binding.** A surface binds raw input to `arguments` deterministically:
   required ordered scalar properties fill positionally from whitespace-delimited
   tokens; `--key value` binds by name; a single string property annotated
   `x-rest: true` captures the remainder. The bound object MUST validate against
   `arguments` before any Event is emitted.
4. **Invocation.** The surface emits `Event(command.invoked)` whose correlation MUST
   carry the originating `SurfaceId` and, when invoked from a conversation, the
   `RunRef`/branch. The derived Subscription routes it to the target Operation.
   `arguments` MUST be structurally assignable to the Operation's input schema, or the
   contribution MUST supply `mapping`, validated at install; the Operation's input
   schema is authoritative at execution.
5. **Result.** The host MUST emit `Event(command.completed)` correlated to the
   invoking Event's id, carrying the Operation's output reference (or the failure).
   Surfaces that render a `commands` slot MUST subscribe to `command.completed` for
   their own invocations and render results via ViewDelta (§6.3). A command whose
   effect belongs in the conversation appends a RunCommit to the correlated Run under
   the invoker's authority.

A worked example — a deploy facet adds `/deploy` to a chat platform:

```ts
contributions: {
  operations: [{ name: "deploy.run", impact: "externalSend", input: DeployArgs }],
  commands: [{
    name: "deploy", title: "Deploy the current slate",
    arguments: DeployArgs, operation: "deploy.run",
    surfaces: ["chat.composer", "cli"],
  }],
}
```

Installing the facet makes `/deploy` discoverable wherever the `commands` slot renders.
`/deploy --target staging` binds, validates, emits `command.invoked` with the Run
correlation, routes through a mediated Invocation (`externalSend`), and the receipt and
result flow back to the composer through `command.completed`. Adding a whole new
affordance category — composer suggestions, dashboard cards — is a `slots` declaration,
not a spec change.

![Command lifecycle](diagrams/command-flow.svg)

### 4.4 Interceptors

An **Interceptor** is an ordered, synchronous, in-process hook at a spec-defined cut
point that can observe, block, or rewrite the value in flight. Every serious local
agent runtime converged on this mechanism independently, because it is the one thing
asynchronous events cannot express: a veto or a transform has to return a value *now*.
The value in flight at each cut point:

| Cut point | Value in flight | May |
| --- | --- | --- |
| `operation.before` | (descriptor, input) | block; rewrite input |
| `operation.after` | (descriptor, output) | rewrite output |
| `prompt.assemble` | assembled prompt sections | reorder, add, remove sections |
| `input.submitted` | user input | transform; block |
| `turn.step` | step context | annotate; request stop |

```ts
interface InterceptorDeclaration {
  readonly id: InterceptorId;
  readonly cutPoint: CutPoint;
  readonly appliesTo: OperationSelector;    // DEFAULT: the contributing facet's own operations
  readonly priority: number;                // total order: (priority, facetId)
}

abstract class Interceptor {
  abstract intercept(ctx: InterceptContext, value: unknown): Promise<InterceptResult>;
  // InterceptResult: { proceed: true, value } | { proceed: false, reason }
}
```

Rules:

1. Interceptors run only within one protection domain; cross-domain interception MUST
   use asynchronous Events.
2. `appliesTo` defaults to the contributing facet's own operations. Intercepting
   another facet's operations requires that facet to declare the operation
   `interceptable` and the interceptor's facet to hold a Grant for it. Sharing a
   domain confers no interception rights.
3. Ordering is total and deterministic: ascending `(priority, facetId)`. Hosts record
   which interceptor last rewrote a value.
4. A thrown error blocks — scoped to the interceptor's `appliesTo`, surfaced as a
   typed operation error, never as a silent global veto.
5. Mutating interceptions are attributable: the host records interceptor identity plus
   before/after value digests through the invocation's tier-appropriate audit channel
   (§7.2).
6. Interceptors are not durable; a crash between an interceptor's decision and the
   operation's effect re-runs the chain on retry.

Example: a policy facet contributes `{ cutPoint: "operation.before",
appliesTo: own("web.fetch"), priority: 10 }` that rewrites outbound URLs onto an
allowlisted proxy — its own operation, no opt-in needed, and the rewrite is
digest-logged.

### 4.5 Environment and Session

An **Environment** is an execution endpoint that opens live **Sessions**; a Session
exposes session-scoped child Facets (`env.fs`, `env.shell`, `env.ports`, `env.proc`).
An Environment is essentially the agent's computer.

Rules: stale Sessions fail; closing a Session disposes its child Facets; rotation
changes future Sessions without retargeting open ones. Environment profiles further
define **snapshot/restore** (boot from a known image — the reliability lever every
production platform converged on), **ephemeral-filesystem durability** (backup and
restore for container-backed environments), **preview exposure** (how a port becomes an
authenticated URL), and the **credential-isolation seam** (secrets injected by proxy,
never present inside the environment).

A **device environment** (§11) is an Environment behind a reverse-connection
transport — the user's laptop or phone. Its profile adds pairing (key exchange plus
operator approval), transport-attached consent (per device × agent, fail-closed), and
typed device command surfaces. These are Environment-profile concerns, not new
primitives.

### 4.6 Slate

A **Slate** is a programmable, user-facing application produced inside the platform —
the thing your agent builds for you: a **source document** (content-addressed; a
git-shaped history is a permitted canonical representation), **immutable versions**,
and **deployments**. A Slate composes with the other primitives rather than
duplicating them:

- live preview *is* an Environment Session — a running process with ports — not a
  rendered View;
- the Slate backend executes in the `dynamic` isolation mode with zero ambient
  authority; capabilities arrive only through explicitly passed Bindings;
- publishing or embedding a Slate contributes Surfaces; app-private data is owned by
  the Slate's Actor.

Operations: `update`, `commit`, `fork`, `publish`, `deploy`, `rollback`.

---

## 5. Execution (L2)

### 5.1 Agent

An **Agent** is durable identity, profile, and policy: instructions, model policy (a
ModelPolicy seam — providers are out of scope), ambient and bound Facet specs, memory
and task relationships, Run history. A model call happens only inside a Turn.

### 5.2 Run, RunBranch, RunCommit

A **Run** is a branchable, durable work session and conversation lineage. It owns
input history, RunBranches (named movable heads), RunCommits (immutable records:
message, checkpoint, invocation, event delivery, result, merge, verdict, undo,
migration), status, an optional parent Run, and results. There is no separate
conversation primitive — conversation state *is* the Run's branch/commit graph, which
is why branching a conversation, undoing a step, and running parallel attempts are
graph operations here rather than product features bolted on later.

- Starting a Run creates an initial RunBranch and RunCommit and **pins** the Blueprint
  and Package versions in effect. Turns replay against pinned versions. **Run
  migration** — moving a Run to newer pins — is an `administer`-impact Operation that
  records a migration RunCommit; a Run is never migrated silently.
- `spawn` creates a child Run under attenuated authority (`delegate` impact, §11 Self
  profile).
- The commit graph is **append-only**. An `undo` appends an undo RunCommit `U` whose
  parent is the current head and whose `selects` field names an ancestor commit; the
  branch head advances to `U`, and the branch's **effective state** becomes the
  selected commit. Redo appends another undo commit selecting the prior effective
  commit. The interval until the next non-undo commit is the **pending revert**: it is
  durable, epoch-carrying, and reversible. Prior heads remain reachable; ancestry
  queries are unaffected.
- Undo targeting a branch whose Turn holds an unexpired lease MUST first fence that
  Turn (§5.3); an undo that would orphan an in-flight Turn is rejected until the Turn
  is fenced or completes.
- `merge` records a RunCommit with two or more parents and its resolution content.
  The host never merges automatically — its job is to detect divergence and require a
  resolution, which is produced by a Turn (an aggregating model call, a deterministic
  strategy, or a person) and recorded as the merge commit's content. Three rules make
  this unambiguous:
  1. *Conversation state.* The merge commit's content is the resolution; the parents
     stay reachable, so nothing about how the resolution was produced is lost.
  2. *Tree state.* When the parents' `treeCheckpoint`s diverge from their nearest
     common ancestor's, the merge commit MUST carry its own `treeCheckpoint` naming
     the resolved tree — produced by the merging Turn using whatever strategy fits
     (a three-way merge inside the Environment, regeneration, or picking one side).
     A merge of tree-divergent parents without a resolved tree checkpoint is rejected.
  3. *Slate state.* A Run merge never merges Slate versions implicitly; the Slate's
     own `commit`/`merge` operations handle that, and the run-level merge records
     which Slate version its resolution selected.
  A merge is a lease-fenced commit like any other, and its parents MUST be the current
  branch heads at commit time (the `expectedRevision` envelope, §8.5) — if a head moved
  since the resolution was prepared, the merge is rejected and must be re-prepared
  against the new heads.
- Conforming stores support ancestry and reachability queries, not merely head moves.

![The commit graph: undo as selection](diagrams/undo-graph.svg)

```ts
interface RunCommit {
  readonly id: RunCommitId;
  readonly branch: RunBranchId;
  readonly kind: "message" | "checkpoint" | "invocation" | "event" | "result"
               | "merge" | "verdict" | "undo" | "migration";
  readonly parents: readonly RunCommitId[];
  readonly leaseEpoch: number;                    // §5.3
  readonly content?: ContentRef;
  readonly selects?: RunCommitId;                 // undo/redo only
  readonly treeCheckpoint?: ContentRef;           // §5.4 — associated tree snapshot, if any
}
```

*Why selection instead of head-rewind:* an append-only graph means nothing is ever
lost, undo is itself undoable, ancestry queries stay simple, and two observers can
never disagree about history — they can only disagree about which commit is currently
selected, which is one field.

### 5.3 Turn: lease-fenced execution attempts

A **Turn** is one lease-fenced execution attempt inside a Run: input, status, lease,
branch, resolved FacetSet, checkpoints, Invocations, result.

```ts
abstract class TurnLease {
  abstract readonly holder: PrincipalId | undefined;
  abstract readonly epoch: number;                                   // monotonic
  abstract readonly expiresAt: Date | undefined;
  abstract claim(holder: PrincipalId, expiresAt: Date): TurnLease;   // epoch += 1
  abstract renew(holder: PrincipalId, epoch: number, expiresAt: Date): TurnLease;
  abstract fence(): TurnLease;                                       // epoch += 1, holder cleared
}
```

A Turn starts queued at epoch 0; claiming records an executor and increments the
epoch; renewal extends the current holder; reclaiming an expired lease replaces the
executor and increments the epoch; suspension persists a checkpoint and fences. **Every
Turn-owned commit carries the current lease epoch** — checkpoint writes, RunCommit
appends, Invocation preparation, terminal completion, child-Run spawning, and callbacks
from external executors. A stale epoch is rejected at the owning Actor. Where the
substrate permits, the epoch is presented to external resources as a fencing token
whose check MUST be atomic with the guarded write; where it does not, delivery is
at-least-once and the owning Actor's epoch check is the fence (§10.3).

![Turn lease lifecycle](diagrams/turn-lease.svg)

The point of all this machinery is that a crashed executor which comes back later
cannot corrupt anything: every write it attempts carries a stale epoch and gets
rejected. The lease is also deliberately application-visible — your code can hand the
epoch to an external system and ask it to check, and that check is the only kind of
fencing that still works across a network partition.

### 5.4 Checkpoints

Two checkpoint kinds are distinct and MUST NOT be conflated: **run checkpoints**
(conversation and executor state, recorded as RunCommits) and **tree checkpoints**
(filesystem state of an Environment, content-addressed snapshots). Undoing a
conversation and undoing files are separate operations — a RunCommit MAY carry
`treeCheckpoint` (§5.2) naming the tree snapshot current at that commit, which is what
makes *coordinated* undo expressible as two explicit steps, never one implicit one.

### 5.5 Cache lineage

A Turn MAY carry an advisory `cacheLineage` hint identifying the Turn and prompt
prefix it descends from, so executors can preserve provider-side prefix caches across
forked or parallel attempts. Purely advisory; no correctness semantics. The savings
are real — systems that exploit prefix-cache sharing across forks have measured
roughly a quarter of inference cost saved — which is why it is worth a dedicated
field.

### 5.6 The executor seam

```ts
abstract class TurnExecutor {
  abstract execute(turn: TurnContext): Promise<TurnOutcome>;
  // TurnContext: resolved facets, operation catalog, prompt assembly, inbox,
  // lease commit handle, checkpoint handle, tiered invocation gateway (§7.2),
  // cancellation signal
}
```

Existing harnesses — the Claude Agent SDK, Pydantic AI, the Vercel AI SDK, bespoke
loops — are hosted behind this seam. Prompt assembly derives from platform rules,
Agent instructions, Workspace/Run context, the branch's **effective state** (§5.2 —
not the raw head, which may be an undo marker), `prompt` contributions, and operation
help, and is interceptable at `prompt.assemble`.

Mid-turn input uses `turn.deliverEvent`: a lease-fenced operation appending an Event
to the running Turn's inbox; hosts MAY implement delivery as "the durable log is the
queue" — re-read the inbox each step. **Cancellation** is the reserved inbox Event
`turn.cancel`: fencing a Turn (undo, takeover, timeout) delivers it, and a conforming
executor observes the cancellation signal between steps and stops committing.

---

## 6. Interaction (L3)

### 6.1 Events, provenance, ingress

An **Event** is an immutable occurrence record: scope, source (Facet or Actor),
category, payload reference and digest, idempotency key, correlation and causation,
**provenance**, derived **TrustTier**, and visibility policy. A webhook, a schedule
firing, a chat message, a button press, and a command invocation are all Events. The
benefit of unifying them is that there is one input model, one routing mechanism, and
one audit trail for everything that enters the system.

**Trust tiers are host-derived, never facet-asserted.** A Facet supplies raw
provenance — authenticated identity, channel, group, transport verification result —
and the host derives the tier from that provenance and the Blueprint's trust-tier
policy:

- `owner` — the authenticated owning Principal of the scope;
- `authenticated` — a verified non-owner principal;
- `external` — unauthenticated or third-party origin;
- `self` — emitted by a Turn executor under a valid lease. Assignable only by the
  host for lease-fenced emissions.

An Event whose tier was set by a non-host source is rejected. The reason for this
rule: if a channel adapter could stamp its own trust tier, then a compromised adapter
could mark an attacker's message as `owner` and defeat every policy keyed on the tier.
Deriving the tier in the host closes that hole.

**Ingress.** External input enters through `ingress` contributions:

```ts
interface IngressDeclaration {
  readonly path: string;                       // or transport binding
  readonly verification: { scheme: "hmac" | "signature" | "oauth" | "mtls"; secret: SecretRef };
  readonly provenance: ProvenanceMapping;      // verified identity → provenance fields
}
```

The host exposes declared endpoints, verifies per `verification`, and mints Events
with derived provenance; unverified requests never mint Events. This is how a
messaging channel's inbound webhook becomes a trusted Event stream.

**Ownership.** An Event is owned by the Actor that accepts it (§8.4). Appending and
routing are transactional within that owning Actor; routing over Events owned by a
different Actor is an asynchronous, at-least-once, idempotency-keyed projection
(§10.1).

### 6.2 Subscription

A **Subscription** is a durable route from matching Events to an Operation:

```ts
interface Subscription {
  readonly source: EventPattern;             // kind/source matching, wildcards
  readonly target: OperationRef;
  readonly mapping: PayloadMapping;          // event payload → operation input
  readonly dedupe: DedupePolicy;             // none | event | causation | payload
  readonly authority: BindingRequirement;    // the authority the invocation runs under
}
```

Routing is at-least-once with deduplication on the subscription's dedupe key. A
scheduled automation is a Subscription from a scheduler Event (idempotency key derived
from `(subscription, fireTime)`); a webhook automation is a Subscription from a
verified ingress Event. Example: `{ source: "schedule.daily-report", target:
"report.generate", dedupe: "event" }`.

### 6.3 Surface, View, ViewDelta

A **Surface** is a stable UI contribution from a Facet; a **View** is one rendered
snapshot of it.

```ts
interface View {
  readonly surface: SurfaceId;
  readonly revision: Revision;
  readonly body: ViewBody;                   // data only
  readonly actions: readonly ActionDescriptor[];
  readonly cursor: EventCursor;
}
```

A View carries no live Facets, stubs, credentials, or hidden state — refs only.
Surfaces stream via **ViewDelta** events: RFC 6902 JSON Patches against a View
revision (compatible with AG-UI's `STATE_DELTA` convention), so clients update
without re-snapshotting. Surface actions emit Events; Subscriptions route them to
Operations. Aggregating surfaces — dashboards — compose slot-contributed child Views
per §4.2. Token-level model-output streaming is an executor and transport concern
(§5.6), not Events.

---

## 7. Mediation (L4)

### 7.1 Impact taxonomy

The six impacts are defined in §1.4. Boundary rule: an operation whose request crosses
the trust boundary is `externalSend` regardless of data direction; reading the
response is `observe`. A web fetch is `externalSend`; listing its cached result is
`observe`.

### 7.2 Enforcement tiers

Every protected call is an **Invocation**; enforcement is tiered. Workspace policy
maps `(facet, operation, impact, event trust tier)` to an `EnforcementTier`:

- **mediated** — the durable pipeline: resolve Binding → durably record intent →
  evaluate policy → Approval when required (§7.3) → revalidate the revocation epoch on
  the durable path → invoke under stable operation identity → persist Receipt (or an
  explicit *indeterminate*) → append AuditRecord → emit Event.
- **direct** — an in-process call. Authority — Binding validity, lease epoch,
  Turn-start revocation stamp — is checked in memory; no durable writes occur on the
  call path; audit is a sampled, batched observability record. The `direct` tier
  REQUIRES the facet to be `bundled` in the Actor that owns the Turn lease; a
  provider- or dynamic-mode facet is never `direct`, because its authority check would
  cross an isolate boundary.

Defaults (policy may override explicitly): `observe` → direct; `execute` scoped to a
session the Turn owns → direct, all other `execute` → mediated; `mutate` → mediated;
`externalSend`, `delegate`, `administer` → mediated. When a default selects `direct`
but the facet is not bundled with the lease-owning Actor, the invocation escalates to
`mediated` — the co-location requirement always wins.

![Tiers and the approval continuation](diagrams/mediation.svg)

*Why tiers at all:* an agent loop makes thousands of `observe` calls per session, and
several durable writes per file read would make the platform unusable — every fast
agent runtime treats hot-path tool calls as plain function calls, for good reason. On
the other hand, an external send with no receipt leaves you unable to answer basic
questions like "did we actually email that customer?". Tiering keeps one uniform
model — everything is an Invocation — while matching the cost of each call to its
consequences.

### 7.3 Approval

An **Approval** authorizes one described Invocation — operation identity, impact,
target, **argument digest** (collision-resistant, §1.4), idempotency key — or a
declared homogeneous batch. The lifecycle is a continuation, normative end to end:

```text
invoke → policy: approval required → persist pending Approval (digest-bound)
      → [out of band: resolver approves | denies | expires]
      → resume: revalidate Grant, Binding, lease epoch, revocation epoch,
                AND argument digest against the approved digest
      → execute → Receipt → AuditRecord → Event
```

Approvals are single-use, MAY expire, and survive process death: the persisted pending
Approval plus the persisted Invocation intent are sufficient to resume on any executor
holding a valid lease. Denial produces a denied Receipt; expiry produces a cancelled
Receipt.

The digest binding is the detail everything else depends on. An approval is a human's
yes to *these exact arguments*, so the resume path recomputes the digest of what is
about to execute and compares it to what was approved. If the payload changed by even
one byte after approval, the invocation fails with a denied receipt.

### 7.4 Receipt, AuditRecord, reconciliation

A **Receipt** records the known outcome: success, failure, denial, cancellation, or
**indeterminate**. An **AuditRecord** is the durable security record — grants,
bindings, attempts, denials, approvals, receipts, revocations, delegation lineage.
Telemetry is diagnostic data and never substitutes for either.

For mediated Invocations with external effects, reconciliation is mechanical:

1. the intent is durably committed **before** the external effect (write-ahead);
2. the external call carries the Invocation's idempotency key, so the provider can
   deduplicate and answer "did key X land?";
3. an intent with no Receipt after its executor's lease expires becomes
   *indeterminate*, and a named **reconciliation driver** (substrate-defined: alarm
   sweep or workflow, §10.3) re-queries by idempotency key or safely re-sends, then
   persists the final Receipt.

---

## 8. Substrates (L5)

### 8.1 Actor

An **Actor** is a durably addressable state machine with one authoritative
coordination unit owning its mailbox, local transaction boundary, lifecycle, recovery,
and fencing state. It serializes conflicting commands, recovers state before serving,
commits at declared linearization points, and rejects stale fences. Actor roles:
Tenant, Workspace, Run (when dedicated), Environment, Slate host.

### 8.2 ContentStore

```ts
abstract class ContentStore {
  abstract put(bytes: Uint8Array, hint?: MediaHint): Promise<{ ref: ContentRef; digest: Digest }>;
  abstract get(ref: ContentRef, range?: ByteRange): Promise<Uint8Array>;
  abstract stat(ref: ContentRef): Promise<ContentStat | undefined>;
}
```

Every `ContentRef` in this specification resolves through a ContentStore — run inputs,
checkpoints, instructions, results, slate sources — so there can never be a reference
that nothing is able to load. Retention and GC follow Tenant policy.

### 8.3 Records and codecs

Durable records are data. Every record type defines a stable serialized form with a
**versioned codec**, used identically for storage, the command protocol, and
export/import. A codec tolerantly reads and upcasts records of any older version
within the same major, and rejects records of an unknown newer major with a typed
error — never a silent truncation. Live behavior wraps records; it never *is* the
record, and durable records never own live substrate resources.

### 8.4 State-ownership rules

1. Every record type names exactly **one owning Actor**.
2. Other actors hold identifiers and rebuildable indexes only. An index maps id →
   locator and is disposable; a Workspace's index over dedicated Runs is constrained
   to `{ runId, actor locator, pins, terminal status }` and never carries replayable
   Run state.
3. Caches are derived, versioned, rebuildable; a cache miss is never an error.
4. Cross-actor reads use RPC or explicitly versioned snapshots — never dual writes.
5. Authority evidence is resolved at Turn start and revalidated per the bounded-window
   rule of §3.4 rule 5.
6. Conformance includes an **ownership map** artifact — record type → owning Actor —
   verified against the implementation.

These rules exist because mirrored state is the most expensive class of bug a durable
platform can have: two copies of the truth always eventually disagree, and by the time
they do, both copies have already been read by something.

### 8.5 The command protocol

Protocol **commands** (controller contracts — distinct from the user-facing Commands
of §4.3) are how coordination is implemented. Every mutating command defines
authority, valid lifecycle state, linearization point, optimistic-concurrency envelope
(`expectedRevision`, `expectedLeaseEpoch`), durable mutation, emitted observation,
reply, retry, and reconciliation behavior. Reference command families: Tenant,
membership, resource, Grant, Binding, Event, Subscription, Run, Turn, RunBranch,
RunCommit, Invocation, Approval, Environment, and Workspace portability.

A conforming substrate provides a **dispatcher** that enforces the envelope at the
protocol boundary. The envelope check and the guarded mutation execute as one atomic
unit on the owning Actor — on substrates with interactive-gap hazards this means a
single synchronous transaction with no intervening I/O (§10.3). "Emitted observation"
is atomic only intra-Actor; cross-Actor observation is post-commit and asynchronous
(§6.1).

---

## 9. The definition plane (L6)

### 9.1 Package

A **Package** is the distributable unit: one or more FacetManifests, code references,
version, compatibility range, provenance, config-schema fragments. Packages are
inspectable without execution — hosts, registries, and the Blueprint validator read
manifests as data. Registry governance is out of scope; the package shape is not.

### 9.2 Blueprint

A **Blueprint** declares a platform:

```ts
interface Blueprint {
  readonly meta: { name: string; version: SemVer };
  readonly packages: readonly PackageInstall[];    // package ref + config (SecretRefs only)
  readonly scopes?: ScopeScaffold;                 // default Projects/Workspaces
  readonly agents: readonly AgentProfile[];
  readonly slots?: readonly SlotDeclaration[];
  readonly subscriptions?: readonly SubscriptionTemplate[];
  readonly policies: PolicySet;                    // enforcement tiers, approval rules,
                                                   // trust-tier derivation, placement policy,
                                                   // command visibility, quotas, retention
  readonly environments?: readonly EnvironmentSpec[];
  readonly surfaces?: SurfaceLayout;
}
```

`policies.placement` decides isolation (§1.5): the platform places each facet at the
strongest of (manifest minimum, policy assignment), and refuses `bundled` to any
package not on the platform's trusted list. The composed platform config schema is the
spec's base schema plus every installed package's `settings` fragments, and a
Blueprint MUST validate against it **before any package code loads** — you can know
exactly what a Blueprint will do while it is still just a document.

A skeleton:

```jsonc
{
  "meta": { "name": "support-desk", "version": "1.2.0" },
  "packages": [
    { "ref": "core.chat@^2", "config": {} },
    { "ref": "acme.deploy@^1", "config": { "apiKey": { "$secret": "acme/deploy-key" } } }
  ],
  "agents": [{ "name": "helper", "instructions": "…", "model": { "policy": "balanced" } }],
  "policies": {
    "placement": { "trusted": ["core.*"], "default": "provider" },
    "tiers": { "acme.deploy:deploy.run": "mediated" }
  }
}
```

### 9.3 Materialization

A **materializer** projects a Blueprint into records — Facet installs, Bindings,
Subscriptions, slots, policies, scope scaffolding — **idempotently**: re-applying
reconciles (create, update, remove-managed) rather than duplicates. Materialized
records are marked Blueprint-managed; manual edits to managed records are rejected or
adopted explicitly, per policy. The materializer enforces slot contribute-authority
(§4.2), command uniqueness (§4.3), and role→Grant materialization (§3.3) through the
same records the runtime uses. Reconciliation on a live platform orders changes so
in-flight Runs keep their pins (§5.2); removing a package with live pinned Runs is
deferred or forced-with-migration, per policy — never silent.

![From Blueprint to running platform](diagrams/blueprint.svg)

This is the control plane, and honestly, the goal of this whole project: a platform
is a Blueprint plus Packages, deployed onto a substrate profile. The same document
that configures your platform is the one a registry can inspect, a reviewer can diff,
and a second substrate can materialize.

---

## 10. The Cloudflare profile (normative)

Cloudflare Durable Objects are the first-class substrate: a DO is very nearly an Actor
already — single-threaded, durably addressed, with private transactional storage — so
the mapping is short. What the profile mostly adds is discipline about the things DOs
do *not* give you: there is no transaction across two DOs, RPC stubs do not outlive an
execution context, and queues deliver at least once. The rules below are written
against those facts.

### 10.1 Topology

| Construct | Hosting |
| --- | --- |
| Tenant Actor | one Durable Object per Tenant (SQLite): principals, teams, memberships, Projects, grants ledger, revocation epochs and holder index, credential custody, quotas |
| Workspace Actor | one DO per Workspace (SQLite): facet installs, bindings, its event log, subscriptions, runs (default) or run index (dedicated), tasks, slate records |
| Run | Workspace-owned by default; MAY be pinned `dedicated` at start, in which case a Run DO owns the Run's records and its Run-scoped event log, and the Workspace keeps a locator index (§8.4 rule 2). Pinned at start; migration only per §5.2. |
| Turn execution | in the Run-owning DO; long compute offloads to Workflows and Queues with application-level lease-epoch fencing on callbacks — delivery is at-least-once and the owning DO rejects stale epochs |
| Environment | Sandbox SDK container or session DO; tree checkpoints and filesystem durability via R2 snapshots; preview via authenticated exposed ports |
| Slate | records in the owning DO; frontend on static assets; backend as dynamic-mode code (§10.2) |
| ContentStore | R2, with DO SQLite for small content, content-addressed |
| Events | owned by the accepting Actor. In-Actor append and route is one transaction. Cross-Actor — dedicated Run → Workspace subscriptions, or cross-workspace — is an asynchronous at-least-once projection via fenced RPC or Queues, idempotency-keyed, deduped by the Subscription's key. |

Projects are records in the Tenant DO — grouping adds zero DOs. Authority resolution
costs one Tenant-DO hop per Turn start; revocation freshness follows the
bounded-window rule (§3.4 rule 5), with the Tenant DO pushing invalidations to holders
from its reverse index and mediated invocations revalidating on their durable path.

![Cloudflare topology](diagrams/cloudflare.svg)

### 10.2 Facet hosting

Placement follows §9.2 policy over the manifest's minimum isolation. It is
emphatically **not** one Worker per Facet — isolation boundaries are drawn exactly
where protection domains change, and same-domain separation is fanout and cold-start
tax with no security benefit:

1. **Bundled** — facet code ships in the platform Worker and runs in-process inside
   the hosting Actor. Turn-scoped resolutions; eligible for `direct` (§7.2).
   First-party facets — fs, shell, memory, tasks, chat — live here, by policy grant.
2. **Provider** — a separate Worker or service behind a service binding or
   capability-RPC stub (Workers RPC / Cap'n Web). This is where custody demands
   isolation: third-party integrations and credential-holding approval gateways. RPC stubs
   do not survive execution contexts, hibernation, or isolate eviction, so provider
   resolutions are scoped to a single Turn step and re-resolved with epoch
   revalidation each step (§3.4 rule 6). Revocation drops the stub; so do platform
   lifecycle events; re-resolution is the uniform recovery for both.
3. **Dynamic** — code loaded via Worker Loader into a fresh isolate: agent-generated
   facets and Slate backends. Hosts pass `globalOutbound: null` (or equivalent), so
   dynamic isolates inherit no ambient network; capabilities arrive only as
   explicitly passed Bindings. Worker Loader is in open beta at the time of writing;
   Workers-for-Platforms dispatch namespaces serve as the GA fallback for
   pre-deployed Slate backends, with identical authority semantics.

### 10.3 Implementation constraints

- DO SQLite is synchronous; the dispatcher's envelope check plus guarded mutation is
  one synchronous span with no intervening `await` (input-gate hazard, §8.5).
- WebSocket surfaces use hibernation. ViewDelta streaming requires a durable,
  compactable delta/snapshot log keyed by revision in the owning DO, and the
  per-socket last-acked revision cursor in the WebSocket attachment (≤ 16 KB); replay
  cost is bounded by periodic snapshots.
- Alarms drive schedules (idempotency key = `(subscription, fireTime)`) and serve as
  the reconciliation driver (§7.4): an alarm sweep re-drives indeterminate intents.
  Workflows `step.waitForEvent` MAY serve as the driver for provider-callback flows.
- Queues and Workflows are at-least-once with no platform-fenced DO callback; all
  fencing is the application-level lease epoch (§5.3).
- Platform and Slate-backend deployment uses dispatch namespaces; per-app resources
  (D1, KV) are provisioned at first need and recorded on the owning Slate record.

---

## 11. Profiles

A profile is a named, conformance-testable composition of primitives — never a new
primitive.

| Profile | Composed from | Defining requirements |
| --- | --- | --- |
| Filesystem | Facet + Operations | strict paths, byte reads, create/replace/upsert writes, paged stat-inclusive lists, moves, receipts, stable error codes |
| Shell | Facet + Operations + Environment | parser, command registry, stdio, filesystem boundary, cancellation, external-execution handoff |
| Memory | Facet + Operations + prompt | canonical content, recall/remember, derived indexes, pruning |
| Task | Facet + Operations + Surface | lifecycle, acyclic hierarchy, task-board surface, Run relations |
| Web | Facet + Operations | request scope, URL safety, credential policy, rate/size limits; §7.1 boundary rule |
| MCP | Facet (adapter) | tool/resource discovery → Operations, schema validation, server lifecycle, prompt bounds; targets the current MCP revision |
| Approval gateway | provider-mode Facet + Invocation | external-resource sessions, protected mutations, approval Surfaces, receipt persistence, reconciliation (§7.4) |
| Self | Facet + Operations over L2 | Run identity, checkpoint, message commit; spawn/finish are Operations with `delegate` impact — the Self profile flows through the Invocation membrane like any other Facet |
| Environment | §4.5 | session lifecycle, child facets, staleness, rotation, snapshot/restore, FS durability, preview exposure, credential seam |
| Device | Environment | pairing, transport-attached consent, typed device commands |
| Slate | §4.6 | source, versions, deployments, dynamic-mode backend, preview-as-Environment |
| Single-tenant | policy profile | one Principal, one Tenant; Grant/Binding ceremony collapsed to trusted-operator defaults while keeping the seams — records exist, policy auto-grants. A personal platform is a policy choice, not a different architecture. |

Each profile carries its own conformance suite; the filesystem suite is the template.
Full per-profile specifications are the largest remaining body of work (§15).

---

## 12. Assembly sketches *(informative)*

Four platforms, assembled from the same box of blocks. These are inspired by real
systems; where the real system does something the primitives don't capture, the sketch
says so.

**An exploration platform** (Proteus-shaped). A Workspace DO per agent workspace;
sibling RunBranches as parallel heads; an orchestration Facet owning search state.
Search statistics — visit counts, value estimates, preference ledgers — are the
orchestration Facet's own records referenced from RunCommits: the commit graph records
lineage and results, not algorithm state. Self-modifying scaffolds are a versioned
Slate-like resource; shadow evaluation runs as child Runs; promotion is a mediated
`administer` Invocation.

**An app generator** (vibesdk-shaped). One Workspace per generated app; the generator
Agent runs in the Workspace DO; the app is a Slate whose source history is git-shaped
content in the ContentStore; live preview is an Environment Session — a container with
an exposed port; deploys are mediated `externalSend` Invocations into a dispatch
namespace; chat arrives as Events.

**A personal assistant** (OpenClaw-shaped). Single-tenant profile. Channel facets
contribute `ingress`, outbound `externalSend` Operations, and `commands`; routing
rules are Subscriptions; per-group trust downgrades are trust-tier policy over ingress
provenance (§6.1); devices are Device-profile Environments; skills are
prompt-contribution Packages. The whole assistant is one Blueprint, and hot-reload is
re-materialization.

**Mixture-of-agents orchestration.** Proposer Turns on sibling branches from one
parent commit; an aggregator Turn reads sibling heads and writes a merge RunCommit; a
judge Turn writes a verdict commit; fan-out is `delegate`-impact spawning under
attenuated Grants.

---

## 13. Conformance

A conforming implementation provides:

- the Scope chain with Membership→Grant materialization (§3.3) and deny-overrides
  precedence, tested with direct, team, and guest cases, including that
  guest-materialized Grants never carry `delegate` or `administer`;
- placement policy (§9.2): facets placed at the strongest of manifest minimum and
  policy assignment, with `bundled` refused to untrusted packages;
- the `direct`-tier co-location requirement with escalation to `mediated` (§7.2);
- Grant/Binding authorization with bounded-window epoch revocation (§3.4 rule 5),
  tested for the three effect deadlines;
- SecretRef-only configuration — no raw credentials in manifests or Blueprints;
- Facet manifests with contribution materialization, slot contribute-authority
  enforcement, and viewer-filtered `SlotCatalog.query`;
- the Command lifecycle end to end (§4.3): argument binding, mapping validation at
  install, collision rejection, correlated `command.completed` result delivery;
- Interceptor ordering `(priority, facetId)`, default self-scope, opt-in cross-facet
  interception, attributable rewrites, throw-as-scoped-block;
- Environment session lifecycle tests: stale session, dispose-on-close, rotation
  non-retargeting;
- host-derived trust tiers with rejection of tier-asserting sources, and verified
  ingress minting;
- the tiered Invocation pipeline including the approval continuation (§7.3), digest
  strength, and the reconciliation mechanism (§7.4: write-ahead intent, idempotency
  propagation, named driver);
- Run/RunBranch/RunCommit with ancestry queries, append-only undo/redo selection,
  undo-fences-live-turn, and version pinning with explicit migration;
- lease-fenced Turns — stale-epoch rejection on every commit class — and executor
  cancellation observance;
- the View no-live-state invariant and ViewDelta revision replay;
- ContentStore resolution for every ContentRef; codec compatibility (§8.3);
- a command-protocol dispatcher enforcing concurrency envelopes atomically (§8.5);
- the state-ownership map (§8.4 rule 6);
- Blueprint validation-before-load and idempotent re-materialization with pin
  preservation (§9.3);
- adversarial tests: stale lease, revoked grant mid-turn, digest mismatch at approval
  resume, duplicate event delivery, cache loss, hostile tier assertion, unauthorized
  slot contribution, interceptor overreach.

## 14. The formal model

A good part of the semantics in this document is machine-checked. A Lean 4 model
under `formal/` covers the places where an informal argument is most likely to be
subtly wrong: grant-chain attenuation and tenant isolation, revocation monotonicity
and the bounded-window epoch rule, lease-epoch monotonicity across the Turn lifecycle,
Event acceptance and Subscription dedup, deny-overrides precedence over the Scope
chain, the approval continuation (digest binding, denial, and trace-level single use),
the append-only undo-selection graph, and the tier and trust-tier derivations.

The model covers the abstract state machine; implementation correctness is a separate
refinement obligation, tracked per requirement. `artifacts/traceability.yaml` maps
requirements to theorems and is machine-verified against the Lean axiom report in both
directions — every claimed theorem exists, every proven theorem is claimed, nothing
depends on `sorry` — by `pnpm check:traceability`. Representability results (profile
and assembly witnesses) are labeled as witnesses, distinct from safety theorems.

Build it yourself: `cd packages/agent-core/formal && lake build AgentCore`.

## 15. Open questions

1. **The public name.** "Agent Core" collides with a shipping AWS product (Bedrock
   AgentCore). Undecided.
2. **Run/Turn vocabulary.** Industry convention uses Run for one execution and
   Session or Thread for the container; Session/Run and Run/Attempt are the candidate
   alternatives. This document keeps the current names until decided.
3. **Schema artifacts lag the spec.** The JSON schemas under `artifacts/schemas/`
   still describe v1 shapes; until they are regenerated alongside the record codecs
   (§8.3), the shapes in this document are the normative ones.
4. **Per-profile specifications** (§11) — the filesystem profile has a full
   conformance suite; the others need theirs.

## Appendix A — Translation table *(informative)*

| Agent Core | Elsewhere |
| --- | --- |
| Facet | MCP server's tools + resources + prompts; plugin; extension; toolset |
| Operation | tool / tool call |
| Command (contribution) | slash command; palette command; CLI verb |
| Run / RunBranch | thread or session with branches; conversation tree |
| Turn | run; execution attempt |
| Environment | sandbox; VM; the agent's computer |
| Slate | canvas; artifact; generated app |
| Blueprint | platform config; manifest; IaC definition |
| Grant / Binding | scoped token; capability; connection |
| mediated Invocation | approval-gated tool call with receipts |
| Interceptor | plugin hook; middleware; tool wrapper |
| ingress | webhook endpoint; channel adapter |

## Appendix B — Artifacts

JSON schemas live under `artifacts/schemas/` (v1-era until regenerated — see §15.3);
the implementation-manifest schema under `artifacts/`; the Lean model under `formal/`;
generated traceability under `artifacts/traceability.yaml`. The condensed introduction
to this project is the repository's [README](../../README.md).
